/**
 * The PostgreSQL `TokenTransactionStore` (`~/ports/tokenTransaction`) on the `transactions` and
 * `balances` tables: the balance protocol of `~/methods/transactionRules` (valuation, credit
 * updates, the balance upsert keyed by the user id, the fenced auto-refill and its ledger marker,
 * reservations) on the collection primitive's operations. Must not import `mongoose`, `mongodb`
 * or `bson`.
 *
 * Typed storage (docs/postgres-port/PHASE4.md §1.4): `reservations` is the child table
 * `balances__reservations`, `pendingRefill` an object flattened into columns.
 *
 * Concurrency (§3.5, R2):
 * - A credit update (`updateBalance`, and through it every transaction applied to the balance)
 *   is a lock-then-write in one transaction: the user's oldest balance row is locked (`SELECT
 *   ... ORDER BY _id LIMIT 1 FOR UPDATE`, hand-written, parent columns only), its credits read in
 *   the next statement, and the floored sum written by the primitive on that `tx`. Concurrent
 *   spends serialize on the row lock, so none is lost and none needs MongoDB's optimistic retry.
 * - Every other guarded write is one primitive operation whose filter is re-evaluated on the
 *   locked row: the admission (`$push` into the child table with the `$inc`, guarded on the
 *   credits and the reserved total), the auto-refill fence, the null-credit compare-and-set, the
 *   marker clear. Filters on the child table (the removal's `$elemMatch`, the renewal's
 *   `reservations.id`) take the primitive's lock and recheck in a new statement, so two releases
 *   of one reservation remove it, and its credits, once.
 * - A balance created for a user without one is keyed by the user id: racing creators converge
 *   on one row (the primary key), the primitive's upsert retrying the loser as an update.
 */
import { sql } from 'kysely';
import type { TokenTransactionStore, TokenTransactionRecord } from '~/ports/tokenTransaction';
import type { LedgerTransaction } from '~/methods/transactionRules';
import type { TokenTransactionFactoryDeps } from '~/compose/types';
import type { PostgresStoreContext } from './context';
import type { IBalance } from '~/types';
import {
  balanceCreditUpdate,
  OLDEST_BALANCE_FIRST,
  createBalanceLedgerOnSteps,
} from '~/methods/transactionRules';
import { asRecord, runStoreSql, storeWhere } from './context';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { postgresStoreIds } from '../storeIds';
import logger from '~/config/winston';

type BalanceRow = IBalance & Record<string, unknown>;
type TransactionRow = TokenTransactionRecord & Record<string, unknown>;

/**
 * The fields of a transaction the ledger stores (the schema's); the valuation's working fields
 * (`endpointTokenConfig`, `inputTokenCount`, `write1hTokens`, `rateDetail`) are left out, as the
 * mongoose document leaves them out of what it saves.
 */
const LEDGER_FIELDS = [
  '_id',
  'user',
  'conversationId',
  'tokenType',
  'model',
  'context',
  'valueKey',
  'rate',
  'rawAmount',
  'tokenValue',
  'inputTokens',
  'writeTokens',
  'readTokens',
  'messageId',
] as const;

/** An id as the store writes it: the hex string of an `IdLike`, anything else as given. */
function storeIdOf(id: unknown): unknown {
  return id != null && typeof id === 'object' && 'toHexString' in id
    ? (id as { toHexString(): string }).toHexString()
    : id;
}

export function createPostgresTokenTransactionStore(
  context: PostgresStoreContext,
  pricing: TokenTransactionFactoryDeps,
): TokenTransactionStore {
  const balances = () => context.collections().collection<BalanceRow>('balances');
  const transactions = () => context.collections().collection<TransactionRow>('transactions');

  const ledger = createBalanceLedgerOnSteps(
    {
      findOldestBalance: (user, select) =>
        balances().findOne(
          { user },
          { sort: OLDEST_BALANCE_FIRST, ...(select ? { projection: select } : {}) },
        ),
      findOneAndUpdateBalance: (filter, update, options = {}) =>
        balances().findOneAndUpdate(filter, update, {
          returnDocument: 'after',
          ...(options.oldestFirst ? { sort: OLDEST_BALANCE_FIRST } : {}),
          ...(options.upsert ? { upsert: true } : {}),
        }),
      updateOneBalance: (filter, update, options) =>
        balances().updateOne(
          filter,
          update,
          options?.arrayFilters ? { arrayFilters: options.arrayFilters } : {},
        ),
      async updateEachBalance(updates) {
        if (updates.length === 0) {
          return;
        }
        await balances().bulk(
          updates.map(({ filter, update }) => ({ updateOne: { filter, update } })),
          { ordered: false },
        );
      },
      addCredits: (user, incrementValue, setValues) =>
        context.transactions.transaction(async (tx) => {
          const locked = await runStoreSql<{ _id: string }>(
            context,
            sql`SELECT t._id FROM balances t WHERE ${storeWhere(
              context,
              'balances',
              { user },
              { operation: 'findOneAndUpdate' },
            )} ORDER BY t._id LIMIT 1 FOR UPDATE`,
            tx,
          );
          const balanceId = locked.rows[0]?._id;
          if (balanceId === undefined) {
            return { status: 'missing' as const };
          }
          const current = await balances().findOne(
            { _id: balanceId },
            { projection: 'tokenCredits', tx },
          );
          const balance = await balances().findOneAndUpdate(
            { _id: balanceId },
            balanceCreditUpdate(current?.tokenCredits as number, incrementValue, setValues),
            { returnDocument: 'after', tx },
          );
          return balance ? { status: 'updated' as const, balance } : { status: 'missing' as const };
        }),
      newTransactionId: () => postgresStoreIds.generate(),
      buildTransaction: (data) => ({ ...data, user: storeIdOf(data.user) }),
      async saveTransaction(transaction: LedgerTransaction) {
        const stored = transaction as Record<string, unknown>;
        const document: Record<string, unknown> = {};
        for (const field of LEDGER_FIELDS) {
          if (stored[field] !== undefined) {
            document[field] = stored[field];
          }
        }
        await transactions().insertOne(document);
      },
      isDuplicateKey: (error) => error instanceof StoreDuplicateKeyError,
    },
    pricing,
  );

  const store: TokenTransactionStore = {
    ...ledger,

    async getTransactions(filter) {
      try {
        return await transactions().find(filter);
      } catch (error) {
        logger.error('Error querying transactions:', error);
        throw error;
      }
    },

    async deleteTransactions(filter) {
      return await transactions().deleteMany(filter);
    },

    async deleteBalances(filter) {
      return await balances().deleteMany(filter);
    },

    async bulkInsertTransactions(docs) {
      if (!docs.length) {
        return;
      }
      try {
        await transactions().insertMany(docs.map((doc) => asRecord(doc)));
      } catch (error) {
        logger.error('[bulkInsertTransactions] Error inserting transaction docs:', error);
        throw error;
      }
    },

    /** The oldest record of each user decides; the records are read in `_id` order. */
    async findBalanceCreditsByUsers(userIds) {
      if (userIds.length === 0) {
        return [];
      }
      const users = userIds.map((id) => (typeof id === 'string' ? id : id.toHexString()));
      const records = await balances().find(
        { user: { $in: users } },
        { projection: 'user tokenCredits', sort: OLDEST_BALANCE_FIRST },
      );
      const credits = new Map<string, number | null>();
      for (const record of records) {
        const user = String(record.user);
        if (!credits.has(user)) {
          credits.set(user, record.tokenCredits ?? null);
        }
      }
      return [...credits].map(([user, tokenCredits]) => ({ user, tokenCredits }));
    },
  };
  return store;
}

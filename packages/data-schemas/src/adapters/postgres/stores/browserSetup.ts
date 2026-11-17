/**
 * The PostgreSQL `BrowserSetupBackendStore` (`~/ports/browserSetup`): the code environment browser
 * setup flow's storage. The session store (`createStore`) is the shared one
 * (`createBrowserSetupStoreOnSteps`, `~/methods/browserSetupRules`) on the raw tables
 * `browser_setup_sessions` (with its `nonces` child table), `browser_setup_budget` (the allocation
 * singleton, with its `allocations` child table) and `browser_setup_requests` (the request
 * singleton, its `peers` map a `json` column), through the collection primitive in raw mode (the
 * tables have no model or tenant policy; MongoDB writes them through the driver). Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * - **Allocation claim**: the budget row is locked (`SELECT ... FOR UPDATE`, parent columns
 *   only), its allocations are counted in the next statement (all, those of the peer, and whether
 *   the attempt holds one: MongoDB's `$expr` over `$size`/`$filter` and the `$ne` on the elements),
 *   and the allocation is pushed (a child `INSERT`) on the same transaction, so racing starts are
 *   serialized on the singleton and the global and per-peer bounds hold.
 * - **Lost session inserts**: the allocations whose session record is missing are an anti-join
 *   (`NOT EXISTS` on `browser_setup_sessions`), their snapshots then read from the budget record
 *   and restored by one bulk write of insert-only upserts.
 * - **Guarded session writes** (the revision compare-and-set, leases, the nonce claim with its
 *   `$not $elemMatch` and capacity guards, the allocation release that arms `deleteAfter`) are
 *   single primitive operations: filters on the `nonces` child table take the primitive's lock and
 *   recheck, so of two racing claims of one nonce exactly one is `claimed`.
 * - The request budget's per-peer counter (`peers.<hash>`, a path into the `json` map) is updated
 *   by the primitive's read-modify-write under the row lock.
 */
import { sql } from 'kysely';
import type {
  BrowserSetupAllocation,
  BrowserSetupStorageSteps,
  BrowserSetupSessionDocument,
} from '~/methods/browserSetupRules';
import type { BrowserSetupBackendStore } from '~/ports/browserSetup';
import type { CodeEnvironmentStore } from '~/ports/codeEnvironment';
import type { PgProjection, PgRecord } from '../collection';
import type { PostgresStoreContext } from './context';
import { createBrowserSetupStoreOnSteps } from '~/methods/browserSetupRules';
import { postgresStoreErrors } from '../storeErrors';
import { runStoreSql } from './context';

const SESSIONS = 'browser_setup_sessions';
const BUDGET = 'browser_setup_budget';
const REQUESTS = 'browser_setup_requests';
const GLOBAL = 'global';

type SessionRecord = BrowserSetupSessionDocument & PgRecord;
type BudgetRecord = PgRecord & { _id: string; allocations?: BrowserSetupAllocation[] };

/** The setup session store's storage steps on the raw tables. */
function browserSetupSteps(context: PostgresStoreContext): BrowserSetupStorageSteps {
  const sessions = () => context.collections().raw<SessionRecord>(SESSIONS);
  const budgets = () => context.collections().raw<BudgetRecord>(BUDGET);
  const requests = () => context.collections().raw(REQUESTS);
  const isDuplicateKey = (error: unknown) => postgresStoreErrors.isDuplicateKey(error);
  const ignoreDuplicate = (error: unknown) => {
    if (!isDuplicateKey(error)) throw error;
  };
  /** The open allocation of the attempt, read through the `$elemMatch` projection. */
  const findAllocation = async (attemptId: string, tx?: Parameters<typeof runStoreSql>[2]) => {
    const reservation = await budgets().findOne(
      { _id: GLOBAL, 'allocations.session.attemptId': attemptId },
      {
        /** C2's `$elemMatch` projection, which `PgProjection` does not spell. */
        projection: {
          allocations: { $elemMatch: { 'session.attemptId': attemptId } },
        } as unknown as PgProjection,
        tx,
      },
    );
    return reservation?.allocations?.[0] ?? null;
  };

  return {
    isDuplicateKey,
    async initialize() {
      await Promise.all([
        requests()
          .updateOne(
            { _id: GLOBAL },
            { $setOnInsert: { expiresAt: 0, count: 0, peers: {} } },
            { upsert: true },
          )
          .catch(ignoreDuplicate),
        budgets()
          .updateOne({ _id: GLOBAL }, { $setOnInsert: { allocations: [] } }, { upsert: true })
          .catch(ignoreDuplicate),
      ]);
    },
    sessions: {
      findOne: (filter) => sessions().findOne(filter),
      find: (filter, sort, limit) => sessions().find(filter, { sort, limit }),
      findOneAndUpdate: (filter, update) =>
        sessions().findOneAndUpdate(filter, update, { returnDocument: 'after' }),
      async updateOne(filter, update, options) {
        const result = await sessions().updateOne(filter, update, { upsert: options?.upsert });
        return { matchedCount: result.matchedCount, upsertedCount: result.upsertedCount };
      },
      async write(operations) {
        // Attempt IDs are deployment-global; raw batches use exact IDs and CAS/lease predicates.
        await sessions().bulk(operations);
      },
    },
    allocations: {
      claim: (allocation, limits) =>
        context.transactions.transaction(async (tx) => {
          const locked = await runStoreSql<{ _id: string }>(
            context,
            sql`SELECT t._id FROM browser_setup_budget t WHERE t._id = ${GLOBAL} FOR UPDATE`,
            tx,
          );
          if (locked.rows.length === 0) return null;
          const counts = await runStoreSql<{ total: number; peer: number; taken: boolean }>(
            context,
            sql`SELECT count(*)::integer AS total,
              (count(*) FILTER (WHERE a."ipHash" = ${allocation.ipHash}))::integer AS peer,
              coalesce(bool_or(a."session__attemptId" = ${allocation.attemptId}), false) AS taken
              FROM browser_setup_budget__allocations a WHERE a._parent = ${GLOBAL}`,
            tx,
          );
          const { total, peer, taken } = counts.rows[0];
          if (taken || total >= limits.global || peer >= limits.perIp) return null;
          await budgets().updateOne(
            { _id: GLOBAL },
            { $push: { allocations: allocation } },
            { tx },
          );
          return findAllocation(allocation.attemptId, tx);
        }),
      find: (attemptId) => findAllocation(attemptId),
      async release(attemptIds) {
        await budgets().updateOne(
          { _id: GLOBAL },
          { $pull: { allocations: { attemptId: { $in: attemptIds } } } },
        );
      },
      async missingSessions(limit) {
        const missing = await runStoreSql<{ attemptId: string }>(
          context,
          sql`SELECT a."attemptId" FROM browser_setup_budget__allocations a
            WHERE a._parent = ${GLOBAL}
            AND NOT EXISTS (SELECT 1 FROM browser_setup_sessions s WHERE s._id = a."attemptId")
            ORDER BY a._ord LIMIT ${limit}`,
        );
        if (missing.rows.length === 0) return [];
        const attemptIds = new Set(missing.rows.map((row) => row.attemptId));
        const budget = await budgets().findOne({ _id: GLOBAL });
        return (budget?.allocations ?? [])
          .filter((entry) => attemptIds.has(entry.attemptId))
          .slice(0, limit);
      },
    },
    requests: {
      async updateOne(filter, update) {
        const result = await requests().updateOne(filter, update);
        return { matchedCount: result.matchedCount };
      },
    },
  };
}

export function createPostgresBrowserSetupStore(
  context: PostgresStoreContext,
  deps: { codeEnvironments: Pick<CodeEnvironmentStore, 'ensureSetupEnvironmentIndexes'> },
): BrowserSetupBackendStore {
  const store: BrowserSetupBackendStore = {
    ensureRegistration: () => deps.codeEnvironments.ensureSetupEnvironmentIndexes(),
    createStore: () => createBrowserSetupStoreOnSteps(browserSetupSteps(context)),
    isConnected() {
      try {
        context.db();
        return true;
      } catch {
        return false;
      }
    },
    async getUser(id) {
      const user = await context.collections().collection('users').findOne(
        { _id: id },
        {
          projection:
            '_id tenantId role idOnTheSource provider emailVerified twoFactorEnabled termsAccepted expiresAt agentTriggerDeletionStartedAt',
        },
      );
      if (user == null) return null;
      return {
        id: String(user._id),
        tenantId: user.tenantId as string | undefined,
        role: user.role as string | undefined,
        idOnTheSource: (user.idOnTheSource as string | undefined) ?? null,
        provider: user.provider as string | undefined,
        emailVerified: user.emailVerified as boolean | undefined,
        twoFactorEnabled: user.twoFactorEnabled as boolean | undefined,
        termsAccepted: user.termsAccepted as boolean | undefined,
        expiresAt: user.expiresAt as Date | undefined,
        agentTriggerDeletionStartedAt: user.agentTriggerDeletionStartedAt as
          | Date
          | null
          | undefined,
      };
    },
  };
  return store;
}

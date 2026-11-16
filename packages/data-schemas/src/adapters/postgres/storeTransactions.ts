/**
 * PostgreSQL adapter for `StoreTransactions` (`DataStore.transactions`;
 * docs/postgres-port/PHASE4.md §4, "Internal transactions"). Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * `transaction(fn)` starts a Kysely controlled transaction on one pooled connection and hands
 * `fn` an opaque {@link StoreTransaction}: a frozen empty object, mapped through a `WeakMap` to
 * the Kysely transaction, so callers can pass it on but never reach the driver. The store
 * methods that take a transaction resolve it with {@link resolvePostgresExecutor}. PostgreSQL
 * always runs transactions, so `fn` never receives `undefined`.
 *
 * Driven by hand (begin, commit, roll back on failure) rather than with Kysely's
 * `transaction().execute`, so a failed rollback is logged and the original error rethrown, as
 * the port requires. A failed commit rejects (and the transaction is rolled back). Work queued
 * with `runAfterCommit` runs after the commit, in the async context of its call, before
 * `transaction` resolves; it is dropped on rollback, and its failures are ignored.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ControlledTransaction, Kysely } from 'kysely';
import type { StoreTransactions } from '~/ports/storeTransactions';
import type { PostgresKysely, PostgresTables } from './types';
import type { StoreTransaction } from '~/ports/common';
import logger from '~/config/winston';

/** One piece of work queued for a commit, with the async context it was queued in. */
interface AfterCommitWork {
  run: ReturnType<typeof AsyncLocalStorage.snapshot>;
  fn: () => Promise<void>;
}

/** Runs queued work in its own async context; its failure is ignored (never fails the commit). */
async function runQuietly(work: AfterCommitWork): Promise<void> {
  try {
    await work.run(work.fn);
  } catch {
    /* ignored, as the port states */
  }
}

/** What a transaction handle stands for. */
interface TransactionState {
  trx: ControlledTransaction<PostgresTables>;
  /** Whether the transaction still accepts work (false once committing or rolling back). */
  open: boolean;
  afterCommit: AfterCommitWork[];
}

const transactions = new WeakMap<StoreTransaction, TransactionState>();

/**
 * The Kysely executor a store method runs on: the open transaction `tx` stands for, or `db`
 * when `tx` is `undefined`. Throws when `tx` is not a handle this adapter handed out, or its
 * transaction has ended (a handle kept after its callback settled).
 */
export function resolvePostgresExecutor(
  db: PostgresKysely,
  tx: StoreTransaction | undefined,
): Kysely<PostgresTables> {
  if (tx === undefined) {
    return db;
  }
  const state = transactions.get(tx);
  if (!state) {
    throw new TypeError('Not a transaction of the PostgreSQL store');
  }
  if (!state.open) {
    throw new Error('The PostgreSQL transaction has already ended');
  }
  return state.trx;
}

/** Whether `tx` is a transaction of this adapter that is still open. */
export function isOpenPostgresTransaction(tx: StoreTransaction | undefined): boolean {
  return tx !== undefined && transactions.get(tx)?.open === true;
}

async function rollbackQuietly(trx: ControlledTransaction<PostgresTables>): Promise<void> {
  if (trx.isCommitted || trx.isRolledBack) {
    return;
  }
  try {
    await trx.rollback().execute();
  } catch (rollbackError) {
    logger.error('[StoreTransactions.transaction] Error rolling back transaction:', rollbackError);
  }
}

/**
 * The PostgreSQL `StoreTransactions` on the database `getDb` returns when a transaction starts
 * (the connected handle's Kysely instance; it throws while not connected).
 */
export function createPostgresStoreTransactions(getDb: () => PostgresKysely): StoreTransactions {
  async function transaction<T>(fn: (tx: StoreTransaction | undefined) => Promise<T>): Promise<T> {
    const trx = await getDb().startTransaction().execute();
    const handle: StoreTransaction = Object.freeze({});
    const state: TransactionState = { trx, open: true, afterCommit: [] };
    transactions.set(handle, state);

    let result: T;
    try {
      result = await fn(handle);
    } catch (error) {
      state.open = false;
      state.afterCommit = [];
      await rollbackQuietly(trx);
      throw error;
    }

    state.open = false;
    try {
      await trx.commit().execute();
    } catch (commitError) {
      state.afterCommit = [];
      await rollbackQuietly(trx);
      throw commitError;
    }

    const queued = state.afterCommit;
    state.afterCommit = [];
    await Promise.all(queued.map(runQuietly));
    return result;
  }

  function runAfterCommit(
    tx: StoreTransaction | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    const state = tx === undefined ? undefined : transactions.get(tx);
    if (!state?.open) {
      return fn();
    }
    state.afterCommit.push({ run: AsyncLocalStorage.snapshot(), fn });
    return Promise.resolve();
  }

  return { transaction, runAfterCommit };
}

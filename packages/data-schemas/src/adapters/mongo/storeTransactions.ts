import type { ClientSession } from 'mongoose';
import { getTransactionSupport } from '~/utils/transactions';
import { runAfterTransaction } from '~/methods/userGroup';
import logger from '~/config/winston';

/** The MongoDB methods behind the `StoreTransactions` port (`~/ports/storeTransactions`). */
export interface MongoStoreTransactionMethods {
  /**
   * Runs `fn` in a MongoDB transaction on a new session, handing `fn` the session; see
   * `StoreTransactions.transaction` for the contract. Without transaction support (as
   * `getTransactionSupport` probes it once per instance), `fn` gets `undefined` and runs without
   * a session, as callers have done in that case.
   */
  transaction<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T>;
  /**
   * `runAfterTransaction` (`~/methods/userGroup`): runs `fn` now unless the session is in a
   * transaction, otherwise queues it for that session's commit (discarded on abort); see
   * `StoreTransactions.runAfterCommit`.
   */
  runAfterCommit(session: ClientSession | undefined, fn: () => Promise<void>): Promise<void>;
}

/**
 * MongoDB adapter for `StoreTransactions`. The transaction is driven by hand (start, commit,
 * abort on failure, end), as the access control service drives its own today, rather than with
 * the driver's `withTransaction`, which would also rerun `fn` on transient errors: `fn` runs
 * exactly once either way.
 */
export function createMongoStoreTransactionMethods(
  mongoose: typeof import('mongoose'),
): MongoStoreTransactionMethods {
  /** The probe's verdict, kept once known: a deployment does not gain or lose support. */
  let transactionSupportCache: boolean | null = null;

  async function transaction<T>(
    fn: (session: ClientSession | undefined) => Promise<T>,
  ): Promise<T> {
    const supportsTransactions = await getTransactionSupport(mongoose, transactionSupportCache);
    transactionSupportCache = supportsTransactions;
    if (!supportsTransactions) {
      return fn(undefined);
    }

    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      try {
        const result = await fn(session);
        await session.commitTransaction();
        return result;
      } catch (error) {
        try {
          await session.abortTransaction();
        } catch (abortError) {
          logger.error('[StoreTransactions.transaction] Error aborting transaction:', abortError);
        }
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }

  return { transaction, runAfterCommit: runAfterTransaction };
}

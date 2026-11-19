/**
 * Store transactions port: running several store operations as one transaction, on whichever
 * database the store is. Nothing here may import `mongoose`.
 *
 * It is a store of its own (`DataStore.transactions`) rather than a method on `DataStore`, so
 * that every member of `DataStore` stays a store of flat methods: each store's functions are
 * the ones the adapter's flat methods export, and no two stores share a method name.
 */
import type { StoreTransaction } from './common';
import { listPortMethods } from './common';

export interface StoreTransactions {
  /**
   * Runs `fn` in a new transaction and resolves to what `fn` resolves to.
   *
   * Where the store runs transactions, `fn` receives the transaction to pass on to the store
   * methods that take one (a trailing `session` parameter or a `session` option); only the
   * reads and writes made with it belong to the transaction. When `fn` resolves, the
   * transaction is committed, and a failed commit rejects. When `fn` rejects, the transaction is
   * rolled back and the error is rethrown (a failed rollback is logged, never thrown in its
   * place). Either way the transaction is closed before the promise settles, so work that must
   * only follow a durable write (cache invalidation, notifications) goes after the call.
   * Transactions do not nest: inside `fn`, pass the transaction on rather than calling
   * `transaction` again, which would start an unrelated one.
   *
   * Where the store cannot run transactions (with MongoDB: a standalone server, or a deployment
   * whose transaction probe fails, as the first call finds out; the verdict is kept), `fn`
   * receives `undefined` and runs once with no transaction, as if the methods were called
   * without one: each write commits on its own as it is made, and nothing is rolled back when
   * `fn` rejects. A caller that needs its reads and writes ordered against concurrent callers
   * must then serialize them itself; the access control service, for instance, takes a
   * per-resource lease when it has no transaction.
   */
  transaction<T>(fn: (tx: StoreTransaction | undefined) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` once the writes made with `tx` are durable: right away (and resolves when `fn`
   * does) when `tx` is `undefined` or its transaction is no longer open, otherwise right after
   * that transaction commits, in the async context of this call (tenant scoping included); never
   * when it rolls back. A deferred `fn` is queued and the call resolves at once; the commit then
   * waits for it before it resolves, and a failure of a deferred `fn` is ignored (it never fails
   * the commit).
   *
   * For work that must only follow a durable write (cache invalidation) in code that writes with
   * a transaction its caller owns, so it cannot simply run after `transaction` resolves.
   */
  runAfterCommit(tx: StoreTransaction | undefined, fn: () => Promise<void>): Promise<void>;
}

/** Every method of {@link StoreTransactions}, for adapters and conformance checks. */
export const STORE_TRANSACTIONS_METHODS: ReadonlyArray<keyof StoreTransactions> =
  listPortMethods<StoreTransactions>({
    transaction: true,
    runAfterCommit: true,
  });

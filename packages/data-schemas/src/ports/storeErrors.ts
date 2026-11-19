/**
 * Store error port: how code outside the data layer recognizes the errors a store rejects with,
 * without knowing the database behind it. Nothing here may import `mongoose` or the MongoDB
 * driver, at runtime or as a type.
 *
 * Duplicate keys: a write that would give two records the same value of a unique key (with
 * MongoDB: a unique index, server error code 11000; with PostgreSQL: a unique constraint,
 * SQLSTATE 23505) rejects with an error that `isDuplicateKeyError` (exported from
 * `@librechat/data-schemas`, served by the backend's {@link StoreErrors}) recognizes. That is
 * either the backend's own error, as the driver raised it, or a {@link StoreDuplicateKeyError},
 * which any adapter or database-neutral domain function may throw instead.
 * `duplicateKeyFields` names the fields of the violated key when the store reports them. Store
 * methods that retry or absorb their own duplicates say so in their port; the others pass the
 * error on, and callers that turn it into an outcome (a 409, a replay of the record that won)
 * test it only with `isDuplicateKeyError`, never with a backend's error code.
 *
 * Not a member of `DataStore`: recognizing errors belongs to the backend, not to a store of
 * records, and needs no connection (`DataStoreBackend.errors`).
 */
import { listPortMethods } from './common';

/**
 * The database-neutral duplicate-key error: a write broke a unique key. `keyValue` holds the
 * violated key's fields and the values written, when the store knows them (the shape of the
 * `keyValue` MongoDB reports, so callers read either the same way).
 */
export class StoreDuplicateKeyError extends Error {
  readonly keyValue?: Record<string, unknown>;
  /** The backend's own error, when this one stands for it. */
  readonly cause?: unknown;
  constructor(
    message = 'Duplicate key',
    options: { keyValue?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'StoreDuplicateKeyError';
    if (options.keyValue !== undefined) {
      this.keyValue = options.keyValue;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface StoreErrors {
  /**
   * Whether `error` is a duplicate-key error of this store: a {@link StoreDuplicateKeyError} or
   * the backend's own duplicate-key error.
   */
  isDuplicateKey(error: unknown): boolean;
  /**
   * The fields of the unique key `error` violated, when `isDuplicateKey` accepts it and the
   * store reports them (the keys of its `keyValue`); `undefined` otherwise.
   */
  duplicateKeyFields(error: unknown): string[] | undefined;
}

/** Every method of {@link StoreErrors}, for adapters and conformance checks. */
export const STORE_ERRORS_METHODS: ReadonlyArray<keyof StoreErrors> = listPortMethods<StoreErrors>({
  isDuplicateKey: true,
  duplicateKeyFields: true,
});

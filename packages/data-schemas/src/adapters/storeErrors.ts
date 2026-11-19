import { getDataStoreBackend } from './backend';

/**
 * Whether `error` is a duplicate-key error of the process's data store (`~/ports/storeErrors`):
 * a write broke a unique key. The way code outside the data layer tests for one, instead of a
 * database's error code. Resolves the backend when called, never at load.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return getDataStoreBackend().errors.isDuplicateKey(error);
}

/**
 * The fields of the unique key a duplicate-key error violated, when the store reports them;
 * `undefined` for any other error or when the store does not say.
 */
export function duplicateKeyFields(error: unknown): string[] | undefined {
  return getDataStoreBackend().errors.duplicateKeyFields(error);
}

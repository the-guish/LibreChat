/**
 * Stand-ins for what the PostgreSQL backend does not implement yet (docs/postgres-port/PHASE4.md
 * §8: stores arrive unit by unit, S1 to S11; the key-value store with I1, the checkpoint store
 * with I2, the search index sync with I3, the startup checks and the credential marker with B1).
 * Every stand-in throws a {@link StoreNotImplementedError} when it is used: a store method when
 * it is called, a key-value store or a startup check on its first operation. Nothing answers
 * "not available" (`null`) in its place, so a missing piece is never silently skipped.
 *
 * The backend refuses to connect while anything here is in use, unless
 * `POSTGRES_ALLOW_INCOMPLETE_STORES=true` (`./backend.ts`). Must not import `mongoose`,
 * `mongodb` or `bson`.
 */
import type { DataStoreStartupChecks } from '~/ports/startupChecks';
import type { KeyValueStore } from '~/ports/keyValueStore';
import type { DataStore } from '~/ports';
import { DATA_STORE_STARTUP_CHECK_METHODS } from '~/ports/startupChecks';
import { KEY_VALUE_STORE_METHODS } from '~/ports/keyValueStore';
import { DATA_STORE_METHODS } from '~/ports';

/** A store method, or another member of the backend, that the PostgreSQL backend lacks yet. */
export class StoreNotImplementedError extends Error {
  /** The store (`DataStore` key) or backend member, such as `users` or `keyValueStore`. */
  readonly store: string;
  /** The method, such as `findUser`. */
  readonly method: string;
  constructor(store: string, method: string) {
    super(`The PostgreSQL backend does not implement ${store}.${method} yet`);
    this.name = 'StoreNotImplementedError';
    this.store = store;
    this.method = method;
  }
}

/** A function that throws `StoreNotImplementedError(store, method)` when called. */
export function notImplemented(store: string, method: string): (...args: unknown[]) => never {
  return () => {
    throw new StoreNotImplementedError(store, method);
  };
}

/** An object with every method in `methods` replaced by {@link notImplemented}. */
function notImplementedMembers<T>(store: string, methods: ReadonlyArray<keyof T>): T {
  const members: Record<string, (...args: unknown[]) => never> = {};
  for (const method of methods) {
    members[String(method)] = notImplemented(store, String(method));
  }
  return members as T;
}

/** The store `store` with every port method throwing `StoreNotImplementedError`. */
export function createNotImplementedStore<K extends keyof DataStore>(store: K): DataStore[K] {
  return notImplementedMembers<DataStore[K]>(store, DATA_STORE_METHODS[store]);
}

/** A key-value store whose every operation throws `StoreNotImplementedError` (I1). */
export function createNotImplementedKeyValueStore(): KeyValueStore {
  return notImplementedMembers<KeyValueStore>('keyValueStore', KEY_VALUE_STORE_METHODS);
}

/** Startup checks that each throw `StoreNotImplementedError` (B1). */
export function createNotImplementedStartupChecks(): DataStoreStartupChecks {
  return notImplementedMembers<DataStoreStartupChecks>(
    'startupChecks',
    DATA_STORE_STARTUP_CHECK_METHODS,
  );
}

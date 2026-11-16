/**
 * The types of the backend-neutral test data store (`./index`, docs/postgres-port/PHASE4.md §7
 * item 5). Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { CreateMethodsDeps, DataMethods } from '~/compose/types';
import type { StoreErrors } from '~/ports/storeErrors';
import type { RawRecord } from '~/contracts/harness';
import type { StoreIds } from '~/ports/storeIds';

export type { RawRecord } from '~/contracts/harness';

/** Options of {@link createTestDataStore}. */
export interface TestDataStoreOptions {
  /** The dependencies `methods` is composed with (`createMethods(deps)`), as the server passes them. */
  deps?: CreateMethodsDeps;
}

/** A test database on the process's backend, with fixtures in raw mode. */
export interface TestDataStore {
  /** The backend it runs on (`DATABASE_BACKEND`): `mongo` or `postgres`. */
  readonly backend: 'mongo' | 'postgres';
  /**
   * The data methods (`getDataStoreBackend().createMethods(deps)`: the stores under `stores` and
   * the flat members), on the connected test database.
   */
  readonly methods: DataMethods;
  /** The backend's id format, for fixture ids (`ids.generate()`, `ids.toStoreId(hex)`). */
  readonly ids: StoreIds;
  /** The backend's error classification (`errors.isDuplicateKey(error)`). */
  readonly errors: StoreErrors;
  /**
   * Inserts `records` into `collection` (the MongoDB collection's name, which is also the
   * PostgreSQL table's) in raw mode: bypassing the stores, tenant scoping, defaults, validators,
   * timestamps and hooks. Declared paths are cast to their declared types (a 24-hex string to an
   * id, an ISO string to a date); undeclared fields are kept as given.
   */
  seed(collection: string, records: ReadonlyArray<RawRecord>): Promise<void>;
  /**
   * Every record of `collection`, bypassing the stores, oldest `_id` first, in canonical form:
   * ids as 24 lowercase hex strings, dates as `Date`, binary data as `Buffer`, hidden paths
   * included.
   */
  read(collection: string): Promise<RawRecord[]>;
  /** Removes every record of every collection (indexes and the schema stay). */
  reset(): Promise<void>;
  /** Disconnects, drops the test database and stops what was started for it. */
  close(): Promise<void>;
}

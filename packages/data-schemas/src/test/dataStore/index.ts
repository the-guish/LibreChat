/**
 * The backend-neutral test data store (docs/postgres-port/PHASE4.md §7, "Definition of done for
 * phase 5", item 5): the fixture helper the curated DB-backed suites (H2a to H2d) use instead of
 * mongoose, so the same suite runs on MongoDB and on PostgreSQL. Exported as
 * `createTestDataStore()` from `@librechat/data-schemas/testing`. Must not import `mongoose`,
 * `mongodb` or `bson`: the backend's implementation is loaded only once the backend is known.
 *
 * ```js
 * const { createTestDataStore } = require('@librechat/data-schemas/testing');
 * let store;
 * beforeAll(async () => { store = await createTestDataStore(); });
 * afterEach(() => store.reset());
 * afterAll(() => store.close());
 * it('...', async () => {
 *   await store.seed('users', [{ _id: store.ids.generate(), email: 'a@example.com' }]);
 *   // ... exercise the route, which reaches the database through `~/models` ...
 *   expect(await store.read('users')).toEqual([expect.objectContaining({ email: 'a@example.com' })]);
 * });
 * ```
 *
 * The backend is the process's (`getDataStoreBackend()`, chosen by `DATABASE_BACKEND`), and the
 * store connects that backend's own connection state, so the server modules built on it
 * (`api/models`, `~/models`) reach the same database as `methods`, `seed` and `read`:
 * - `mongo` (the default): an in-memory MongoDB (`MongoMemoryServer.create()`), connected on the
 *   shared `mongoose` instance (as the existing DB-backed suites do with `mongoose.connect`),
 *   every model registered and its indexes built before the first case.
 * - `postgres`: a database copied from the migrated template of the PostgreSQL test server
 *   (`~/test/postgres`: the run's shared server under the PostgreSQL Jest configs, otherwise one
 *   of its own), connected on the process-wide PostgreSQL connection state with
 *   `POSTGRES_ALLOW_INCOMPLETE_STORES=true` until every store exists (B1). Stores whose S unit has
 *   not landed are the backend's stand-ins, which throw `StoreNotImplementedError`.
 *
 * One store per test file at a time: it owns the process's connection until `close`.
 */
import type { TestDataStore, TestDataStoreOptions } from './types';

export type { RawRecord, TestDataStore, TestDataStoreOptions } from './types';

/** The backend `DATABASE_BACKEND` names; `getDataStoreBackend()` rejects other values. */
function backendName(value: string | undefined): 'mongo' | 'postgres' {
  return value?.trim().toLowerCase() === 'postgres' ? 'postgres' : 'mongo';
}

/**
 * Starts (or locates) a test database on the backend `DATABASE_BACKEND` names and connects the
 * process's backend to it. Call it in `beforeAll` (it can take a few seconds) and `close` it in
 * `afterAll`.
 */
export async function createTestDataStore(
  options: TestDataStoreOptions = {},
): Promise<TestDataStore> {
  if (backendName(process.env.DATABASE_BACKEND) === 'postgres') {
    const { createPostgresTestDataStore } = await import('./postgres');
    return createPostgresTestDataStore(options);
  }
  const { createMongoTestDataStore } = await import('./mongo');
  return createMongoTestDataStore(options);
}

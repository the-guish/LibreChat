/**
 * `@librechat/data-schemas/testing`: helpers for tests, fixtures and the e2e suite, kept out of
 * the main entry (docs/postgres-port/PHASE4.md §7). Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * - `createRawDatabase`: a driver-like facade (`db.collection(name).find(...).toArray()`,
 *   `insertOne`, `updateOne`, `countDocuments`, ...) over the PostgreSQL collection primitive's raw
 *   mode, for the e2e helpers (`e2e/specs/mock/db.ts`, E1) and fixtures that seed and inspect the
 *   database the way the MongoDB driver does. Connects with `POSTGRES_URI`/`POSTGRES_SCHEMA`, or to
 *   a given Kysely instance or `pg` pool.
 * - `createTestDataStore()` (H1, §7 item 5): the backend-neutral fixture helper of the DB-backed
 *   suites: the process's backend (`DATABASE_BACKEND`) connected to a test database (an
 *   in-memory MongoDB, or a database of the PostgreSQL test server), with `methods`, `seed`,
 *   `read`, `reset` and `close` (`./test/dataStore`). Its MongoDB half (`mongoose`,
 *   `mongodb-memory-server`) is loaded only when MongoDB is selected.
 * - The PostgreSQL test server (`./test/postgres`) for suites outside this package and the
 *   PostgreSQL Jest configs (`jest.postgres.config.*`, H1): `describePostgres`,
 *   `usePostgresTestDatabase`, `openPostgresTestDatabase`, `getPostgresTestAvailability`, and
 *   `acquireSharedPostgresTestServer` for a global setup that starts the run's server up front.
 */
export { createRawDatabase, toRawCollection } from './adapters/postgres/collection/raw';
export type {
  RawCursor,
  RawDatabase,
  RawCollection,
  RawFindOptions,
  RawUpdateResult,
  RawDatabaseOptions,
} from './adapters/postgres/collection/raw';
export type {
  PgSort,
  PgFilter,
  PgRecord,
  PgUpdate,
  PgProjection,
} from './adapters/postgres/collection/types';
export { createTestDataStore } from './test/dataStore';
export type { RawRecord, TestDataStore, TestDataStoreOptions } from './test/dataStore';
export {
  describePostgres,
  usePostgresTestDatabase,
  openPostgresTestDatabase,
  POSTGRES_TESTS_REQUIRED,
  getPostgresTestAvailability,
} from './test/postgres';
export type {
  PostgresTestServer,
  PostgresTestDatabase,
  PostgresTestTemplate,
  OpenPostgresTestDatabase,
  PostgresTestAvailability,
  PostgresTestDatabaseOptions,
} from './test/postgres';
export {
  stopPostgresTestServer,
  POSTGRES_TEST_RUN_DIR_ENV,
  acquireSharedPostgresTestServer,
} from './test/postgres/server';

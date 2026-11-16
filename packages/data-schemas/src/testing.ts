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
 * - H1 adds `createTestDataStore()` (backend from `DATABASE_BACKEND`) here.
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

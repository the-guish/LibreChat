/**
 * The collection primitive of the PostgreSQL backend (docs/postgres-port/PHASE4.md §3, unit C1):
 * the lean-subset API the store adapters (S units) build on, over the typed tables of the schema
 * descriptor. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * ```ts
 * const collections = createPgCollections({
 *   db: () => handle.db,                 // the backend's Kysely instance
 *   descriptor: SCHEMA_DESCRIPTOR,
 *   engine: getSchemaEngine(),           // D2: documents built by mongoose, offline
 * });
 * const convos = collections.collection<ConvoRecord>('conversations');
 * await convos.findOne({ conversationId, user }, { projection: 'title updatedAt' });
 * await convos.updateOne({ conversationId, user }, { $set: { title } }, { upsert: true, tx });
 * await convos.findOneAndUpdate(
 *   { user, status: 'queued' },
 *   { $set: { status: 'claimed', claimedAt: new Date() } },
 *   { sort: { createdAt: 1 }, returnDocument: 'after', skipLocked: true },
 * );
 * ```
 *
 * For store authors:
 * - Records come back as lean reads return them (key order of `toObject()`, ids as 24-hex strings,
 *   `_extra` merged); `find` without `sort` orders by `_id`.
 * - Filters are the query language (plus Q1's extensions); C2 adds `$elemMatch`, `$all`, `$type`,
 *   bit tests and positional updates. Undeclared paths are refused (R9).
 * - Updates pick tier 1 (one SQL statement over parent-row columns) or tier 2 (read-modify-write
 *   under `FOR UPDATE`) by themselves: a store states the update as on MongoDB. Both follow §3.5:
 *   a write never lands on a row that no longer matches. `skipLocked` is for queue claims.
 * - Timestamps, `__v`, the tenant policy and the collection hooks (`hooks.ts`) are applied as
 *   mongoose applies them; `timestamps: false` as mongoose's option.
 * - Duplicate keys reject with `StoreDuplicateKeyError` (`keyValue` from the written record).
 * - `tx` (a `StoreTransaction` from `DataStore.transactions`) runs the operation in that
 *   transaction; multi-statement operations use a savepoint inside it.
 * - What the API cannot say (aggregations, joins, `$expr`, keyset cursors) is hand-written SQL
 *   (Kysely typed by `schema/db.generated.ts`): lock parent rows before touching their child rows,
 *   and never read a parent's child rows in the statement that locks it (§3.5).
 * - `raw(name)` is the raw mode (fixtures, the e2e facade, the copy tool): no engine, hooks,
 *   tenant policy or timestamps.
 */
export { createPgCollections, UpdateShadowCheckError } from './collection';
export type { PgCollections, PgCollectionsOptions } from './collection';
export { DEFAULT_COLLECTION_HOOKS, AUDIT_LOG_APPEND_ONLY_MESSAGE, searchTokenHooks } from './hooks';
export type { CollectionHooks, UpdateHookContext } from './hooks';
export { tenantPartitionFilter } from './tenant';
export type { TenantPartitionStoreFilter } from './tenant';
export { descriptorUniqueConstraints } from './constraints';
export { createSqlRunner } from './runner';
export type { SqlRunner, SqlResult } from './runner';
export type * from './types';

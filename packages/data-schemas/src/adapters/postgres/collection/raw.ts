/**
 * The raw facade (docs/postgres-port/PHASE4.md §7, "e2e mock suite on PostgreSQL"): a driver-like
 * `db` whose `collection(name)` speaks the MongoDB driver's shape (`find(...).sort().toArray()`,
 * `insertOne` → `{ insertedId }`, `updateOne` → `{ matchedCount }`, `countDocuments`, ...) over
 * the collection primitive's raw mode, so the e2e helpers and fixtures that seed and inspect the
 * database through the driver run unchanged on PostgreSQL. Must not import `mongoose`, `mongodb`
 * or `bson`.
 *
 * Raw mode: values are cast by the descriptor (a 24-hex string or an id object to an id, an ISO
 * string to a date), with no defaults, validators, hooks, tenant scoping or timestamps, as a
 * driver write; undeclared or uncastable inserted values go to `_extra` (D7). Ids come back as
 * 24-hex strings (R7); `insertedId` is one too. Reads return hidden paths, as the driver does.
 * Filters on paths the schema does not declare are refused (R9).
 */
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { PgCollection, PgFilter, PgProjection, PgRecord, PgSort, PgUpdate } from './types';
import type { PostgresTables, PostgresKysely } from '../types';
import type { SchemaDescriptor } from '../schema/descriptor';
import { createPostgresPool, readPostgresConnectionSettings } from '../connection';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { quoteIdentifier } from '../schema/naming';
import { createPgCollections } from './collection';
import { createSqlRunner } from './runner';

/** Driver-style update options. */
export interface RawUpdateOptions {
  upsert?: boolean;
  arrayFilters?: ReadonlyArray<Record<string, unknown>>;
}

/** Driver-style find options. */
export interface RawFindOptions {
  sort?: PgSort;
  projection?: PgProjection;
  limit?: number;
  skip?: number;
}

/** The cursor `find` returns: chained options, then `toArray()`. */
export interface RawCursor<T extends PgRecord = PgRecord> {
  sort(sort: PgSort): RawCursor<T>;
  project(projection: PgProjection): RawCursor<T>;
  limit(limit: number): RawCursor<T>;
  skip(skip: number): RawCursor<T>;
  toArray(): Promise<T[]>;
}

/** A driver-like collection over the primitive's raw mode. */
export interface RawCollection<T extends PgRecord = PgRecord> {
  readonly collectionName: string;
  find(filter?: PgFilter, options?: RawFindOptions): RawCursor<T>;
  findOne(filter?: PgFilter, options?: Omit<RawFindOptions, 'limit'>): Promise<T | null>;
  countDocuments(filter?: PgFilter): Promise<number>;
  insertOne(document: PgRecord): Promise<{ acknowledged: true; insertedId: string }>;
  insertMany(
    documents: readonly PgRecord[],
    options?: { ordered?: boolean },
  ): Promise<{ acknowledged: true; insertedCount: number; insertedIds: Record<number, string> }>;
  updateOne(
    filter: PgFilter,
    update: PgUpdate,
    options?: RawUpdateOptions,
  ): Promise<RawUpdateResult>;
  updateMany(
    filter: PgFilter,
    update: PgUpdate,
    options?: RawUpdateOptions,
  ): Promise<RawUpdateResult>;
  deleteOne(filter?: PgFilter): Promise<{ acknowledged: true; deletedCount: number }>;
  deleteMany(filter?: PgFilter): Promise<{ acknowledged: true; deletedCount: number }>;
}

/** The driver's `UpdateResult` shape. */
export interface RawUpdateResult {
  acknowledged: true;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: string | null;
}

/** A driver-like database over the raw mode of every collection of a descriptor. */
export interface RawDatabase {
  collection<T extends PgRecord = PgRecord>(name: string): RawCollection<T>;
  /** Removes every row of every collection (child rows by cascade). */
  truncateAll(): Promise<void>;
  /** Closes the pool when the facade opened it. */
  close(): Promise<void>;
}

/** Options of {@link createRawDatabase}. */
export interface RawDatabaseOptions {
  /**
   * Where to connect: a Kysely instance or a `pg` pool (left open by `close`), or `POSTGRES_URI`
   * and `POSTGRES_SCHEMA` (as the server reads them; the facade opens and closes its own pool).
   */
  db?: PostgresKysely;
  pool?: Pool;
  env?: Readonly<Record<string, string | undefined>>;
  /** The schema descriptor (default: the package's). */
  descriptor?: SchemaDescriptor;
}

function cursorOf<T extends PgRecord>(
  collection: PgCollection<T>,
  filter: PgFilter,
  initial: RawFindOptions,
): RawCursor<T> {
  const options: RawFindOptions = { ...initial };
  const cursor: RawCursor<T> = {
    sort: (sort) => ((options.sort = sort), cursor),
    project: (projection) => ((options.projection = projection), cursor),
    limit: (limit) => ((options.limit = limit), cursor),
    skip: (skip) => ((options.skip = skip), cursor),
    toArray: () => collection.find(filter, options),
  };
  return cursor;
}

/** The driver-like facade of one raw collection. */
export function toRawCollection<T extends PgRecord>(collection: PgCollection<T>): RawCollection<T> {
  return {
    collectionName: collection.name,
    find: (filter = {}, options = {}) => cursorOf(collection, filter, options),
    findOne: (filter = {}, options = {}) => collection.findOne(filter, options),
    countDocuments: (filter = {}) => collection.count(filter),
    insertOne: async (document) => {
      const record = await collection.insertOne(document);
      return { acknowledged: true, insertedId: String(record._id) };
    },
    insertMany: async (documents, options = {}) => {
      const records = await collection.insertMany(documents, options);
      const insertedIds: Record<number, string> = {};
      records.forEach((record, index) => (insertedIds[index] = String(record._id)));
      return { acknowledged: true, insertedCount: records.length, insertedIds };
    },
    updateOne: (filter, update, options = {}) => collection.updateOne(filter, update, options),
    updateMany: (filter, update, options = {}) => collection.updateMany(filter, update, options),
    deleteOne: (filter = {}) => collection.deleteOne(filter),
    deleteMany: (filter = {}) => collection.deleteMany(filter),
  };
}

/** The raw facade over a PostgreSQL database (see the module header). */
export function createRawDatabase(options: RawDatabaseOptions = {}): RawDatabase {
  let owned: PostgresKysely | undefined;
  let db = options.db;
  if (!db) {
    const pool =
      options.pool ??
      createPostgresPool(readPostgresConnectionSettings(options.env ?? process.env));
    db = new Kysely<PostgresTables>({ dialect: new PostgresDialect({ pool }) });
    if (!options.pool) {
      owned = db;
    }
  }
  const descriptor = options.descriptor ?? SCHEMA_DESCRIPTOR;
  const collections = createPgCollections({ db, descriptor, engine: null });
  const facades = new Map<string, RawCollection>();
  const executor = db;
  return {
    collection: <T extends PgRecord>(name: string) => {
      let facade = facades.get(name);
      if (!facade) {
        facade = toRawCollection(collections.raw(name));
        facades.set(name, facade);
      }
      return facade as unknown as RawCollection<T>;
    },
    truncateAll: async () => {
      const roots = collections.tables.roots.map((table) => quoteIdentifier(table.descriptor.name));
      if (roots.length > 0) {
        await createSqlRunner(executor).query(`TRUNCATE ${roots.join(', ')} CASCADE`);
      }
    },
    close: async () => {
      await owned?.destroy();
    },
  };
}

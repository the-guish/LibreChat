/**
 * The types of the collection primitive's API (`PgCollection`; docs/postgres-port/PHASE4.md §3).
 * Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { UpdateCastEngine } from '../records/cast';
import type { StoreTransaction } from '~/ports/common';

/** A record as the primitive reads and writes it: ids as 24-hex strings, dates as `Date`. */
export type PgRecord = Record<string, unknown>;

/**
 * A filter: the query language of `ports/query.ts` plus what the translator accepts beyond it
 * (`$eq`, `$nor`, `$size`, equality with an array, numeric path segments; C2's `$elemMatch`,
 * `$all`, `$not`, `$type` and bit tests). Values are cast to the
 * declared types first (`'5'` on a Number path is `5`, a 24-hex string on an id path an id). A path
 * the schema does not declare is refused (`StoreQueryError`, R9).
 */
export type PgFilter = Readonly<Record<string, unknown>>;

/**
 * An update: plain paths (meaning `$set`) and the operators `$set`, `$unset`, `$inc`, `$min`,
 * `$max`, `$push` (with `$each` and `$slice`), `$addToSet` (with `$each`), `$pull` (a value, an
 * operator condition, a regular expression, or a condition on the elements of a subdocument
 * array), `$pullAll`, `$setOnInsert` and `$currentDate`, on plain and positional paths (`a.$`,
 * `a.$[]`, `a.$[x]` with `arrayFilters`, `a.0`). Refused with a `StoreQueryError`: `$mul`,
 * `$pop`, `$rename`, `$bit`, `$push`'s `$position` and `$sort` (no store method uses them), and
 * update pipelines.
 */
export type PgUpdate = Readonly<Record<string, unknown>>;

/** A projection, as the query language spells it (`'a b'`, `'-a'`, `'+hidden'`, `{ a: 1 }`). */
export type PgProjection = string | Readonly<Record<string, 0 | 1 | boolean>>;

/** A sort: paths with `1` (ascending) or `-1` (descending), most significant first. */
export type PgSort = Readonly<Record<string, 1 | -1>>;

/** Options every operation takes. */
export interface PgOperationOptions {
  /**
   * The transaction to run in (`DataStore.transactions.transaction`'s handle); the operation runs
   * on its own connection otherwise. Operations that need several statements open their own
   * transaction, or a savepoint inside the given one.
   */
  tx?: StoreTransaction;
}

/** Options of `find`. */
export interface PgFindOptions extends PgOperationOptions {
  projection?: PgProjection;
  /** Default: `_id` ascending (insertion order for generated ids), so reads are deterministic. */
  sort?: PgSort;
  /** At most this many records (`0` or less: no limit). */
  limit?: number;
  /** Skip this many records first. */
  skip?: number;
}

/** Options of `findOne`. */
export type PgFindOneOptions = Omit<PgFindOptions, 'limit'>;

/** Options of `count`. */
export interface PgCountOptions extends PgOperationOptions {
  limit?: number;
  skip?: number;
}

/** Options of `insertOne` and `insertMany`. */
export interface PgInsertOptions extends PgOperationOptions {
  /** Run the schema's validators (default true, as `Model.create`). */
  validate?: boolean;
  /** Set `createdAt`/`updatedAt` per the schema (default true; `false` as mongoose's option). */
  timestamps?: boolean;
}

/** Options of `insertMany`. */
export interface PgInsertManyOptions extends PgInsertOptions {
  /**
   * `true` (default): stop at the first duplicate key, keeping the records before it, as
   * MongoDB's ordered insert; `false`: insert every other record.
   */
  ordered?: boolean;
}

/** Options of the updates. */
export interface PgUpdateOptions extends PgOperationOptions {
  /** Insert a record when none matches (§3.4). */
  upsert?: boolean;
  /** Set `updatedAt` (and `createdAt` on an upsert insert) per the schema (default true). */
  timestamps?: boolean;
  /** Validate the updated paths of the post-image (mongoose's `runValidators`). */
  runValidators?: boolean;
  /** Which record a single-record update takes first. */
  sort?: PgSort;
  /**
   * Skip rows another transaction holds locked (`FOR UPDATE SKIP LOCKED`), for queue claims:
   * concurrent claims then take distinct rows without waiting. Single-record updates only.
   */
  skipLocked?: boolean;
  /**
   * The filters of the update's `$[<identifier>]` paths (MongoDB's `arrayFilters`): one per
   * identifier, its paths starting with the identifier (`{ 'held.id': id }`), cast to the
   * elements' types.
   */
  arrayFilters?: ReadonlyArray<Record<string, unknown>>;
}

/** Options of `findOneAndUpdate`. */
export interface PgFindOneAndUpdateOptions extends PgUpdateOptions {
  /** The record before the update (default, as mongoose's `new: false`) or after it. */
  returnDocument?: 'before' | 'after';
  projection?: PgProjection;
}

/** Options of `findOneAndDelete`. */
export interface PgFindOneAndDeleteOptions extends PgOperationOptions {
  sort?: PgSort;
  projection?: PgProjection;
}

/** Options of `deleteOne`. */
export interface PgDeleteOptions extends PgOperationOptions {
  sort?: PgSort;
}

/** What an update did (the neutral shape of MongoDB's `UpdateResult`). */
export interface PgUpdateResult {
  acknowledged: true;
  /** Records the filter matched (at most 1 for single-record updates). */
  matchedCount: number;
  /** Matched records whose stored content changed (`updatedAt` counts). */
  modifiedCount: number;
  /** 1 when an upsert inserted a record. */
  upsertedCount: number;
  /** The `_id` an upsert inserted, `null` otherwise. */
  upsertedId: string | null;
}

/** What a delete did. */
export interface PgDeleteResult {
  acknowledged: true;
  deletedCount: number;
}

/** An update of `bulk`. */
export interface PgBulkUpdate {
  filter: PgFilter;
  update: PgUpdate;
  upsert?: boolean;
  arrayFilters?: ReadonlyArray<Record<string, unknown>>;
}

/** One operation of `bulk`. */
export type PgBulkOperation =
  | { insertOne: { document: PgRecord } }
  | { updateOne: PgBulkUpdate }
  | { updateMany: PgBulkUpdate }
  | { deleteOne: { filter: PgFilter } }
  | { deleteMany: { filter: PgFilter } };

/** Options of `bulk`. */
export interface PgBulkOptions extends PgOperationOptions {
  /** `true` (default): stop at the first failing operation; `false`: run every operation. */
  ordered?: boolean;
  /** As for the single operations (default true). */
  timestamps?: boolean;
}

/** What `bulk` did (the neutral shape of MongoDB's `BulkWriteResult`). */
export interface PgBulkResult {
  insertedCount: number;
  matchedCount: number;
  modifiedCount: number;
  deletedCount: number;
  upsertedCount: number;
  /** Operation index → the `_id` inserted. */
  insertedIds: Record<number, string>;
  /** Operation index → the `_id` an upsert inserted. */
  upsertedIds: Record<number, string>;
}

/** One failed write of `insertMany` or `bulk`. */
export interface PgWriteError {
  /** The index of the record or operation. */
  index: number;
  error: unknown;
}

/**
 * Properties `insertMany` and `bulk` attach to the error they reject with (the first failure, so a
 * duplicate key is still a `StoreDuplicateKeyError` that `isDuplicateKeyError` recognizes): every
 * failed write, and what was written.
 */
export interface PgWriteErrorDetails {
  writeErrors: PgWriteError[];
  /** `insertMany`: the `_id`s inserted, by input index. */
  insertedIds?: Record<number, string>;
  /** `bulk`: the counts of the writes that went through. */
  result?: PgBulkResult;
}

/**
 * What the primitive needs from the schema engine (`schema/engine.ts`, D2), which implements it:
 * documents built and validated by mongoose without a connection, update values cast by mongoose's
 * update casting, immutable paths, and the tenant plugin's presence. Without an engine (hand-made
 * tables in specs, raw mode) documents are cast by the descriptor caster, without defaults or
 * validators.
 */
export interface PgDocumentEngine extends UpdateCastEngine {
  hasCollection(collection: string): boolean;
  buildDocument(
    collection: string,
    input: Readonly<Record<string, unknown>>,
    options?: { validate?: boolean },
  ): Promise<Record<string, unknown>>;
  validatePaths(
    collection: string,
    record: Readonly<Record<string, unknown>>,
    paths: readonly string[],
    context?: unknown,
  ): Promise<void>;
  isTenantScoped?(collection: string): boolean;
}

/**
 * The lean-subset API of one collection over its typed tables (docs/postgres-port/PHASE4.md §3).
 * Records come back as lean MongoDB reads return them, with ids as 24-hex strings (R7).
 */
export interface PgCollection<T extends PgRecord = PgRecord> {
  /** The collection's name (its table's). */
  readonly name: string;
  /** Whether the collection runs in raw mode (see `PgCollections.raw`). */
  readonly raw: boolean;

  find(filter?: PgFilter, options?: PgFindOptions): Promise<T[]>;
  findOne(filter?: PgFilter, options?: PgFindOneOptions): Promise<T | null>;
  count(filter?: PgFilter, options?: PgCountOptions): Promise<number>;
  /** The `_id` of one matching record, or `null` (mongoose's `exists`). */
  exists(filter?: PgFilter, options?: PgOperationOptions): Promise<{ _id: string } | null>;
  /**
   * The distinct values at `path` among the matching records, as MongoDB's `distinct`: array
   * values contribute their elements, an explicit `null` contributes `null`, a missing path
   * nothing; sorted in MongoDB's order.
   */
  distinct(path: string, filter?: PgFilter, options?: PgOperationOptions): Promise<unknown[]>;

  /** Inserts one record; returns it as stored (defaults, `_id`, timestamps and `__v` set). */
  insertOne(document: PgRecord, options?: PgInsertOptions): Promise<T>;
  /** Inserts records; returns them as stored. See {@link PgInsertManyOptions.ordered}. */
  insertMany(documents: readonly PgRecord[], options?: PgInsertManyOptions): Promise<T[]>;

  updateOne(filter: PgFilter, update: PgUpdate, options?: PgUpdateOptions): Promise<PgUpdateResult>;
  updateMany(
    filter: PgFilter,
    update: PgUpdate,
    options?: Omit<PgUpdateOptions, 'sort' | 'skipLocked'>,
  ): Promise<PgUpdateResult>;
  /** Updates the first matching record (by `sort`) and returns it before or after the update. */
  findOneAndUpdate(
    filter: PgFilter,
    update: PgUpdate,
    options?: PgFindOneAndUpdateOptions,
  ): Promise<T | null>;

  findOneAndDelete(filter: PgFilter, options?: PgFindOneAndDeleteOptions): Promise<T | null>;
  deleteOne(filter: PgFilter, options?: PgDeleteOptions): Promise<PgDeleteResult>;
  deleteMany(filter: PgFilter, options?: PgOperationOptions): Promise<PgDeleteResult>;

  /** Several writes in one transaction, each in a savepoint (MongoDB's `bulkWrite` semantics). */
  bulk(operations: readonly PgBulkOperation[], options?: PgBulkOptions): Promise<PgBulkResult>;
}

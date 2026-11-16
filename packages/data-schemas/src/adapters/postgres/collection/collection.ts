/**
 * The collection primitive (docs/postgres-port/PHASE4.md §3): `PgCollection`, the lean-subset API
 * of one collection over its typed tables, which the store adapters (S units) build on. Must not
 * import `mongoose`, `mongodb` or `bson` (the schema engine, which does, is handed in).
 *
 * Reads (§3.1): one statement through the query translator (Q1): filter, projection pushed down to
 * columns and child subselects, sort, paging; records assembled by R1's codec.
 *
 * Inserts (§3.2): document mode builds the record with the schema engine (D2: casting, defaults,
 * setters, validators, subdocument ids), then sets `_id`, timestamps and `__v`, runs the hooks, and
 * inserts the parent and child rows; `insertMany` is one multi-row `INSERT ... ON CONFLICT DO
 * NOTHING` per batch in a transaction, the skipped rows becoming duplicate-key errors (ordered: the
 * rows after the first skipped one are removed before commit, as MongoDB's ordered insert keeps
 * only the prefix).
 *
 * Updates (§3.3, §3.5): the update goes through the tenant guard, the hooks, the timestamps and the
 * descriptor caster, then:
 * - tier 1 (`updates.ts`) compiles parent-row changes to one `SET` list. With a parent-only filter
 *   a single statement locks and writes:
 *   `UPDATE t SET ... FROM (SELECT * FROM t WHERE <filter> ORDER BY <sort> LIMIT 1 FOR UPDATE
 *   [SKIP LOCKED]) old WHERE t._id = old._id RETURNING ...` (READ COMMITTED rechecks the parent
 *   conditions; `old` is the pre-image); an empty claim while a match exists is retried;
 * - a filter reading child tables locks the candidates first (`SELECT _id ... FOR UPDATE`), then
 *   re-evaluates the whole filter in a new statement (which sees child rows committed while it
 *   waited) and writes only rows that still match; a single-record update moves to the next
 *   candidate;
 * - tier 2 (everything else: child and element tables, `json` subpaths, `runValidators`) locks the
 *   rows, reads them in the next statement, computes the post-image with the evaluator
 *   (`evaluate.ts`), validates it when asked, and writes the changed columns and child tables.
 * - With `POSTGRES_UPDATE_SHADOW_CHECK=true` (every PostgreSQL spec but the concurrency ones), a
 *   tier-1 update runs on the locked, re-read pre-image, and its result must equal the evaluator's
 *   post-image (row by row), or the update fails.
 * Upserts (§3.4): the update first; when nothing matched, the record built from the filter's
 * equality seed, the update (with `$setOnInsert`, `createdAt`, `__v: 0`) and the engine's defaults
 * is inserted; a duplicate key retries the update once.
 *
 * Deletes (§3.7) cascade to child tables; filters reading child tables lock and re-evaluate first.
 *
 * Every SQLSTATE 23505 becomes a `StoreDuplicateKeyError` naming the violated key's fields
 * (`constraints.ts`) with the written record's values.
 */
import type {
  PgSort,
  PgFilter,
  PgRecord,
  PgUpdate,
  PgCollection,
  PgBulkResult,
  PgWriteError,
  PgProjection,
  PgUpdateResult,
  PgDocumentEngine,
  PgUpdateOptions,
  PgBulkOperation,
  PgWriteErrorDetails,
} from './types';
import type { RecordProjection, RecordSelect } from '../records/assemble';
import type { RecordTable, RecordTables } from '../records/tables';
import type { DecomposedRecord } from '../records/decompose';
import type { SchemaDescriptor } from '../schema/descriptor';
import type { StoreTransaction } from '~/ports/common';
import type { StoreFilter } from '~/ports/query';
import type { QueryTranslator } from '../query';
import type { SqlFragment } from '../query/sql';
import type { PostgresKysely } from '../types';
import type { CollectionHooks } from './hooks';
import type { SqlRunner } from './runner';
import {
  fullProjection,
  distinctValues,
  uniqueSorted,
  changedColumns,
  changedChildTables,
  filterReadsChildren,
} from './support';
import { decomposeRecord, insertRowsStatements, insertStatements } from '../records/decompose';
import { scopeTenantFilter, scopeTenantUpdate, stampTenant } from './tenant';
import { toStoreDuplicateKeyError, isUniqueViolation } from '../storeErrors';
import { canonicalizeValue, createRecordCaster } from '../records/cast';
import { storeFilterInsertSeed, StoreQueryError } from '~/ports/query';
import { compileQuerySql, createQueryTranslator } from '../query';
import { selectRecord, readChildRows } from '../records/assemble';
import { checkUpdate, planTier1, updatedPaths } from './updates';
import { resolvePostgresExecutor } from '../storeTransactions';
import { descriptorUniqueConstraints } from './constraints';
import { arrayColumnType, param, sql } from '../query/sql';
import { indexRecordTables } from '../records/tables';
import { generatePostgresStoreId } from '../storeIds';
import { DEFAULT_COLLECTION_HOOKS } from './hooks';
import { applyCollectionUpdate } from './evaluate';
import { isPlainRecord } from '../records/extra';
import { createSqlRunner } from './runner';

/** Options of {@link createPgCollections}. */
export interface PgCollectionsOptions {
  /** The Kysely instance, or a getter (a backend's handle exists only once connected). */
  db: PostgresKysely | (() => PostgresKysely);
  /** The schema descriptor (or its lookups): `SCHEMA_DESCRIPTOR` for the production tables. */
  descriptor: SchemaDescriptor | RecordTables;
  /**
   * The schema engine (`getSchemaEngine()` for the production tables). `null`: documents and
   * update values are cast by the descriptor caster only (no defaults, validators or setters
   * beyond the descriptor's string transforms).
   */
  engine: PgDocumentEngine | null;
  /** The collection hooks, by collection (default {@link DEFAULT_COLLECTION_HOOKS}). */
  hooks?: Readonly<Record<string, CollectionHooks>>;
  /** Which collections bind the tenant policy (default: the engine's `isTenantScoped`). */
  tenantScoped?: (collection: string) => boolean;
  /** Unique constraint name → fields (default: the descriptor's, `constraints.ts`). */
  uniqueConstraints?: ReadonlyMap<string, ReadonlyArray<string>>;
  /** The clock of timestamps (default `new Date()`). */
  now?: () => Date;
  /**
   * Check every tier-1 update against the evaluator (default: `POSTGRES_UPDATE_SHADOW_CHECK` is
   * `true`, read at each update).
   */
  shadowCheck?: boolean;
}

/** The collections of one schema descriptor. */
export interface PgCollections {
  readonly tables: RecordTables;
  readonly translator: QueryTranslator;
  /** The collection in document mode: engine, hooks, tenant policy, timestamps. */
  collection<T extends PgRecord = PgRecord>(name: string): PgCollection<T>;
  /**
   * The collection in raw mode (the e2e facade, contract `seedRaw`, the copy tool): no engine,
   * hooks, tenant policy, timestamps or `__v`; inserted values are cast by the descriptor without
   * defaults, and undeclared or uncastable ones go to `_extra` (D7); updates keep undeclared paths
   * (in `_extra`); reads return hidden paths too, as a driver read does.
   */
  raw<T extends PgRecord = PgRecord>(name: string): PgCollection<T>;
}

/** Raised by the shadow check when tier 1 and the evaluator disagree. */
export class UpdateShadowCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateShadowCheckError';
  }
}

const ALIAS = 't';
const OLD = 'lc_old';
/** Retries of an empty single-record claim while a matching record exists (§3.5). */
const CLAIM_RETRIES = 5;

interface UpdateCall {
  filter: PgFilter;
  update: PgUpdate;
  options: PgUpdateOptions;
  many: boolean;
  returning?: { when: 'before' | 'after'; projection?: PgProjection };
}

interface UpdateOutcome {
  matched: number;
  modified: number;
  upsertedId: string | null;
  record: PgRecord | null;
}

/** A prepared update: the cast filter and update, and how to run them. */
interface PreparedUpdate {
  filter: PgRecord;
  update: PgRecord;
  childFilter: boolean;
  where: SqlFragment;
}

/** Creates the collections of `options.descriptor` on `options.db`. */
export function createPgCollections(options: PgCollectionsOptions): PgCollections {
  const tables =
    'roots' in options.descriptor ? options.descriptor : indexRecordTables(options.descriptor);
  const engine = options.engine ?? null;
  const caster = createRecordCaster(tables, engine ? { engine } : {});
  const translator = createQueryTranslator(tables, { caster });
  const hooks = options.hooks ?? DEFAULT_COLLECTION_HOOKS;
  const constraints = options.uniqueConstraints ?? descriptorUniqueConstraints(tables.descriptor);
  const tenantScoped =
    options.tenantScoped ?? ((collection: string) => engine?.isTenantScoped?.(collection) ?? false);
  const now = options.now ?? (() => new Date());
  const getDb = typeof options.db === 'function' ? options.db : () => options.db as PostgresKysely;
  const shadowCheck = () =>
    options.shadowCheck ?? process.env.POSTGRES_UPDATE_SHADOW_CHECK === 'true';

  const shared: Shared = {
    tables,
    engine,
    caster,
    translator,
    hooks,
    constraints,
    tenantScoped,
    now,
    shadowCheck,
    runnerFor: (tx) => createSqlRunner(resolvePostgresExecutor(getDb(), tx)),
  };
  const cache = new Map<string, PgCollection>();
  const get = (name: string, raw: boolean): PgCollection => {
    const key = `${raw ? 'raw' : 'doc'}:${name}`;
    let collection = cache.get(key);
    if (!collection) {
      collection = createCollection(shared, name, raw);
      cache.set(key, collection);
    }
    return collection;
  };
  return {
    tables,
    translator,
    collection: <T extends PgRecord>(name: string) => get(name, false) as PgCollection<T>,
    raw: <T extends PgRecord>(name: string) => get(name, true) as PgCollection<T>,
  };
}

interface Shared {
  tables: RecordTables;
  engine: PgDocumentEngine | null;
  caster: ReturnType<typeof createRecordCaster>;
  translator: QueryTranslator;
  hooks: Readonly<Record<string, CollectionHooks>>;
  constraints: ReadonlyMap<string, ReadonlyArray<string>>;
  tenantScoped: (collection: string) => boolean;
  now: () => Date;
  shadowCheck: () => boolean;
  runnerFor: (tx: StoreTransaction | undefined) => SqlRunner;
}

/** Attaches `insertMany`/`bulk` details to the error they reject with. */
function withDetails(error: unknown, details: PgWriteErrorDetails): unknown {
  if (typeof error === 'object' && error !== null) {
    Object.assign(error, details);
  }
  return error;
}

function createCollection(shared: Shared, name: string, raw: boolean): PgCollection {
  const { tables, translator, caster, engine } = shared;
  const table: RecordTable = tables.collection(name);
  const descriptor = table.descriptor;
  const quotedTable = sql.id(descriptor.name);
  const hooks: CollectionHooks = raw ? {} : (shared.hooks[name] ?? {});
  const scoped = !raw && shared.tenantScoped(name);
  const keyColumns = descriptor.primaryKey;
  const keyColumn = keyColumns[0];
  const hasId = descriptor.idType !== undefined;
  const idType = (column: string) => arrayColumnType(table.columns.get(column)!);
  const full = fullProjection(tables, table);
  const engineFor = engine && engine.hasCollection(name) ? engine : null;

  /* ---- shared pieces ---- */

  const scopeFilter = (filter: PgFilter): PgFilter =>
    scoped ? scopeTenantFilter('Query', filter) : filter;

  const castFilter = (filter: PgFilter): PgRecord =>
    caster.castFilter(name, filter as PgRecord) as PgRecord;

  const whereOf = (cast: PgRecord): SqlFragment =>
    translator.filter(name, cast, { alias: ALIAS, cast: false });

  const orderBy = (sort: PgSort | undefined, alias = ALIAS): SqlFragment => {
    const items = translator.sort(name, (sort ?? (hasId ? { _id: 1 } : undefined)) as never, {
      alias,
    });
    return items.length > 0 ? sql` ORDER BY ${sql.join(items, sql`, `)}` : sql``;
  };

  const keyJoin = (left: string, right: string): SqlFragment =>
    sql.join(
      keyColumns.map((column) => sql`${sql.id(left, column)} = ${sql.id(right, column)}`),
      sql` AND `,
    );

  /** The read of `projection` (raw mode reads every hidden path when none is given). */
  const projectionOf = (
    projection: PgProjection | undefined,
  ): { record: RecordProjection; apply?: (record: PgRecord) => PgRecord } => {
    if (projection === undefined && raw) {
      return { record: full };
    }
    return translator.projection(name, projection);
  };

  const decodeRows = async (
    runner: SqlRunner,
    select: RecordSelect,
    rows: ReadonlyArray<Record<string, unknown>>,
    apply?: (record: PgRecord) => PgRecord,
  ): Promise<PgRecord[]> => {
    const batch =
      select.mode === 'batched' && select.children.length > 0
        ? await readChildRows(
            runner,
            select,
            rows.map((row) => row[keyColumn] as string),
          )
        : undefined;
    return rows.map((row) => {
      const record = select.decode(row, batch);
      return apply ? apply(record) : record;
    });
  };

  /** Reads records by key, with `projection`, in the order of `ids`; `where` rechecks the filter. */
  const readByIds = async (
    runner: SqlRunner,
    ids: readonly string[],
    projection: { record: RecordProjection; apply?: (record: PgRecord) => PgRecord },
    where?: SqlFragment,
  ): Promise<PgRecord[]> => {
    if (ids.length === 0) {
      return [];
    }
    const select = selectRecord(tables, name, {
      alias: ALIAS,
      projection: projection.record,
      children: 'subselect',
    });
    const statement = compileQuerySql(
      sql`SELECT ${sql.raw(select.sql)} FROM ${quotedTable} AS ${sql.id(ALIAS)} WHERE ${sql.id(
        ALIAS,
        keyColumn,
      )} = ANY (${param(ids, `${idType(keyColumn)}[]`)})${where ? sql` AND ${where}` : sql``}`,
    );
    const { rows } = await runner.run(statement);
    const byId = new Map(rows.map((row) => [row[keyColumn] as string, row]));
    const records: PgRecord[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row) {
        const record = select.decode(row);
        records.push(projection.apply ? projection.apply(record) : record);
      }
    }
    return records;
  };

  /**
   * Locks the candidates of `where` (`SELECT key ... FOR UPDATE`), first by `sort`; `limit` 1 for
   * single-record operations. Keys in `exclude` (rejected by a recheck) are skipped.
   */
  const lockIds = async (
    runner: SqlRunner,
    where: SqlFragment,
    options: { sort?: PgSort; limit?: number; skipLocked?: boolean; exclude?: readonly string[] },
  ): Promise<string[]> => {
    const exclude =
      options.exclude && options.exclude.length > 0
        ? sql` AND NOT (${sql.id(ALIAS, keyColumn)} = ANY (${param(
            options.exclude,
            `${idType(keyColumn)}[]`,
          )}))`
        : sql``;
    const statement = compileQuerySql(
      sql`SELECT ${sql.id(ALIAS, keyColumn)} AS "lc_key" FROM ${quotedTable} AS ${sql.id(
        ALIAS,
      )} WHERE ${where}${exclude}${orderBy(options.sort)}${
        options.limit ? sql` LIMIT ${sql.lit(options.limit)}` : sql``
      } FOR UPDATE${options.skipLocked ? sql` SKIP LOCKED` : sql``}`,
    );
    const { rows } = await runner.run<{ lc_key: string }>(statement);
    return rows.map((row) => row.lc_key);
  };

  const existsWhere = async (runner: SqlRunner, where: SqlFragment): Promise<boolean> => {
    const { rows } = await runner.run(
      compileQuerySql(
        sql`SELECT EXISTS (SELECT 1 FROM ${quotedTable} AS ${sql.id(ALIAS)} WHERE ${where}) AS "found"`,
      ),
    );
    return rows[0]?.found === true;
  };

  const duplicate = (error: unknown, record?: PgRecord): unknown =>
    isUniqueViolation(error) ? toStoreDuplicateKeyError(error, shared.constraints, record) : error;

  /* ---- reads ---- */

  async function find(filter: PgFilter = {}, options: Parameters<PgCollection['find']>[1] = {}) {
    const runner = shared.runnerFor(options.tx);
    const where = whereOf(castFilter(scopeFilter(filter)));
    const projection = projectionOf(options.projection);
    const select = selectRecord(tables, name, {
      alias: ALIAS,
      projection: projection.record,
      children: 'subselect',
    });
    const statement = compileQuerySql(
      sql`SELECT ${sql.raw(select.sql)} FROM ${quotedTable} AS ${sql.id(
        ALIAS,
      )} WHERE ${where}${orderBy(options.sort)}${translator.paging({
        limit: options.limit,
        offset: options.skip,
      })}`,
    );
    const { rows } = await runner.run(statement);
    return decodeRows(runner, select, rows, projection.apply);
  }

  async function findOne(
    filter: PgFilter = {},
    options: Parameters<PgCollection['findOne']>[1] = {},
  ) {
    const [record] = await find(filter, { ...options, limit: 1 });
    return record ?? null;
  }

  async function count(filter: PgFilter = {}, options: Parameters<PgCollection['count']>[1] = {}) {
    const runner = shared.runnerFor(options.tx);
    const where = whereOf(castFilter(scopeFilter(filter)));
    const paging = translator.paging({ limit: options.limit, offset: options.skip });
    const { rows } = await runner.run<{ n: string | number }>(
      compileQuerySql(
        sql`SELECT count(*) AS "n" FROM (SELECT 1 FROM ${quotedTable} AS ${sql.id(
          ALIAS,
        )} WHERE ${where}${paging}) AS "lc_rows"`,
      ),
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function exists(filter: PgFilter = {}, options: { tx?: StoreTransaction } = {}) {
    const runner = shared.runnerFor(options.tx);
    const where = whereOf(castFilter(scopeFilter(filter)));
    const { rows } = await runner.run<{ lc_key: string }>(
      compileQuerySql(
        sql`SELECT ${sql.id(ALIAS, keyColumn)} AS "lc_key" FROM ${quotedTable} AS ${sql.id(
          ALIAS,
        )} WHERE ${where} LIMIT 1`,
      ),
    );
    return rows.length > 0 ? { _id: rows[0].lc_key } : null;
  }

  async function distinct(
    path: string,
    filter: PgFilter = {},
    options: { tx?: StoreTransaction } = {},
  ) {
    const runner = shared.runnerFor(options.tx);
    const where = whereOf(castFilter(scopeFilter(filter)));
    const resolved = caster.resolve(name, path);
    const field = resolved.node.kind === 'field' ? resolved.node.field : undefined;
    if (
      resolved.hops.length === 0 &&
      field &&
      (field.kind === 'scalar' || field.kind === 'array')
    ) {
      const column = sql.id(ALIAS, field.column);
      const columnDescriptor = table.columns.get(field.column)!;
      const ids = columnDescriptor.type === 'objectId';
      const statement =
        field.kind === 'scalar'
          ? sql`SELECT DISTINCT ${ids ? sql`${column}::text` : column} AS "v" FROM ${quotedTable} AS ${sql.id(
              ALIAS,
            )} WHERE ${where} AND (${column} IS NOT NULL${
              table.systemColumns
                ? sql` OR ${sql.lit(field.path)} = ANY (${sql.id(ALIAS, '_nulls')})`
                : sql``
            })`
          : sql`SELECT DISTINCT ${ids ? sql`"u"."e"::text` : sql`"u"."e"`} AS "v" FROM ${quotedTable} AS ${sql.id(
              ALIAS,
            )} CROSS JOIN LATERAL unnest(${column}) AS "u" ("e") WHERE ${where}`;
      const { rows } = await runner.run<{ v: unknown }>(compileQuerySql(statement));
      return uniqueSorted(
        rows.map((row) =>
          columnDescriptor.type === 'date' && row.v !== null ? new Date(row.v as string) : row.v,
        ),
      );
    }
    const records = await find(filter, { tx: options.tx, projection: { [path]: 1 } });
    return uniqueSorted(records.flatMap((record) => distinctValues(record, path)));
  }

  /* ---- inserts ---- */

  /** The record an insert stores (document or raw mode). */
  async function buildInsert(
    document: PgRecord,
    options: { validate?: boolean; timestamps?: boolean },
    operation: string,
  ): Promise<PgRecord> {
    if (!isPlainRecord(document)) {
      throw new StoreQueryError(`A ${name} document must be an object`);
    }
    if (raw) {
      const record = { ...document };
      if (descriptor.idType === 'objectId' && (record._id === undefined || record._id === null)) {
        record._id = generatePostgresStoreId();
      }
      return record;
    }
    let input: PgRecord = { ...document };
    if (scoped) {
      stampTenant(operation, input);
    }
    if (hooks.beforeBuild) {
      input = hooks.beforeBuild(input);
    }
    let record: PgRecord;
    if (engineFor) {
      record = canonicalizeValue(
        await engineFor.buildDocument(name, input, { validate: options.validate !== false }),
      ) as PgRecord;
    } else {
      const cast = caster.castUpdate(name, { $set: input }, { undeclared: 'strip' }) as PgRecord;
      record = { ...((cast.$set as PgRecord | undefined) ?? {}) };
    }
    if (descriptor.idType === 'objectId' && (record._id === undefined || record._id === null)) {
      record = { _id: generatePostgresStoreId(), ...record };
    }
    hooks.beforeInsert?.(record);
    const timestamps = descriptor.timestamps;
    if (timestamps && options.timestamps !== false) {
      const at = shared.now();
      if (timestamps.createdAt && !record[timestamps.createdAt]) {
        record[timestamps.createdAt] = at;
      }
      if (timestamps.updatedAt) {
        if (operation === 'insertMany') {
          record[timestamps.updatedAt] ??= at;
        } else {
          record[timestamps.updatedAt] = timestamps.createdAt ? record[timestamps.createdAt] : at;
        }
      }
    }
    if (descriptor.versionKey && record[descriptor.versionKey] === undefined) {
      record[descriptor.versionKey] = 0;
    }
    return record;
  }

  const decompose = (record: PgRecord): DecomposedRecord =>
    decomposeRecord(tables, name, record, raw ? { mode: 'raw' } : {});

  const writeStatements = async (runner: SqlRunner, record: DecomposedRecord) => {
    const statements = insertStatements(tables, [record]);
    if (statements.length === 1) {
      await runner.run(statements[0]);
      return;
    }
    await runner.atomic(async (inner) => {
      for (const statement of statements) {
        await inner.run(statement);
      }
    });
  };

  async function insertOne(
    document: PgRecord,
    options: Parameters<PgCollection['insertOne']>[1] = {},
  ) {
    const runner = shared.runnerFor(options.tx);
    return insertOneOn(runner, document, options);
  }

  async function insertOneOn(
    runner: SqlRunner,
    document: PgRecord,
    options: { validate?: boolean; timestamps?: boolean },
  ): Promise<PgRecord> {
    const record = await buildInsert(document, options, 'Save');
    const decomposed = decompose(record);
    try {
      await writeStatements(runner, decomposed);
    } catch (error) {
      throw duplicate(error, record);
    }
    return record;
  }

  async function insertMany(
    documents: readonly PgRecord[],
    options: Parameters<PgCollection['insertMany']>[1] = {},
  ) {
    hooks.beforeInsertMany?.();
    const runner = shared.runnerFor(options.tx);
    const ordered = options.ordered !== false;
    const records: PgRecord[] = [];
    for (const document of documents) {
      records.push(await buildInsert(document, options, 'insertMany'));
    }
    if (records.length === 0) {
      return [];
    }
    const decomposed = records.map(decompose);
    const inserted = new Set<number>();
    const writeErrors: PgWriteError[] = [];

    await runner.atomic(async (tx) => {
      let pending: number[] = records.map((_, index) => index);
      if (hasId) {
        /** One multi-row insert of the parents; conflicting rows are skipped, not failed. */
        const keys = new Map<string, number>();
        decomposed.forEach((record, index) => keys.set(record.id as string, index));
        const statements = insertRowsStatements(
          tables,
          descriptor.name,
          decomposed.map((record) => record.row),
        );
        for (const statement of statements) {
          const { rows } = await tx.query<{ _id: string }>(
            `${statement.text} ON CONFLICT DO NOTHING RETURNING "_id"`,
            statement.values,
          );
          rows.forEach((row) => inserted.add(keys.get(row._id) as number));
        }
        const skipped = pending.filter((index) => !inserted.has(index));
        if (ordered && skipped.length > 0) {
          const first = skipped[0];
          const after = [...inserted].filter((index) => index > first);
          if (after.length > 0) {
            await tx.run(
              compileQuerySql(
                sql`DELETE FROM ${quotedTable} WHERE "_id" = ANY (${param(
                  after.map((index) => decomposed[index].id),
                  `${idType('_id')}[]`,
                )})`,
              ),
            );
            after.forEach((index) => inserted.delete(index));
          }
          pending = pending.filter((index) => index >= first);
        } else {
          pending = skipped;
        }
        const children = decomposed
          .filter((_, index) => inserted.has(index))
          .flatMap((record) => record.children);
        const byTable = new Map<string, Array<Record<string, unknown>>>();
        for (const child of children) {
          byTable.set(child.table, [...(byTable.get(child.table) ?? []), ...child.rows]);
        }
        for (const [childTable, rows] of byTable) {
          for (const statement of insertRowsStatements(tables, childTable, rows)) {
            await tx.run(statement);
          }
        }
      }
      /** The skipped rows (and every row of a table without `_id`), one at a time. */
      for (const index of pending) {
        if (inserted.has(index)) {
          continue;
        }
        try {
          await tx.atomic((inner) => writeStatements(inner, decomposed[index]));
          inserted.add(index);
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          writeErrors.push({ index, error: duplicate(error, records[index]) });
          if (ordered) {
            break;
          }
        }
      }
    });

    if (writeErrors.length > 0) {
      const insertedIds: Record<number, string> = {};
      for (const index of inserted) {
        insertedIds[index] = String(records[index][keyColumn]);
      }
      throw withDetails(writeErrors[0].error, { writeErrors, insertedIds });
    }
    return records;
  }

  /* ---- updates ---- */

  /** Applies mongoose's timestamp rules to an update (before casting, as mongoose does). */
  function applyTimestamps(update: PgRecord, upsert: boolean): void {
    const timestamps = descriptor.timestamps;
    if (!timestamps) {
      return;
    }
    const at = shared.now();
    if (timestamps.updatedAt) {
      delete update[timestamps.updatedAt];
      update.$set = {
        ...((update.$set as PgRecord | undefined) ?? {}),
        [timestamps.updatedAt]: at,
      };
    }
    if (timestamps.createdAt) {
      delete update[timestamps.createdAt];
      if (isPlainRecord(update.$set) && timestamps.createdAt in update.$set) {
        const { [timestamps.createdAt]: _dropped, ...rest } = update.$set;
        update.$set = rest;
      }
      update.$setOnInsert = {
        ...((update.$setOnInsert as PgRecord | undefined) ?? {}),
        [timestamps.createdAt]: at,
      };
    }
    void upsert;
  }

  /** mongoose's `decorateUpdateWithVersionKey`: an upsert inserts `__v: 0`. */
  function applyVersionKey(update: PgRecord): void {
    const key = descriptor.versionKey;
    if (!key) {
      return;
    }
    const has = (value: unknown) => isPlainRecord(value) && key in value;
    if (key in update || has(update.$set) || has(update.$inc) || has(update.$setOnInsert)) {
      return;
    }
    update.$setOnInsert = { ...((update.$setOnInsert as PgRecord | undefined) ?? {}), [key]: 0 };
  }

  /** The cast filter and update of a call; `null` when the tenant guard emptied the update. */
  function prepare(call: UpdateCall): PreparedUpdate | null {
    let filter: PgFilter = call.filter;
    let update: PgRecord = { ...call.update };
    for (const [key, value] of Object.entries(update)) {
      if (key.startsWith('$') && isPlainRecord(value)) {
        update[key] = { ...value };
      }
    }
    const upsert = call.options.upsert === true;
    if (!raw) {
      if (scoped) {
        filter = scopeTenantFilter('Query', filter);
        const sanitized = scopeTenantUpdate(update);
        if (!sanitized) {
          return null;
        }
        update = sanitized;
      }
      if (hooks.beforeUpdate) {
        update = hooks.beforeUpdate(update, { filter: call.filter as PgRecord, upsert });
      }
      if (call.options.timestamps !== false) {
        applyTimestamps(update, upsert);
      }
      if (upsert) {
        applyVersionKey(update);
      }
    }
    const cast = caster.castUpdate(name, update, {
      undeclared: raw ? 'keep' : 'strip',
    }) as PgRecord;
    checkUpdate(cast);
    const castedFilter = castFilter(filter);
    return {
      filter: castedFilter,
      update: cast,
      childFilter: filterReadsChildren(tables, table, castedFilter),
      where: whereOf(castedFilter),
    };
  }

  /** The tier-2 write of one record: the changed columns, then the changed child tables. */
  async function writeDiff(runner: SqlRunner, before: PgRecord, after: PgRecord): Promise<boolean> {
    if (String(before[keyColumn]) !== String(after[keyColumn])) {
      throw new StoreQueryError(
        `Performing an update on the path '${keyColumn}' would modify the immutable field '${keyColumn}'`,
      );
    }
    const options = { mode: 'raw' as const, rawValues: 'exact' as const };
    const old = decomposeRecord(tables, name, before, { ...options, countNul: false });
    const next = decomposeRecord(tables, name, after, options);
    const columns = changedColumns(old.row, next.row);
    const childTables = changedChildTables(old, next);
    if (columns.length > 0) {
      const sets = columns.map(
        (column) =>
          sql`${sql.id(column)} = ${param(next.row[column], arrayColumnType(table.columns.get(column)!))}`,
      );
      await runner.run(
        compileQuerySql(
          sql`UPDATE ${quotedTable} SET ${sql.join(sets, sql`, `)} WHERE ${sql.id(keyColumn)} = ${param(
            next.row[keyColumn],
            idType(keyColumn),
          )}`,
        ),
      );
    }
    for (const childTable of childTables) {
      await runner.run(
        compileQuerySql(
          sql`DELETE FROM ${sql.id(childTable)} WHERE "_parent" = ${param(next.id, idType(keyColumn))}`,
        ),
      );
      const rows = next.children.find((child) => child.table === childTable)?.rows ?? [];
      for (const statement of insertRowsStatements(tables, childTable, rows)) {
        await runner.run(statement);
      }
    }
    return columns.length > 0 || childTables.length > 0;
  }

  /** Compares decomposed rows of the evaluator's post-image and of what tier 1 stored. */
  function assertShadow(expected: PgRecord, actual: PgRecord): void {
    const options = { mode: 'raw' as const, rawValues: 'exact' as const, countNul: false };
    const a = decomposeRecord(tables, name, expected, options);
    const b = decomposeRecord(tables, name, actual, options);
    const columns = changedColumns(a.row, b.row);
    const children = changedChildTables(a, b);
    if (columns.length > 0 || children.length > 0) {
      throw new UpdateShadowCheckError(
        `Shadow check of ${name} ${String(actual[keyColumn])}: tier 1 and the evaluator differ on ${[
          ...columns,
          ...children,
        ].join(', ')}`,
      );
    }
  }

  /** The returning select of a single-record update (batched children). */
  const returningSelect = (call: UpdateCall, alias: string) => {
    const projection = projectionOf(call.returning?.projection);
    return {
      projection,
      select: selectRecord(tables, name, {
        alias,
        projection: projection.record,
        children: 'batched',
      }),
    };
  };

  /** Runs the update part of a call (no upsert insert). */
  async function runUpdate(
    runner: SqlRunner,
    call: UpdateCall,
    prepared: PreparedUpdate,
  ): Promise<UpdateOutcome> {
    const outcome: UpdateOutcome = { matched: 0, modified: 0, upsertedId: null, record: null };
    const plan = call.options.runValidators ? null : planTier1(tables, table, prepared.update);
    const shadow = plan !== null && shared.shadowCheck();
    const returning = call.returning;

    /* Tier 1, parent-only filter: one statement locks and writes (§3.5). */
    if (plan && !prepared.childFilter && !shadow) {
      const old = sql.id(OLD);
      const t = sql.id(ALIAS);
      const lock = call.many
        ? sql`${orderBy(undefined)} FOR UPDATE`
        : sql`${orderBy(call.options.sort)} LIMIT 1 FOR UPDATE${
            call.options.skipLocked ? sql` SKIP LOCKED` : sql``
          }`;
      const read = returning
        ? returningSelect(call, returning.when === 'before' ? OLD : ALIAS)
        : undefined;
      const statement = compileQuerySql(
        sql`UPDATE ${quotedTable} AS ${t} SET ${plan.set} FROM (SELECT * FROM ${quotedTable} AS ${t} WHERE ${
          prepared.where
        }${lock}) AS ${old} WHERE ${keyJoin(ALIAS, OLD)} RETURNING ${sql.id(
          ALIAS,
          keyColumn,
        )} AS "lc_key", (${t}::text IS DISTINCT FROM ${old}::text) AS "lc_modified"${
          read ? sql`, ${sql.raw(read.select.sql)}` : sql``
        }`,
      );
      const execute = async (inner: SqlRunner) => {
        for (let attempt = 0; ; attempt++) {
          const { rows } = await inner.run<Record<string, unknown>>(statement);
          if (
            rows.length === 0 &&
            !call.many &&
            !call.options.skipLocked &&
            attempt < CLAIM_RETRIES &&
            (await existsWhere(inner, prepared.where))
          ) {
            continue;
          }
          outcome.matched = rows.length;
          outcome.modified = rows.filter((row) => row.lc_modified === true).length;
          if (read && rows.length > 0) {
            [outcome.record] = await decodeRows(inner, read.select, rows, read.projection.apply);
          }
          return;
        }
      };
      if (read && read.select.children.length > 0) {
        await runner.atomic(execute);
      } else {
        await execute(runner);
      }
      return outcome;
    }

    /* Lock, re-evaluate in a new statement, write (child filters, tier 2, shadow check). */
    await runner.atomic(async (tx) => {
      const rejected: string[] = [];
      for (;;) {
        const ids = await lockIds(tx, prepared.where, {
          sort: call.many ? undefined : call.options.sort,
          limit: call.many ? undefined : 1,
          skipLocked: !call.many && call.options.skipLocked,
          exclude: rejected,
        });
        if (ids.length === 0) {
          return;
        }
        if (plan && !shadow) {
          const read = returning
            ? returningSelect(call, returning.when === 'before' ? OLD : ALIAS)
            : undefined;
          const { rows } = await tx.run<Record<string, unknown>>(
            compileQuerySql(
              sql`UPDATE ${quotedTable} AS ${sql.id(ALIAS)} SET ${plan.set} FROM (SELECT * FROM ${quotedTable} AS ${sql.id(
                ALIAS,
              )} WHERE ${sql.id(ALIAS, keyColumn)} = ANY (${param(ids, `${idType(keyColumn)}[]`)})) AS ${sql.id(
                OLD,
              )} WHERE ${keyJoin(ALIAS, OLD)} AND ${prepared.where} RETURNING ${sql.id(
                ALIAS,
                keyColumn,
              )} AS "lc_key", (${sql.id(ALIAS)}::text IS DISTINCT FROM ${sql.id(OLD)}::text) AS "lc_modified"${
                read ? sql`, ${sql.raw(read.select.sql)}` : sql``
              }`,
            ),
          );
          if (rows.length === 0 && !call.many) {
            rejected.push(...ids);
            continue;
          }
          outcome.matched = rows.length;
          outcome.modified = rows.filter((row) => row.lc_modified === true).length;
          if (read && rows.length > 0) {
            [outcome.record] = await decodeRows(tx, read.select, rows, read.projection.apply);
          }
          return;
        }
        const records = await readByIds(tx, ids, { record: full }, prepared.where);
        if (records.length === 0 && !call.many) {
          rejected.push(...ids);
          continue;
        }
        for (const before of records) {
          const id = String(before[keyColumn]);
          const projected = returning ? projectionOf(returning.projection) : undefined;
          if (returning?.when === 'before') {
            [outcome.record] = await readByIds(tx, [id], projected!);
          }
          const after = applyCollectionUpdate(before, prepared.update);
          let modified: boolean;
          if (plan) {
            const { rows } = await tx.run<{ lc_modified: boolean }>(
              compileQuerySql(
                sql`UPDATE ${quotedTable} AS ${sql.id(ALIAS)} SET ${plan.set} FROM (SELECT * FROM ${quotedTable} AS ${sql.id(
                  ALIAS,
                )} WHERE ${sql.id(ALIAS, keyColumn)} = ${param(id, idType(keyColumn))}) AS ${sql.id(
                  OLD,
                )} WHERE ${keyJoin(ALIAS, OLD)} RETURNING (${sql.id(ALIAS)}::text IS DISTINCT FROM ${sql.id(
                  OLD,
                )}::text) AS "lc_modified"`,
              ),
            );
            modified = rows[0]?.lc_modified === true;
            const [stored] = await readByIds(tx, [id], { record: full });
            assertShadow(after, stored);
          } else {
            if (call.options.runValidators && engineFor) {
              await engineFor.validatePaths(name, after, updatedPaths(prepared.update), 'query');
            }
            modified = await writeDiff(tx, before, after);
          }
          outcome.matched += 1;
          outcome.modified += modified ? 1 : 0;
          if (returning?.when === 'after') {
            [outcome.record] = await readByIds(tx, [id], projected!);
          }
        }
        return;
      }
    });
    return outcome;
  }

  /** The record an upsert inserts (§3.4). */
  async function buildUpsert(prepared: PreparedUpdate, call: UpdateCall): Promise<PgRecord> {
    const seed = storeFilterInsertSeed(prepared.filter as StoreFilter);
    let record = applyCollectionUpdate(seed, prepared.update, { inserting: true });
    if (!raw && engineFor) {
      record = canonicalizeValue(
        await engineFor.buildDocument(name, record, { validate: false }),
      ) as PgRecord;
      if (call.options.runValidators) {
        await engineFor.validatePaths(
          name,
          record,
          updatedPaths(prepared.update, { inserting: true }),
          'query',
        );
      }
    }
    if (descriptor.idType === 'objectId' && (record._id === undefined || record._id === null)) {
      record = { _id: generatePostgresStoreId(), ...record };
    }
    return record;
  }

  /**
   * The record an update that broke a unique key tried to write, for the duplicate-key error's
   * `keyValue`: the first matching record with the update applied, or (when it cannot be read: a
   * caller's transaction the failure aborted) the values the update itself writes.
   */
  async function updatedRecordOf(runner: SqlRunner, prepared: PreparedUpdate): Promise<PgRecord> {
    try {
      const [before] = await runner
        .run(
          compileQuerySql(
            sql`SELECT ${sql.id(ALIAS, keyColumn)} AS "lc_key" FROM ${quotedTable} AS ${sql.id(
              ALIAS,
            )} WHERE ${prepared.where}${orderBy(undefined)} LIMIT 1`,
          ),
        )
        .then(async ({ rows }) =>
          readByIds(
            runner,
            rows.map((row) => row.lc_key as string),
            { record: full },
          ),
        );
      return applyCollectionUpdate(before ?? {}, prepared.update);
    } catch {
      try {
        return applyCollectionUpdate({}, prepared.update);
      } catch {
        return {};
      }
    }
  }

  async function update(runner: SqlRunner, call: UpdateCall): Promise<UpdateOutcome> {
    if (!isPlainRecord(call.filter)) {
      throw new StoreQueryError('A filter must be an object');
    }
    const prepared = prepare(call);
    if (!prepared) {
      return { matched: 0, modified: 0, upsertedId: null, record: null };
    }
    for (let attempt = 0; ; attempt++) {
      let outcome: UpdateOutcome;
      try {
        outcome = await runUpdate(runner, call, prepared);
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        throw duplicate(error, await updatedRecordOf(runner, prepared));
      }
      if (outcome.matched > 0 || call.options.upsert !== true) {
        return outcome;
      }
      const record = await buildUpsert(prepared, call);
      try {
        await runner.atomic((inner) => writeStatements(inner, decompose(record)));
      } catch (error) {
        if (isUniqueViolation(error) && attempt === 0) {
          continue;
        }
        throw duplicate(error, record);
      }
      const id = String(record[keyColumn]);
      const result: UpdateOutcome = { matched: 0, modified: 0, upsertedId: id, record: null };
      if (call.returning?.when === 'after') {
        [result.record] = await readByIds(runner, [id], projectionOf(call.returning.projection));
      }
      return result;
    }
  }

  const toResult = (outcome: UpdateOutcome): PgUpdateResult => ({
    acknowledged: true,
    matchedCount: outcome.matched,
    modifiedCount: outcome.modified,
    upsertedCount: outcome.upsertedId ? 1 : 0,
    upsertedId: outcome.upsertedId,
  });

  async function updateOn(
    runner: SqlRunner,
    filter: PgFilter,
    change: PgUpdate,
    options: PgUpdateOptions,
    many: boolean,
  ): Promise<PgUpdateResult> {
    return toResult(await update(runner, { filter, update: change, options, many }));
  }

  /* ---- deletes ---- */

  async function deleteOn(
    runner: SqlRunner,
    filter: PgFilter,
    options: { sort?: PgSort; many: boolean },
  ): Promise<number> {
    hooks.beforeDelete?.();
    const cast = castFilter(scopeFilter(filter));
    const where = whereOf(cast);
    if (!filterReadsChildren(tables, table, cast)) {
      if (options.many) {
        const { rowCount } = await runner.run(
          compileQuerySql(sql`DELETE FROM ${quotedTable} AS ${sql.id(ALIAS)} WHERE ${where}`),
        );
        return rowCount;
      }
      const statement = compileQuerySql(
        sql`DELETE FROM ${quotedTable} AS ${sql.id(ALIAS)} USING (SELECT ${sql.join(
          keyColumns.map((column) => sql.id(ALIAS, column)),
          sql`, `,
        )} FROM ${quotedTable} AS ${sql.id(ALIAS)} WHERE ${where}${orderBy(
          options.sort,
        )} LIMIT 1 FOR UPDATE) AS ${sql.id(OLD)} WHERE ${keyJoin(ALIAS, OLD)}`,
      );
      for (let attempt = 0; ; attempt++) {
        const { rowCount } = await runner.run(statement);
        if (rowCount === 0 && attempt < CLAIM_RETRIES && (await existsWhere(runner, where))) {
          continue;
        }
        return rowCount;
      }
    }
    return runner.atomic(async (tx) => {
      const rejected: string[] = [];
      for (;;) {
        const ids = await lockIds(tx, where, {
          sort: options.sort,
          limit: options.many ? undefined : 1,
          exclude: rejected,
        });
        if (ids.length === 0) {
          return 0;
        }
        const { rowCount } = await tx.run(
          compileQuerySql(
            sql`DELETE FROM ${quotedTable} AS ${sql.id(ALIAS)} WHERE ${sql.id(
              ALIAS,
              keyColumn,
            )} = ANY (${param(ids, `${idType(keyColumn)}[]`)}) AND ${where}`,
          ),
        );
        if (rowCount === 0 && !options.many) {
          rejected.push(...ids);
          continue;
        }
        return rowCount;
      }
    });
  }

  async function findOneAndDelete(
    filter: PgFilter,
    options: Parameters<PgCollection['findOneAndDelete']>[1] = {},
  ) {
    hooks.beforeDelete?.();
    const runner = shared.runnerFor(options.tx);
    const where = whereOf(castFilter(scopeFilter(filter)));
    const projection = projectionOf(options.projection);
    return runner.atomic(async (tx) => {
      const rejected: string[] = [];
      for (;;) {
        const ids = await lockIds(tx, where, { sort: options.sort, limit: 1, exclude: rejected });
        if (ids.length === 0) {
          return null;
        }
        const [record] = await readByIds(tx, ids, projection, where);
        if (!record) {
          rejected.push(...ids);
          continue;
        }
        await tx.run(
          compileQuerySql(
            sql`DELETE FROM ${quotedTable} WHERE ${sql.id(keyColumn)} = ${param(
              ids[0],
              idType(keyColumn),
            )}`,
          ),
        );
        return record;
      }
    });
  }

  /* ---- bulk ---- */

  async function bulk(
    operations: readonly PgBulkOperation[],
    options: Parameters<PgCollection['bulk']>[1] = {},
  ): Promise<PgBulkResult> {
    hooks.beforeBulk?.();
    const runner = shared.runnerFor(options.tx);
    const ordered = options.ordered !== false;
    const result: PgBulkResult = {
      insertedCount: 0,
      matchedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      upsertedCount: 0,
      insertedIds: {},
      upsertedIds: {},
    };
    const writeErrors: PgWriteError[] = [];
    const timestamps = options.timestamps;
    await runner.atomic(async (tx) => {
      for (const [index, operation] of operations.entries()) {
        try {
          await tx.atomic(async (inner) => {
            if ('insertOne' in operation) {
              const record = await insertOneOn(inner, operation.insertOne.document, { timestamps });
              result.insertedCount += 1;
              result.insertedIds[index] = String(record[keyColumn]);
              return;
            }
            if ('deleteOne' in operation || 'deleteMany' in operation) {
              const many = 'deleteMany' in operation;
              const { filter } = many ? operation.deleteMany : operation.deleteOne;
              result.deletedCount += await deleteOn(inner, filter, { many });
              return;
            }
            const many = 'updateMany' in operation;
            const spec = many ? operation.updateMany : operation.updateOne;
            const outcome = await updateOn(
              inner,
              spec.filter,
              spec.update,
              { upsert: spec.upsert, timestamps },
              many,
            );
            result.matchedCount += outcome.matchedCount;
            result.modifiedCount += outcome.modifiedCount;
            if (outcome.upsertedId) {
              result.upsertedCount += 1;
              result.upsertedIds[index] = outcome.upsertedId;
            }
          });
        } catch (error) {
          writeErrors.push({ index, error });
          if (ordered) {
            break;
          }
        }
      }
    });
    if (writeErrors.length > 0) {
      throw withDetails(writeErrors[0].error, { writeErrors, result });
    }
    return result;
  }

  return {
    name,
    raw,
    find: find as PgCollection['find'],
    findOne: findOne as PgCollection['findOne'],
    count,
    exists,
    distinct,
    insertOne,
    insertMany,
    updateOne: (filter, change, options = {}) =>
      updateOn(shared.runnerFor(options.tx), filter, change, options, false),
    updateMany: (filter, change, options = {}) =>
      updateOn(shared.runnerFor(options.tx), filter, change, options, true),
    findOneAndUpdate: async (filter, change, options = {}) => {
      const outcome = await update(shared.runnerFor(options.tx), {
        filter,
        update: change,
        options,
        many: false,
        returning: { when: options.returnDocument ?? 'before', projection: options.projection },
      });
      return outcome.record;
    },
    findOneAndDelete,
    deleteOne: async (filter, options = {}) => ({
      acknowledged: true,
      deletedCount: await deleteOn(shared.runnerFor(options.tx), filter, {
        sort: options.sort,
        many: false,
      }),
    }),
    deleteMany: async (filter, options = {}) => ({
      acknowledged: true,
      deletedCount: await deleteOn(shared.runnerFor(options.tx), filter, { many: true }),
    }),
    bulk,
  };
}

/**
 * The query translator (docs/postgres-port/PHASE4.md §2): the portable query language of
 * `ports/query.ts` (filters, projections, sorts, paging) translated to SQL over the typed schema
 * descriptor, as Kysely `RawBuilder`s. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * ```ts
 * const translator = createQueryTranslator(SCHEMA_DESCRIPTOR);
 * const where = translator.filter('conversations', { user, isArchived: { $ne: true } });
 * const order = translator.sort('conversations', { updatedAt: -1, _id: -1 });
 * const read = translator.find('conversations', { filter, projection, sort, limit: 25 });
 * const { rows } = await pool.query(read.text, read.values);
 * const records = read.decode(rows);
 * ```
 *
 * - Values are cast first by R1's descriptor caster (`records/cast.ts`), so `{ n: '5' }` on a
 *   Number path compares `5` and a `lowercase` path compares the lowercased value; a value that
 *   cannot be cast, and a path the schema does not declare, raise a `StoreQueryError`.
 * - Fragments refer to the parent rows by the alias given (default `t`); `filterOn` translates a
 *   filter over another table's rows (a child table's elements) for `$elemMatch` and positional
 *   updates (C2).
 * - `find` builds a whole read: R1's `selectRecord` select list (projection pushed down to
 *   columns and child subselects), the filter, the sort and the paging; `decode` turns the rows
 *   back into records (key order and `_nulls` as R1 assembles them) and applies projections into
 *   `json` values.
 * - `compileQuerySql` gives any fragment's `{ text, values }` for `pg`.
 */
import type { ChildReadMode, RecordSelect } from '../records/assemble';
import type { RecordCaster, UpdateCastEngine } from '../records/cast';
import type { RecordTable, RecordTables } from '../records/tables';
import type { SchemaDescriptor } from '../schema/descriptor';
import type { CompiledQuerySql, SqlFragment } from './sql';
import type { TranslatedProjection } from './projection';
import type { PagingOptions } from './paging';
import { indexRecordTables } from '../records/tables';
import { createRecordCaster } from '../records/cast';
import { selectRecord } from '../records/assemble';
import { translateProjection } from './projection';
import { translateCastFilter } from './filter';
import { compileQuerySql, sql } from './sql';
import { translatePaging } from './paging';
import { QueryContext } from './resolve';
import { translateSort } from './sort';

export { compileQuerySql } from './sql';
export { translateRegex } from './regex';
export type { SqlFragment, CompiledQuerySql } from './sql';
export type { TranslatedRegex } from './regex';
export type { TranslatedProjection } from './projection';
export type { PagingOptions } from './paging';

/** The default alias of the parent rows. */
export const DEFAULT_ALIAS = 't';

/** Options of the translator's methods. */
export interface TranslateOptions {
  /** The alias of the rows in the SQL (default `t`). */
  alias?: string;
  /** Cast the filter's values first (default `true`); `false` for a filter already cast. */
  cast?: boolean;
}

/** A read of the query language. */
export interface StoreReadQuery {
  filter?: Record<string, unknown>;
  projection?: unknown;
  sort?: Record<string, unknown>;
  limit?: number | null;
  offset?: number | null;
}

/** A whole read, translated. */
export interface TranslatedRead extends CompiledQuerySql {
  readonly sql: SqlFragment;
  readonly select: RecordSelect;
  /** The records of the rows `text` returned (in `subselect` child mode). */
  decode(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>>;
}

/** The query translator over one schema descriptor. */
export interface QueryTranslator {
  readonly tables: RecordTables;
  readonly caster: RecordCaster;
  /** The `WHERE` condition of `filter` over `collection`'s rows. */
  filter(
    collection: string,
    filter: Record<string, unknown>,
    options?: TranslateOptions,
  ): SqlFragment;
  /** The `WHERE` condition of `filter` over the rows of `table` (a child table's elements). */
  filterOn(
    table: RecordTable,
    filter: Record<string, unknown>,
    options?: TranslateOptions,
  ): SqlFragment;
  /** The `ORDER BY` items of `sort` (empty for none). */
  sort(
    collection: string,
    sort: Record<string, unknown> | undefined,
    options?: Pick<TranslateOptions, 'alias'>,
  ): SqlFragment[];
  /** The projection of `collection`'s reads. */
  projection(collection: string, projection: unknown): TranslatedProjection;
  /** ` LIMIT n OFFSET m`. */
  paging(options: PagingOptions): SqlFragment;
  /** A whole read: `SELECT <record> FROM <table> WHERE ... ORDER BY ... LIMIT ... OFFSET ...`. */
  find(
    collection: string,
    query?: StoreReadQuery,
    options?: Pick<TranslateOptions, 'alias' | 'cast'> & { children?: ChildReadMode },
  ): TranslatedRead;
}

/** Options of {@link createQueryTranslator}. */
export interface QueryTranslatorOptions {
  /** The caster to use (one is created over the descriptor otherwise). */
  caster?: RecordCaster;
  /** The schema engine, for a caster created here (filters do not need it). */
  engine?: UpdateCastEngine;
}

/** Creates the query translator over `descriptor` (or its lookups). */
export function createQueryTranslator(
  descriptor: SchemaDescriptor | RecordTables,
  options: QueryTranslatorOptions = {},
): QueryTranslator {
  const tables = 'roots' in descriptor ? descriptor : indexRecordTables(descriptor);
  const caster =
    options.caster ?? createRecordCaster(tables, options.engine ? { engine: options.engine } : {});

  const filterIn = (
    context: QueryContext,
    table: RecordTable,
    filter: Record<string, unknown>,
    translateOptions: TranslateOptions,
  ): SqlFragment => {
    const cast = translateOptions.cast === false ? filter : caster.castFilterOn(table, filter);
    return translateCastFilter(
      context,
      context.scope(table, translateOptions.alias ?? DEFAULT_ALIAS),
      cast,
    );
  };

  const sortIn = (
    context: QueryContext,
    collection: string,
    sort: Record<string, unknown> | undefined,
    alias: string,
  ): SqlFragment[] =>
    sort ? translateSort(context, context.scope(tables.collection(collection), alias), sort) : [];

  const filterOn: QueryTranslator['filterOn'] = (table, filter, translateOptions = {}) =>
    filterIn(new QueryContext(tables), table, filter, translateOptions);

  const sortOf: QueryTranslator['sort'] = (collection, sort, sortOptions = {}) =>
    sortIn(new QueryContext(tables), collection, sort, sortOptions.alias ?? DEFAULT_ALIAS);

  const projectionOf: QueryTranslator['projection'] = (collection, projection) =>
    translateProjection(tables, tables.collection(collection), projection, { caster });

  return {
    tables,
    caster,
    filter: (collection, filter, translateOptions) =>
      filterOn(tables.collection(collection), filter, translateOptions),
    filterOn,
    sort: sortOf,
    projection: projectionOf,
    paging: translatePaging,
    find: (collection, query = {}, findOptions = {}) => {
      const table = tables.collection(collection);
      const alias = findOptions.alias ?? DEFAULT_ALIAS;
      const projection = projectionOf(collection, query.projection);
      const select = selectRecord(tables, collection, {
        alias,
        projection: projection.record,
        children: findOptions.children ?? 'subselect',
      });
      const context = new QueryContext(tables);
      const where = query.filter
        ? filterIn(context, table, query.filter, { alias, cast: findOptions.cast })
        : undefined;
      const order = sortIn(context, collection, query.sort, alias);
      const statement = sql`SELECT ${sql.raw(select.sql)} FROM ${sql.id(table.descriptor.name)} AS ${sql.id(
        alias,
      )}${where ? sql` WHERE ${where}` : sql``}${
        order.length > 0 ? sql` ORDER BY ${sql.join(order, sql`, `)}` : sql``
      }${translatePaging({ limit: query.limit, offset: query.offset })}`;
      const compiled = compileQuerySql(statement);
      return {
        ...compiled,
        sql: statement,
        select,
        decode: (rows) =>
          rows.map((row) => {
            const record = select.decode(row);
            return projection.apply ? projection.apply(record) : record;
          }),
      };
    },
  };
}

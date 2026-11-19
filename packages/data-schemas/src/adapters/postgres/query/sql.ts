/**
 * SQL building blocks of the query translator (docs/postgres-port/PHASE4.md §2): Kysely
 * `RawBuilder` fragments, typed parameters and the boolean combinators the filter, sort and
 * paging modules compose, and {@link compileQuerySql}, which turns a fragment into the
 * `{ text, values }` pair `pg`'s `query` takes. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Every value reaches PostgreSQL as a bound parameter with an explicit cast; identifiers are
 * quoted by Kysely (`sql.id`). Fragments never hold user text spliced in as SQL.
 */
import {
  sql,
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { RawBuilder } from 'kysely';
import type { ColumnDescriptor, ScalarType } from '../schema/descriptor';
import type { TranslatedRegex } from './regex';
import type { PostgresTables } from '../types';
import { prefixUpperBound } from './regex';

/** A fragment of SQL with its bound values. */
export type SqlFragment = RawBuilder<unknown>;

/** A compiled statement, as `pg`'s `query(text, values)` takes it. */
export interface CompiledQuerySql {
  text: string;
  values: unknown[];
}

let compiler: Kysely<PostgresTables> | undefined;

/** A Kysely instance that only compiles (no connection): PostgreSQL syntax, `$n` parameters. */
function getCompiler(): Kysely<PostgresTables> {
  if (!compiler) {
    compiler = new Kysely<PostgresTables>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  }
  return compiler;
}

/** The text and values of a fragment, for `pg` (`pool.query(text, values)`). */
export function compileQuerySql(fragment: SqlFragment): CompiledQuerySql {
  const compiled = fragment.compile(getCompiler());
  return { text: compiled.sql, values: [...compiled.parameters] };
}

export const TRUE: SqlFragment = sql`TRUE`;
export const FALSE: SqlFragment = sql`FALSE`;

/** `a AND b AND ...` (`TRUE` for none). */
export function and(parts: readonly SqlFragment[]): SqlFragment {
  if (parts.length === 0) return TRUE;
  if (parts.length === 1) return parts[0];
  return sql`(${sql.join(parts, sql` AND `)})`;
}

/** `a OR b OR ...` (`FALSE` for none). */
export function or(parts: readonly SqlFragment[]): SqlFragment {
  if (parts.length === 0) return FALSE;
  if (parts.length === 1) return parts[0];
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * The negation of a predicate whose `NULL` means "no" (a comparison with a `NULL` column): `NOT
 * coalesce(p, false)`, so it is `TRUE` where `p` is `NULL`, as MongoDB's `$ne` and `$nin` match a
 * missing field.
 */
export function not(part: SqlFragment): SqlFragment {
  return sql`NOT coalesce(${part}, FALSE)`;
}

/** `"alias"."column"`. */
export function columnRef(alias: string, column: string): SqlFragment {
  return sql.id(alias, column);
}

/** A string literal inlined in the SQL (paths in `_nulls` checks, jsonpath keys): never user values. */
export function literal(value: string): SqlFragment {
  return sql.lit(value);
}

/** The SQL type of a parameter holding one value of `type`. */
export function scalarParamType(type: ScalarType): string {
  switch (type) {
    case 'string':
    case 'objectId':
    case 'objectIdOrString':
      return 'text';
    case 'number':
      return 'double precision';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'timestamptz';
    case 'buffer':
      return 'bytea';
  }
}

/** A bound value cast to `type` (`$n::type`). */
export function param(value: unknown, type: string): SqlFragment {
  return sql`${sql.val(value)}::${sql.raw(type)}`;
}

/** A bound value of a scalar type. */
export function scalarParam(value: unknown, type: ScalarType): SqlFragment {
  return param(value, scalarParamType(type));
}

/** The SQL type of an array column without its collation (`text[]`, `lc_object_id[]`, ...). */
export function arrayColumnType(column: ColumnDescriptor): string {
  return column.sqlType.replace(/\s+COLLATE\s+"[^"]+"/, '');
}

/** The element type of an array column (`text`, `lc_object_id`, ...). */
export function arrayElementType(column: ColumnDescriptor): string {
  return arrayColumnType(column).replace(/\[\]$/, '');
}

/** A bound `jsonb` value (the JSON text of `json`, parsed by PostgreSQL). */
export function jsonbParam(json: string): SqlFragment {
  return sql`${sql.val(json)}::jsonb`;
}

/** The collation that orders and compares text by code point, whatever the database locale. */
export const COLLATE_C: SqlFragment = sql.raw('COLLATE "C"');

/** The collation case-insensitive regular expressions fold with (Unicode, §2.4). */
export const COLLATE_ICU: SqlFragment = sql.raw('COLLATE "und-x-icu"');

/**
 * `text` matched by a translated regular expression: `~` under `COLLATE "C"`, or `~*` under
 * `und-x-icu` for `i` (§2.4). A case-sensitive pattern anchored on a literal prefix also gets the
 * code point range of that prefix, which a btree index on the text serves.
 */
export function regexMatch(text: SqlFragment, regex: TranslatedRegex): SqlFragment {
  const pattern = param(regex.pattern, 'text');
  if (regex.insensitive) {
    return sql`((${text}) ${COLLATE_ICU} ~* ${pattern})`;
  }
  const match = sql`((${text}) ${COLLATE_C} ~ ${pattern})`;
  if (!regex.prefix) {
    return match;
  }
  const parts = [sql`${text} >= (${param(regex.prefix, 'text')} ${COLLATE_C})`];
  const upper = prefixUpperBound(regex.prefix);
  if (upper !== null) {
    parts.push(sql`${text} < (${param(upper, 'text')} ${COLLATE_C})`);
  }
  parts.push(match);
  return and(parts);
}

/** `a <op> b` for a range operator. */
export function rangeOperatorSql(operator: '$gt' | '$gte' | '$lt' | '$lte'): SqlFragment {
  switch (operator) {
    case '$gt':
      return sql.raw('>');
    case '$gte':
      return sql.raw('>=');
    case '$lt':
      return sql.raw('<');
    case '$lte':
      return sql.raw('<=');
  }
}

export { sql };

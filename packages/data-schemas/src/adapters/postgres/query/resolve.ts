/**
 * Path resolution for the query translator (docs/postgres-port/PHASE4.md §2.1): the scope a
 * filter, sort or projection is translated in (a table of the descriptor and the SQL alias of its
 * rows), aliases for the subqueries the translation nests, and the `_nulls` presence rules of a
 * declared path. The path itself is resolved by R1's `resolveRecordPath` (`records/paths.ts`),
 * which the caster shares, so a path is resolved the same way for casting and for SQL. Must not
 * import `mongoose`, `mongodb` or `bson`.
 */
import type { RecordTable, RecordTables } from '../records/tables';
import type { ResolvedPath } from '../records/paths';
import type { TranslatedRegex } from './regex';
import type { SqlFragment } from './sql';
import { absenceSql, presenceSql } from '../records/nulls';
import { resolveRecordPath } from '../records/paths';
import { sql } from './sql';

/** The rows a translation applies to: a table and the alias its rows have in the SQL. */
export interface QueryScope {
  readonly table: RecordTable;
  readonly alias: string;
}

/** The state of one translation: the descriptor's lookups and the aliases handed out. */
export class QueryContext {
  private counter = 0;

  constructor(readonly tables: RecordTables) {}

  /** A fresh alias for a subquery (`_q1`, `_q2`, ...), unlike any column or assemble alias. */
  alias(prefix = 'q'): string {
    this.counter += 1;
    return `_${prefix}${this.counter}`;
  }

  /** The scope of the rows of `table` under `alias`. */
  scope(table: RecordTable, alias: string): QueryScope {
    return { table, alias };
  }
}

/**
 * Resolves `path` (relative to the scope's rows) with R1's resolver. Throws an
 * `UndeclaredPathError` (a `StoreQueryError`) for a path the schema does not declare (R9).
 */
export function resolveQueryPath(
  context: QueryContext,
  scope: QueryScope,
  path: string,
): ResolvedPath {
  return resolveRecordPath(context.tables, scope.table, path);
}

/**
 * `$exists: true` on the declared path `path` stored in `column` of the scope's rows: the column
 * holds a value, or the path is listed in `_nulls` (R1's `presenceSql`).
 */
export function presence(scope: QueryScope, column: string, path: string): SqlFragment {
  return sql.raw(
    presenceSql(column, path, { alias: scope.alias, systemColumns: scope.table.systemColumns }),
  );
}

/**
 * `$exists: false`: R1's `absenceSql`, which stays `TRUE` on rows whose `_nulls` is `NULL` (a
 * plain `NOT` of {@link presence} would be `NULL` there).
 */
export function absence(scope: QueryScope, column: string, path: string): SqlFragment {
  return sql.raw(
    absenceSql(column, path, { alias: scope.alias, systemColumns: scope.table.systemColumns }),
  );
}

/** Whether the path is listed in the scope row's `_nulls` (explicitly `null`). */
export function listedNull(scope: QueryScope, path: string): SqlFragment {
  if (!scope.table.systemColumns) {
    return sql`FALSE`;
  }
  return sql`coalesce(${sql.lit(path)} = ANY (${sql.id(scope.alias, '_nulls')}), FALSE)`;
}

/** The parent key column a child or element table's rows point at their parent with. */
export const PARENT_KEY = '_parent';
/** The primary key of a collection table (the parent of its child and element tables). */
export const ID_COLUMN = '_id';
/** The position column of child and element tables. */
export const ORD_COLUMN = '_ord';

/** `<alias>._parent = <outer>._id`: the rows of a child or element table of the outer row. */
export function childOf(alias: string, outer: QueryScope): SqlFragment {
  return sql`${sql.id(alias, PARENT_KEY)} = ${sql.id(outer.alias, ID_COLUMN)}`;
}

/* ------------------------------------------------------------------------------------------ */
/* What a filter path reaches                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** The range operators. */
export type RangeOperator = '$gt' | '$gte' | '$lt' | '$lte';

/**
 * A test on the values a filter path reaches (its candidates, in the reference evaluator's
 * words). Values are cast already (R1's caster); none of them is `null`.
 * - `eq`, `in`, `isNull`, `range`, `regex` hold when the value, or one element of an array value,
 *   passes ("array contains"); `isNull` is a `null` value or element;
 * - `any` holds for every value (`$exists: true`);
 * - `size` holds for an array of that many elements, `arrayEq` for an array equal to `values`
 *   (or holding such an array).
 */
export type ValuePredicate =
  | { kind: 'eq'; value: unknown }
  | { kind: 'in'; values: readonly unknown[] }
  | { kind: 'isNull' }
  | { kind: 'any' }
  | { kind: 'range'; operator: RangeOperator; value: unknown }
  | { kind: 'regex'; regex: TranslatedRegex }
  | { kind: 'size'; size: number }
  | { kind: 'arrayEq'; values: readonly unknown[] };

/**
 * The SQL of the conditions on one resolved path. MongoDB's semantics are stated in terms of the
 * path's candidates (`matchesStoreFilter`): each reached value, or "missing" where the path ends
 * early (a missing field, a scalar or `null` where an object is needed).
 */
export interface FilterLeaf {
  /** Some candidate holds a value passing `predicate`. */
  some(predicate: ValuePredicate): SqlFragment;
  /** Some candidate is missing. */
  missing(): SqlFragment;
  /** Some candidate is missing or `null` (equality with `null`). */
  nullOrMissing(): SqlFragment;
  /** No candidate holds a value (`$exists: false`); two-valued. */
  absent(): SqlFragment;
}

/** Re-exported for the translator's modules. */
export type { RecordTable, RecordTables, ResolvedPath };

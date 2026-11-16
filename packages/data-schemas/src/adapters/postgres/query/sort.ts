/**
 * Sorts → SQL (docs/postgres-port/PHASE4.md §2.3): a `StoreSort` translated to an `ORDER BY`
 * list in MongoDB's order. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - **Scalar columns** (flattened object leaves included) sort on the column itself, `ASC NULLS
 *   FIRST` or `DESC NULLS LAST` (missing and `null` first ascending, as in MongoDB), so the btree
 *   indexes the generator writes in the same order serve the sort. Text columns are `COLLATE "C"`
 *   by their DDL (code point order) and ids sort as their hex, oldest first.
 * - **Arrays and paths through child tables** sort on a text key compared under `COLLATE "C"`:
 *   MongoDB's type rank, then the value (F3's `lc_sort_number` for numbers), the smallest element
 *   ascending and the largest descending, an empty array before `null`; through an array of
 *   subdocuments every element counts, and an element lacking the field, a missing array and an
 *   empty one count as `null`.
 * - **`json` paths**: `lc_sort_key` over the values MongoDB's sort walk reaches (`jsonpath.ts`).
 *   Objects, nested arrays and binaries inside `json` are ordered by their `jsonb` text, F3's
 *   approximation of MongoDB's field-by-field order.
 * - Refused (`StoreQueryError`): an object path or a whole array of subdocuments (MongoDB would
 *   compare the objects), an undeclared path, a direction other than `1`/`-1`.
 * Ties are left to the caller, as in MongoDB: a page that must be stable ends with `_id`.
 */
import type { FieldDescriptor, ScalarType } from '../schema/descriptor';
import type { QueryContext, QueryScope, ResolvedPath } from './resolve';
import type { PathHop } from '../records/paths';
import type { SqlFragment } from './sql';
import { childOf, ORD_COLUMN, resolveQueryPath } from './resolve';
import { isPlainRecord } from '../records/extra';
import { StoreQueryError } from '~/ports/query';
import { jsonSortKey } from './jsonpath';
import { COLLATE_C, sql } from './sql';

/** The key text of `null` (and missing), and of an empty array (MongoDB orders it first). */
const NULL_KEY = sql`'1'`;
const EMPTY_ARRAY_KEY = sql`'0'`;

/**
 * The sort key of one typed value `x` of `type` as text, in `lc_sort_key`'s encoding (type rank
 * digit, then an order-preserving form of the value); `'1'` for `NULL`.
 */
function typedKey(x: SqlFragment, type: ScalarType): SqlFragment {
  let key: SqlFragment;
  switch (type) {
    case 'string':
    case 'objectId':
    case 'objectIdOrString':
      key = sql`'3' || (${x})::text`;
      break;
    case 'number':
      key = sql`'2' || lc_sort_number(${x})`;
      break;
    case 'boolean':
      key = sql`CASE WHEN ${x} THEN '81' ELSE '80' END`;
      break;
    case 'date':
      key = sql`'9' || lc_sort_number(extract(epoch FROM ${x})::double precision)`;
      break;
    case 'buffer':
      key = sql`'6' || lpad(to_hex(length(${x})), 8, '0') || encode(${x}, 'hex')`;
      break;
  }
  return sql`CASE WHEN ${x} IS NULL THEN ${NULL_KEY} ELSE ${key} END`;
}

/** The key of a set of typed values (`SELECT v FROM ...` rows): their minimum or maximum key. */
function aggregateKey(
  values: (key: (x: SqlFragment) => SqlFragment) => SqlFragment,
  ascending: boolean,
): SqlFragment {
  const aggregate = ascending ? sql`min` : sql`max`;
  return values((key) => sql`${aggregate}((${key}) ${COLLATE_C})`);
}

/** The key of a scalar array column: empty first, `null` for missing, else its min or max element. */
function arrayKey(
  context: QueryContext,
  column: SqlFragment,
  element: ScalarType,
  ascending: boolean,
): SqlFragment {
  const alias = context.alias('e');
  const extreme = aggregateKey(
    (aggregate) =>
      sql`(SELECT ${aggregate(typedKey(sql.id(alias, 'v'), element))} FROM unnest(${column}) AS ${sql.id(
        alias,
      )} (v))`,
    ascending,
  );
  return sql`CASE WHEN ${column} IS NULL THEN ${NULL_KEY} WHEN cardinality(${column}) = 0 THEN ${EMPTY_ARRAY_KEY} ELSE ${extreme} END`;
}

/** The key of a scalar array stored in an element table. */
function elementsKey(
  context: QueryContext,
  scope: QueryScope,
  field: Extract<FieldDescriptor, { kind: 'elements' }>,
  ascending: boolean,
): SqlFragment {
  const count = sql.id(scope.alias, field.column);
  const table = context.tables.table(field.table).descriptor.name;
  const alias = context.alias('t');
  const extreme = aggregateKey(
    (aggregate) =>
      sql`(SELECT ${aggregate(typedKey(sql.id(alias, 'value'), field.element))} FROM ${sql.id(
        table,
      )} AS ${sql.id(alias)} WHERE ${childOf(alias, scope)})`,
    ascending,
  );
  return sql`CASE WHEN ${count} IS NULL THEN ${NULL_KEY} WHEN ${count} = 0 THEN ${EMPTY_ARRAY_KEY} ELSE ${extreme} END`;
}

/** The text key of what a resolved path reaches in the scope's rows (no column shortcut). */
function nodeKey(
  context: QueryContext,
  scope: QueryScope,
  resolved: ResolvedPath,
  ascending: boolean,
): SqlFragment {
  const { node } = resolved;
  switch (node.kind) {
    case 'json':
      return jsonSortKey(context, scope, node.field, node.subpath, ascending);
    case 'element': {
      if (node.position.kind !== 'index') {
        throw new StoreQueryError(`Cannot sort by the positional path "${resolved.path}"`);
      }
      if (node.field.kind === 'array') {
        return typedKey(
          sql`${sql.id(scope.alias, node.field.column)}[${sql.lit(node.position.index + 1)}]`,
          node.field.element,
        );
      }
      const table = context.tables.table(node.field.table).descriptor.name;
      const alias = context.alias('t');
      return sql`coalesce((SELECT ${typedKey(sql.id(alias, 'value'), node.field.element)} FROM ${sql.id(
        table,
      )} AS ${sql.id(alias)} WHERE ${childOf(alias, scope)} ORDER BY ${sql.id(
        alias,
        ORD_COLUMN,
      )} OFFSET ${sql.lit(node.position.index)} LIMIT 1), ${NULL_KEY})`;
    }
    case 'childElement':
      throw new StoreQueryError(`Cannot sort by the subdocument "${resolved.path}"`);
    case 'field': {
      const { field } = node;
      switch (field.kind) {
        case 'scalar':
          return typedKey(sql.id(scope.alias, field.column), field.type);
        case 'array':
          return arrayKey(context, sql.id(scope.alias, field.column), field.element, ascending);
        case 'elements':
          return elementsKey(context, scope, field, ascending);
        case 'json':
          return jsonSortKey(context, scope, field, [], ascending);
        case 'object':
        case 'children':
          throw new StoreQueryError(
            `Cannot sort by "${resolved.path}": sorting by an object or an array of subdocuments is not supported`,
          );
      }
    }
  }
}

/** The key of a path through child tables: `null` for a missing or empty array, else min or max. */
function hopKey(
  context: QueryContext,
  outer: QueryScope,
  hops: readonly PathHop[],
  resolved: ResolvedPath,
  ascending: boolean,
): SqlFragment {
  if (hops.length === 0) {
    return nodeKey(context, outer, resolved, ascending);
  }
  const [hop, ...rest] = hops;
  const alias = context.alias('c');
  const scope: QueryScope = { table: hop.table, alias };
  const inner = hopKey(context, scope, rest, resolved, ascending);
  const table = sql.id(hop.table.descriptor.name);
  if (hop.position) {
    if (hop.position.kind !== 'index') {
      throw new StoreQueryError(`Cannot sort by the positional path "${resolved.path}"`);
    }
    return sql`coalesce((SELECT ${inner} FROM ${table} AS ${sql.id(alias)} WHERE ${childOf(
      alias,
      outer,
    )} ORDER BY ${sql.id(alias, ORD_COLUMN)} OFFSET ${sql.lit(hop.position.index)} LIMIT 1), ${NULL_KEY})`;
  }
  const count = sql.id(outer.alias, hop.field.column);
  const extreme = aggregateKey(
    (aggregate) =>
      sql`(SELECT ${aggregate(inner)} FROM ${table} AS ${sql.id(alias)} WHERE ${childOf(alias, outer)})`,
    ascending,
  );
  return sql`CASE WHEN ${count} IS NULL OR ${count} = 0 THEN ${NULL_KEY} ELSE ${extreme} END`;
}

/** One `ORDER BY` item for `path` in `direction`. */
function sortItem(
  context: QueryContext,
  scope: QueryScope,
  path: string,
  direction: 1 | -1,
): SqlFragment {
  const resolved = resolveQueryPath(context, scope, path);
  const ascending = direction === 1;
  const order = ascending ? sql`ASC` : sql`DESC`;
  const { node } = resolved;
  if (resolved.hops.length === 0 && node.kind === 'field' && node.field.kind === 'scalar') {
    const nulls = ascending ? sql`NULLS FIRST` : sql`NULLS LAST`;
    return sql`${sql.id(scope.alias, node.field.column)} ${order} ${nulls}`;
  }
  const key = hopKey(context, scope, resolved.hops, resolved, ascending);
  return sql`(${key}) ${COLLATE_C} ${order}`;
}

/** The `ORDER BY` items of `sort` (most significant first) over the rows of `scope`. */
export function translateSort(
  context: QueryContext,
  scope: QueryScope,
  sort: Record<string, unknown>,
): SqlFragment[] {
  if (!isPlainRecord(sort)) {
    throw new StoreQueryError('A sort must be a record of paths and directions');
  }
  return Object.entries(sort).map(([path, direction]) => {
    if (direction !== 1 && direction !== -1) {
      throw new StoreQueryError(`The sort direction of "${path}" must be 1 or -1`);
    }
    return sortItem(context, scope, path, direction);
  });
}

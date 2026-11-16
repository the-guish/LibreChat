/**
 * Filters → SQL (docs/postgres-port/PHASE4.md §2.1, §2.2): a `StoreFilter`, cast by R1's caster,
 * translated to a `WHERE` condition over the descriptor's typed columns, child tables, element
 * tables and `json` columns. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Each path is resolved by R1's resolver to the node it reaches (`resolve.ts`), which becomes a
 * {@link FilterLeaf}: the SQL of "some candidate passes", "some candidate is missing" and their
 * combinations, by storage:
 * - scalar column: the column (`c = $1`, `c > $1`, `c ~ $1`); `null` matches `c IS NULL`;
 *   `$exists` follows the `_nulls` rule (R1's `presenceSql`/`absenceSql`);
 * - scalar array (`T[]`): `c @> ARRAY[$1]` and `c && $1` (GIN), ranges and regular expressions
 *   on `unnest(c)`, `$size` on `cardinality(c)`;
 * - element table: `EXISTS` over its rows (a btree on `value` serves ranges and prefixes);
 * - object path or whole child array: the shape column (`null`, `$exists`, `$size`, `[]`);
 * - path inside a child array (`a.f`): `EXISTS` over the child rows, the rest of the path
 *   resolved in the child table; `a.0.f` reads the element at that position;
 * - `json` column: `jsonpath.ts`.
 * MongoDB's semantics (§2.2): `null` matches missing; `$ne` and `$nin` are the negation of
 * equality and `$in`, so they match a missing field; equality with a value matches an array
 * holding it; several operators on one path each hold on their own; `$or`, `$and` and `$nor`
 * compose.
 *
 * Supported: the query language (`ports/query.ts`), plus `$eq`, `$nor`, `$size`, equality with an
 * array (`[]` included) and numeric path segments (§2.1). Refused with a `StoreQueryError`: the
 * operators of unit C2 (`$elemMatch`, `$all`, `$not`, `$type`, `$mod`, `$bits*`), `$expr`,
 * `$where`, `$text`, equality with an object, a path the schema does not declare (R9), and
 * whatever R1's caster refuses.
 */
import type {
  FilterLeaf,
  QueryScope,
  QueryContext,
  ResolvedPath,
  RangeOperator,
  ValuePredicate,
} from './resolve';
import type { ColumnDescriptor, FieldDescriptor, ScalarType } from '../schema/descriptor';
import type { PathHop, PathPosition } from '../records/paths';
import type { SqlFragment } from './sql';
import {
  or,
  and,
  not,
  sql,
  TRUE,
  FALSE,
  param,
  COLLATE_C,
  regexMatch,
  scalarParam,
  arrayColumnType,
  scalarParamType,
  rangeOperatorSql,
} from './sql';
import { childOf, absence, presence, listedNull, ORD_COLUMN, resolveQueryPath } from './resolve';
import { isPlainRecord } from '../records/extra';
import { StoreQueryError } from '~/ports/query';
import { jsonFilterLeaf } from './jsonpath';
import { translateRegex } from './regex';

/* ------------------------------------------------------------------------------------------ */
/* Typed values                                                                                */
/* ------------------------------------------------------------------------------------------ */

const STRING_TYPES: ReadonlySet<ScalarType> = new Set(['string', 'objectId', 'objectIdOrString']);

/** The test of `predicate` on one typed value `x` of `type` (a column, an element, a row value). */
function typedTest(
  x: SqlFragment,
  type: ScalarType,
  predicate: ValuePredicate,
  path: string,
): SqlFragment {
  switch (predicate.kind) {
    case 'eq':
      return sql`${x} = ${scalarParam(predicate.value, type)}`;
    case 'in':
      return sql`${x} = ANY (${param(predicate.values, `${scalarParamType(type)}[]`)})`;
    case 'isNull':
      return sql`${x} IS NULL`;
    case 'any':
      return TRUE;
    case 'range': {
      if (type === 'buffer') {
        throw new StoreQueryError(`${predicate.operator} cannot compare the binary path "${path}"`);
      }
      const operand = scalarParam(predicate.value, type);
      const op = rangeOperatorSql(predicate.operator);
      return STRING_TYPES.has(type)
        ? sql`${x} ${op} (${operand} ${COLLATE_C})`
        : sql`${x} ${op} ${operand}`;
    }
    case 'regex':
      if (type !== 'string' && type !== 'objectIdOrString') {
        throw new StoreQueryError(`$regex cannot match the path "${path}"`);
      }
      return regexMatch(x, predicate.regex);
    case 'size':
    case 'arrayEq':
      return FALSE;
  }
}

function refuseOn(path: string, what: string): StoreQueryError {
  return new StoreQueryError(`${what} is not supported on the path "${path}"`);
}

/* ------------------------------------------------------------------------------------------ */
/* Leaves                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** A scalar column of the scope's rows. */
function columnLeaf(
  scope: QueryScope,
  field: Extract<FieldDescriptor, { kind: 'scalar' }>,
): FilterLeaf {
  const column = sql.id(scope.alias, field.column);
  return {
    some: (predicate) => {
      if (predicate.kind === 'isNull') {
        return sql`(${column} IS NULL AND ${listedNull(scope, field.path)})`;
      }
      if (predicate.kind === 'any') {
        return presence(scope, field.column, field.path);
      }
      return typedTest(column, field.type, predicate, field.path);
    },
    missing: () => absence(scope, field.column, field.path),
    nullOrMissing: () => sql`${column} IS NULL`,
    absent: () => absence(scope, field.column, field.path),
  };
}

/** A scalar array column (`T[]`) of the scope's rows. */
function arrayLeaf(
  context: QueryContext,
  scope: QueryScope,
  field: Extract<FieldDescriptor, { kind: 'array' }>,
): FilterLeaf {
  const column = sql.id(scope.alias, field.column);
  const descriptor = scope.table.columns.get(field.column) as ColumnDescriptor;
  const arrayType = arrayColumnType(descriptor);
  const hasNull = sql`array_position(${column}, NULL) IS NOT NULL`;
  const elements = (predicate: ValuePredicate) => {
    const alias = context.alias('e');
    return sql`EXISTS (SELECT 1 FROM unnest(${column}) AS ${sql.id(alias)} (v) WHERE ${typedTest(
      sql.id(alias, 'v'),
      field.element,
      predicate,
      field.path,
    )})`;
  };
  return {
    some: (predicate) => {
      switch (predicate.kind) {
        case 'eq':
          return sql`${column} @> ${param([predicate.value], arrayType)}`;
        case 'in':
          return sql`${column} && ${param(predicate.values, arrayType)}`;
        case 'isNull':
          return or([sql`(${column} IS NULL AND ${listedNull(scope, field.path)})`, hasNull]);
        case 'any':
          return presence(scope, field.column, field.path);
        case 'size':
          return sql`cardinality(${column}) = ${sql.lit(predicate.size)}`;
        case 'arrayEq':
          return sql`${column} = ${param(predicate.values, arrayType)}`;
        default:
          return elements(predicate);
      }
    },
    missing: () => absence(scope, field.column, field.path),
    nullOrMissing: () => sql`(${column} IS NULL OR ${hasNull})`,
    absent: () => absence(scope, field.column, field.path),
  };
}

/** A scalar array stored in an element table (`<table>__<path>(_parent, _ord, value)`). */
function elementsLeaf(
  context: QueryContext,
  scope: QueryScope,
  field: Extract<FieldDescriptor, { kind: 'elements' }>,
): FilterLeaf {
  const count = sql.id(scope.alias, field.column);
  const table = context.tables.table(field.table);
  const valueType = arrayColumnType(table.columns.get('value') as ColumnDescriptor);
  const rows = (condition: (value: SqlFragment) => SqlFragment) => {
    const alias = context.alias('t');
    return sql`EXISTS (SELECT 1 FROM ${sql.id(table.descriptor.name)} AS ${sql.id(alias)} WHERE ${childOf(
      alias,
      scope,
    )} AND ${condition(sql.id(alias, 'value'))})`;
  };
  return {
    some: (predicate) => {
      switch (predicate.kind) {
        case 'any':
          return presence(scope, field.column, field.path);
        case 'size':
          return sql`${count} = ${sql.lit(predicate.size)}`;
        case 'arrayEq': {
          if (predicate.values.length === 0) {
            return sql`${count} = 0`;
          }
          const alias = context.alias('t');
          return sql`ARRAY(SELECT ${sql.id(alias, 'value')} FROM ${sql.id(table.descriptor.name)} AS ${sql.id(
            alias,
          )} WHERE ${childOf(alias, scope)} ORDER BY ${sql.id(alias, ORD_COLUMN)}) = ${param(
            predicate.values,
            `${valueType}[]`,
          )}`;
        }
        case 'isNull':
          return or([
            sql`(${count} IS NULL AND ${listedNull(scope, field.path)})`,
            rows((value) => sql`${value} IS NULL`),
          ]);
        default:
          return rows((value) => typedTest(value, field.element, predicate, field.path));
      }
    },
    missing: () => absence(scope, field.column, field.path),
    nullOrMissing: () => or([sql`${count} IS NULL`, rows((value) => sql`${value} IS NULL`)]),
    absent: () => absence(scope, field.column, field.path),
  };
}

/** An object path (its shape column) or a whole child array (its element count). */
function shapeLeaf(
  scope: QueryScope,
  field: Extract<FieldDescriptor, { kind: 'object' | 'children' }>,
): FilterLeaf {
  const column = sql.id(scope.alias, field.column);
  return {
    some: (predicate) => {
      switch (predicate.kind) {
        case 'isNull':
          return sql`(${column} IS NULL AND ${listedNull(scope, field.path)})`;
        case 'any':
          return presence(scope, field.column, field.path);
        case 'size':
          if (field.kind === 'children') {
            return sql`${column} = ${sql.lit(predicate.size)}`;
          }
          return FALSE;
        case 'arrayEq':
          if (field.kind === 'children' && predicate.values.length === 0) {
            return sql`${column} = 0`;
          }
          throw refuseOn(field.path, 'Equality with a non-empty array');
        default:
          throw refuseOn(
            field.path,
            field.kind === 'object'
              ? 'Comparing an object with a value'
              : 'Comparing an array of subdocuments with a value (use $elemMatch, unit C2)',
          );
      }
    },
    missing: () => absence(scope, field.column, field.path),
    nullOrMissing: () => sql`${column} IS NULL`,
    absent: () => absence(scope, field.column, field.path),
  };
}

/**
 * One element of a `T[]` column (`tags.0`). MongoDB reads a numeric segment on an array as the
 * element at that index; an index past the end reaches nothing (not "missing"), so `null` matches
 * a missing or `null` array, or a `null` element at the index, but not a shorter array.
 */
function arrayElementLeaf(
  scope: QueryScope,
  field: Extract<FieldDescriptor, { kind: 'array' }>,
  index: number,
): FilterLeaf {
  const column = sql.id(scope.alias, field.column);
  const element = sql`${column}[${sql.lit(index + 1)}]`;
  const inRange = sql`coalesce(cardinality(${column}), 0) > ${sql.lit(index)}`;
  return {
    some: (predicate) => {
      if (predicate.kind === 'any') return inRange;
      return and([inRange, typedTest(element, field.element, predicate, field.path)]);
    },
    missing: () => sql`${column} IS NULL`,
    nullOrMissing: () => or([sql`${column} IS NULL`, and([inRange, sql`${element} IS NULL`])]),
    absent: () => not(inRange),
  };
}

/** The rows of a child or element table of the outer scope's row, or the one at a position. */
function childRows(
  context: QueryContext,
  table: string,
  outer: QueryScope,
  alias: string,
  position: PathPosition | undefined,
): SqlFragment {
  if (!position) {
    return sql`${sql.id(table)} AS ${sql.id(alias)} WHERE ${childOf(alias, outer)}`;
  }
  if (position.kind !== 'index') {
    throw new StoreQueryError('Positional operators ($, $[]) are not supported in filters');
  }
  const inner = context.alias('p');
  return sql`(SELECT * FROM ${sql.id(table)} AS ${sql.id(inner)} WHERE ${childOf(
    inner,
    outer,
  )} ORDER BY ${sql.id(inner, ORD_COLUMN)} OFFSET ${sql.lit(position.index)} LIMIT 1) AS ${sql.id(
    alias,
  )} WHERE TRUE`;
}

/** One element of an element table (`nameTokens.0`), as {@link arrayElementLeaf}. */
function elementsElementLeaf(
  context: QueryContext,
  scope: QueryScope,
  field: Extract<FieldDescriptor, { kind: 'elements' }>,
  position: PathPosition,
): FilterLeaf {
  const table = context.tables.table(field.table).descriptor.name;
  const row = (condition: (value: SqlFragment) => SqlFragment) => {
    const alias = context.alias('t');
    return sql`EXISTS (SELECT 1 FROM ${childRows(context, table, scope, alias, position)} AND ${condition(
      sql.id(alias, 'value'),
    )})`;
  };
  const exists = () => row(() => TRUE);
  const arrayMissing = sql`${sql.id(scope.alias, field.column)} IS NULL`;
  return {
    some: (predicate) => {
      if (predicate.kind === 'any') return exists();
      return row((value) => typedTest(value, field.element, predicate, field.path));
    },
    missing: () => arrayMissing,
    nullOrMissing: () => or([arrayMissing, row((value) => sql`${value} IS NULL`)]),
    absent: () => not(exists()),
  };
}

/**
 * One element of a child array as a whole (`items.0`). Besides the element at the index, MongoDB
 * also reads the segment as a field name in every element, which subdocuments never declare: so
 * a non-empty array has a "missing" candidate, as has a missing or `null` one.
 */
function childElementLeaf(
  context: QueryContext,
  scope: QueryScope,
  count: string,
  table: string,
  position: PathPosition,
  path: string,
): FilterLeaf {
  const exists = () => {
    const alias = context.alias('c');
    return sql`EXISTS (SELECT 1 FROM ${childRows(context, table, scope, alias, position)})`;
  };
  const missing = () => elementFieldMissing(scope, count);
  return {
    some: (predicate) => {
      if (predicate.kind === 'any') return exists();
      if (predicate.kind === 'isNull') return FALSE;
      throw refuseOn(path, 'Comparing a subdocument with a value');
    },
    missing,
    nullOrMissing: missing,
    absent: () => not(exists()),
  };
}

/**
 * Where a numeric segment follows a child array (`items.1`, `items.1.sku`), MongoDB also reads it
 * as a field of each element, which subdocuments never declare: a "missing" candidate whenever the
 * array is missing, `null` or not empty.
 */
function elementFieldMissing(scope: QueryScope, count: string): SqlFragment {
  return sql`coalesce(${sql.id(scope.alias, count)}, 1) > 0`;
}

/** A path inside a child array: conditions on the child rows (`EXISTS`). */
function hopLeaf(
  context: QueryContext,
  outer: QueryScope,
  hop: PathHop,
  inner: (scope: QueryScope) => FilterLeaf,
): FilterLeaf {
  const alias = context.alias('c');
  const scope: QueryScope = { table: hop.table, alias };
  const leaf = inner(scope);
  const table = hop.table.descriptor.name;
  const rows = (condition: SqlFragment) =>
    sql`EXISTS (SELECT 1 FROM ${childRows(context, table, outer, alias, hop.position)} AND ${condition})`;
  /**
   * A candidate is missing because of the array itself: it is missing or `null`; after a numeric
   * segment (`a.1.f`), also when it is not empty (see {@link elementFieldMissing}).
   */
  const arrayMissing = (): SqlFragment =>
    hop.position
      ? elementFieldMissing(outer, hop.field.column)
      : sql`${sql.id(outer.alias, hop.field.column)} IS NULL`;
  return {
    some: (predicate) => rows(leaf.some(predicate)),
    missing: () => or([arrayMissing(), rows(leaf.missing())]),
    nullOrMissing: () => or([arrayMissing(), rows(leaf.nullOrMissing())]),
    absent: () => not(rows(leaf.some({ kind: 'any' }))),
  };
}

/** The leaf of a resolved path, the hops crossed from `scope`. */
function leafOf(context: QueryContext, scope: QueryScope, resolved: ResolvedPath): FilterLeaf {
  const build = (current: QueryScope, hopIndex: number): FilterLeaf => {
    if (hopIndex < resolved.hops.length) {
      return hopLeaf(context, current, resolved.hops[hopIndex], (inner) =>
        build(inner, hopIndex + 1),
      );
    }
    const { node } = resolved;
    switch (node.kind) {
      case 'json':
        return jsonFilterLeaf(context, current, node.field, node.subpath);
      case 'element':
        if (node.position.kind !== 'index') {
          throw new StoreQueryError('Positional operators ($, $[]) are not supported in filters');
        }
        return node.field.kind === 'array'
          ? arrayElementLeaf(current, node.field, node.position.index)
          : elementsElementLeaf(context, current, node.field, node.position);
      case 'childElement':
        return childElementLeaf(
          context,
          current,
          node.field.column,
          node.table.descriptor.name,
          node.position,
          resolved.path,
        );
      case 'field': {
        const { field } = node;
        switch (field.kind) {
          case 'scalar':
            return columnLeaf(current, field);
          case 'array':
            return arrayLeaf(context, current, field);
          case 'elements':
            return elementsLeaf(context, current, field);
          case 'object':
          case 'children':
            return shapeLeaf(current, field);
          case 'json':
            return jsonFilterLeaf(context, current, field, []);
        }
      }
    }
  };
  return build(scope, 0);
}

/* ------------------------------------------------------------------------------------------ */
/* Conditions                                                                                  */
/* ------------------------------------------------------------------------------------------ */

const C2_OPERATORS: ReadonlySet<string> = new Set([
  '$elemMatch',
  '$all',
  '$not',
  '$type',
  '$mod',
  '$bitsAllSet',
  '$bitsAnySet',
  '$bitsAllClear',
  '$bitsAnyClear',
]);

function isOperatorRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

function unsupportedOperator(operator: string, path?: string): StoreQueryError {
  const where = path ? ` on "${path}"` : '';
  if (C2_OPERATORS.has(operator)) {
    return new StoreQueryError(
      `The filter operator ${operator}${where} is not supported by the translator yet (unit C2)`,
    );
  }
  return new StoreQueryError(`Unsupported filter operator ${operator}${where}`);
}

/** Whether `value` is an id object (`toHexString`). */
function isIdObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === 'function'
  );
}

/** Checks an equality operand: a scalar, a `Date`, a `Buffer`, an id. */
function assertScalarOperand(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    isIdObject(value)
  ) {
    return;
  }
  if (Array.isArray(value)) {
    throw new StoreQueryError(`Equality with a nested array is not supported on "${path}"`);
  }
  throw new StoreQueryError(`Equality with an object is not supported on "${path}"`);
}

/** Equality with `value` (MongoDB's `field: value`). */
function equality(leaf: FilterLeaf, value: unknown, path: string): SqlFragment {
  if (value === null || value === undefined) {
    return leaf.nullOrMissing();
  }
  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (item !== null) assertScalarOperand(item, path);
    });
    return leaf.some({ kind: 'arrayEq', values: value });
  }
  assertScalarOperand(value, path);
  return leaf.some({ kind: 'eq', value });
}

/** `$in`: equality with one of the values. */
function membership(leaf: FilterLeaf, values: unknown, path: string): SqlFragment {
  if (!Array.isArray(values)) {
    throw new StoreQueryError(`$in on "${path}" takes an array`);
  }
  const scalars: unknown[] = [];
  const parts: SqlFragment[] = [];
  let withNull = false;
  for (const value of values) {
    if (value === null || value === undefined) {
      withNull = true;
    } else if (Array.isArray(value) || value instanceof RegExp) {
      if (value instanceof RegExp) {
        throw new StoreQueryError(`$in with regular expressions is not supported on "${path}"`);
      }
      parts.push(equality(leaf, value, path));
    } else {
      assertScalarOperand(value, path);
      scalars.push(value);
    }
  }
  if (scalars.length === 1) {
    parts.unshift(leaf.some({ kind: 'eq', value: scalars[0] }));
  } else if (scalars.length > 1) {
    parts.unshift(leaf.some({ kind: 'in', values: scalars }));
  }
  if (withNull) {
    parts.push(leaf.nullOrMissing());
  }
  return or(parts);
}

function regexPredicate(source: string, flags: string): ValuePredicate {
  return { kind: 'regex', regex: translateRegex(source, flags) };
}

/** A range; a `null` operand (a cast of `''` to a number) behaves as MongoDB's `$gte: null`. */
function range(
  leaf: FilterLeaf,
  operator: RangeOperator,
  value: unknown,
  path: string,
): SqlFragment {
  if (value === null || value === undefined) {
    return operator === '$gte' || operator === '$lte' ? leaf.nullOrMissing() : FALSE;
  }
  if (Array.isArray(value) || isPlainRecord(value)) {
    throw new StoreQueryError(`${operator} on "${path}" takes a scalar`);
  }
  return leaf.some({ kind: 'range', operator, value });
}

/** The SQL of an operator record on one path. */
function operators(leaf: FilterLeaf, record: Record<string, unknown>, path: string): SqlFragment {
  const parts: SqlFragment[] = [];
  for (const [operator, value] of Object.entries(record)) {
    switch (operator) {
      case '$eq':
        parts.push(equality(leaf, value, path));
        break;
      case '$ne':
        parts.push(not(equality(leaf, value, path)));
        break;
      case '$in':
        parts.push(membership(leaf, value, path));
        break;
      case '$nin':
        parts.push(not(membership(leaf, value, path)));
        break;
      case '$exists':
        if (value === null || value === undefined) {
          break;
        }
        parts.push(value ? leaf.some({ kind: 'any' }) : leaf.absent());
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        parts.push(range(leaf, operator, value, path));
        break;
      case '$regex': {
        const options = record.$options;
        if (options !== undefined && typeof options !== 'string') {
          throw new StoreQueryError(`$options on "${path}" takes a string`);
        }
        if (value instanceof RegExp) {
          parts.push(leaf.some(regexPredicate(value.source, options ?? value.flags)));
        } else if (typeof value === 'string') {
          parts.push(leaf.some(regexPredicate(value, options ?? '')));
        } else {
          throw new StoreQueryError(`$regex on "${path}" takes a pattern`);
        }
        break;
      }
      case '$options':
        if (!('$regex' in record)) {
          throw new StoreQueryError(`$options on "${path}" is only allowed with $regex`);
        }
        break;
      case '$size': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new StoreQueryError(`$size on "${path}" takes a non-negative integer`);
        }
        parts.push(leaf.some({ kind: 'size', size: value }));
        break;
      }
      case '$comment':
        break;
      default:
        throw unsupportedOperator(operator, path);
    }
  }
  return and(parts);
}

/** The SQL of the condition a filter gives one path. */
function condition(leaf: FilterLeaf, value: unknown, path: string): SqlFragment {
  if (value instanceof RegExp) {
    return leaf.some(regexPredicate(value.source, value.flags));
  }
  if (isOperatorRecord(value)) {
    return operators(leaf, value, path);
  }
  return equality(leaf, value, path);
}

/**
 * The `WHERE` condition of a filter whose values are already cast (R1's `castFilterOn`), over the
 * rows of `scope`. Throws a `StoreQueryError` for what the translator does not support.
 */
export function translateCastFilter(
  context: QueryContext,
  scope: QueryScope,
  filter: Record<string, unknown>,
): SqlFragment {
  if (!isPlainRecord(filter)) {
    throw new StoreQueryError('A filter must be an object');
  }
  const parts: SqlFragment[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new StoreQueryError(`${key} takes a non-empty array of filters`);
      }
      const clauses = value.map((clause) =>
        translateCastFilter(context, scope, clause as Record<string, unknown>),
      );
      if (key === '$and') parts.push(and(clauses));
      else if (key === '$or') parts.push(or(clauses));
      else parts.push(not(or(clauses)));
      continue;
    }
    if (key === '$comment') {
      continue;
    }
    if (key.startsWith('$')) {
      throw unsupportedOperator(key);
    }
    const resolved = resolveQueryPath(context, scope, key);
    parts.push(condition(leafOf(context, scope, resolved), value, key));
  }
  return and(parts);
}

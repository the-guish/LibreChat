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
 * array (`[]` included) and numeric path segments (§2.1), and C2's operators:
 * - `$elemMatch`: on a child array, `EXISTS` over its rows with the element filter; on `T[]` and
 *   element tables, the operators on each element (value form); in `json`, an array candidate
 *   with an element that is an object matching the filter (document form) or a value passing the
 *   operators (value form); elements are not unwrapped further, as in MongoDB;
 * - `$all` (each value, or each `$elemMatch`, held by some element), `$not` (the negation of an
 *   operator record or a regular expression, so it matches a missing field);
 * - `$type` (aliases, codes and lists; `number` is `int`, `double`, `long` and `decimal`): typed
 *   columns by their type (a Number is `int` when integral within 32 bits and not `-0`, as the
 *   driver writes it, `double` otherwise), `array` on arrays, `object` on objects and child
 *   elements, `null` on explicit `null`s; in `json` by the tagged encoding (ids are strings there,
 *   R7). Refused on the `objectIdOrString` override, which stores both as text;
 * - `$bitsAllSet`, `$bitsAnySet`, `$bitsAllClear`, `$bitsAnyClear` (a non-negative mask or bit
 *   positions 0 to 63) on numbers representable as signed 64-bit integers:
 *   `(v::bigint & mask) <op>`.
 * Refused with a `StoreQueryError`: `$mod` (no store method uses it), `$expr`, `$where`, `$text`,
 * equality with an object, a path the schema does not declare (R9), and whatever R1's caster
 * refuses. The extended evaluator (`../evaluator`) states the same semantics in JavaScript.
 */
import type {
  FilterLeaf,
  QueryScope,
  BitOperator,
  QueryContext,
  ElemMatchSql,
  ResolvedPath,
  RangeOperator,
  ValuePredicate,
} from './resolve';
import type { ColumnDescriptor, FieldDescriptor, ScalarType } from '../schema/descriptor';
import type { PathHop, PathPosition } from '../records/paths';
import type { BsonTypeName } from '../evaluator/values';
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
import {
  jsonIsObject,
  bitsCondition,
  jsonFilterLeaf,
  jsonSingleLeaf,
  jsonSubpathLeaf,
} from './jsonpath';
import { childOf, absence, presence, listedNull, ORD_COLUMN, resolveQueryPath } from './resolve';
import { bitMaskOf, isValueElemMatch } from '../evaluator/filter';
import { parseTypeOperand } from '../evaluator/values';
import { isPlainRecord } from '../records/extra';
import { StoreQueryError } from '~/ports/query';
import { translateRegex } from './regex';

/* ------------------------------------------------------------------------------------------ */
/* Typed values                                                                                */
/* ------------------------------------------------------------------------------------------ */

const STRING_TYPES: ReadonlySet<ScalarType> = new Set(['string', 'objectId', 'objectIdOrString']);

/**
 * A `double precision` value stored by MongoDB as a 32-bit integer: the driver serializes an
 * integral JavaScript number within 32 bits (but not `-0`) as `int`, any other as `double`.
 */
function int32Test(x: SqlFragment): SqlFragment {
  return sql`(${x} = trunc(${x}) AND ${x} BETWEEN -2147483648 AND 2147483647 AND ${x}::text <> '-0')`;
}

/** `$type` on one typed, non-`null` value of `type`. */
function typedTypeTest(
  x: SqlFragment,
  type: ScalarType,
  types: ReadonlySet<BsonTypeName>,
  path: string,
): SqlFragment {
  const parts: SqlFragment[] = [];
  switch (type) {
    case 'string':
      if (types.has('string')) parts.push(TRUE);
      break;
    case 'number':
      if (types.has('int') && types.has('double')) parts.push(TRUE);
      else if (types.has('int')) parts.push(int32Test(x));
      else if (types.has('double')) parts.push(not(int32Test(x)));
      break;
    case 'boolean':
      if (types.has('bool')) parts.push(TRUE);
      break;
    case 'date':
      if (types.has('date')) parts.push(TRUE);
      break;
    case 'objectId':
      if (types.has('objectId')) parts.push(TRUE);
      break;
    case 'buffer':
      if (types.has('binData')) parts.push(TRUE);
      break;
    case 'objectIdOrString':
      throw new StoreQueryError(
        `$type cannot tell ids from strings on "${path}" (stored as text, R7)`,
      );
  }
  return parts.length === 0 ? FALSE : and([sql`${x} IS NOT NULL`, or(parts)]);
}

/** A bit test on one typed value (numbers only: other types never match). */
function typedBitsTest(
  x: SqlFragment,
  type: ScalarType,
  predicate: Extract<ValuePredicate, { kind: 'bits' }>,
): SqlFragment {
  if (type !== 'number') {
    return FALSE;
  }
  return sql`CASE WHEN ${x} = trunc(${x}) AND ${x} >= -9223372036854775808::double precision AND ${x} < 9223372036854775808::double precision THEN ${bitsCondition(
    sql`(${x})::bigint`,
    predicate,
  )} END`;
}

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
    case 'type':
      return typedTypeTest(x, type, predicate.types, path);
    case 'bits':
      return typedBitsTest(x, type, predicate);
    case 'size':
    case 'arrayEq':
    case 'elemMatch':
      return FALSE;
  }
}

/**
 * One typed scalar value tested as itself (no array to unwrap): an element of a `T[]` or element
 * table under `$elemMatch`'s value form.
 */
function scalarValueLeaf(x: SqlFragment, type: ScalarType, path: string): FilterLeaf {
  return {
    some: (predicate) => {
      if (predicate.kind === 'isNull') return sql`${x} IS NULL`;
      if (predicate.kind === 'any') return TRUE;
      return typedTest(x, type, predicate, path);
    },
    missing: () => FALSE,
    nullOrMissing: () => sql`${x} IS NULL`,
    absent: () => FALSE,
  };
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
        case 'type':
          return or([
            predicate.types.has('array') ? sql`${column} IS NOT NULL` : FALSE,
            elements(predicate),
          ]);
        case 'elemMatch': {
          const alias = context.alias('e');
          return sql`EXISTS (SELECT 1 FROM unnest(${column}) AS ${sql.id(alias)} (v) WHERE ${predicate.match.scalar(
            sql.id(alias, 'v'),
            field.element,
          )})`;
        }
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
        case 'type':
          return or([
            predicate.types.has('array') ? sql`${count} IS NOT NULL` : FALSE,
            rows((value) => typedTest(value, field.element, predicate, field.path)),
          ]);
        case 'elemMatch':
          return rows((value) => predicate.match.scalar(value, field.element));
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
  context: QueryContext,
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
        case 'type':
          if (field.kind === 'object') {
            return predicate.types.has('object') ? sql`${column} IS TRUE` : FALSE;
          }
          return or([
            predicate.types.has('array') ? sql`${column} IS NOT NULL` : FALSE,
            predicate.types.has('object') ? sql`${column} > 0` : FALSE,
          ]);
        case 'bits':
          return FALSE;
        case 'elemMatch': {
          if (field.kind === 'object') {
            return FALSE;
          }
          const alias = context.alias('c');
          const table = context.tables.table(field.table);
          return sql`EXISTS (SELECT 1 FROM ${sql.id(table.descriptor.name)} AS ${sql.id(
            alias,
          )} WHERE ${childOf(alias, scope)} AND ${predicate.match.children({ table, alias })})`;
        }
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
              : 'Comparing an array of subdocuments with a value (use $elemMatch)',
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
      if (predicate.kind === 'type') return predicate.types.has('object') ? exists() : FALSE;
      if (
        predicate.kind === 'isNull' ||
        predicate.kind === 'bits' ||
        predicate.kind === 'elemMatch'
      ) {
        return FALSE;
      }
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
            return shapeLeaf(context, current, field);
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

/** Operators MongoDB has that the translator refuses, with the reason. */
const REFUSED_OPERATORS: Readonly<Record<string, string>> = {
  $mod: 'no store method uses it',
  $expr: 'stores write such conditions as SQL',
  $text: 'search goes through MeiliSearch (D4)',
};

const LOGICAL = new Set(['$and', '$or', '$nor']);

function isOperatorRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

function unsupportedOperator(operator: string, path?: string): StoreQueryError {
  const where = path ? ` on "${path}"` : '';
  const reason = REFUSED_OPERATORS[operator];
  return new StoreQueryError(
    `Unsupported filter operator ${operator}${where}${reason ? ` (${reason})` : ''}`,
  );
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

/** `$type`: the BSON types other than `null` on values, and `null` as an explicit `null`. */
function typeCondition(leaf: FilterLeaf, operand: unknown): SqlFragment {
  const types = parseTypeOperand(operand);
  const parts: SqlFragment[] = [];
  const withNull = types.delete('null');
  if (types.size > 0) {
    parts.push(leaf.some({ kind: 'type', types }));
  }
  if (withNull) {
    parts.push(leaf.some({ kind: 'isNull' }));
  }
  return or(parts);
}

/**
 * The `$elemMatch` predicate of `spec` (cast already): the document form (a filter on each
 * element) or the value form (operators on each element), translated for whichever storage the
 * leaf holds the array in.
 */
function elemMatchPredicate(
  context: QueryContext,
  spec: unknown,
  path: string,
): Extract<ValuePredicate, { kind: 'elemMatch' }> {
  if (!isPlainRecord(spec) || Object.keys(spec).length === 0) {
    throw new StoreQueryError(`$elemMatch on "${path}" takes a non-empty object`);
  }
  const valueForm = isValueElemMatch(spec);
  const match: ElemMatchSql = {
    children: (scope) => {
      if (valueForm) {
        throw new StoreQueryError(
          `$elemMatch on the subdocument array "${path}" takes a filter on its elements`,
        );
      }
      return translateCastFilter(context, scope, spec);
    },
    scalar: (element, type) => {
      if (!valueForm) {
        throw new StoreQueryError(`$elemMatch on the scalar array "${path}" takes operators`);
      }
      return operators(context, scalarValueLeaf(element, type, path), spec, path);
    },
    json: (element) =>
      valueForm
        ? operators(context, jsonSingleLeaf(context, element), spec, path)
        : and([
            jsonIsObject(element),
            translateFilterWith(context, spec, (key) =>
              jsonSubpathLeaf(context, element, key.split('.')),
            ),
          ]),
  };
  return { kind: 'elemMatch', match };
}

/** The SQL of an operator record on one path. */
function operators(
  context: QueryContext,
  leaf: FilterLeaf,
  record: Record<string, unknown>,
  path: string,
): SqlFragment {
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
      case '$elemMatch':
        parts.push(leaf.some(elemMatchPredicate(context, value, path)));
        break;
      case '$all': {
        if (!Array.isArray(value)) {
          throw new StoreQueryError(`$all on "${path}" takes an array`);
        }
        if (value.length === 0) {
          parts.push(FALSE);
          break;
        }
        for (const item of value) {
          parts.push(
            isPlainRecord(item) && '$elemMatch' in item
              ? leaf.some(elemMatchPredicate(context, item.$elemMatch, path))
              : equality(leaf, item, path),
          );
        }
        break;
      }
      case '$not':
        if (value instanceof RegExp) {
          parts.push(not(leaf.some(regexPredicate(value.source, value.flags))));
        } else if (isOperatorRecord(value)) {
          parts.push(not(operators(context, leaf, value, path)));
        } else {
          throw new StoreQueryError(
            `$not on "${path}" takes an operator record or a regular expression`,
          );
        }
        break;
      case '$type':
        parts.push(typeCondition(leaf, value));
        break;
      case '$bitsAllSet':
      case '$bitsAnySet':
      case '$bitsAllClear':
      case '$bitsAnyClear':
        parts.push(
          leaf.some({
            kind: 'bits',
            operator: operator as BitOperator,
            mask: BigInt.asIntN(64, bitMaskOf(operator, value)).toString(),
          }),
        );
        break;
      case '$comment':
        break;
      default:
        throw unsupportedOperator(operator, path);
    }
  }
  return and(parts);
}

/** The SQL of the condition a filter gives one path. */
function condition(
  context: QueryContext,
  leaf: FilterLeaf,
  value: unknown,
  path: string,
): SqlFragment {
  if (value instanceof RegExp) {
    return leaf.some(regexPredicate(value.source, value.flags));
  }
  if (isOperatorRecord(value)) {
    return operators(context, leaf, value, path);
  }
  return equality(leaf, value, path);
}

/**
 * The `WHERE` condition of a filter whose values are cast already, with each path's leaf given by
 * `leafFor` (the scope's resolved paths, or subpaths of a `json` element).
 */
export function translateFilterWith(
  context: QueryContext,
  filter: Record<string, unknown>,
  leafFor: (path: string) => FilterLeaf,
): SqlFragment {
  if (!isPlainRecord(filter)) {
    throw new StoreQueryError('A filter must be an object');
  }
  const parts: SqlFragment[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL.has(key)) {
      if (!Array.isArray(value) || value.length === 0) {
        throw new StoreQueryError(`${key} takes a non-empty array of filters`);
      }
      const clauses = value.map((clause) =>
        translateFilterWith(context, clause as Record<string, unknown>, leafFor),
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
    parts.push(condition(context, leafFor(key), value, key));
  }
  return and(parts);
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
  return translateFilterWith(context, filter, (key) =>
    leafOf(context, scope, resolveQueryPath(context, scope, key)),
  );
}

/**
 * The condition of `record` (an operator record, a value or a `RegExp`, cast already) on one
 * typed scalar value: the positional `$` of a `T[]` element (C2).
 */
export function translateScalarCondition(
  context: QueryContext,
  value: SqlFragment,
  type: ScalarType,
  record: unknown,
  path: string,
): SqlFragment {
  return condition(context, scalarValueLeaf(value, type, path), record, path);
}

/**
 * Paths into `json` columns (docs/postgres-port/PHASE4.md §1.3, §2.1, §2.2, §2.3): `Mixed`,
 * arrays of `Mixed` and `Map`s, queried by subpath. Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * ## Filters
 * A condition on `col.a.b` is evaluated on the values MongoDB's path walk reaches (the reference
 * evaluator's candidates), enumerated in SQL over `col::jsonb`:
 * - each step takes key `a` of an object; through an array it takes `a` of each element that is
 *   an object (one level: nested arrays and scalars give nothing); a missing key, or a scalar,
 *   `null` or tagged value (`{"$date"}`, `{"$binary"}`) where an object is needed, gives "missing"
 *   (SQL `NULL`); a numeric segment takes that element of an array (or that key of an object);
 * - the condition then holds for some candidate: equality with the value or with an element of an
 *   array candidate, `null` for missing or `null` (or an array holding `null`), ranges within the
 *   operand's type only (numbers numerically, strings by code point under `COLLATE "C"`, dates by
 *   their fixed-width ISO text), `$regex` on strings, `$exists` for any non-missing candidate.
 * Values are compared in their tagged JSON form (§1.3): a `Date` operand equals `{"$date": ...}`,
 * an id its hex string.
 *
 * This is exact where the lax jsonpath form of §2.1 is not (lax mode unwraps nested arrays in
 * comparisons and has no "missing" result), so lax jsonpath serves as an index prefilter only:
 * where a GIN `jsonb_path_ops` index covers the column, a positive equality or `$in` also gets
 * `col::jsonb @? 'lax $."a"."b" ? (@ == ...)'`, a necessary condition the index answers.
 *
 * **Hinted subpaths** (§1.6: no array on the path, a scalar leaf, enforced by a `CHECK`) compare
 * the descriptor's expression `(col::jsonb #> '{a,b}')` directly, which the btree expression
 * indexes serve. String ranges there extract the text under `COLLATE "C"`: `jsonb` orders strings
 * by the database collation, whereas jsonpath and MongoDB order them by code point (checked by
 * `regex.postgres.spec.ts` on an ICU database).
 *
 * ## Sorts
 * A sort key is `lc_sort_key` (F3's helper: MongoDB's type rank, then the value; an array's
 * minimum ascending or maximum descending) over the values MongoDB's sort walk reaches (a missing
 * value, a non-object element and an empty array on the way count as `null`), the minimum taken
 * ascending, the maximum descending, compared under `COLLATE "C"`.
 */
import type { FilterLeaf, QueryContext, QueryScope, ValuePredicate } from './resolve';
import type { FieldDescriptor } from '../schema/descriptor';
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
  jsonbParam,
  regexMatch,
  rangeOperatorSql,
} from './sql';
import { listedNull, presence, absence } from './resolve';
import { quoteIdentifier } from '../schema/naming';
import { StoreQueryError } from '~/ports/query';
import { toTaggedJson } from '../values';

type JsonField = Extract<FieldDescriptor, { kind: 'json' }>;

const NUMERIC = /^\d+$/;

/** The JSON text of a (cast) operand in the tagged encoding of §1.3. */
export function encodeJsonOperand(value: unknown): string {
  return JSON.stringify(toTaggedJson(value, { countNul: false }));
}

/** The kind of JSON value an operand encodes to. */
function operandKind(value: unknown): 'number' | 'string' | 'boolean' | 'date' | 'other' {
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'other';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  const tagged = toTaggedJson(value, { countNul: false });
  return typeof tagged === 'string' ? 'string' : 'other';
}

/** The text of a string operand (an id as its hex). */
function operandText(value: unknown): string {
  return typeof value === 'string' ? value : (toTaggedJson(value, { countNul: false }) as string);
}

/** `(alias.col)::jsonb`. */
export function jsonColumn(scope: QueryScope, field: JsonField): SqlFragment {
  return sql`(${sql.id(scope.alias, field.column)})::jsonb`;
}

/** A tagged value (`{"$date"}`, `{"$binary"}`): a date or binary, not an object, for MongoDB. */
function isTag(value: SqlFragment): SqlFragment {
  return sql`(${value} ? '$date' OR ${value} ? '$binary')`;
}

/** An object MongoDB walks into (a plain object, not a tagged value). */
function isPlainObject(value: SqlFragment): SqlFragment {
  return sql`(jsonb_typeof(${value}) = 'object' AND NOT ${isTag(value)})`;
}

/** The elements of `value` when it is an array (no rows otherwise). */
function elementsOf(value: SqlFragment): SqlFragment {
  return sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} END)`;
}

/* ------------------------------------------------------------------------------------------ */
/* Candidate enumeration                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** The `FROM` clause enumerating the candidates of a subpath, and the column holding them. */
interface CandidateChain {
  from: SqlFragment;
  value: SqlFragment;
}

/** One filter step from `x` by `segment`. */
function filterStep(x: SqlFragment, segment: string, alias: string): SqlFragment {
  const key = sql.lit(segment);
  const element = sql.id(`${alias}_e`, 'e');
  if (NUMERIC.test(segment)) {
    /**
     * On an array, MongoDB takes the element at the index (none past the end) and also reads the
     * segment as a key of each object element; on an object, it is a key.
     */
    const index = sql.lit(Number(segment));
    return sql`(SELECT CASE WHEN ${isPlainObject(x)} THEN ${x} -> ${key} END AS v
      WHERE jsonb_typeof(${x}) IS DISTINCT FROM 'array'
    UNION ALL
    SELECT ${x} -> ${index} WHERE jsonb_typeof(${x}) = 'array' AND ${x} -> ${index} IS NOT NULL
    UNION ALL
    SELECT ${element} -> ${key} FROM ${elementsOf(x)} AS ${sql.id(`${alias}_e`)} (e)
      WHERE ${isPlainObject(element)}) AS ${sql.id(alias)}`;
  }
  return sql`(SELECT CASE WHEN ${isPlainObject(x)} THEN ${x} -> ${key} END AS v
      WHERE jsonb_typeof(${x}) IS DISTINCT FROM 'array'
    UNION ALL
    SELECT ${element} -> ${key} FROM ${elementsOf(x)} AS ${sql.id(`${alias}_e`)} (e)
      WHERE ${isPlainObject(element)}) AS ${sql.id(alias)}`;
}

/** One sort step: like a filter step, but a missing value, a non-object element and an empty array give `null`. */
function sortStep(x: SqlFragment, segment: string, alias: string): SqlFragment {
  if (NUMERIC.test(segment)) {
    return filterStep(x, segment, alias);
  }
  const key = sql.lit(segment);
  const element = sql.id(`${alias}_e`, 'e');
  return sql`(SELECT CASE WHEN ${isPlainObject(x)} THEN ${x} -> ${key} END AS v
      WHERE jsonb_typeof(${x}) IS DISTINCT FROM 'array'
    UNION ALL
    SELECT NULL::jsonb WHERE ${x} = '[]'::jsonb
    UNION ALL
    SELECT CASE WHEN ${isPlainObject(element)} THEN ${element} -> ${key} END
      FROM ${elementsOf(x)} AS ${sql.id(`${alias}_e`)} (e)) AS ${sql.id(alias)}`;
}

function candidateChain(
  context: QueryContext,
  base: SqlFragment,
  subpath: readonly string[],
  step: typeof filterStep,
): CandidateChain {
  const first = context.alias('j');
  const parts: SqlFragment[] = [sql`(SELECT ${base} AS v) AS ${sql.id(first)}`];
  let previous = sql.id(first, 'v');
  for (const segment of subpath) {
    const alias = context.alias('j');
    parts.push(sql`CROSS JOIN LATERAL ${step(previous, segment, alias)}`);
    previous = sql.id(alias, 'v');
  }
  return { from: sql.join(parts, sql` `), value: previous };
}

/* ------------------------------------------------------------------------------------------ */
/* Value tests                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** A range test on one JSON value `e`, within the operand's type. */
function jsonRange(e: SqlFragment, operator: ValuePredicate & { kind: 'range' }): SqlFragment {
  const op = rangeOperatorSql(operator.operator);
  switch (operandKind(operator.value)) {
    case 'number':
      return sql`CASE WHEN jsonb_typeof(${e}) = 'number' THEN ${e}::numeric ${op} ${param(operator.value, 'numeric')} END`;
    case 'string':
      return sql`CASE WHEN jsonb_typeof(${e}) = 'string' THEN (${e} #>> '{}') ${COLLATE_C} ${op} (${param(operandText(operator.value), 'text')} ${COLLATE_C}) END`;
    case 'boolean':
      return sql`CASE WHEN jsonb_typeof(${e}) = 'boolean' THEN ${e} ${op} ${jsonbParam(JSON.stringify(operator.value))} END`;
    case 'date':
      return sql`CASE WHEN jsonb_typeof(${e}) = 'object' AND jsonb_typeof(${e} -> '$date') = 'string' THEN (${e} ->> '$date') ${COLLATE_C} ${op} (${param((operator.value as Date).toISOString(), 'text')} ${COLLATE_C}) END`;
    default:
      throw new StoreQueryError(`${operator.operator} takes a number, a string or a Date`);
  }
}

/** The test of `predicate` on one JSON value `e` (no array unwrapping). */
function jsonScalarTest(e: SqlFragment, predicate: ValuePredicate): SqlFragment {
  switch (predicate.kind) {
    case 'eq':
      return sql`${e} = ${jsonbParam(encodeJsonOperand(predicate.value))}`;
    case 'in':
      return sql`${e} = ANY (${param(predicate.values.map(encodeJsonOperand), 'jsonb[]')})`;
    case 'isNull':
      return sql`${e} = 'null'::jsonb`;
    case 'range':
      return jsonRange(e, predicate);
    case 'regex':
      return sql`CASE WHEN jsonb_typeof(${e}) = 'string' THEN ${regexMatch(sql`(${e} #>> '{}')`, predicate.regex)} END`;
    case 'arrayEq':
      return sql`${e} = ${jsonbParam(encodeJsonOperand(predicate.values))}`;
    default:
      return FALSE;
  }
}

/** The test of `predicate` on a candidate `v`: the value, or an element of an array value. */
export function jsonValueTest(
  context: QueryContext,
  v: SqlFragment,
  predicate: ValuePredicate,
): SqlFragment {
  switch (predicate.kind) {
    case 'any':
      return TRUE;
    case 'size':
      return sql`CASE WHEN jsonb_typeof(${v}) = 'array' THEN jsonb_array_length(${v}) = ${sql.lit(predicate.size)} END`;
    default: {
      const alias = context.alias('x');
      const element = sql.id(alias, 'e');
      return sql`(${jsonScalarTest(v, predicate)} OR EXISTS (SELECT 1 FROM ${elementsOf(v)} AS ${sql.id(alias)} (e) WHERE ${jsonScalarTest(element, predicate)}))`;
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Index prefilter (lax jsonpath)                                                              */
/* ------------------------------------------------------------------------------------------ */

/** A jsonpath literal of a scalar operand, or `undefined` when it has none. */
function jsonPathLiteral(value: unknown): string | undefined {
  switch (operandKind(value)) {
    case 'number':
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(operandText(value));
    case 'boolean':
      return String(value);
    default:
      return undefined;
  }
}

/** The condition `@` must meet to equal `value`, in jsonpath; `undefined` when there is none. */
function jsonPathEquality(value: unknown): string | undefined {
  if (value instanceof Date) {
    return `@."$date" == ${JSON.stringify(value.toISOString())}`;
  }
  const literal = jsonPathLiteral(value);
  return literal === undefined ? undefined : `@ == ${literal}`;
}

/**
 * The lax jsonpath a positive equality or `$in` on `subpath` implies (`lax $."a"."b" ? (@ == 1 ||
 * @ == 2)`), for a GIN `jsonb_path_ops` index; `undefined` when the condition has none.
 */
export function laxEqualityPath(
  subpath: readonly string[],
  values: readonly unknown[],
): string | undefined {
  if (values.length === 0 || subpath.some((segment) => NUMERIC.test(segment))) {
    return undefined;
  }
  const tests: string[] = [];
  for (const value of values) {
    const test = jsonPathEquality(value);
    if (test === undefined) return undefined;
    tests.push(test);
  }
  const steps = subpath.map((segment) => `.${JSON.stringify(segment)}`).join('');
  return `lax $${steps} ? (${tests.join(' || ')})`;
}

/** The expression a GIN index of `table` keys `field` by (`("col"::jsonb)`), if one does. */
function hasJsonGinIndex(scope: QueryScope, field: JsonField): boolean {
  const expression = `(${quoteIdentifier(field.column)}::jsonb)`;
  return scope.table.descriptor.indexes.some(
    (index) => index.method === 'gin' && index.keys.some((key) => key.expression === expression),
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Filter leaves                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** The `#>` path literal of a hinted subpath (`'{"a","b"}'`), as the descriptor writes it. */
function hintPathLiteral(subpath: readonly string[]): SqlFragment {
  const elements = subpath.map((segment) => `"${segment.replace(/["\\]/g, (c) => `\\${c}`)}"`);
  return sql.lit(`{${elements.join(',')}}`);
}

/** A hinted subpath: no array on the way and a scalar leaf (§1.6), compared on `#>`. */
function hintedLeaf(scope: QueryScope, field: JsonField, subpath: readonly string[]): FilterLeaf {
  const value = sql`((${sql.id(scope.alias, field.column)})::jsonb #> ${hintPathLiteral(subpath)})`;
  const scalar = (v: unknown) => {
    const kind = operandKind(v);
    return kind === 'number' || kind === 'string' || kind === 'boolean';
  };
  const some = (predicate: ValuePredicate): SqlFragment => {
    switch (predicate.kind) {
      case 'eq':
        return scalar(predicate.value)
          ? sql`${value} = ${jsonbParam(encodeJsonOperand(predicate.value))}`
          : FALSE;
      case 'in': {
        const values = predicate.values.filter(scalar);
        return values.length === 0
          ? FALSE
          : sql`${value} = ANY (${param(values.map(encodeJsonOperand), 'jsonb[]')})`;
      }
      case 'isNull':
        return sql`${value} = 'null'::jsonb`;
      case 'any':
        return sql`${value} IS NOT NULL`;
      case 'range': {
        const kind = operandKind(predicate.value);
        const op = rangeOperatorSql(predicate.operator);
        if (kind === 'number' || kind === 'boolean') {
          return sql`(jsonb_typeof(${value}) = ${sql.lit(kind)} AND ${value} ${op} ${jsonbParam(encodeJsonOperand(predicate.value))})`;
        }
        if (kind === 'string') {
          return jsonRange(value, predicate);
        }
        return FALSE;
      }
      case 'regex':
        return jsonScalarTest(value, predicate);
      default:
        return FALSE;
    }
  };
  return {
    some,
    missing: () => sql`${value} IS NULL`,
    nullOrMissing: () => sql`(${value} IS NULL OR ${value} = 'null'::jsonb)`,
    absent: () => sql`${value} IS NULL`,
  };
}

/**
 * The filter leaf of `field` (a `json` column of the scope's rows) at `subpath` (empty for the
 * column itself).
 */
export function jsonFilterLeaf(
  context: QueryContext,
  scope: QueryScope,
  field: JsonField,
  subpath: readonly string[],
): FilterLeaf {
  const joined = subpath.join('.');
  if (
    subpath.length > 0 &&
    field.hints?.includes(joined) &&
    !subpath.some((s) => NUMERIC.test(s))
  ) {
    return hintedLeaf(scope, field, subpath);
  }
  const column = sql.id(scope.alias, field.column);
  const jsonb = jsonColumn(scope, field);
  const gin = hasJsonGinIndex(scope, field);
  const prefilter = (predicate: ValuePredicate): SqlFragment | undefined => {
    if (!gin) return undefined;
    let values: readonly unknown[] = [];
    if (predicate.kind === 'eq') values = [predicate.value];
    else if (predicate.kind === 'in') values = predicate.values;
    const path = laxEqualityPath(subpath, values);
    return path === undefined ? undefined : sql`${jsonb} @? ${param(path, 'jsonpath')}`;
  };

  if (subpath.length === 0) {
    const some = (predicate: ValuePredicate): SqlFragment => {
      if (predicate.kind === 'any') {
        return presence(scope, field.column, field.path);
      }
      const test = and([sql`${column} IS NOT NULL`, jsonValueTest(context, jsonb, predicate)]);
      const withPrefilter = prefilter(predicate);
      const value = withPrefilter ? and([withPrefilter, test]) : test;
      return predicate.kind === 'isNull' ? or([listedNull(scope, field.path), value]) : value;
    };
    return {
      some,
      missing: () => absence(scope, field.column, field.path),
      nullOrMissing: () =>
        or([sql`${column} IS NULL`, jsonValueTest(context, jsonb, { kind: 'isNull' })]),
      absent: () => absence(scope, field.column, field.path),
    };
  }

  const chainOf = (step: typeof filterStep) => candidateChain(context, jsonb, subpath, step);
  const exists = (condition: (value: SqlFragment) => SqlFragment): SqlFragment => {
    const chain = chainOf(filterStep);
    return sql`EXISTS (SELECT 1 FROM ${chain.from} WHERE ${condition(chain.value)})`;
  };
  const some = (predicate: ValuePredicate): SqlFragment => {
    const test = exists(
      (value) => sql`${value} IS NOT NULL AND ${jsonValueTest(context, value, predicate)}`,
    );
    const withPrefilter = prefilter(predicate);
    return withPrefilter ? and([withPrefilter, test]) : test;
  };
  return {
    some,
    missing: () => exists((value) => sql`${value} IS NULL`),
    nullOrMissing: () =>
      exists(
        (value) => sql`(${value} IS NULL OR ${jsonValueTest(context, value, { kind: 'isNull' })})`,
      ),
    absent: () => not(some({ kind: 'any' })),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Sort keys                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * The sort key of `field` (a `json` column of the scope's rows) at `subpath`: text compared under
 * `COLLATE "C"`, never `NULL`.
 */
export function jsonSortKey(
  context: QueryContext,
  scope: QueryScope,
  field: JsonField,
  subpath: readonly string[],
  ascending: boolean,
): SqlFragment {
  const jsonb = jsonColumn(scope, field);
  const flag = ascending ? sql`TRUE` : sql`FALSE`;
  if (subpath.length === 0) {
    return sql`lc_sort_key(${jsonb}, ${flag})`;
  }
  const chain = candidateChain(context, jsonb, subpath, sortStep);
  const aggregate = ascending ? sql`min` : sql`max`;
  return sql`(SELECT ${aggregate}(lc_sort_key(${chain.value}, ${flag}) ${COLLATE_C}) FROM ${chain.from})`;
}

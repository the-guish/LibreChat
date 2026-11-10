/**
 * The database-neutral query language of the ports: a portable subset of MongoDB's filter,
 * projection, sort and update syntax.
 *
 * Port methods that select or change records by caller-supplied criteria state those criteria
 * in these types, so the MongoDB methods (which take mongoose's `FilterQuery`, `UpdateQuery`,
 * projection and sort parameters) still satisfy the port, and another adapter implements one
 * translator for the language instead of one per method.
 *
 * The module has three parts:
 * - the types ({@link StoreFilter}, {@link StoreProjection}, {@link StoreSort},
 *   {@link StoreUpdate}, {@link StoreQueryOptions});
 * - a runtime validator ({@link assertStoreFilter}, {@link assertStoreProjection},
 *   {@link assertStoreSort}, {@link assertStoreUpdate}) for the JavaScript callers the
 *   typecheck cannot see; it throws a {@link StoreQueryError} naming the unsupported form;
 * - a pure reference evaluator ({@link matchesStoreFilter}, {@link applyStoreProjection},
 *   {@link compareByStoreSort}, {@link applyStoreQueryOptions}, {@link applyStoreUpdate},
 *   {@link storeFilterInsertSeed}) that defines the exact semantics, MongoDB's corner cases
 *   included. `query.differential.spec.ts` checks it against MongoDB, case by case, over the
 *   corpus in `query.corpus.ts`; an adapter for another database is tested against the same
 *   corpus.
 *
 * Nothing here may import `mongoose` or the MongoDB driver, at runtime or as a type.
 *
 * ## Values
 * Records are plain objects as a lean read returns them. A value is `null`, a string, a finite
 * number, a boolean, a `Date`, an id (an {@link IdLike} object: anything with `toHexString`), an
 * array of values or a plain object of values. A key whose value is `undefined` is treated as
 * absent.
 *
 * Ids: an id value equals, and orders like, the string `toHexString()` returns, on both sides of
 * a comparison. This is what the MongoDB adapter does by casting through the schema (a string
 * compared with an ObjectId field is cast to an ObjectId; an ObjectId compared with a string field
 * is cast to its hex string), and what an adapter that stores ids as text does natively. Callers
 * pass lowercase hex, as the store hands it out. An id never matches a `$regex`.
 *
 * There is no other casting: `'5'` never equals `5`, and a date stored as a string is not a
 * `Date`.
 *
 * ## Paths
 * A filter, sort or update names a field by a path: field names joined by dots. No segment may be
 * empty, start with `$`, or consist only of digits (MongoDB reads a numeric segment as an array
 * index or a field name depending on the data; the subset has no array positions). Projections
 * name top-level fields only.
 */
import type { IdLike } from './common';

/* ------------------------------------------------------------------------------------------ */
/* Types                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** A scalar a filter compares a field with. */
export type StoreScalar = string | number | boolean | null | Date;

/** A value a filter compares a field with by equality (`field: value`, `$in`, `$ne`, ...). */
export type StoreEqualityValue = StoreScalar | IdLike;

/** A value a range operator (`$gt`, `$gte`, `$lt`, `$lte`) compares a field with. */
export type StoreRangeValue = number | string | Date;

/** The `$options` of a `$regex`: none, or case-insensitive. */
export type StoreRegexOptions = '' | 'i';

/**
 * The operators a field condition may combine. Several operators on one field must all hold, and
 * each one may be satisfied by a different element of an array field.
 */
export interface StoreFieldOperators {
  /** The field equals one of the values (by the rules of field equality). */
  $in?: ReadonlyArray<StoreEqualityValue>;
  /** The field equals none of the values. Matches a missing field. */
  $nin?: ReadonlyArray<StoreEqualityValue>;
  /** The field does not equal the value. Matches a missing field. */
  $ne?: StoreEqualityValue;
  /** The path holds a value (`null` included), or holds none. */
  $exists?: boolean;
  $gt?: StoreRangeValue;
  $gte?: StoreRangeValue;
  $lt?: StoreRangeValue;
  $lte?: StoreRangeValue;
  /** A regular expression source, matched against string values. */
  $regex?: string;
  /** Only with `$regex`. */
  $options?: StoreRegexOptions;
}

/**
 * What a filter says about one path: equality with a value, a regular expression (flags `i` at
 * most, the same as `$regex`), or an operator record. `undefined` means `null`, as MongoDB's
 * driver serializes it.
 */
export type StoreFieldCondition = StoreEqualityValue | RegExp | StoreFieldOperators | undefined;

/**
 * Which records a read or write applies to: a portable subset of a MongoDB filter. Every path
 * condition must hold; `$or` and `$and` take non-empty lists of filters.
 *
 * Not in the subset: `$where`, `$expr`, `$text`, `$elemMatch`, `$all`, `$size`, `$not`, `$nor`,
 * `$eq`, `$type`, `$mod`, equality with an embedded document or an array, `$in` with regular
 * expressions, and aggregation stages.
 */
export interface StoreFilter {
  [path: string]: StoreFieldCondition | StoreFilter[];
  $or?: StoreFilter[];
  $and?: StoreFilter[];
}

/**
 * Which fields a read returns, as a mongoose projection string or record:
 * - `'a b'` returns `_id`, `a` and `b`; `'-_id a'` leaves out `_id`;
 * - `'-a -b'` returns every field but `a` and `b`;
 * - `'+secret'` also returns `secret`, a field the schema hides (`select: false`); it combines
 *   with either form (`'a +secret'`, `'-a +secret'`);
 * - `{ a: 1, b: 1 }` and `{ a: 0 }` are the same as `'a b'` and `'-a'`; `{}` and `''` select the
 *   default fields.
 * Inclusion and exclusion do not mix, except that `_id` may be left out of an inclusion. Naming a
 * hidden field in an inclusion returns it, as `+` does.
 */
export type StoreProjection = StoreProjectionString | StoreProjectionRecord;

/** The string form of a {@link StoreProjection}: field names separated by spaces. */
export type StoreProjectionString = string;

/** The record form of a {@link StoreProjection}. */
export type StoreProjectionRecord = Record<string, 0 | 1>;

/** The order of a read: paths with `1` (ascending) or `-1` (descending), most significant first. */
export type StoreSort = Record<string, 1 | -1>;

/**
 * Paging for a read: sorted by `sort`, the first `offset` records skipped, at most `limit`
 * returned. A `limit` of `0` or less means no limit, as with MongoDB.
 */
export interface StoreQueryOptions {
  sort?: StoreSort;
  limit?: number;
  offset?: number;
}

/** Field values to write: a path and the value it gets. */
export type StoreFieldValues = { [path: string]: unknown };

/** A value `$push` appends, or `{ $each: [...] }` to append several. */
export type StorePushValue = unknown;

/** A value `$addToSet` adds unless already present, or `{ $each: [...] }` to add several. */
export type StoreAddToSetValue = StoreEqualityValue | { $each: ReadonlyArray<StoreEqualityValue> };

/** The update operators of the subset. Each path may appear under one operator only. */
export interface StoreUpdateOperators {
  /** Sets each path, creating missing parents. */
  $set?: StoreFieldValues;
  /** Removes each path; a missing path is left as it is. The value is ignored. */
  $unset?: { [path: string]: 1 | true | '' };
  /** Adds the number; a missing path is set to it. */
  $inc?: { [path: string]: number };
  /** Sets the path when the value is greater than the stored one, or the path is missing. */
  $max?: { [path: string]: number | Date };
  /** Sets the path when the value is less than the stored one, or the path is missing. */
  $min?: { [path: string]: number | Date };
  /** Appends to the array; a missing path becomes an array. */
  $push?: { [path: string]: StorePushValue };
  /** Removes every element equal to the value. */
  $pull?: { [path: string]: StoreEqualityValue };
  /** Removes every element equal to one of the values. */
  $pullAll?: { [path: string]: ReadonlyArray<StoreEqualityValue> };
  /** Appends each value the array does not hold yet; a missing path becomes an array. */
  $addToSet?: { [path: string]: StoreAddToSetValue };
  /** Sets each path, only when the write inserts the record (an upsert that found none). */
  $setOnInsert?: StoreFieldValues;
}

/**
 * A change to records: a plain record of paths and values (meaning `$set`), operator records, or
 * both (the plain paths then join `$set`).
 *
 * Not in the subset: `$rename`, `$mul`, `$currentDate`, `$pop`, `$bit`, positional paths
 * (`a.$`, `a.0`), `$push` modifiers other than `$each`, `$pull` by condition, update pipelines,
 * and writing `_id`.
 */
export type StoreUpdate = StoreUpdateOperators & StoreFieldValues;

/* ------------------------------------------------------------------------------------------ */
/* Errors                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** A filter, projection, sort or update outside the subset, or an update the data refuses. */
export class StoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreQueryError';
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Value helpers                                                                               */
/* ------------------------------------------------------------------------------------------ */

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isId(value: unknown): value is IdLike & object {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    typeof (value as { toHexString?: unknown }).toHexString === 'function'
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a Date';
  if (value instanceof RegExp) return 'a RegExp';
  if (isId(value)) return 'an id';
  if (isPlainObject(value)) return 'an object';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return typeof value === 'object' ? `a ${value.constructor?.name ?? 'object'}` : typeof value;
}

/** A filter scalar or id: what equality, `$in`, `$ne`, `$pull` and `$addToSet` compare with. */
function isEqualityValue(value: unknown): value is StoreEqualityValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    isValidDate(value) ||
    isId(value)
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Validator                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const FIELD_OPERATORS: ReadonlySet<string> = new Set([
  '$in',
  '$nin',
  '$ne',
  '$exists',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$regex',
  '$options',
]);

const UPDATE_OPERATORS: ReadonlySet<string> = new Set([
  '$set',
  '$unset',
  '$inc',
  '$max',
  '$min',
  '$push',
  '$pull',
  '$pullAll',
  '$addToSet',
  '$setOnInsert',
]);

function assertPath(path: string, where: string): void {
  if (path === '') {
    throw new StoreQueryError(`${where}: the empty path is not supported`);
  }
  for (const segment of path.split('.')) {
    if (segment === '') {
      throw new StoreQueryError(`${where}: path "${path}" has an empty segment`);
    }
    if (segment.startsWith('$')) {
      throw new StoreQueryError(
        `${where}: unsupported operator or positional path "${path}" (segment "${segment}")`,
      );
    }
    if (/^\d+$/.test(segment)) {
      throw new StoreQueryError(
        `${where}: path "${path}" has a numeric segment "${segment}"; array positions are not supported`,
      );
    }
  }
}

function assertRegExpFlags(regex: RegExp, where: string): void {
  if (regex.flags !== '' && regex.flags !== 'i') {
    throw new StoreQueryError(
      `${where}: regular expression flags "${regex.flags}" are not supported (only "i")`,
    );
  }
}

function assertFieldOperators(path: string, ops: PlainObject): void {
  const keys = Object.keys(ops);
  if (keys.length === 0) {
    throw new StoreQueryError(
      `filter "${path}": an empty object is equality with an embedded document, which is not supported`,
    );
  }
  for (const key of keys) {
    if (!key.startsWith('$')) {
      throw new StoreQueryError(
        `filter "${path}": equality with an embedded document is not supported (key "${key}")`,
      );
    }
    if (!FIELD_OPERATORS.has(key)) {
      throw new StoreQueryError(`filter "${path}": unsupported operator "${key}"`);
    }
    const operand = ops[key];
    const where = `filter "${path}" ${key}`;
    switch (key) {
      case '$in':
      case '$nin':
        if (!Array.isArray(operand)) {
          throw new StoreQueryError(`${where}: expects an array, got ${describeValue(operand)}`);
        }
        for (const element of operand) {
          if (!isEqualityValue(element)) {
            throw new StoreQueryError(
              `${where}: elements must be scalars or ids, got ${describeValue(element)}`,
            );
          }
        }
        break;
      case '$ne':
        if (!isEqualityValue(operand)) {
          throw new StoreQueryError(
            `${where}: expects a scalar or an id, got ${describeValue(operand)}`,
          );
        }
        break;
      case '$exists':
        if (typeof operand !== 'boolean') {
          throw new StoreQueryError(`${where}: expects a boolean, got ${describeValue(operand)}`);
        }
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (
          !(typeof operand === 'number' && Number.isFinite(operand)) &&
          typeof operand !== 'string' &&
          !isValidDate(operand)
        ) {
          throw new StoreQueryError(
            `${where}: expects a number, a string or a Date, got ${describeValue(operand)}`,
          );
        }
        break;
      case '$regex':
        if (typeof operand !== 'string') {
          throw new StoreQueryError(
            `${where}: expects a pattern string, got ${describeValue(operand)} (pass a RegExp as the field value instead)`,
          );
        }
        try {
          new RegExp(operand);
        } catch (error) {
          throw new StoreQueryError(
            `${where}: invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case '$options':
        if (!('$regex' in ops)) {
          throw new StoreQueryError(`${where}: only allowed with $regex`);
        }
        if (operand !== '' && operand !== 'i') {
          throw new StoreQueryError(
            `${where}: unsupported options ${JSON.stringify(operand)} (only "i")`,
          );
        }
        break;
    }
  }
}

function assertFieldCondition(path: string, condition: unknown): void {
  if (condition === undefined || isEqualityValue(condition)) {
    return;
  }
  if (condition instanceof RegExp) {
    assertRegExpFlags(condition, `filter "${path}"`);
    return;
  }
  if (Array.isArray(condition)) {
    throw new StoreQueryError(
      `filter "${path}": equality with an array is not supported (use $in for "one of")`,
    );
  }
  if (isPlainObject(condition)) {
    assertFieldOperators(path, condition);
    return;
  }
  throw new StoreQueryError(`filter "${path}": unsupported value ${describeValue(condition)}`);
}

/**
 * Throws a {@link StoreQueryError} unless `filter` is in the subset {@link StoreFilter} defines,
 * naming the first unsupported operator or form.
 */
export function assertStoreFilter(filter: unknown): asserts filter is StoreFilter {
  if (!isPlainObject(filter)) {
    throw new StoreQueryError(`a filter must be a plain object, got ${describeValue(filter)}`);
  }
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or' || key === '$and') {
      if (!Array.isArray(condition) || condition.length === 0) {
        throw new StoreQueryError(`filter ${key}: expects a non-empty array of filters`);
      }
      for (const clause of condition) {
        assertStoreFilter(clause);
      }
      continue;
    }
    if (key.startsWith('$')) {
      throw new StoreQueryError(`filter: unsupported operator "${key}"`);
    }
    assertPath(key, 'filter');
    assertFieldCondition(key, condition);
  }
}

interface ParsedProjection {
  /** `include`: only the named fields (and `_id`); `exclude`: all but the named fields. */
  mode: 'include' | 'exclude' | 'default';
  fields: Set<string>;
  /** Hidden fields asked for with `+`. */
  forced: Set<string>;
  /** Whether `_id` is returned. */
  id: boolean;
}

function assertProjectionField(name: string, where: string): void {
  if (name === '' || name.includes('.') || name.startsWith('$')) {
    throw new StoreQueryError(`${where}: unsupported field "${name}" (top-level field names only)`);
  }
}

function parseProjection(projection: unknown): ParsedProjection {
  const parsed: ParsedProjection = {
    mode: 'default',
    fields: new Set(),
    forced: new Set(),
    id: true,
  };
  if (projection == null) {
    return parsed;
  }
  const entries: Array<[name: string, include: boolean, forced: boolean]> = [];
  if (typeof projection === 'string') {
    for (const token of projection.split(/\s+/)) {
      if (token === '') continue;
      const sign = token[0];
      const name = sign === '+' || sign === '-' ? token.slice(1) : token;
      assertProjectionField(name, `projection "${projection}"`);
      entries.push([name, sign !== '-', sign === '+']);
    }
  } else if (isPlainObject(projection)) {
    for (const [name, flag] of Object.entries(projection)) {
      assertProjectionField(name, 'projection');
      if (flag !== 0 && flag !== 1) {
        throw new StoreQueryError(
          `projection "${name}": expects 0 or 1, got ${JSON.stringify(flag) ?? describeValue(flag)}`,
        );
      }
      entries.push([name, flag === 1, false]);
    }
  } else {
    throw new StoreQueryError(
      `a projection must be a string or a record of 0 and 1, got ${describeValue(projection)}`,
    );
  }

  const seen = new Map<string, boolean>();
  for (const [name, include, forced] of entries) {
    if (seen.has(name) && seen.get(name) !== include) {
      throw new StoreQueryError(`projection: field "${name}" is both included and excluded`);
    }
    seen.set(name, include);
    if (forced) {
      parsed.forced.add(name);
      continue;
    }
    if (name === '_id') {
      parsed.id = include;
      continue;
    }
    const mode = include ? 'include' : 'exclude';
    if (parsed.mode !== 'default' && parsed.mode !== mode) {
      throw new StoreQueryError(
        'projection: inclusion and exclusion cannot be mixed (except for leaving out _id)',
      );
    }
    parsed.mode = mode;
    parsed.fields.add(name);
  }
  if (parsed.mode === 'default' && seen.has('_id') && !parsed.forced.has('_id')) {
    /* `'_id'` alone is an inclusion of `_id` only; `'-_id'` alone an exclusion of `_id`. */
    parsed.mode = parsed.id ? 'include' : 'exclude';
  }
  return parsed;
}

/**
 * Throws a {@link StoreQueryError} unless `projection` is a {@link StoreProjection} (or `null` /
 * `undefined`, meaning the default fields).
 */
export function assertStoreProjection(
  projection: unknown,
): asserts projection is StoreProjection | null | undefined {
  parseProjection(projection);
}

/** Throws a {@link StoreQueryError} unless `sort` is a {@link StoreSort}. */
export function assertStoreSort(sort: unknown): asserts sort is StoreSort {
  if (!isPlainObject(sort)) {
    throw new StoreQueryError(`a sort must be a record of paths, got ${describeValue(sort)}`);
  }
  for (const [path, direction] of Object.entries(sort)) {
    assertPath(path, 'sort');
    if (direction !== 1 && direction !== -1) {
      throw new StoreQueryError(
        `sort "${path}": expects 1 or -1, got ${JSON.stringify(direction) ?? describeValue(direction)}`,
      );
    }
  }
}

/** A value `$set` may write: scalars, ids, arrays and plain objects of those. */
function assertWritableValue(value: unknown, where: string): void {
  if (isEqualityValue(value)) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => assertWritableValue(element, `${where}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (key === '' || key.startsWith('$') || key.includes('.')) {
        throw new StoreQueryError(`${where}: unsupported key "${key}" in a written object`);
      }
      if (nested !== undefined) {
        assertWritableValue(nested, `${where}.${key}`);
      }
    }
    return;
  }
  throw new StoreQueryError(`${where}: cannot write ${describeValue(value)}`);
}

function assertEachModifier(
  operator: string,
  path: string,
  value: PlainObject,
  element: (item: unknown, where: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (key !== '$each') {
      throw new StoreQueryError(
        `update ${operator} "${path}": unsupported modifier "${key}" (only $each)`,
      );
    }
  }
  if (!Array.isArray(value.$each)) {
    throw new StoreQueryError(`update ${operator} "${path}" $each: expects an array`);
  }
  value.$each.forEach((item, index) => element(item, `update ${operator} "${path}"[${index}]`));
}

function isEachModifier(value: unknown): value is PlainObject {
  return isPlainObject(value) && Object.keys(value).some((key) => key.startsWith('$'));
}

function assertOperatorValue(operator: string, path: string, value: unknown): void {
  const where = `update ${operator} "${path}"`;
  const equality = (item: unknown, at: string): void => {
    if (!isEqualityValue(item)) {
      throw new StoreQueryError(`${at}: expects a scalar or an id, got ${describeValue(item)}`);
    }
  };
  switch (operator) {
    case '$set':
    case '$setOnInsert':
      if (value !== undefined) assertWritableValue(value, where);
      return;
    case '$unset':
      if (value !== 1 && value !== true && value !== '') {
        throw new StoreQueryError(`${where}: expects 1, got ${describeValue(value)}`);
      }
      return;
    case '$inc':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new StoreQueryError(`${where}: expects a number, got ${describeValue(value)}`);
      }
      return;
    case '$max':
    case '$min':
      if (!(typeof value === 'number' && Number.isFinite(value)) && !isValidDate(value)) {
        throw new StoreQueryError(
          `${where}: expects a number or a Date, got ${describeValue(value)}`,
        );
      }
      return;
    case '$push':
      if (isEachModifier(value)) {
        assertEachModifier(operator, path, value, assertWritableValue);
      } else {
        assertWritableValue(value, where);
      }
      return;
    case '$addToSet':
      if (isEachModifier(value)) {
        assertEachModifier(operator, path, value, equality);
      } else {
        equality(value, where);
      }
      return;
    case '$pull':
      if (isPlainObject(value)) {
        throw new StoreQueryError(`${where}: $pull by condition is not supported (by value only)`);
      }
      equality(value, where);
      return;
    case '$pullAll':
      if (!Array.isArray(value)) {
        throw new StoreQueryError(`${where}: expects an array, got ${describeValue(value)}`);
      }
      value.forEach((item, index) => equality(item, `${where}[${index}]`));
      return;
  }
}

/** Splits an update into operator records, the plain paths joining `$set`. */
function normalizeUpdate(update: PlainObject): Map<string, PlainObject> {
  const operators = new Map<string, PlainObject>();
  const plain: PlainObject = {};
  let hasPlain = false;
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith('$')) {
      if (!UPDATE_OPERATORS.has(key)) {
        throw new StoreQueryError(`update: unsupported operator "${key}"`);
      }
      if (!isPlainObject(value)) {
        throw new StoreQueryError(
          `update ${key}: expects a record of paths, got ${describeValue(value)}`,
        );
      }
      operators.set(key, value);
    } else {
      plain[key] = value;
      hasPlain = true;
    }
  }
  if (hasPlain) {
    const set = operators.get('$set') ?? {};
    for (const key of Object.keys(plain)) {
      if (key in set) {
        throw new StoreQueryError(`update: path "${key}" is both a plain field and in $set`);
      }
    }
    operators.set('$set', { ...set, ...plain });
  }
  return operators;
}

/**
 * Throws a {@link StoreQueryError} unless `update` is a {@link StoreUpdate}: supported operators
 * with valid operands, no `_id`, and no path written by two operators or under a path another
 * operator writes (MongoDB refuses those as conflicts).
 */
export function assertStoreUpdate(update: unknown): asserts update is StoreUpdate {
  if (!isPlainObject(update)) {
    throw new StoreQueryError(`an update must be a plain object, got ${describeValue(update)}`);
  }
  const operators = normalizeUpdate(update);
  const paths: string[] = [];
  for (const [operator, fields] of operators) {
    for (const [path, value] of Object.entries(fields)) {
      assertPath(path, `update ${operator}`);
      if (path === '_id' || path.startsWith('_id.')) {
        throw new StoreQueryError(`update ${operator}: writing "_id" is not supported`);
      }
      if (operator !== '$set' && operator !== '$setOnInsert' && value === undefined) {
        throw new StoreQueryError(`update ${operator} "${path}": expects a value, got undefined`);
      }
      if (value === undefined) {
        continue;
      }
      assertOperatorValue(operator, path, value);
      for (const other of paths) {
        if (other === path || other.startsWith(`${path}.`) || path.startsWith(`${other}.`)) {
          throw new StoreQueryError(`update: paths "${other}" and "${path}" conflict`);
        }
      }
      paths.push(path);
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Evaluator: comparison                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The order of value types, MongoDB's BSON order restricted to the values of the subset: an empty
 * array (as a sort key only) < `null` and missing < numbers < strings (and ids) < objects <
 * arrays < booleans < Dates < regular expressions.
 */
const Rank = {
  EmptyArray: 0,
  Null: 1,
  Number: 2,
  String: 3,
  Object: 4,
  Array: 5,
  Boolean: 8,
  Date: 9,
  RegExp: 11,
} as const;
type Rank = (typeof Rank)[keyof typeof Rank];

/** Marks an empty array as a sort key: it orders before `null`. */
const EMPTY_ARRAY: unique symbol = Symbol('emptyArray');

function rankOf(value: unknown): Rank {
  if (value === EMPTY_ARRAY) return Rank.EmptyArray;
  if (value === null || value === undefined) return Rank.Null;
  if (typeof value === 'number') return Rank.Number;
  if (typeof value === 'string' || isId(value)) return Rank.String;
  if (typeof value === 'boolean') return Rank.Boolean;
  if (value instanceof Date) return Rank.Date;
  if (value instanceof RegExp) return Rank.RegExp;
  if (Array.isArray(value)) return Rank.Array;
  return Rank.Object;
}

function idString(value: unknown): string {
  return isId(value) ? value.toHexString() : (value as string);
}

/** Orders strings by Unicode code point, as MongoDB orders UTF-8 bytes (no collation). */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  return j < b.length ? -1 : 0;
}

function sign(n: number): number {
  if (n < 0) return -1;
  return n > 0 ? 1 : 0;
}

/**
 * Compares two values in MongoDB's order: first by type ({@link Rank}), then within the type.
 * Numbers compare numerically, strings and ids by code point, Dates by time, `false < true`.
 * Objects compare entry by entry (an entry's value type, then its key, then its value; a prefix
 * orders first), arrays element by element.
 */
export function compareStoreValues(a: unknown, b: unknown): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case Rank.EmptyArray:
    case Rank.Null:
      return 0;
    case Rank.Number:
      return sign((a as number) - (b as number));
    case Rank.String:
      return compareStrings(idString(a), idString(b));
    case Rank.Boolean:
      if (a === b) return 0;
      return a ? 1 : -1;
    case Rank.Date:
      return sign((a as Date).getTime() - (b as Date).getTime());
    case Rank.RegExp:
      return compareStrings(String(a), String(b));
    case Rank.Array: {
      const xa = a as unknown[];
      const xb = b as unknown[];
      for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
        const c = compareStoreValues(xa[i], xb[i]);
        if (c !== 0) return c;
      }
      return sign(xa.length - xb.length);
    }
    default: {
      const ea = Object.entries(a as PlainObject).filter(([, v]) => v !== undefined);
      const eb = Object.entries(b as PlainObject).filter(([, v]) => v !== undefined);
      for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
        const [ka, va] = ea[i];
        const [kb, vb] = eb[i];
        const rva = rankOf(va);
        const rvb = rankOf(vb);
        if (rva !== rvb) return rva < rvb ? -1 : 1;
        const ck = compareStrings(ka, kb);
        if (ck !== 0) return ck;
        const cv = compareStoreValues(va, vb);
        if (cv !== 0) return cv;
      }
      return sign(ea.length - eb.length);
    }
  }
}

/** MongoDB equality: same type and same value; `null` equals only `null`. */
function valuesEqual(a: unknown, b: unknown): boolean {
  return compareStoreValues(a, b) === 0 && rankOf(a) === rankOf(b);
}

/* ------------------------------------------------------------------------------------------ */
/* Evaluator: filters                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Stands for "no value here" while resolving a filter path. */
const MISSING: unique symbol = Symbol('missing');
type Candidate = unknown | typeof MISSING;

/**
 * The values a filter path reaches in a record, by MongoDB's rules:
 * - a missing field, or a scalar or `null` where the path needs an object, gives MISSING;
 * - an array met before the last segment is traversed: the rest of the path is resolved in each
 *   element that is an object; elements that are not objects (scalars, nested arrays) give
 *   nothing at all, not even MISSING, so `{ 'a.b': null }` does not match `a: [1, 2]` or `a: []`;
 * - the value at the last segment is returned as it is (an array included).
 */
function resolveFilterPath(value: unknown, segments: readonly string[], out: Candidate[]): void {
  if (segments.length === 0) {
    out.push(value === undefined ? MISSING : value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      if (isPlainObject(element)) {
        resolveFilterPath(element, segments, out);
      }
    }
    return;
  }
  if (!isPlainObject(value)) {
    out.push(MISSING);
    return;
  }
  const [head, ...rest] = segments;
  const child = value[head];
  if (child === undefined) {
    out.push(MISSING);
    return;
  }
  resolveFilterPath(child, rest, out);
}

/**
 * What a condition tests at a reached value: the value, or for an array each of its elements (one
 * level; the array itself never equals a filter operand, which is never an array).
 */
function leafValues(candidate: Candidate): readonly unknown[] {
  return Array.isArray(candidate) ? candidate : [candidate];
}

/**
 * Field equality. `null` matches a missing path, a `null` value, and an array holding `null`.
 * Any other value matches a path holding an equal value or an array holding one ("array
 * contains"). Numbers compare numerically, Dates by time, ids by hex string.
 */
function matchesEquality(candidates: readonly Candidate[], expected: StoreEqualityValue): boolean {
  for (const candidate of candidates) {
    if (expected === null && candidate === MISSING) return true;
    if (candidate === MISSING) continue;
    for (const value of leafValues(candidate)) {
      if (valuesEqual(value, expected)) return true;
    }
  }
  return false;
}

/** Ranges compare only values of the operand's type: a number never matches `$gt: 'a'`. */
function matchesRange(
  candidates: readonly Candidate[],
  operator: '$gt' | '$gte' | '$lt' | '$lte',
  operand: StoreRangeValue,
): boolean {
  const rank = rankOf(operand);
  for (const candidate of candidates) {
    if (candidate === MISSING) continue;
    for (const value of leafValues(candidate)) {
      if (rankOf(value) !== rank) continue;
      const c = compareStoreValues(value, operand);
      if (
        (operator === '$gt' && c > 0) ||
        (operator === '$gte' && c >= 0) ||
        (operator === '$lt' && c < 0) ||
        (operator === '$lte' && c <= 0)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** A regular expression matches string values only (never ids, numbers or Dates). */
function matchesRegex(candidates: readonly Candidate[], regex: RegExp): boolean {
  for (const candidate of candidates) {
    if (candidate === MISSING) continue;
    for (const value of leafValues(candidate)) {
      if (typeof value === 'string' && regex.test(value)) return true;
    }
  }
  return false;
}

function matchesCondition(candidates: readonly Candidate[], condition: unknown): boolean {
  if (condition === undefined) {
    return matchesEquality(candidates, null);
  }
  if (condition instanceof RegExp) {
    return matchesRegex(candidates, new RegExp(condition.source, condition.flags));
  }
  if (!isPlainObject(condition)) {
    return matchesEquality(candidates, condition as StoreEqualityValue);
  }
  const ops = condition as StoreFieldOperators;
  for (const key of Object.keys(ops) as Array<keyof StoreFieldOperators>) {
    switch (key) {
      case '$in':
        if (!(ops.$in ?? []).some((value) => matchesEquality(candidates, value))) return false;
        break;
      case '$nin':
        if ((ops.$nin ?? []).some((value) => matchesEquality(candidates, value))) return false;
        break;
      case '$ne':
        if (matchesEquality(candidates, ops.$ne as StoreEqualityValue)) return false;
        break;
      case '$exists': {
        const exists = candidates.some((candidate) => candidate !== MISSING);
        if (exists !== ops.$exists) return false;
        break;
      }
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (!matchesRange(candidates, key, ops[key] as StoreRangeValue)) return false;
        break;
      case '$regex':
        if (!matchesRegex(candidates, new RegExp(ops.$regex as string, ops.$options ?? ''))) {
          return false;
        }
        break;
    }
  }
  return true;
}

/**
 * Whether `record` matches `filter`, by MongoDB's rules (see {@link resolveFilterPath},
 * `matchesEquality`, `matchesRange`, `matchesRegex`):
 * - every path condition must hold, and every clause of `$and`; one clause of `$or`;
 * - `field: null` (or `undefined`) matches a missing field, `null`, and an array holding `null`;
 * - `field: value` matches an equal value or an array holding one;
 * - `$ne` and `$nin` are the exact negation of equality and `$in`, so they match a missing field;
 *   `$ne: value` does not match an array holding the value;
 * - `$in` with `null` among its values matches a missing field; `$in: []` matches nothing and
 *   `$nin: []` everything;
 * - `$exists: true` matches any value, `null` included; through an array of objects it holds
 *   when one element has the field;
 * - `$gt`/`$gte`/`$lt`/`$lte` compare only values of the operand's type (numbers, strings by code
 *   point, or Dates), each element of an array separately; several operators on one field may be
 *   satisfied by different elements;
 * - `$regex` and RegExp values match strings, and arrays holding a matching string.
 * The filter is not validated here; run {@link assertStoreFilter} first.
 */
export function matchesStoreFilter(record: Record<string, unknown>, filter: StoreFilter): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(condition as StoreFilter[]).some((clause) => matchesStoreFilter(record, clause))) {
        return false;
      }
      continue;
    }
    if (key === '$and') {
      if (!(condition as StoreFilter[]).every((clause) => matchesStoreFilter(record, clause))) {
        return false;
      }
      continue;
    }
    const candidates: Candidate[] = [];
    resolveFilterPath(record, key.split('.'), candidates);
    if (!matchesCondition(candidates, condition)) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------------------------------ */
/* Evaluator: projections                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The fields of `record` that `projection` returns, by mongoose's rules:
 * - no projection, `''` or `{}`: every field but the `hiddenFields` (the schema's
 *   `select: false` fields);
 * - inclusion (`'a b'`, `{ a: 1 }`): `_id` and the named fields, hidden or not;
 * - exclusion (`'-a'`, `{ a: 0 }`, `{ _id: 0 }`): every field but the named and the hidden ones;
 * - `+field` adds a hidden field to either form or to the default; `-_id` leaves out `_id`.
 * Fields the record lacks stay absent. Returns a new object; values are not copied.
 */
export function applyStoreProjection<T extends Record<string, unknown>>(
  record: T,
  projection?: StoreProjection | null,
  hiddenFields: readonly string[] = [],
): Partial<T> {
  const parsed = parseProjection(projection);
  const hidden = new Set(hiddenFields);
  const result: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    if (value === undefined) continue;
    let keep: boolean;
    if (field === '_id') {
      keep = parsed.id;
    } else if (parsed.mode === 'include') {
      keep = parsed.fields.has(field) || parsed.forced.has(field);
    } else if (parsed.mode === 'exclude') {
      keep = !parsed.fields.has(field) && (!hidden.has(field) || parsed.forced.has(field));
    } else {
      keep = !hidden.has(field) || parsed.forced.has(field);
    }
    if (keep) {
      result[field] = value;
    }
  }
  return result as Partial<T>;
}

/* ------------------------------------------------------------------------------------------ */
/* Evaluator: sorts and paging                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * The values a sort path reaches, by MongoDB's sort-key rules: like a filter path, except that a
 * missing value, a non-object array element met before the last segment, and an empty array met
 * before the last segment each count as `null`; an array at the last segment gives its elements,
 * and an empty array there gives {@link EMPTY_ARRAY}.
 */
function resolveSortPath(value: unknown, segments: readonly string[], out: unknown[]): void {
  if (segments.length === 0) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push(EMPTY_ARRAY);
      } else {
        out.push(...value.map((element) => (element === undefined ? null : element)));
      }
      return;
    }
    out.push(value === undefined ? null : value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(null);
      return;
    }
    for (const element of value) {
      if (isPlainObject(element)) {
        resolveSortPath(element, segments, out);
      } else {
        out.push(null);
      }
    }
    return;
  }
  if (!isPlainObject(value)) {
    out.push(null);
    return;
  }
  const [head, ...rest] = segments;
  resolveSortPath(value[head], rest, out);
}

function sortKey(record: Record<string, unknown>, path: string, direction: 1 | -1): unknown {
  const values: unknown[] = [];
  resolveSortPath(record, path.split('.'), values);
  let key = values[0];
  for (const value of values.slice(1)) {
    const c = compareStoreValues(value, key);
    if ((direction === 1 && c < 0) || (direction === -1 && c > 0)) {
      key = value;
    }
  }
  return key;
}

/**
 * A comparator for `Array.prototype.sort` that orders records as MongoDB does for `sort`:
 * - values of different types order by type: an empty array < missing and `null` (equal) <
 *   numbers < strings and ids < objects < arrays < booleans < Dates (see
 *   {@link compareStoreValues});
 * - an array field sorts by its smallest element ascending and its largest descending;
 * - through an array of objects, every element's value counts, and an element lacking the field
 *   counts as `null`.
 * Records equal on every key compare as 0: their order is unspecified (MongoDB does not keep
 * insertion order), so a caller that needs a stable page adds a unique key such as `_id`.
 */
export function compareByStoreSort(
  sort: StoreSort,
): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  const keys = Object.entries(sort);
  return (a, b) => {
    for (const [path, direction] of keys) {
      const c = compareStoreValues(sortKey(a, path, direction), sortKey(b, path, direction));
      if (c !== 0) return direction === 1 ? c : -c;
    }
    return 0;
  };
}

/**
 * Sorts (when `sort` is given), skips `offset` and keeps at most `limit` records, as a read with
 * {@link StoreQueryOptions} does. Returns a new array.
 */
export function applyStoreQueryOptions<T extends Record<string, unknown>>(
  records: readonly T[],
  options: StoreQueryOptions = {},
): T[] {
  let result = [...records];
  if (options.sort) {
    result.sort(compareByStoreSort(options.sort));
  }
  if (options.offset != null && options.offset > 0) {
    result = result.slice(options.offset);
  }
  if (options.limit != null && options.limit > 0) {
    result = result.slice(0, options.limit);
  }
  return result;
}

/* ------------------------------------------------------------------------------------------ */
/* Evaluator: updates                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** A deep copy of a record's own structure; Dates, ids and other leaves are shared. */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneValue) as T;
  }
  if (isPlainObject(value)) {
    const copy: PlainObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined) copy[key] = cloneValue(nested);
    }
    return copy as T;
  }
  return value;
}

interface Slot {
  parent: PlainObject;
  key: string;
}

/**
 * How {@link locate} treats the parents of a path:
 * - `create` (writes that set a value): missing parents become empty objects;
 * - `existing` (`$pull`, `$pullAll`): a missing parent leaves nothing to change;
 * - `unset`: a missing parent, or one that is not an object, leaves nothing to remove.
 * Otherwise a parent that is a scalar, `null` or an array is an error, as in MongoDB.
 */
type LocateMode = 'create' | 'existing' | 'unset';

/** The object and key a path writes to, or undefined when there is nothing to change. */
function locate(
  record: PlainObject,
  path: string,
  mode: LocateMode,
  operator: string,
): Slot | undefined {
  const segments = path.split('.');
  let current: PlainObject = record;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = current[segment];
    if (next === undefined) {
      if (mode !== 'create') return undefined;
      const created: PlainObject = {};
      current[segment] = created;
      current = created;
      continue;
    }
    if (!isPlainObject(next)) {
      if (mode === 'unset') return undefined;
      throw new StoreQueryError(
        `${operator} "${path}": cannot write through ${describeValue(next)} at "${segments
          .slice(0, i + 1)
          .join('.')}"`,
      );
    }
    current = next;
  }
  return { parent: current, key: segments[segments.length - 1] };
}

function arrayAt(slot: Slot, operator: string, path: string): unknown[] | undefined {
  const value = slot.parent[slot.key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new StoreQueryError(
      `${operator} "${path}": the stored value is ${describeValue(value)}, not an array`,
    );
  }
  return value;
}

function eachValues(value: unknown): unknown[] {
  return isEachModifier(value) ? [...(value.$each as unknown[])] : [value];
}

/**
 * The record after `update`, by MongoDB's rules. Returns a new record; `record` is not changed.
 * - plain paths and `$set` write each value (a deep copy), creating missing parents; writing
 *   through a scalar, `null` or an array is an error; an `undefined` value is skipped;
 * - `$unset` removes the path; a missing path, or a parent that is missing or not an object, is
 *   left as it is;
 * - `$inc` adds to a number; a missing path is set to the amount; a non-number (`null` included)
 *   is an error;
 * - `$max`/`$min` set the path when the operand orders after/before the stored value by
 *   {@link compareStoreValues} (so any number is greater than `null`, and a string is greater
 *   than any number), or when the path is missing;
 * - `$push` appends the value (an array value as one element) or each `$each` element; a
 *   missing path becomes an array; a non-array is an error;
 * - `$addToSet` appends each value not equal to an element already there (or to one appended
 *   before it); a missing path becomes an array; a non-array is an error;
 * - `$pull`/`$pullAll` remove every element equal to the value(s); a missing path or parent is
 *   left as it is; a non-array value, or a parent that is not an object, is an error;
 * - `$setOnInsert` writes like `$set` when `inserting`, and is ignored otherwise.
 * Equality is MongoDB's (ids by hex string). Errors are {@link StoreQueryError}s; the update is
 * not validated here, so run {@link assertStoreUpdate} first.
 */
export function applyStoreUpdate<T extends Record<string, unknown>>(
  record: T,
  update: StoreUpdate,
  options: { inserting?: boolean } = {},
): T {
  const result = cloneValue(record) as PlainObject;
  const operators = normalizeUpdate(update as PlainObject);
  for (const [operator, fields] of operators) {
    for (const [path, value] of Object.entries(fields)) {
      switch (operator) {
        case '$setOnInsert':
        case '$set': {
          if (value === undefined || (operator === '$setOnInsert' && !options.inserting)) break;
          const slot = locate(result, path, 'create', operator) as Slot;
          slot.parent[slot.key] = cloneValue(value);
          break;
        }
        case '$unset': {
          const slot = locate(result, path, 'unset', operator);
          if (slot) delete slot.parent[slot.key];
          break;
        }
        case '$inc': {
          const slot = locate(result, path, 'create', operator) as Slot;
          const current = slot.parent[slot.key];
          if (current === undefined) {
            slot.parent[slot.key] = value;
          } else if (typeof current === 'number') {
            slot.parent[slot.key] = current + (value as number);
          } else {
            throw new StoreQueryError(
              `$inc "${path}": the stored value is ${describeValue(current)}, not a number`,
            );
          }
          break;
        }
        case '$max':
        case '$min': {
          const slot = locate(result, path, 'create', operator) as Slot;
          const current = slot.parent[slot.key];
          const c = current === undefined ? 0 : compareStoreValues(value, current);
          if (current === undefined || (operator === '$max' ? c > 0 : c < 0)) {
            slot.parent[slot.key] = value;
          }
          break;
        }
        case '$push': {
          const slot = locate(result, path, 'create', operator) as Slot;
          const current = arrayAt(slot, operator, path) ?? [];
          slot.parent[slot.key] = [...current, ...eachValues(value).map(cloneValue)];
          break;
        }
        case '$addToSet': {
          const slot = locate(result, path, 'create', operator) as Slot;
          const next = [...(arrayAt(slot, operator, path) ?? [])];
          for (const item of eachValues(value)) {
            if (!next.some((element) => valuesEqual(element, item))) next.push(item);
          }
          slot.parent[slot.key] = next;
          break;
        }
        case '$pull':
        case '$pullAll': {
          const slot = locate(result, path, 'existing', operator);
          if (!slot) break;
          const current = arrayAt(slot, operator, path);
          if (!current) break;
          const removed = operator === '$pull' ? [value] : (value as unknown[]);
          slot.parent[slot.key] = current.filter(
            (element) => !removed.some((item) => valuesEqual(element, item)),
          );
          break;
        }
      }
    }
  }
  return result as T;
}

/**
 * The record an upsert starts from when no record matches `filter`, before the update applies
 * (with `inserting: true`): the equality conditions of the filter's top level and of its `$and`
 * clauses, each written at its path (a dotted path creates nested objects; `undefined` is
 * written as `null`). Operator conditions, regular expressions and `$or` add nothing. `_id` is
 * the adapter's to generate when the seed has none.
 */
export function storeFilterInsertSeed(filter: StoreFilter): Record<string, unknown> {
  const seed: PlainObject = {};
  const visit = (clause: StoreFilter): void => {
    for (const [key, condition] of Object.entries(clause)) {
      if (key === '$and') {
        (condition as StoreFilter[]).forEach(visit);
        continue;
      }
      if (key === '$or') continue;
      if (condition !== undefined && !isEqualityValue(condition)) continue;
      const slot = locate(seed, key, 'create', 'upsert') as Slot;
      slot.parent[slot.key] = condition === undefined ? null : condition;
    }
  };
  visit(filter);
  return seed;
}

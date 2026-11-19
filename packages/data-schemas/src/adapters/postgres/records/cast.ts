/**
 * The descriptor caster (docs/postgres-port/PHASE4.md §1.9 "Filter and update values", D2): casts
 * the values of filters and updates to the declared type of the path they apply to, as mongoose
 * casts them through `Query#cast` and its update casting, so `{ n: '5' }` on a Number path matches
 * `5` and `{ email: 'A@B.C' }` on a `lowercase` String path matches `a@b.c`. Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * ## Interface for the query translator (Q1) and the collection primitive (C1)
 *
 * ```ts
 * const caster = createRecordCaster(indexRecordTables(descriptor), { engine: getSchemaEngine() });
 * caster.castFilter('conversations', filter);              // a whole filter, recursively
 * caster.castUpdate('conversations', update);              // a whole update document
 * caster.castCondition(resolved, '$gt', value);            // one operand, path already resolved
 * castScalar('number', '5', { path: 'n' });                // one value of a scalar type
 * ```
 *
 * - Paths are resolved with `resolveRecordPath` (`paths.ts`), which the translator shares; a
 *   filter on an undeclared path throws an `UndeclaredPathError` (a `StoreQueryError`, R9), an
 *   update strips it (mongoose's `strict`) unless `undeclared: 'refuse'` or `'keep'` is given.
 * - Casts follow mongoose's cast functions per type (`lib/cast/*.js` of 8.24.1) and its query
 *   handlers per operator; string setters (`lowercase`, `uppercase`, `trim`) apply where mongoose
 *   applies them (equality, `$in`, ranges, update values; not `$regex` on a String path).
 * - Results are in the store's canonical form: ids as 24 lowercase hex characters (R7), dates as
 *   `Date`, binaries as `Buffer`, strings with U+0000 replaced by U+FFFD (D8; counted for update
 *   values, which are written, not for filter values). `json` (`Mixed`) values are not cast,
 *   as mongoose leaves `Mixed` alone; a `Map`'s values are cast to its declared type.
 * - A value that cannot be cast throws a `StoreQueryError` (mongoose throws a `CastError`).
 * - Subdocuments written by an update (`$set` of a single subdocument, `$set`/`$push`/
 *   `$addToSet` of child array elements) are built by the {@link UpdateCastEngine} when one is
 *   given (the schema engine, which applies their defaults and `_id`s as mongoose does);
 *   otherwise their leaves are cast one by one, without defaults. The engine also names the
 *   `immutable` paths, which updates strip outside `$setOnInsert`, as mongoose does.
 * - Equality with an array on a scalar path becomes `$in`, as mongoose casts it.
 *
 * Differences from mongoose (R7): an ObjectId path accepts only 24 hex characters or an object
 * whose `toHexString()` returns them (mongoose also takes 12-character strings and numbers); the
 * `objectIdOrString` override (`principalId`, a `Mixed` path in mongoose) casts ids to hex and
 * keeps strings, refusing other values; equality with a whole object or a non-empty array of
 * subdocuments is refused (outside the query language); a date outside PostgreSQL's range is
 * refused.
 */
import type { ScalarType, StringTransform, FieldDescriptor } from '../schema/descriptor';
import type { RecordTable, RecordTables } from './tables';
import type { CastTarget, ResolvedPath } from './paths';
import {
  isBinaryValue,
  isIdValue,
  replaceNul,
  toByteaColumn,
  toIdColumn,
  toTimestampColumn,
} from '../values';
import { castTargetOf, resolveRecordPath, UndeclaredPathError } from './paths';
import { arrayFilterIdentifier } from '../evaluator/update';
import { StoreQueryError } from '~/ports/query';
import { isPlainRecord } from './extra';

/* ------------------------------------------------------------------------------------------ */
/* Scalars                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Options of {@link castScalar}. */
export interface ScalarCastOptions {
  /** The path, for error messages. */
  path?: string;
  /** String setters to apply after the cast (`lowercase`, `uppercase`, `trim`). */
  transforms?: readonly StringTransform[];
  /** Count U+0000 replacements (values that are written); default false. */
  countNul?: boolean;
}

const TRUE_VALUES: ReadonlySet<unknown> = new Set<unknown>([true, 'true', 1, '1', 'yes']);
const FALSE_VALUES: ReadonlySet<unknown> = new Set<unknown>([false, 'false', 0, '0', 'no']);

function castError(type: string, value: unknown, path?: string): StoreQueryError {
  let shown: string;
  try {
    shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    shown = Object.prototype.toString.call(value);
  }
  return new StoreQueryError(
    `Cast to ${type} failed for value ${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}${path ? ` at path "${path}"` : ''}`,
  );
}

/** Whether `value` is an id object (an ObjectId or anything with `toHexString`). */
function isIdObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === 'function'
  );
}

/** mongoose's `castString`: `_id` strings of documents, then `toString()` unless the default one. */
function castStringValue(value: unknown, path?: string): string {
  const candidate = value as { _id?: unknown; toString?: unknown };
  if (candidate._id && typeof candidate._id === 'string') {
    return candidate._id;
  }
  if (
    candidate.toString &&
    candidate.toString !== Object.prototype.toString &&
    !Array.isArray(value)
  ) {
    return (value as { toString(): string }).toString();
  }
  throw castError('string', value, path);
}

/** mongoose's `castNumber` (after taking a document's `_id`); `NaN` is refused as there. */
function castNumberValue(input: unknown, path?: string): number | null {
  let value = input;
  if (value === '') {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    value = Number(value);
  }
  let notANumber: boolean;
  try {
    notANumber = isNaN(value as number);
  } catch {
    notANumber = true;
  }
  if (notANumber) {
    throw castError('Number', input, path);
  }
  if (value instanceof Number) {
    return value.valueOf();
  }
  if (typeof value === 'number') {
    return value;
  }
  const object = value as { valueOf?: unknown };
  if (!Array.isArray(value) && typeof object.valueOf === 'function') {
    return Number((object.valueOf as () => unknown).call(value));
  }
  throw castError('Number', input, path);
}

/** mongoose's `castDate`, then PostgreSQL's range. */
function castDateValue(value: unknown, path?: string): Date | null {
  if (value === '') {
    return null;
  }
  let date: Date;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === 'boolean') {
    throw castError('date', value, path);
  } else if (value instanceof Number || typeof value === 'number') {
    date = new Date(value as number);
  } else if (
    typeof value === 'string' &&
    !Number.isNaN(Number(value)) &&
    (Number(value) >= 275761 || Number(value) < -271820)
  ) {
    date = new Date(Number(value));
  } else if (typeof (value as { valueOf?: unknown }).valueOf === 'function') {
    date = new Date((value as { valueOf(): string | number }).valueOf());
  } else {
    date = new Date(value as string);
  }
  if (Number.isNaN(date.getTime())) {
    throw castError('date', value, path);
  }
  try {
    return toTimestampColumn(date);
  } catch (error) {
    throw new StoreQueryError(`${(error as Error).message}${path ? ` at path "${path}"` : ''}`);
  }
}

/** mongoose's `castObjectId`, limited to 24 hex characters (R7); the result is lowercase hex. */
function castObjectIdValue(value: unknown, path?: string): string {
  let candidate: unknown = value;
  if (!isIdObject(value)) {
    const id = (value as { _id?: unknown })._id;
    if (id) {
      candidate = isIdObject(id) ? id : String(id);
    } else if (typeof (value as { toString?: unknown }).toString === 'function') {
      candidate = String(value);
    }
  }
  if (!isIdValue(candidate)) {
    throw castError('ObjectId', value, path);
  }
  return toIdColumn(candidate);
}

/** mongoose's Buffer cast: binaries, strings, byte arrays, `{ type: 'Buffer', data }`. */
function castBufferValue(value: unknown, path?: string): Buffer {
  let input = value;
  if (input && typeof input === 'object' && (input as { _id?: unknown })._id) {
    input = (input as { _id: unknown })._id;
  }
  if (isBinaryValue(input)) {
    return toByteaColumn(input);
  }
  if (typeof input === 'string') {
    return Buffer.from(input);
  }
  if (typeof input === 'number') {
    return Buffer.from([input]);
  }
  if (Array.isArray(input)) {
    return Buffer.from(input as number[]);
  }
  const shaped = input as { type?: unknown; data?: unknown; $binary?: unknown };
  if (shaped && shaped.type === 'Buffer' && Array.isArray(shaped.data)) {
    return Buffer.from(shaped.data as number[]);
  }
  if (isPlainRecord(input) && typeof shaped.$binary === 'string') {
    return Buffer.from(shaped.$binary, 'base64');
  }
  throw castError('Buffer', value, path);
}

/** The string setters, in their mongoose order (they commute for these three). */
function applyTransforms(value: string, transforms: readonly StringTransform[] = []): string {
  let result = value;
  for (const transform of transforms) {
    if (transform === 'lowercase') result = result.toLowerCase();
    else if (transform === 'uppercase') result = result.toUpperCase();
    else if (transform === 'trim') result = result.trim();
  }
  return result;
}

/**
 * `value` cast to a column of `type`, in the store's canonical form. `null` and `undefined` are
 * returned as given (`undefined` meaning absent). Throws a `StoreQueryError` when it cannot be cast.
 */
export function castScalar(
  type: ScalarType,
  value: unknown,
  options: ScalarCastOptions = {},
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const { path } = options;
  switch (type) {
    case 'string': {
      const cast = applyTransforms(castStringValue(value, path), options.transforms);
      return replaceNul(cast, { countNul: options.countNul ?? false });
    }
    case 'number': {
      const object = value as { _id?: unknown };
      const target = typeof object === 'object' && object._id !== undefined ? object._id : value;
      if (target === null || target === undefined) {
        return target;
      }
      return castNumberValue(target, path);
    }
    case 'boolean':
      if (TRUE_VALUES.has(value)) return true;
      if (FALSE_VALUES.has(value)) return false;
      throw castError('Boolean', value, path);
    case 'date':
      return castDateValue(value, path);
    case 'objectId':
      return castObjectIdValue(value, path);
    case 'buffer':
      return castBufferValue(value, path);
    case 'objectIdOrString':
      if (typeof value === 'string') {
        return replaceNul(value, { countNul: options.countNul ?? false });
      }
      if (isIdObject(value) && isIdValue(value)) {
        return toIdColumn(value);
      }
      throw castError('ObjectId or string', value, path);
  }
}

/**
 * Converts mongoose and driver values to the store's canonical form, deeply: ids to lowercase
 * hex, binaries to `Buffer`, `Map`s to plain objects (insertion order kept). Other values are
 * copied as they are.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (isBinaryValue(value)) {
    return toByteaColumn(value);
  }
  if (isIdObject(value) && isIdValue(value)) {
    return toIdColumn(value);
  }
  if (Array.isArray(value)) {
    /** `Array.from`: a mongoose array's own `map` builds another mongoose array. */
    return Array.from(value as unknown[], canonicalizeValue);
  }
  const document = value as { toObject?: unknown; $__?: unknown };
  if (typeof document.toObject === 'function' && document.$__ !== undefined) {
    /** A mongoose (sub)document, by shape: its plain form, as `save` serializes it. */
    return canonicalizeValue(
      (document.toObject as (options: object) => unknown).call(value, {
        transform: false,
        virtuals: false,
        getters: false,
        depopulate: true,
        flattenMaps: true,
        versionKey: true,
      }),
    );
  }
  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of value) {
      result[String(key)] = canonicalizeValue(item);
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = canonicalizeValue(item);
  }
  return result;
}

/* ------------------------------------------------------------------------------------------ */
/* The caster                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Update operators that build subdocuments through the {@link UpdateCastEngine}. */
export type SubdocumentOperator = '$set' | '$setOnInsert' | '$push' | '$addToSet';

/**
 * What update casting needs from the schemas beyond the descriptor; the schema engine implements
 * it (`schema/engine.ts`).
 */
export interface UpdateCastEngine {
  /**
   * Builds the subdocuments an update writes, as mongoose's update casting does (defaults,
   * setters, subdocument `_id`s): given an operator, a document path (positional segments kept)
   * and the value the update gives it, returns the cast value.
   */
  castUpdateValue(
    collection: string,
    operator: SubdocumentOperator,
    path: string,
    value: unknown,
  ): unknown;
  /**
   * Whether the schema declares the document path `immutable` (timestamps' `createdAt`, the audit
   * log's fields, ...): mongoose's update casting strips such paths from every operator but
   * `$setOnInsert`.
   */
  isImmutable(collection: string, path: string): boolean;
}

/** Options of {@link createRecordCaster}. */
export interface RecordCasterOptions {
  /**
   * The schema engine: builds subdocuments written by updates and names immutable paths. Without
   * it, subdocuments are cast leaf by leaf (no defaults) and no path is immutable.
   */
  engine?: UpdateCastEngine;
}

/** What an update does with a path the schema does not declare. */
export type UndeclaredUpdatePaths = 'strip' | 'refuse' | 'keep';

/** Options of {@link RecordCaster.castUpdate}. */
export interface UpdateCastOptions {
  /**
   * `strip` (default): leave the path out, as mongoose's `strict` does; `refuse`: throw an
   * `UndeclaredPathError`; `keep`: keep it with its value uncast (`$unset` of an `_extra` path,
   * D7).
   */
  undeclared?: UndeclaredUpdatePaths;
}

/** The descriptor caster: filter and update values cast to the declared types. */
export interface RecordCaster {
  readonly tables: RecordTables;
  /** Resolves `path` of `collection`'s documents (positions `$`, `$[]`, `$[x]` when `positional`). */
  resolve(collection: string, path: string, options?: { positional?: boolean }): ResolvedPath;
  /** A filter with every operand cast (`$and`/`$or`/`$nor` and `$elemMatch` recursively). */
  castFilter<T extends Record<string, unknown>>(collection: string, filter: T): T;
  /** A filter on the rows of `table` (a child table's: its elements), for `$elemMatch` and `$pull`. */
  castFilterOn<T extends Record<string, unknown>>(table: RecordTable, filter: T): T;
  /**
   * One filter condition on a resolved path: `operator` is `null` for equality (a value, a
   * `RegExp` or an operator record), or one operator (`$in`, `$gt`, `$exists`, `$regex`, ...).
   */
  castCondition(resolved: ResolvedPath, operator: string | null, value: unknown): unknown;
  /** An update with every value cast; plain paths are moved into `$set`, as mongoose does. */
  castUpdate<T extends Record<string, unknown>>(
    collection: string,
    update: T,
    options?: UpdateCastOptions,
  ): T;
  /** The value `$set` writes at `path` (a scalar, an array, an object, child elements, `json`). */
  castAssignment(collection: string, path: string, value: unknown): unknown;
  /**
   * The `arrayFilters` of an update, each cast as a filter on the elements of the array its
   * identifier selects in the update's paths (as mongoose's `castArrayFilters`): a child table's
   * fields (`x.f`), a scalar array's element type (`x`); `json` elements are not cast. Filters no
   * path uses are dropped, as mongoose drops them before MongoDB would refuse them.
   */
  castArrayFilters(
    collection: string,
    update: Record<string, unknown>,
    arrayFilters: ReadonlyArray<Record<string, unknown>>,
  ): Array<Record<string, unknown>>;
}

/** Rewrites the paths of a filter (`$and`/`$or`/`$nor` recursively). */
function mapFilterPaths(
  filter: Record<string, unknown>,
  map: (path: string) => string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL.has(key) && Array.isArray(value)) {
      result[key] = value.map((entry) => mapFilterPaths(entry as Record<string, unknown>, map));
    } else {
      result[key.startsWith('$') ? key : map(key)] = value;
    }
  }
  return result;
}

const LOGICAL = new Set(['$and', '$or', '$nor']);
const PASS_THROUGH_OPERATORS = new Set(['$type', '$comment']);

/** Whether `value` is an operator record (`{ $gt: 1 }`): a plain object whose keys all start with `$`. */
function isOperatorRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

/** Creates the descriptor caster over `tables`. */
export function createRecordCaster(
  tables: RecordTables,
  options: RecordCasterOptions = {},
): RecordCaster {
  const engine = options.engine;

  /* ---- filters ---- */

  const castFilterOn = <T extends Record<string, unknown>>(table: RecordTable, filter: T): T => {
    if (!isPlainRecord(filter)) {
      throw new StoreQueryError('A filter must be an object');
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (LOGICAL.has(key)) {
        if (!Array.isArray(value)) {
          throw new StoreQueryError(`${key} takes an array of filters`);
        }
        result[key] = value.map((entry) => castFilterOn(table, entry as Record<string, unknown>));
        continue;
      }
      if (key === '$comment') {
        result[key] = value;
        continue;
      }
      if (key.startsWith('$')) {
        throw new StoreQueryError(`Unsupported filter operator ${key}`);
      }
      const resolved = resolveRecordPath(tables, table, key);
      result[key] = castCondition(resolved, null, value);
    }
    return result as T;
  };

  const castEquality = (resolved: ResolvedPath, target: CastTarget, value: unknown): unknown => {
    if (value === null || value === undefined) {
      return value;
    }
    switch (target.kind) {
      case 'json':
        return value;
      case 'scalar':
        if (value instanceof RegExp) {
          if (target.type === 'string' || target.type === 'objectIdOrString') return value;
          throw new StoreQueryError(
            `A regular expression cannot match the path "${resolved.path}"`,
          );
        }
        return castScalar(target.type, value, {
          path: resolved.path,
          transforms: target.transforms,
        });
      case 'map': {
        if (!isPlainRecord(value)) {
          throw castError('Map', value, resolved.path);
        }
        const map: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          map[key] =
            target.of === 'mixed'
              ? item
              : castScalar(target.of, item, { path: `${resolved.path}.${key}` });
        }
        return map;
      }
      case 'array': {
        const one = (item: unknown) =>
          item instanceof RegExp && target.element === 'string'
            ? item
            : castScalar(target.element, item, {
                path: resolved.path,
                transforms: target.transforms,
              });
        return Array.isArray(value) ? value.map(one) : one(value);
      }
      case 'children':
        if (Array.isArray(value) && value.length === 0) {
          return value;
        }
        throw new StoreQueryError(
          `Equality with elements of the subdocument array "${resolved.path}" is not supported; use $elemMatch`,
        );
      case 'object':
        throw new StoreQueryError(
          `Comparing the object path "${resolved.path}" with a value is not supported (only null and $exists)`,
        );
    }
  };

  const castOperator = (
    resolved: ResolvedPath,
    target: CastTarget,
    operator: string,
    value: unknown,
  ): unknown => {
    if (target.kind === 'json') {
      return value;
    }
    switch (operator) {
      case '$eq':
      case '$ne':
        return castEquality(resolved, target, value);
      case '$in':
      case '$nin': {
        const list = Array.isArray(value) ? value : [value];
        /** mongoose keeps an empty array inside `$in` as it is. */
        return list.map((item) =>
          Array.isArray(item) && item.length === 0 ? item : castEquality(resolved, target, item),
        );
      }
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (target.kind !== 'scalar' && target.kind !== 'array') {
          throw new StoreQueryError(`${operator} cannot compare the path "${resolved.path}"`);
        }
        return castEquality(resolved, target, value);
      case '$exists':
        if (TRUE_VALUES.has(value)) return true;
        if (FALSE_VALUES.has(value)) return false;
        if (value === null || value === undefined) return value;
        throw castError('Boolean', value, resolved.path);
      case '$regex':
        if (value instanceof RegExp) {
          return value;
        }
        if (target.kind === 'array' && target.element === 'string') {
          return castScalar('string', value, {
            path: resolved.path,
            transforms: target.transforms,
          });
        }
        if (
          target.kind === 'scalar' &&
          (target.type === 'string' || target.type === 'objectIdOrString')
        ) {
          return castScalar('string', value, { path: resolved.path });
        }
        throw new StoreQueryError(`$regex cannot match the path "${resolved.path}"`);
      case '$options':
        return String(value);
      case '$not':
        if (value instanceof RegExp) return value;
        if (isOperatorRecord(value)) return castOperators(resolved, target, value);
        throw new StoreQueryError(`$not takes an operator record or a regular expression`);
      case '$size':
        if (target.kind !== 'array' && target.kind !== 'children') {
          throw new StoreQueryError(`$size applies to arrays, not to "${resolved.path}"`);
        }
        return castScalar('number', value, { path: resolved.path });
      case '$all': {
        const list = Array.isArray(value) ? value : [value];
        if (target.kind === 'children') {
          return list.map((item) => {
            if (isPlainRecord(item) && isPlainRecord(item.$elemMatch)) {
              return { $elemMatch: castFilterOn(target.table, item.$elemMatch) };
            }
            throw new StoreQueryError(`$all on "${resolved.path}" takes $elemMatch conditions`);
          });
        }
        if (target.kind === 'array') {
          /** Each `$all` operand is one element (an array operand fails to cast, as in mongoose). */
          return list.map((item) =>
            item instanceof RegExp && target.element === 'string'
              ? item
              : castScalar(target.element, item, {
                  path: resolved.path,
                  transforms: target.transforms,
                }),
          );
        }
        return list.map((item) => castEquality(resolved, target, item));
      }
      case '$elemMatch':
        if (!isPlainRecord(value)) {
          throw new StoreQueryError('$elemMatch takes an object');
        }
        if (target.kind === 'children') {
          return castFilterOn(target.table, value);
        }
        if (target.kind === 'array') {
          const element: CastTarget = {
            kind: 'scalar',
            type: target.element,
            transforms: target.transforms,
          };
          const result: Record<string, unknown> = {};
          for (const [key, item] of Object.entries(value)) {
            if (LOGICAL.has(key) && Array.isArray(item)) {
              result[key] = item.map((entry) =>
                castOperators(resolved, element, entry as Record<string, unknown>),
              );
            } else if (key.startsWith('$bits')) {
              /** mongoose casts `$elemMatch` on a Number array with the array's caster. */
              throw new StoreQueryError(`Can't use ${key} with the array "${resolved.path}"`);
            } else if (key.startsWith('$')) {
              result[key] = castOperator(resolved, element, key, item);
            } else {
              throw new StoreQueryError(
                `$elemMatch on the scalar array "${resolved.path}" takes operators`,
              );
            }
          }
          return result;
        }
        throw new StoreQueryError(`$elemMatch applies to arrays, not to "${resolved.path}"`);
      case '$mod':
        if (!Array.isArray(value)) throw new StoreQueryError('$mod takes [divisor, remainder]');
        return value.map((item) => castScalar('number', item, { path: resolved.path }));
      case '$bitsAllSet':
      case '$bitsAnySet':
      case '$bitsAllClear':
      case '$bitsAnyClear':
        if (target.kind === 'array') {
          /** mongoose: "Can't use $bitsAnySet with Array." */
          throw new StoreQueryError(`Can't use ${operator} with the array "${resolved.path}"`);
        }
        return Array.isArray(value)
          ? value.map((item) => castScalar('number', item, { path: resolved.path }))
          : castScalar('number', value, { path: resolved.path });
      default:
        if (PASS_THROUGH_OPERATORS.has(operator)) {
          return value;
        }
        throw new StoreQueryError(`Unsupported filter operator ${operator} on "${resolved.path}"`);
    }
  };

  const castOperators = (
    resolved: ResolvedPath,
    target: CastTarget,
    operators: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [operator, value] of Object.entries(operators)) {
      result[operator] = castOperator(resolved, target, operator, value);
    }
    return result;
  };

  const castCondition = (
    resolved: ResolvedPath,
    operator: string | null,
    value: unknown,
  ): unknown => {
    const target = castTargetOf(tables, resolved);
    if (operator !== null) {
      return castOperator(resolved, target, operator, value);
    }
    if (target.kind === 'json') {
      return value;
    }
    if (isOperatorRecord(value)) {
      return castOperators(resolved, target, value);
    }
    if (target.kind === 'scalar' && target.type !== 'buffer' && Array.isArray(value)) {
      /** mongoose reads equality with an array on a scalar path (bytes aside) as `$in`. */
      return { $in: castOperator(resolved, target, '$in', value) };
    }
    return castEquality(resolved, target, value);
  };

  /* ---- updates ---- */

  /** The document path of `relative` inside an object whose own path is `base`. */
  const join = (base: string, relative: string) => (base ? `${base}.${relative}` : relative);

  /** Whether an update leaves out the document path (immutable outside `$setOnInsert`). */
  type SkipPath = (docPath: string) => boolean;
  const NO_SKIP: SkipPath = () => false;
  const skipFor = (collection: string, operator: string): SkipPath =>
    !engine || operator === '$setOnInsert'
      ? NO_SKIP
      : (docPath) => engine.isImmutable(collection, docPath);

  /** Casts an object's fields one by one (no defaults); undeclared keys are stripped. */
  const castObjectLeaves = (
    fields: readonly FieldDescriptor[],
    table: RecordTable,
    value: Record<string, unknown>,
    base: string,
    relativeBase: string,
    skip: SkipPath = NO_SKIP,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    const byName = new Map(fields.map((field) => [lastSegmentOf(field.path, relativeBase), field]));
    for (const [key, item] of Object.entries(value)) {
      const field = byName.get(key);
      if (!field) {
        continue;
      }
      if (item === undefined || skip(join(base, key))) {
        continue;
      }
      result[key] = castFieldValue(field, table, item, join(base, key), skip);
    }
    return result;
  };

  const lastSegmentOf = (path: string, relativeBase: string) =>
    relativeBase ? path.slice(relativeBase.length + 1) : path;

  /** The value a declared field gets when assigned (leaf casting, setters applied). */
  const castFieldValue = (
    field: FieldDescriptor,
    table: RecordTable,
    value: unknown,
    docPath: string,
    skip: SkipPath = NO_SKIP,
  ): unknown => {
    if (value === null) {
      return null;
    }
    switch (field.kind) {
      case 'scalar':
        return castScalar(field.type, value, {
          path: docPath,
          transforms: field.transforms,
          countNul: true,
        });
      case 'array':
      case 'elements': {
        const list = Array.isArray(value) ? value : [value];
        return list.map((item) =>
          castScalar(field.element, item, {
            path: docPath,
            transforms: field.transforms,
            countNul: true,
          }),
        );
      }
      case 'object':
        if (!isPlainRecord(value)) {
          throw castError(field.subdocument ? 'Embedded' : 'Object', value, docPath);
        }
        return castObjectLeaves(field.fields, table, value, docPath, field.path, skip);
      case 'children': {
        const child = tables.table(field.table);
        const list = Array.isArray(value) ? value : [value];
        return list.map((item) => {
          if (!isPlainRecord(item)) {
            throw castError('Embedded', item, docPath);
          }
          return castObjectLeaves(child.descriptor.fields, child, item, docPath, '');
        });
      }
      case 'json':
        return castJsonAssignment(field, value, docPath);
    }
  };

  const castJsonAssignment = (
    field: Extract<FieldDescriptor, { kind: 'json' }>,
    value: unknown,
    docPath: string,
  ): unknown => {
    const mapOf = field.json === 'map' ? field.mapOf : undefined;
    if (!mapOf || mapOf === 'mixed') {
      return canonicalizeValue(value);
    }
    let entries: Array<[unknown, unknown]> | null = null;
    if (value instanceof Map) {
      entries = [...value.entries()];
    } else if (isPlainRecord(value)) {
      entries = Object.entries(value);
    }
    if (!entries) {
      throw castError('Map', value, docPath);
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      result[String(key)] = castScalar(mapOf, item, { path: `${docPath}.${key}`, countNul: true });
    }
    return result;
  };

  /** The value `$set` writes at a resolved path. */
  const castAssignedValue = (
    collection: string,
    operator: SubdocumentOperator,
    resolved: ResolvedPath,
    value: unknown,
  ): unknown => {
    const { node } = resolved;
    if (value === null || value === undefined) {
      return value;
    }
    const skip = skipFor(collection, operator);
    const build = (): unknown =>
      canonicalizeValue(engine!.castUpdateValue(collection, operator, resolved.path, value));
    switch (node.kind) {
      case 'element':
        return castScalar(node.field.element, value, {
          path: resolved.path,
          transforms: node.field.transforms,
          countNul: true,
        });
      case 'json': {
        const target = castTargetOf(tables, resolved);
        return target.kind === 'scalar'
          ? castScalar(target.type, value, { path: resolved.path, countNul: true })
          : canonicalizeValue(value);
      }
      case 'childElement':
        if (engine) return build();
        if (!isPlainRecord(value)) throw castError('Embedded', value, resolved.path);
        return castObjectLeaves(node.table.descriptor.fields, node.table, value, resolved.path, '');
      case 'field': {
        const { field } = node;
        if (
          engine &&
          (field.kind === 'children' || (field.kind === 'object' && field.subdocument))
        ) {
          return build();
        }
        if (field.kind === 'children' && isPlainRecord(value)) {
          return castFieldValue(field, resolved.table, [value], resolved.path, skip);
        }
        return castFieldValue(field, resolved.table, value, resolved.path, skip);
      }
    }
  };

  /** The element(s) `$push`/`$addToSet` append at a resolved array path. */
  const castAppended = (
    collection: string,
    operator: '$push' | '$addToSet',
    resolved: ResolvedPath,
    value: unknown,
  ): unknown => {
    const target = castTargetOf(tables, resolved);
    if (target.kind === 'json') {
      return canonicalizeValue(value);
    }
    if (target.kind !== 'array' && target.kind !== 'children') {
      throw new StoreQueryError(`${operator} applies to arrays, not to "${resolved.path}"`);
    }
    const each = isPlainRecord(value) && '$each' in value;
    let slice: number | undefined;
    if (each) {
      /** `$push`'s `$slice` is used by store methods (C2); `$position` and `$sort` are not. */
      const modifiers = Object.keys(value).filter(
        (key) => key !== '$each' && !(key === '$slice' && operator === '$push'),
      );
      if (modifiers.length > 0) {
        throw new StoreQueryError(
          `${operator} modifiers are not supported: ${modifiers.join(', ')}`,
        );
      }
      if (!Array.isArray(value.$each)) {
        throw new StoreQueryError(`${operator}.$each takes an array`);
      }
      if (value.$slice !== undefined) {
        slice = castScalar('number', value.$slice, { path: `${resolved.path}.$slice` }) as number;
        if (!Number.isInteger(slice)) {
          throw new StoreQueryError(`$push.$slice on "${resolved.path}" takes an integer`);
        }
      }
    }
    if (target.kind === 'children' && engine) {
      return canonicalizeValue(engine.castUpdateValue(collection, operator, resolved.path, value));
    }
    const one = (item: unknown): unknown => {
      if (target.kind === 'array') {
        return castScalar(target.element, item, {
          path: resolved.path,
          transforms: target.transforms,
          countNul: true,
        });
      }
      if (!isPlainRecord(item)) {
        throw castError('Embedded', item, resolved.path);
      }
      return castObjectLeaves(
        target.table.descriptor.fields,
        target.table,
        item,
        resolved.path,
        '',
      );
    };
    if (each) {
      return {
        $each: (value as { $each: unknown[] }).$each.map(one),
        ...(slice !== undefined ? { $slice: slice } : {}),
      };
    }
    return one(value);
  };

  /** The condition or value `$pull` removes at a resolved array path. */
  const castPulled = (resolved: ResolvedPath, value: unknown): unknown => {
    const target = castTargetOf(tables, resolved);
    if (target.kind === 'json') {
      return canonicalizeValue(value);
    }
    if (target.kind === 'children') {
      if (!isPlainRecord(value)) {
        throw new StoreQueryError(`$pull on "${resolved.path}" takes a condition on its elements`);
      }
      return castFilterOn(target.table, value);
    }
    if (target.kind !== 'array') {
      throw new StoreQueryError(`$pull applies to arrays, not to "${resolved.path}"`);
    }
    const element: CastTarget = {
      kind: 'scalar',
      type: target.element,
      transforms: target.transforms,
    };
    if (isOperatorRecord(value)) {
      return castOperators(resolved, element, value);
    }
    return castEquality(resolved, element, value);
  };

  const castUpdate = <T extends Record<string, unknown>>(
    collection: string,
    update: T,
    updateOptions: UpdateCastOptions = {},
  ): T => {
    if (!isPlainRecord(update)) {
      throw new StoreQueryError('An update must be an object');
    }
    const root = tables.collection(collection);
    const undeclared = updateOptions.undeclared ?? 'strip';
    const result: Record<string, unknown> = {};

    const castPath = (
      operator: string,
      path: string,
      value: unknown,
    ): { keep: boolean; value?: unknown } => {
      let resolved: ResolvedPath;
      try {
        resolved = resolveRecordPath(tables, root, path, { positional: true });
      } catch (error) {
        if (error instanceof UndeclaredPathError && undeclared !== 'refuse') {
          return undeclared === 'keep' ? { keep: true, value } : { keep: false };
        }
        throw error;
      }
      if (skipFor(collection, operator)(path)) {
        return { keep: false };
      }
      switch (operator) {
        case '$set':
        case '$setOnInsert':
          return { keep: true, value: castAssignedValue(collection, operator, resolved, value) };
        case '$unset':
        case '$currentDate':
          return { keep: true, value };
        case '$inc':
        case '$mul':
        case '$pop': {
          const target = castTargetOf(tables, resolved);
          if (target.kind === 'json') return { keep: true, value };
          if (value === null || value === undefined) {
            throw castError('number', value, path);
          }
          return { keep: true, value: castScalar('number', value, { path }) };
        }
        case '$min':
        case '$max': {
          const target = castTargetOf(tables, resolved);
          if (target.kind === 'json') return { keep: true, value };
          if (target.kind !== 'scalar') {
            throw new StoreQueryError(`${operator} cannot compare the path "${path}"`);
          }
          return {
            keep: true,
            value: castScalar(target.type, value, {
              path,
              transforms: target.transforms,
              countNul: true,
            }),
          };
        }
        case '$push':
        case '$addToSet':
          return { keep: true, value: castAppended(collection, operator, resolved, value) };
        case '$pull':
          return { keep: true, value: castPulled(resolved, value) };
        case '$pullAll': {
          if (!Array.isArray(value)) throw new StoreQueryError('$pullAll takes an array');
          const target = castTargetOf(tables, resolved);
          if (target.kind === 'json') return { keep: true, value: canonicalizeValue(value) };
          if (target.kind !== 'array') {
            throw new StoreQueryError(`$pullAll applies to scalar arrays, not to "${path}"`);
          }
          return {
            keep: true,
            value: value.map((item) =>
              castScalar(target.element, item, { path, transforms: target.transforms }),
            ),
          };
        }
        default:
          throw new StoreQueryError(`Unsupported update operator ${operator}`);
      }
    };

    for (const [key, value] of Object.entries(update)) {
      if (key.startsWith('$')) {
        if (!isPlainRecord(value)) {
          throw new StoreQueryError(`${key} takes an object of paths`);
        }
        const cast: Record<string, unknown> = {};
        for (const [path, item] of Object.entries(value)) {
          const outcome = castPath(key, path, item);
          if (outcome.keep) cast[path] = outcome.value;
        }
        if (Object.keys(cast).length > 0) {
          /** Plain paths cast before `$set` already joined it: merge, as mongoose does. */
          const joined =
            key === '$set' ? (result.$set as Record<string, unknown> | undefined) : undefined;
          result[key] = joined ? { ...joined, ...cast } : cast;
        }
        continue;
      }
      /** A plain path joins `$set`, as mongoose's update casting writes it. */
      const outcome = castPath('$set', key, value);
      if (outcome.keep) {
        const set = (result.$set as Record<string, unknown> | undefined) ?? {};
        set[key] = outcome.value;
        result.$set = set;
      }
    }
    return result as T;
  };

  const castArrayFilters: RecordCaster['castArrayFilters'] = (collection, update, arrayFilters) => {
    const root = tables.collection(collection);
    const paths = Object.entries(update).flatMap(([operator, fields]) =>
      operator.startsWith('$') && isPlainRecord(fields) ? Object.keys(fields) : [],
    );
    /** mongoose drops the filters no update path uses (`removeUnusedArrayFilters`). */
    const used = arrayFilters.filter((filter) => {
      if (!isPlainRecord(filter)) {
        throw new StoreQueryError('An array filter must be an object');
      }
      const segment = `$[${arrayFilterIdentifier(filter)}]`;
      return paths.some((candidate) => candidate.split('.').includes(segment));
    });
    return used.map((filter) => {
      const identifier = arrayFilterIdentifier(filter);
      const segment = `$[${identifier}]`;
      const path = paths.find((candidate) => candidate.split('.').includes(segment)) as string;
      const segments = path.split('.');
      const element = segments.slice(0, segments.indexOf(segment) + 1).join('.');
      const resolved = resolveRecordPath(tables, root, element, { positional: true });
      const { node } = resolved;
      if (node.kind === 'childElement') {
        const prefix = `${identifier}.`;
        const relative = mapFilterPaths(filter, (key) => {
          if (!key.startsWith(prefix)) {
            throw new StoreQueryError(
              `The array filter of "${identifier}" must name fields of the subdocuments of "${element}"`,
            );
          }
          return key.slice(prefix.length);
        });
        return mapFilterPaths(castFilterOn(node.table, relative), (key) => `${prefix}${key}`);
      }
      if (node.kind === 'element') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(filter)) {
          result[key] = key === identifier ? castCondition(resolved, null, value) : value;
        }
        return result;
      }
      return filter;
    });
  };

  return {
    tables,
    castArrayFilters,
    resolve: (collection, path, resolveOptions) =>
      resolveRecordPath(tables, tables.collection(collection), path, resolveOptions),
    castFilter: (collection, filter) => castFilterOn(tables.collection(collection), filter),
    castFilterOn,
    castCondition,
    castUpdate,
    castAssignment: (collection, path, value) =>
      castAssignedValue(
        collection,
        '$set',
        resolveRecordPath(tables, tables.collection(collection), path, { positional: true }),
        value,
      ),
  };
}

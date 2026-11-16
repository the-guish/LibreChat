/**
 * Values of the extended evaluator (docs/postgres-port/PHASE4.md §8 C2): MongoDB's comparison
 * order and equality over the values the collection primitive reads and writes (records as lean
 * reads return them: ids as `IdLike` objects or 24-hex strings, dates as `Date`, binaries as
 * `Buffer`), deep copies, and the BSON type a value has for `$type`. Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * The order is the reference evaluator's (`compareStoreValues` in `ports/query.ts`, an id equal to
 * and ordered like its hex string, R7), extended with binaries (BSON's BinData: by length, then
 * byte by byte), which the typed storage holds in `bytea` columns.
 */
import { StoreQueryError } from '~/ports/query';

export type PlainObject = Record<string, unknown>;

/** A plain object (not an array, `Date`, `Buffer`, id or class instance). */
export function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** An id object (anything with `toHexString`, as `IdLike`). */
export function isIdObject(value: unknown): value is { toHexString(): string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    typeof (value as { toHexString?: unknown }).toHexString === 'function'
  );
}

/** A binary value (`Buffer` or another `Uint8Array`). */
export function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** MongoDB's type order, restricted to the values the storage holds (ids rank as strings, R7). */
const Rank = {
  Null: 1,
  Number: 2,
  String: 3,
  Object: 4,
  Array: 5,
  Binary: 6,
  Boolean: 8,
  Date: 9,
  RegExp: 11,
} as const;

export function rankOf(value: unknown): number {
  if (value === null || value === undefined) return Rank.Null;
  if (typeof value === 'number') return Rank.Number;
  if (typeof value === 'string' || isIdObject(value)) return Rank.String;
  if (typeof value === 'boolean') return Rank.Boolean;
  if (value instanceof Date) return Rank.Date;
  if (value instanceof RegExp) return Rank.RegExp;
  if (Array.isArray(value)) return Rank.Array;
  if (isBinary(value)) return Rank.Binary;
  return Rank.Object;
}

function textOf(value: unknown): string {
  return isIdObject(value) ? value.toHexString().toLowerCase() : (value as string);
}

/** Orders strings by Unicode code point, as MongoDB orders UTF-8 bytes. */
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

/** Compares two values in MongoDB's order (type rank first, then within the type). */
export function compareValues(a: unknown, b: unknown): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case Rank.Null:
      return 0;
    case Rank.Number:
      return sign((a as number) - (b as number));
    case Rank.String:
      return compareStrings(textOf(a), textOf(b));
    case Rank.Boolean:
      if (a === b) return 0;
      return a ? 1 : -1;
    case Rank.Date:
      return sign((a as Date).getTime() - (b as Date).getTime());
    case Rank.RegExp:
      return compareStrings(String(a), String(b));
    case Rank.Binary: {
      const xa = a as Uint8Array;
      const xb = b as Uint8Array;
      if (xa.length !== xb.length) return sign(xa.length - xb.length);
      for (let i = 0; i < xa.length; i++) {
        if (xa[i] !== xb[i]) return sign(xa[i] - xb[i]);
      }
      return 0;
    }
    case Rank.Array: {
      const xa = a as unknown[];
      const xb = b as unknown[];
      for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
        const c = compareValues(xa[i], xb[i]);
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
        const cv = compareValues(va, vb);
        if (cv !== 0) return cv;
      }
      return sign(ea.length - eb.length);
    }
  }
}

/** MongoDB equality: same type rank and equal value (`null` equals only `null`). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return rankOf(a) === rankOf(b) && compareValues(a, b) === 0;
}

/** A deep copy of arrays and plain objects (`undefined` keys dropped); other values are shared. */
export function cloneValue<T>(value: T): T {
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

/** A value for an error message. */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a Date';
  if (isPlainObject(value)) return 'an object';
  return typeof value === 'object' ? 'a value' : `the ${typeof value} ${JSON.stringify(value)}`;
}

/* ------------------------------------------------------------------------------------------ */
/* BSON types ($type)                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * The BSON types `$type` names (aliases and numeric codes). `long`, `decimal`, `timestamp`,
 * `regex` and the deprecated types exist in MongoDB but never in the typed storage (no column or
 * `json` encoding holds them), so they match nothing.
 */
export type BsonTypeName =
  | 'double'
  | 'string'
  | 'object'
  | 'array'
  | 'binData'
  | 'objectId'
  | 'bool'
  | 'date'
  | 'null'
  | 'int'
  | 'long'
  | 'decimal'
  | 'timestamp'
  | 'regex'
  | 'undefined'
  | 'minKey'
  | 'maxKey'
  | 'javascript'
  | 'symbol'
  | 'dbPointer';

const TYPE_CODES: Readonly<Record<number, BsonTypeName>> = {
  1: 'double',
  2: 'string',
  3: 'object',
  4: 'array',
  5: 'binData',
  6: 'undefined',
  7: 'objectId',
  8: 'bool',
  9: 'date',
  10: 'null',
  11: 'regex',
  12: 'dbPointer',
  13: 'javascript',
  14: 'symbol',
  16: 'int',
  17: 'timestamp',
  18: 'long',
  19: 'decimal',
  [-1]: 'minKey',
  127: 'maxKey',
};

const TYPE_NAMES: ReadonlySet<string> = new Set(Object.values(TYPE_CODES));

/** The numeric types `$type: 'number'` stands for. */
const NUMBER_TYPES: readonly BsonTypeName[] = ['double', 'int', 'long', 'decimal'];

/** The type names a `$type` operand selects; throws a `StoreQueryError` for an unknown one. */
export function parseTypeOperand(operand: unknown): Set<BsonTypeName> {
  const list = Array.isArray(operand) ? operand : [operand];
  if (list.length === 0) {
    throw new StoreQueryError('$type takes at least one type');
  }
  const types = new Set<BsonTypeName>();
  for (const item of list) {
    if (item === 'number') {
      NUMBER_TYPES.forEach((type) => types.add(type));
      continue;
    }
    if (typeof item === 'string' && TYPE_NAMES.has(item)) {
      types.add(item as BsonTypeName);
      continue;
    }
    if (typeof item === 'number' && TYPE_CODES[item] !== undefined) {
      types.add(TYPE_CODES[item]);
      continue;
    }
    throw new StoreQueryError(`$type: unknown type ${JSON.stringify(item)}`);
  }
  return types;
}

/**
 * Whether a number is stored as a 32-bit integer: the MongoDB driver serializes a JavaScript
 * number as `int` when it is a safe integer within 32 bits and not `-0`, as `double` otherwise.
 */
export function isInt32Number(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value <= 2_147_483_647 &&
    value >= -2_147_483_648
  );
}

/** The BSON type of a value; `string` is reported as `objectId` when `id` says so. */
export function bsonTypeOf(value: unknown, id = false): BsonTypeName {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return isInt32Number(value) ? 'int' : 'double';
  if (typeof value === 'string') return id ? 'objectId' : 'string';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regex';
  if (Array.isArray(value)) return 'array';
  if (isBinary(value)) return 'binData';
  if (isIdObject(value)) return 'objectId';
  return 'object';
}

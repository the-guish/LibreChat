/**
 * Column value conversions of the PostgreSQL backend (docs/postgres-port/PHASE4.md §1.2, §1.3,
 * D8): how a value of a declared path is written to its typed column and read back, and the
 * tagged encoding of the values held in `json` columns (`Mixed`, arrays of `Mixed`, `Map`).
 * Must not import `mongoose`, `mongodb` or `bson` (eslint.config.mjs): values the MongoDB side
 * hands over (ObjectIds, BSON binaries) are recognized by shape.
 *
 * - an id (24 hex characters, or an object with `toHexString`): an `lc_object_id` column (24
 *   lowercase hex); inside `json`, the lowercase hex string;
 * - a `Date`: a `timestamptz` column (milliseconds); inside `json`, `{"$date":"<ISO 8601>"}`;
 * - binary data (`Buffer`, `Uint8Array`, BSON `Binary`): a `bytea` column; inside `json`,
 *   `{"$binary":"<base64>"}`;
 * - a string: a `text` column; inside `json`, a string.
 *
 * U+0000 (D8): PostgreSQL `text` cannot hold it and a `json` value holding it cannot be cast to
 * `jsonb`, so every string written (text columns, and every string and key inside `json`) has
 * U+0000 replaced with U+FFFD. Each string that had one counts once in
 * {@link getNulReplacementCount}, which the metrics read.
 */
import { StoreQueryError } from '~/ports/query';

/** U+0000, which PostgreSQL text cannot store. */
const NUL = '\u0000';
/** U+FFFD REPLACEMENT CHARACTER, written in its place (D8). */
const REPLACEMENT_CHARACTER = '\uFFFD';

/** Strings (values and keys) written so far with U+0000 replaced, in this process. */
let nulReplacements = 0;
/** Notified once per string whose U+0000 were replaced (the replacement metric). */
let nulReplacementObserver: (() => void) | undefined;

/** How many strings had U+0000 replaced with U+FFFD on write in this process (D8). */
export function getNulReplacementCount(): number {
  return nulReplacements;
}

/** Resets {@link getNulReplacementCount} to zero (specs, metrics scrapes that reset). */
export function resetNulReplacementCount(): void {
  nulReplacements = 0;
}

/**
 * Sets the function told about every string whose U+0000 were replaced (the metric); `undefined`
 * removes it. It must not throw.
 */
export function setNulReplacementObserver(observer: (() => void) | undefined): void {
  nulReplacementObserver = observer;
}

/** Options of the writers; `countNul: false` leaves the replacement counter alone (measuring). */
export interface ValueWriteOptions {
  countNul?: boolean;
}

/**
 * `value` with every U+0000 replaced with U+FFFD (D8), counted once per string that had one
 * unless `countNul` is `false`.
 */
export function replaceNul(value: string, options: ValueWriteOptions = {}): string {
  if (!value.includes(NUL)) {
    return value;
  }
  if (options.countNul !== false) {
    nulReplacements += 1;
    nulReplacementObserver?.();
  }
  return value.split(NUL).join(REPLACEMENT_CHARACTER);
}

/* ------------------------------------------------------------------------------------------ */
/* Ids                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const HEX_ID = /^[0-9a-fA-F]{24}$/;

/** The 24 hex characters `value` spells: a 24-hex string, or an id object's `toHexString()`. */
function hexOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return HEX_ID.test(value) ? value : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const { toHexString } = value as { toHexString?: unknown };
    if (typeof toHexString === 'function') {
      const hex: unknown = toHexString.call(value);
      return typeof hex === 'string' && HEX_ID.test(hex) ? hex : undefined;
    }
  }
  return undefined;
}

/** Whether `value` names an id: a 24-hex string in either case, or an object whose `toHexString()` is one. */
export function isIdValue(value: unknown): boolean {
  return hexOf(value) !== undefined;
}

/**
 * The `lc_object_id` column value of an id: its 24 lowercase hex characters. Throws a
 * `StoreQueryError` for anything {@link isIdValue} refuses (12-byte strings included, R7).
 */
export function toIdColumn(value: unknown): string {
  const hex = hexOf(value);
  if (hex === undefined) {
    throw new StoreQueryError(`Not a valid store id: ${describeValue(value)}`);
  }
  return hex.toLowerCase();
}

/* ------------------------------------------------------------------------------------------ */
/* Dates                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The earliest instant `timestamptz` holds: 24 November 4713 BC (astronomical year -4712),
 * Julian day 0. JavaScript's latest date is within PostgreSQL's range.
 */
const MIN_TIMESTAMP_MS = Date.UTC(-4712, 10, 24);

/**
 * The `timestamptz` column value of a date: a `Date` (a string or number is parsed as `new Date`
 * would), at millisecond precision. Throws a `StoreQueryError` for an invalid date or one before
 * PostgreSQL's range.
 */
export function toTimestampColumn(value: unknown): Date {
  let date: Date | undefined;
  if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === 'string' || typeof value === 'number') {
    date = new Date(value);
  }
  if (!date || Number.isNaN(date.getTime())) {
    throw new StoreQueryError(`Not a valid date: ${describeValue(value)}`);
  }
  if (date.getTime() < MIN_TIMESTAMP_MS) {
    throw new StoreQueryError(`Date outside PostgreSQL's range: ${date.toISOString()}`);
  }
  return date;
}

/** A `timestamptz` value read back (`pg` parses it into a `Date`; a string is parsed). */
export function fromTimestampColumn(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value : new Date(String(value));
}

/* ------------------------------------------------------------------------------------------ */
/* Binary                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** The bytes of a binary value: a `Buffer`, a `Uint8Array`, or a BSON `Binary` (by shape). */
function bytesOf(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'object' && value !== null) {
    const binary = value as { _bsontype?: unknown; buffer?: unknown; position?: unknown };
    if (binary._bsontype === 'Binary' && binary.buffer instanceof Uint8Array) {
      const length = typeof binary.position === 'number' ? binary.position : undefined;
      const bytes = Buffer.from(
        binary.buffer.buffer,
        binary.buffer.byteOffset,
        binary.buffer.byteLength,
      );
      return length === undefined ? bytes : bytes.subarray(0, length);
    }
  }
  return undefined;
}

/** Whether `value` is binary data (`Buffer`, `Uint8Array` or BSON `Binary`). */
export function isBinaryValue(value: unknown): boolean {
  return bytesOf(value) !== undefined;
}

/** The `bytea` column value of binary data. Throws a `StoreQueryError` for anything else. */
export function toByteaColumn(value: unknown): Buffer {
  const bytes = bytesOf(value);
  if (!bytes) {
    throw new StoreQueryError(`Not binary data: ${describeValue(value)}`);
  }
  return bytes;
}

/** A `bytea` value read back (`pg` returns a `Buffer`; the `\x` hex text form is decoded). */
export function fromByteaColumn(value: unknown): Buffer | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  const text = String(value);
  return Buffer.from(text.startsWith('\\x') ? text.slice(2) : text, 'hex');
}

/* ------------------------------------------------------------------------------------------ */
/* Text                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** The `text` column value of a string, with U+0000 replaced (D8). */
export function toTextColumn(value: string, options?: ValueWriteOptions): string {
  return replaceNul(value, options);
}

/* ------------------------------------------------------------------------------------------ */
/* Tagged JSON (json columns)                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** The tag a `Date` is written under inside `json`. */
export const JSON_DATE_TAG = '$date';
/** The tag binary data is written under inside `json`. */
export const JSON_BINARY_TAG = '$binary';

/** A JSON value as the encoder produces it (and `JSON.parse` returns it). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The tagged JSON tree of `value` (PHASE4.md §1.3): dates and binary data tagged, ids as
 * lowercase hex, `undefined` (and functions) dropped from objects and written as `null` in
 * arrays, as `JSON.stringify` does, key order kept, U+0000 replaced in strings and keys (D8).
 *
 * Refused with a `StoreQueryError`, rather than stored as something else:
 * - keys starting with `$` (so a stored object can never look like a tag);
 * - numbers that are not finite (`NaN`, `±Infinity`: JSON has no spelling for them);
 * - `bigint`, symbols, `RegExp`, `Map`, `Set`, invalid dates and circular structures.
 * Other objects (class instances) are written with their own enumerable properties, as
 * `JSON.stringify` writes them; their `toJSON` is not consulted.
 */
export function toTaggedJson(value: unknown, options: ValueWriteOptions = {}): JsonValue {
  const ancestors = new Set<object>();

  const encode = (current: unknown, path: string): JsonValue | undefined => {
    switch (typeof current) {
      case 'undefined':
      case 'function':
        return undefined;
      case 'string':
        return replaceNul(current, options);
      case 'boolean':
        return current;
      case 'number':
        if (!Number.isFinite(current)) {
          throw new StoreQueryError(`Cannot store ${current} inside a json value (at ${path})`);
        }
        return current;
      case 'bigint':
      case 'symbol':
        throw new StoreQueryError(
          `Cannot store a ${typeof current} inside a json value (at ${path})`,
        );
    }
    if (current === null) {
      return null;
    }
    const object = current as object;
    if (object instanceof Date) {
      if (Number.isNaN(object.getTime())) {
        throw new StoreQueryError(`Cannot store an invalid date inside a json value (at ${path})`);
      }
      return { [JSON_DATE_TAG]: object.toISOString() };
    }
    const bytes = bytesOf(object);
    if (bytes) {
      return { [JSON_BINARY_TAG]: bytes.toString('base64') };
    }
    const hex = hexOf(object);
    if (hex !== undefined) {
      return hex.toLowerCase();
    }
    if (object instanceof RegExp || object instanceof Map || object instanceof Set) {
      throw new StoreQueryError(
        `Cannot store a ${object.constructor.name} inside a json value (at ${path})`,
      );
    }
    if (ancestors.has(object)) {
      throw new StoreQueryError(
        `Cannot store a circular structure inside a json value (at ${path})`,
      );
    }
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        return object.map((item, index) => encode(item, `${path}.${index}`) ?? null);
      }
      const result: { [key: string]: JsonValue } = {};
      for (const key of Object.keys(object)) {
        if (key.startsWith('$')) {
          throw new StoreQueryError(
            `Cannot store the key "${key}" inside a json value (at ${path}): keys starting with "$" are refused`,
          );
        }
        const encoded = encode((object as Record<string, unknown>)[key], `${path}.${key}`);
        if (encoded !== undefined) {
          result[replaceNul(key, options)] = encoded;
        }
      }
      return result;
    } finally {
      ancestors.delete(object);
    }
  };

  return encode(value, '$') ?? null;
}

/**
 * The text of a `json` column holding `value` ({@link toTaggedJson}, then `JSON.stringify`).
 * `undefined` at the top level is written as `null`.
 */
export function encodeJsonColumn(value: unknown, options?: ValueWriteOptions): string {
  return JSON.stringify(toTaggedJson(value, options));
}

/** The value a tagged object stands for (`$date` → `Date`, `$binary` → `Buffer`), or `undefined`. */
function untag(value: Record<string, unknown>): Date | Buffer | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return undefined;
  }
  const tagged = value[keys[0]];
  if (typeof tagged !== 'string') {
    return undefined;
  }
  if (keys[0] === JSON_DATE_TAG) {
    return new Date(tagged);
  }
  if (keys[0] === JSON_BINARY_TAG) {
    return Buffer.from(tagged, 'base64');
  }
  return undefined;
}

/** `JSON.parse` reviver of a `json` column: tagged objects back to dates and buffers. */
function reviveTagged(this: unknown, _key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return untag(value as Record<string, unknown>) ?? value;
  }
  return value;
}

/**
 * The value a `json` (or `jsonb`) column holds: its text parsed with the tag reviver, key order
 * kept. A value `pg` already parsed (when the column's type parser was not replaced) is revived
 * in place of being parsed. `null` stays `null`.
 */
export function decodeJsonColumn(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return JSON.parse(value, reviveTagged);
  }
  return reviveParsed(value);
}

/** Revives tags in a value already parsed from JSON. */
function reviveParsed(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reviveParsed);
  }
  if (typeof value === 'object' && value !== null) {
    const tagged = untag(value as Record<string, unknown>);
    if (tagged !== undefined) {
      return tagged;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = reviveParsed(item);
    }
    return result;
  }
  return value;
}

/** A short description of a value for error messages. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}…` : value);
  }
  if (value === null || typeof value !== 'object') {
    return String(value);
  }
  return Object.prototype.toString.call(value);
}

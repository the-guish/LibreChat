/**
 * The canonical form the copy tool verifies with (docs/postgres-port/PHASE4.md §8 X1): a source
 * document (after `bson.ts`) and the record PostgreSQL assembles for it compare equal when their
 * canonical forms do. The form keeps every value and drops only what the storage model does not
 * promise to keep:
 *
 * - ids (ObjectIds, and the 24-hex strings PostgreSQL reads them back as) become lowercase hex;
 * - dates become `{ $date: <ISO 8601> }`, binary data `{ $binary: <base64> }`;
 * - object keys are sorted (key order is not kept: R7, `_extra` in `jsonb` order); `undefined`
 *   values are dropped, as the driver never stores them;
 * - strings and keys have U+0000 replaced with U+FFFD (D8, reported separately);
 * - `-0` becomes `0` (`json` reads it back as `0`), non-finite numbers their names.
 *
 * `_extra` needs nothing here: reads merge it at its paths, so a value moved there compares at the
 * path it had in the source.
 */
import { replaceNul } from '~/adapters/postgres/values';

/** A canonical value: JSON-compatible, keys sorted. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function hexOf(value: object): string | undefined {
  const toHexString = (value as { toHexString?: unknown }).toHexString;
  if (typeof toHexString === 'function') {
    const hex = toHexString.call(value) as unknown;
    if (typeof hex === 'string' && /^[0-9a-fA-F]{24}$/.test(hex)) {
      return hex.toLowerCase();
    }
  }
  return undefined;
}

/** The canonical form of `value` (see the module header). */
export function toCanonical(value: unknown): CanonicalValue {
  switch (typeof value) {
    case 'string':
      return replaceNul(value, { countNul: false });
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return 'Infinity';
      if (value === -Infinity) return '-Infinity';
      return Object.is(value, -0) ? 0 : value;
    case 'boolean':
      return value;
    case 'bigint':
      return Number(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return null;
  }
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map((item) => toCanonical(item));
  }
  const object = value as Record<string, unknown>;
  const hex = hexOf(object);
  if (hex !== undefined) {
    return hex;
  }
  const result: { [key: string]: CanonicalValue } = {};
  for (const key of Object.keys(object).sort()) {
    const item = object[key];
    if (item !== undefined) {
      result[replaceNul(key, { countNul: false })] = toCanonical(item);
    }
  }
  return result;
}

/** Shows a canonical value in a report line, cut to `max` characters. */
function preview(value: CanonicalValue | undefined, max = 80): string {
  const text = value === undefined ? 'missing' : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The first difference between two canonical values, as `{ path, expected, actual }`, or
 * `undefined` when they are equal. `expected` is the source's, `actual` PostgreSQL's.
 */
export function firstDifference(
  expected: CanonicalValue | undefined,
  actual: CanonicalValue | undefined,
  path = '',
): { path: string; expected: string; actual: string } | undefined {
  const differ = () => ({
    path: path || '(root)',
    expected: preview(expected),
    actual: preview(actual),
  });
  if (expected === undefined || actual === undefined || expected === null || actual === null) {
    return expected === actual ? undefined : differ();
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return differ();
    }
    if (expected.length !== actual.length) {
      return differ();
    }
    for (let index = 0; index < expected.length; index++) {
      const found = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof expected === 'object' || typeof actual === 'object') {
    if (typeof expected !== 'object' || typeof actual !== 'object') {
      return differ();
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const found = firstDifference(expected[key], actual[key], path ? `${path}.${key}` : key);
      if (found) return found;
    }
    return undefined;
  }
  return expected === actual ? undefined : differ();
}

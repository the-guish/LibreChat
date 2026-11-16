/**
 * The `_extra` column (docs/postgres-port/PHASE4.md §1.2 "Strict mode and unknown fields", D7): one
 * `jsonb` per table and child table, `NULL` on rows written through the schema engine, holding the
 * values the schema does not describe, under their path: undeclared fields (old fields of
 * long-running deployments, raw seeding) and declared values that do not fit their column (raw
 * mode). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - The value is a nested object: `{ "isPublic": true }`, `{ "permissions": { "AGENTS": {
 *   "SHARED_GLOBAL": true } } }`. Paths are relative to the row (a child row's to its element).
 * - Values use the tagged encoding of §1.3 (`values.ts`): dates and binaries tagged, ids as hex,
 *   U+0000 replaced (D8). Keys starting with `$` are accepted here (legacy `Mixed` contents),
 *   except an object whose only key is a tag.
 * - `jsonb` orders object keys by length then bytes, so the order of `_extra` keys is not kept
 *   (top-level key order is an accepted difference, R7).
 * - Reads merge `_extra` into the record after the declared keys ({@link mergeExtra}); a declared
 *   value read from its column wins over an `_extra` value at the same path. Writes that compute a
 *   record in JavaScript split the undeclared keys back out (`decompose.ts`).
 */
import type { ValueWriteOptions } from '../values';
import { decodeJsonColumn, reviveTaggedJson, toTaggedJson } from '../values';
import { StoreQueryError } from '~/ports/query';

/** An `_extra` value: a nested object of undeclared or misfit values. */
export type ExtraValues = Record<string, unknown>;

/** Whether `value` is a plain object (not an array, date, binary or id). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Sets `value` at the path `segments` of `extra`, creating intermediate objects (a non-object in
 * the way is replaced).
 */
export function setExtraValue(
  extra: ExtraValues,
  segments: readonly string[],
  value: unknown,
): void {
  let current = extra;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]];
    if (isPlainRecord(next)) {
      current = next;
    } else {
      const created: ExtraValues = {};
      current[segments[i]] = created;
      current = created;
    }
  }
  current[segments[segments.length - 1]] = value;
}

/** The value at `path` of `extra` (`undefined` when missing). */
export function getExtraValue(extra: ExtraValues | null, path: string): unknown {
  let current: unknown = extra;
  for (const segment of path.split('.')) {
    if (!isPlainRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * `extra` without the value at `path` (`$unset` of an undeclared path, or a declared path written
 * again); objects left empty are removed. Returns `null` when nothing is left.
 */
export function unsetExtraValue(extra: ExtraValues | null, path: string): ExtraValues | null {
  if (!extra) {
    return null;
  }
  const segments = path.split('.');
  const remove = (current: ExtraValues, depth: number): ExtraValues => {
    const key = segments[depth];
    if (!(key in current)) {
      return current;
    }
    const copy: ExtraValues = { ...current };
    if (depth === segments.length - 1) {
      delete copy[key];
      return copy;
    }
    const next = current[key];
    if (!isPlainRecord(next)) {
      return current;
    }
    const replaced = remove(next, depth + 1);
    if (Object.keys(replaced).length === 0) {
      delete copy[key];
    } else {
      copy[key] = replaced;
    }
    return copy;
  };
  const result = remove(extra, 0);
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * The `_extra` column value (`jsonb` text) of `extra`, `null` when it is empty. Throws a
 * `StoreQueryError` for a value the tagged encoding refuses (non-finite numbers, circular
 * structures, ...).
 */
export function encodeExtraColumn(
  extra: ExtraValues | null,
  options: ValueWriteOptions = {},
): string | null {
  if (!extra || Object.keys(extra).length === 0) {
    return null;
  }
  return JSON.stringify(toTaggedJson(extra, { ...options, allowDollarKeys: true }));
}

/** An `_extra` value read back: from its text, or from JSON already parsed (`json_agg`). */
export function decodeExtraColumn(
  value: unknown,
  options: { parsed?: boolean } = {},
): ExtraValues | null {
  if (value === null || value === undefined) {
    return null;
  }
  const decoded = options.parsed ? reviveTaggedJson(value) : decodeJsonColumn(value);
  if (!isPlainRecord(decoded)) {
    throw new StoreQueryError('The _extra column does not hold an object');
  }
  return Object.keys(decoded).length === 0 ? null : decoded;
}

/**
 * Merges `extra` into `record` (in place) after its declared keys: a key the record lacks is
 * appended; where both hold plain objects the merge recurses; otherwise the record's (declared)
 * value wins. `keep(path)` filters the `_extra` paths merged (a projection): `'whole'` merges the
 * value at the path, `'partial'` recurses into it (when it is an object), `'none'` skips it.
 */
export function mergeExtra(
  record: Record<string, unknown>,
  extra: ExtraValues | null,
  keep: (path: string) => 'whole' | 'partial' | 'none' = () => 'whole',
  prefix = '',
): Record<string, unknown> {
  if (!extra) {
    return record;
  }
  for (const [key, value] of Object.entries(extra)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const state = keep(path);
    if (state === 'none') {
      continue;
    }
    const existing = record[key];
    if (state === 'partial') {
      if (!isPlainRecord(value)) {
        continue;
      }
      if (existing === undefined) {
        const target: Record<string, unknown> = {};
        mergeExtra(target, value, keep, path);
        if (Object.keys(target).length > 0) {
          record[key] = target;
        }
      } else if (isPlainRecord(existing)) {
        mergeExtra(existing, value, keep, path);
      }
      continue;
    }
    if (existing === undefined) {
      record[key] = value;
    } else if (isPlainRecord(existing) && isPlainRecord(value)) {
      mergeExtra(existing, value, keep, path);
    }
  }
  return record;
}

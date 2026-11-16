/**
 * The update evaluator of the tier-2 path (docs/postgres-port/PHASE4.md §3.3): the reference
 * evaluator's `applyStoreUpdate` (`ports/query.ts`, MongoDB's rules, checked against MongoDB),
 * plus `$pull` by condition, which the primitive accepts beyond the query language (MongoDB's
 * forms: an operator condition or a regular expression on scalar elements, a filter on the
 * elements of an array of subdocuments). Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { StoreFilter, StoreUpdate } from '~/ports/query';
import type { PgRecord } from './types';
import { applyStoreUpdate, matchesStoreFilter, StoreQueryError } from '~/ports/query';
import { isPlainRecord } from '../records/extra';

/** Whether a `$pull` operand is a condition rather than a value to remove. */
export function isPullCondition(value: unknown): boolean {
  return value instanceof RegExp || isPlainRecord(value);
}

/** Whether `element` matches the `$pull` condition `condition`. */
function pullMatches(element: unknown, condition: unknown): boolean {
  if (condition instanceof RegExp) {
    condition.lastIndex = 0;
    return typeof element === 'string' && condition.test(element);
  }
  const record = condition as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 0 && keys.every((key) => key.startsWith('$'))) {
    return matchesStoreFilter({ v: element }, { v: record } as unknown as StoreFilter);
  }
  return isPlainRecord(element) && matchesStoreFilter(element, record as StoreFilter);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `the ${typeof value} ${String(value)}`;
}

/** Removes the elements matching `condition` from the array at `path` (in place). */
function pullByCondition(record: PgRecord, path: string, condition: unknown): void {
  const segments = path.split('.');
  let current: unknown = record;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = (current as PgRecord)[segments[i]];
    if (next === undefined) {
      return;
    }
    if (!isPlainRecord(next)) {
      throw new StoreQueryError(
        `$pull "${path}": cannot write through ${describe(next)} at "${segments
          .slice(0, i + 1)
          .join('.')}"`,
      );
    }
    current = next;
  }
  const parent = current as PgRecord;
  const key = segments[segments.length - 1];
  const value = parent[key];
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new StoreQueryError(
      `$pull "${path}": the stored value is ${describe(value)}, not an array`,
    );
  }
  parent[key] = value.filter((element) => !pullMatches(element, condition));
}

/**
 * The record after `update` (cast already), by MongoDB's rules; `record` is not changed. Throws a
 * `StoreQueryError` for an update MongoDB refuses (writing through a scalar, `$inc` of a
 * non-number, `$push` onto a non-array, ...) and for operators outside the primitive's set.
 */
export function applyCollectionUpdate(
  record: PgRecord,
  update: PgRecord,
  options: { inserting?: boolean } = {},
): PgRecord {
  const pull = update.$pull;
  if (!isPlainRecord(pull)) {
    return applyStoreUpdate(record, update as StoreUpdate, options);
  }
  const values: PgRecord = {};
  const conditions: Array<[string, unknown]> = [];
  for (const [path, operand] of Object.entries(pull)) {
    if (isPullCondition(operand)) {
      conditions.push([path, operand]);
    } else {
      values[path] = operand;
    }
  }
  const rest: PgRecord = { ...update };
  if (Object.keys(values).length > 0) {
    rest.$pull = values;
  } else {
    delete rest.$pull;
  }
  const result = applyStoreUpdate(record, rest as StoreUpdate, options);
  for (const [path, condition] of conditions) {
    pullByCondition(result, path, condition);
  }
  return result;
}

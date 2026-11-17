/**
 * The `$elemMatch` projection of the extended evaluator (docs/postgres-port/PHASE4.md §8 C2):
 * `{ allocations: { $elemMatch: { 'session.attemptId': id } } }` returns the array with only its
 * first element matching the condition, and leaves the field out when none does (or when it is
 * not an array). It counts as an inclusion of the field. Must not import `mongoose`, `mongodb` or
 * `bson`.
 */
import type { MatchOptions } from './filter';
import type { PlainObject } from './values';
import { firstElemMatch } from './filter';
import { isPlainObject } from './values';

/** The `$elemMatch` entries of a record-form projection, by field. */
export function elemMatchEntries(projection: unknown): Map<string, PlainObject> {
  const entries = new Map<string, PlainObject>();
  if (!isPlainObject(projection)) {
    return entries;
  }
  for (const [field, value] of Object.entries(projection)) {
    if (isPlainObject(value) && isPlainObject(value.$elemMatch)) {
      entries.set(field, value.$elemMatch);
    }
  }
  return entries;
}

/** Applies `$elemMatch` projections (by field) to a read record, in place. */
export function applyElemMatchProjection(
  record: PlainObject,
  entries: ReadonlyMap<string, PlainObject>,
  options: MatchOptions = {},
): PlainObject {
  for (const [field, spec] of entries) {
    const value = record[field];
    if (!Array.isArray(value)) {
      delete record[field];
      continue;
    }
    const index = firstElemMatch(value, spec, field, options);
    if (index < 0) {
      delete record[field];
    } else {
      record[field] = [value[index]];
    }
  }
  return record;
}

/**
 * The update evaluator of the tier-2 path and of the shadow check (docs/postgres-port/PHASE4.md
 * §3.3): the extended evaluator of `../evaluator` (MongoDB's rules for every update the primitive
 * applies: the operators of the query language, `$pull` by condition, positional paths with
 * `arrayFilters`, `$push` with `$slice`, `$currentDate`), checked against MongoDB by corpus C.
 * Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { ExtendedUpdateContext } from '../evaluator';
import type { PgRecord } from './types';
import { applyExtendedUpdate } from '../evaluator';
import { isPlainRecord } from '../records/extra';

/** Whether a `$pull` operand is a condition rather than a value to remove. */
export function isPullCondition(value: unknown): boolean {
  return value instanceof RegExp || isPlainRecord(value);
}

/**
 * The record after `update` (cast already), by MongoDB's rules; `record` is not changed. Throws a
 * `StoreQueryError` for an update MongoDB refuses (writing through a scalar, `$inc` of a
 * non-number, `$push` onto a non-array, a positional `$` without a match, ...) and for operators
 * outside the primitive's set.
 */
export function applyCollectionUpdate(
  record: PgRecord,
  update: PgRecord,
  context: ExtendedUpdateContext = {},
): PgRecord {
  return applyExtendedUpdate(record, update, context);
}

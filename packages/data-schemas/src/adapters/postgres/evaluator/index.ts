/**
 * The extended reference evaluator of the PostgreSQL backend (docs/postgres-port/PHASE4.md §3.3,
 * §8 C2): MongoDB's semantics for everything the collection primitive accepts beyond the portable
 * query language of `ports/query.ts` (which is not widened): the extended filter operators, the
 * `$elemMatch` projection, positional updates with `arrayFilters`, `$pull` by condition, `$push`
 * with `$slice`, `$addToSet` of subdocuments and `$currentDate`. Tier 2 computes its post-images
 * with it, the shadow check compares tier 1 against it, and corpus C checks it against MongoDB.
 * Must not import `mongoose`, `mongodb` or `bson`.
 */
export {
  bitTest,
  bitMaskOf,
  FilterMatcher,
  firstElemMatch,
  positionalIndex,
  isValueElemMatch,
  matchesExtendedFilter,
} from './filter';
export type { MatchOptions, MatchDetails } from './filter';
export {
  applyExtendedUpdate,
  indexArrayFilters,
  arrayFilterIdentifier,
  arrayFilterIdentifiers,
  REFUSED_UPDATE_OPERATORS,
  EXTENDED_UPDATE_OPERATORS,
} from './update';
export type { ExtendedUpdateContext } from './update';
export { applyElemMatchProjection, elemMatchEntries } from './projection';
export {
  rankOf,
  cloneValue,
  bsonTypeOf,
  valuesEqual,
  compareValues,
  isInt32Number,
  parseTypeOperand,
} from './values';
export type { BsonTypeName } from './values';

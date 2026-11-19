/**
 * Filters of the extended evaluator (docs/postgres-port/PHASE4.md §8 C2): MongoDB's matching
 * rules for everything the PostgreSQL translator accepts, beyond the query language of
 * `ports/query.ts`: `$eq`, `$nor`, `$size`, `$elemMatch` (document and value forms), `$all`,
 * `$not`, `$type`, the bit tests, equality with arrays and objects, and numeric path segments. It
 * also reports the position the positional `$` update operator takes from a match. Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * ## Paths
 * A path reaches its candidates as MongoDB walks it: a key of an object; through an array, the
 * key of each object element (an object element lacking it gives "missing"; a scalar or nested
 * array element gives nothing); a numeric segment on an array also takes the element at that
 * index (none past the end); a missing key, or a scalar or `null` where an object is needed, gives
 * "missing". A condition then holds for some candidate: the value itself, or (for an array value)
 * one of its elements, which is how `field: value` means "array contains".
 *
 * ## The positional `$`
 * MongoDB records, for the update's positional operator, the index of the array element through
 * which a filter condition matched (the outermost array the path crossed, or the element of the
 * array value that passed). Its optimizer sorts a conjunction (the filter's top level, with `$and`
 * clauses and a one-clause `$or` flattened into it) by path, then by expression type (`$or` <
 * `$elemMatch` < equality < `$lte` < `$lt` < `$gt` < `$gte` < regular expressions < `$exists` <
 * `$in` < bit tests < negations < `$type`), and the last condition in that order that records an
 * index wins (checked against MongoDB by corpus C); an `$or` records the index of its first
 * matching clause. Negations (`$ne`, `$nin`, `$not`, `$exists: false`) and `$nor` record nothing,
 * nor does a condition met by the array as a whole (`$size`, `$exists` on the array, `$type:
 * 'array'`).
 *
 * Refused with a `StoreQueryError`: `$expr`, `$where`, `$text`, `$mod`, geospatial and any other
 * operator, positions in filter paths (`a.$`), and bit tests with a binary mask or a bit position
 * past 63.
 */
import type { BsonTypeName, PlainObject } from './values';
import {
  rankOf,
  isBinary,
  bsonTypeOf,
  valuesEqual,
  isPlainObject,
  compareValues,
  parseTypeOperand,
} from './values';
import { StoreQueryError } from '~/ports/query';

/** Options of the matcher. */
export interface MatchOptions {
  /**
   * Whether the value at a document path (numeric segments left out) is an id: records read from
   * the typed storage hold ids as 24-hex strings, which `$type: 'objectId'` must recognize.
   */
  isIdPath?: (path: string) => boolean;
}

/** What a match records for the positional `$` (see the module header). */
export interface MatchDetails {
  position?: number;
}

const MISSING: unique symbol = Symbol('missing');

interface Candidate {
  value: unknown;
  /** The document path reached (numeric segments into arrays left out). */
  path: string;
  /** The index in the outermost array the path crossed, if any. */
  index?: number;
}

/** A match: `position` is the array index it went through, if any. */
type Hit = { position: number | undefined } | null;

const hit = (position?: number): Hit => ({ position });
const NUMERIC = /^\d+$/;
const LOGICAL = new Set(['$and', '$or', '$nor']);

const join = (base: string, segment: string): string => (base ? `${base}.${segment}` : segment);

function resolve(
  value: unknown,
  segments: readonly string[],
  at: number,
  path: string,
  index: number | undefined,
  out: Candidate[],
): void {
  if (at === segments.length) {
    out.push({ value: value === undefined ? MISSING : value, path, index });
    return;
  }
  const segment = segments[at];
  if (segment.startsWith('$')) {
    throw new StoreQueryError(`Positional operators are not supported in filters ("${segment}")`);
  }
  if (Array.isArray(value)) {
    if (NUMERIC.test(segment)) {
      const position = Number(segment);
      if (position < value.length) {
        resolve(value[position], segments, at + 1, path, index ?? position, out);
      }
    }
    value.forEach((element, position) => {
      if (isPlainObject(element)) {
        resolve(element, segments, at, path, index ?? position, out);
      }
    });
    return;
  }
  if (!isPlainObject(value)) {
    out.push({ value: MISSING, path, index });
    return;
  }
  const child = value[segment];
  if (child === undefined) {
    out.push({ value: MISSING, path: join(path, segment), index });
    return;
  }
  resolve(child, segments, at + 1, join(path, segment), index, out);
}

/** The candidates of `path` in `record`. */
function candidatesOf(record: unknown, path: string): Candidate[] {
  const out: Candidate[] = [];
  resolve(record, path.split('.'), 0, '', undefined, out);
  return out;
}

/** What a condition tests at a candidate: the value, and each element of an array value. */
interface Leaf {
  value: unknown;
  /** The position of an array element, `undefined` for the value itself. */
  element?: number;
}

function leavesOf(candidate: Candidate, unwrap: boolean): Leaf[] {
  if (candidate.value === MISSING) return [];
  if (!unwrap || !Array.isArray(candidate.value)) return [{ value: candidate.value }];
  return [
    { value: candidate.value },
    ...candidate.value.map((value, element) => ({ value, element })),
  ];
}

/** Finds the first leaf passing `test`, giving its position. */
function some(
  candidates: readonly Candidate[],
  unwrap: boolean,
  test: (value: unknown, candidate: Candidate) => boolean,
): Hit {
  for (const candidate of candidates) {
    for (const leaf of leavesOf(candidate, unwrap)) {
      if (test(leaf.value, candidate)) {
        return hit(candidate.index ?? leaf.element);
      }
    }
  }
  return null;
}

/** A `RegExp` from a value or a `$regex`/`$options` pair. */
function regexOf(source: unknown, options?: unknown): RegExp {
  if (source instanceof RegExp) {
    return new RegExp(source.source, typeof options === 'string' ? options : source.flags);
  }
  if (typeof source !== 'string') {
    throw new StoreQueryError('$regex takes a pattern');
  }
  return new RegExp(source, typeof options === 'string' ? options : '');
}

function matchesRegex(value: unknown, regex: RegExp): boolean {
  regex.lastIndex = 0;
  return typeof value === 'string' && regex.test(value);
}

function equality(candidates: readonly Candidate[], expected: unknown, unwrap: boolean): Hit {
  if (expected instanceof RegExp) {
    return some(candidates, unwrap, (value) => matchesRegex(value, expected));
  }
  if (expected === null || expected === undefined) {
    for (const candidate of candidates) {
      if (candidate.value === MISSING) return hit(candidate.index);
      const leaf = leavesOf(candidate, unwrap).find((item) => item.value === null);
      if (leaf) return hit(candidate.index ?? leaf.element);
    }
    return null;
  }
  return some(candidates, unwrap, (value) => valuesEqual(value, expected));
}

function membership(candidates: readonly Candidate[], list: unknown, unwrap: boolean): Hit {
  if (!Array.isArray(list)) {
    throw new StoreQueryError('$in takes an array');
  }
  for (const candidate of candidates) {
    if (candidate.value === MISSING) {
      if (list.some((expected) => expected === null || expected === undefined)) {
        return hit(candidate.index);
      }
      continue;
    }
    for (const leaf of leavesOf(candidate, unwrap)) {
      const single: Candidate = { value: leaf.value, path: candidate.path };
      if (list.some((expected) => equality([single], expected, false))) {
        return hit(candidate.index ?? leaf.element);
      }
    }
  }
  return null;
}

function range(
  candidates: readonly Candidate[],
  operator: string,
  operand: unknown,
  unwrap: boolean,
): Hit {
  if (operand === null || operand === undefined) {
    return operator === '$gte' || operator === '$lte' ? equality(candidates, null, unwrap) : null;
  }
  const rank = rankOf(operand);
  return some(candidates, unwrap, (value) => {
    if (value === null || rankOf(value) !== rank) return false;
    const c = compareValues(value, operand);
    switch (operator) {
      case '$gt':
        return c > 0;
      case '$gte':
        return c >= 0;
      case '$lt':
        return c < 0;
      default:
        return c <= 0;
    }
  });
}

/** The 64-bit mask of a bit test operand (a non-negative integer or a list of bit positions). */
export function bitMaskOf(operator: string, operand: unknown): bigint {
  if (typeof operand === 'number') {
    if (!Number.isSafeInteger(operand) || operand < 0) {
      throw new StoreQueryError(`${operator} takes a non-negative integer mask`);
    }
    return BigInt(operand);
  }
  if (Array.isArray(operand)) {
    let mask = BigInt(0);
    for (const position of operand) {
      if (!Number.isInteger(position) || position < 0 || position > 63) {
        throw new StoreQueryError(`${operator} takes bit positions from 0 to 63`);
      }
      mask |= BigInt(1) << BigInt(position);
    }
    return mask;
  }
  throw new StoreQueryError(
    `${operator} takes a mask or a list of bit positions (binary masks are not supported)`,
  );
}

/** The signed 64-bit value of a number a bit test applies to, or `undefined`. */
function int64Of(value: unknown): bigint | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < -(2 ** 63) || value >= 2 ** 63) return undefined;
  return BigInt(value);
}

/** Whether `bits` passes the bit test `operator` with `mask`. */
export function bitTest(operator: string, bits: bigint, mask: bigint): boolean {
  const masked = BigInt.asUintN(64, bits) & mask;
  switch (operator) {
    case '$bitsAllSet':
      return masked === mask;
    case '$bitsAnySet':
      return masked !== BigInt(0);
    case '$bitsAllClear':
      return masked === BigInt(0);
    default:
      return masked !== mask;
  }
}

/** Whether `$elemMatch`'s operand is the value form (operators on each element). */
export function isValueElemMatch(spec: PlainObject): boolean {
  const keys = Object.keys(spec);
  return keys.length > 0 && keys.every((key) => key.startsWith('$') && !LOGICAL.has(key));
}

/** A plain object whose keys are all operators (`{ $gt: 1 }`). */
function isOperatorRecord(value: unknown): value is PlainObject {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

export class FilterMatcher {
  constructor(private readonly options: MatchOptions = {}) {}

  private typeMatches(value: unknown, path: string, types: ReadonlySet<BsonTypeName>): boolean {
    if (value === undefined) return false;
    const id = typeof value === 'string' && (this.options.isIdPath?.(path) ?? false);
    return types.has(bsonTypeOf(value, id));
  }

  /** Whether `element` (one array element) matches the `$elemMatch` operand `spec`. */
  elementMatches(element: unknown, spec: PlainObject, path: string): boolean {
    if (isValueElemMatch(spec)) {
      return this.operators([{ value: element, path }], spec, false) !== null;
    }
    return isPlainObject(element) && this.matches(element, spec, undefined, path);
  }

  private elemMatch(candidates: readonly Candidate[], spec: unknown): Hit {
    if (!isPlainObject(spec)) {
      throw new StoreQueryError('$elemMatch takes an object');
    }
    for (const candidate of candidates) {
      if (!Array.isArray(candidate.value)) continue;
      const position = candidate.value.findIndex((element) =>
        this.elementMatches(element, spec, candidate.path),
      );
      if (position >= 0) return hit(candidate.index ?? position);
    }
    return null;
  }

  private operator(
    candidates: readonly Candidate[],
    operator: string,
    operand: unknown,
    record: PlainObject,
    unwrap: boolean,
  ): Hit {
    switch (operator) {
      case '$eq':
        return equality(candidates, operand, unwrap);
      case '$ne':
        return equality(candidates, operand, unwrap) ? null : hit();
      case '$in':
        return membership(candidates, operand, unwrap);
      case '$nin':
        return membership(candidates, operand, unwrap) ? null : hit();
      case '$exists': {
        const present = candidates.find((candidate) => candidate.value !== MISSING);
        if (operand === false) return present ? null : hit();
        return present ? hit(present.index) : null;
      }
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        return range(candidates, operator, operand, unwrap);
      case '$regex':
        return some(candidates, unwrap, (value) =>
          matchesRegex(value, regexOf(operand, record.$options)),
        );
      case '$options':
        if (!('$regex' in record)) {
          throw new StoreQueryError('$options is only allowed with $regex');
        }
        return hit();
      case '$size': {
        if (typeof operand !== 'number' || !Number.isInteger(operand) || operand < 0) {
          throw new StoreQueryError('$size takes a non-negative integer');
        }
        const found = candidates.find(
          (candidate) => Array.isArray(candidate.value) && candidate.value.length === operand,
        );
        return found ? hit(found.index) : null;
      }
      case '$elemMatch':
        return this.elemMatch(candidates, operand);
      case '$all': {
        if (!Array.isArray(operand)) {
          throw new StoreQueryError('$all takes an array');
        }
        if (operand.length === 0) return null;
        let last: Hit = null;
        for (const item of operand) {
          const found =
            isPlainObject(item) && '$elemMatch' in item
              ? this.elemMatch(candidates, item.$elemMatch)
              : equality(candidates, item, unwrap);
          if (!found) return null;
          last = found.position !== undefined || !last ? found : last;
        }
        return last;
      }
      case '$not': {
        let inner: Hit;
        if (operand instanceof RegExp) {
          inner = some(candidates, unwrap, (value) => matchesRegex(value, operand));
        } else if (isOperatorRecord(operand)) {
          inner = this.operators(candidates, operand, unwrap);
        } else {
          throw new StoreQueryError('$not takes an operator record or a regular expression');
        }
        return inner ? null : hit();
      }
      case '$type': {
        const types = parseTypeOperand(operand);
        for (const candidate of candidates) {
          if (candidate.value === MISSING) continue;
          if (this.typeMatches(candidate.value, candidate.path, types)) {
            return hit(candidate.index);
          }
          if (unwrap && Array.isArray(candidate.value)) {
            const position = candidate.value.findIndex((element) =>
              this.typeMatches(element, candidate.path, types),
            );
            if (position >= 0) return hit(candidate.index ?? position);
          }
        }
        return null;
      }
      case '$bitsAllSet':
      case '$bitsAnySet':
      case '$bitsAllClear':
      case '$bitsAnyClear': {
        const mask = bitMaskOf(operator, operand);
        return some(candidates, unwrap, (value) => {
          const bits = int64Of(value);
          return bits !== undefined && !isBinary(value) && bitTest(operator, bits, mask);
        });
      }
      case '$comment':
        return hit();
      default:
        throw new StoreQueryError(`Unsupported filter operator ${operator}`);
    }
  }

  /** All operators of `record` on the candidates, each recording its position in `hits`. */
  private operators(
    candidates: readonly Candidate[],
    record: PlainObject,
    unwrap: boolean,
    hits?: KeyHit[],
    path = '',
  ): Hit {
    let result: Hit = hit();
    for (const [operator, operand] of Object.entries(record)) {
      const found = this.operator(candidates, operator, operand, record, unwrap);
      if (!found) return null;
      if (found.position !== undefined) {
        result = found;
        hits?.push({
          path,
          rank: operatorRank(operator, operand),
          order: hits.length,
          position: found.position,
        });
      }
    }
    return result;
  }

  private condition(
    candidates: readonly Candidate[],
    condition: unknown,
    hits: KeyHit[] | undefined,
    path: string,
  ): Hit {
    if (isOperatorRecord(condition)) {
      return this.operators(candidates, condition, true, hits, path);
    }
    const found = equality(candidates, condition, true);
    if (found?.position !== undefined) {
      hits?.push({
        path,
        rank: condition instanceof RegExp ? MATCH_RANK.$regex : MATCH_RANK.$eq,
        order: hits.length,
        position: found.position,
      });
    }
    return found;
  }

  /** Matches `filter`'s conditions (a conjunction), collecting the positions they record. */
  private conjunction(
    record: unknown,
    filter: PlainObject,
    hits: KeyHit[] | undefined,
    base: string,
  ): boolean {
    if (!isPlainObject(filter)) {
      throw new StoreQueryError('A filter must be an object');
    }
    for (const [key, condition] of Object.entries(filter)) {
      if (LOGICAL.has(key)) {
        if (!Array.isArray(condition) || condition.length === 0) {
          throw new StoreQueryError(`${key} takes a non-empty array of filters`);
        }
        const clauses = condition as PlainObject[];
        if (key === '$and' || (key === '$or' && clauses.length === 1)) {
          /** MongoDB flattens `$and` (and a one-clause `$or`) into the enclosing conjunction. */
          if (!clauses.every((clause) => this.conjunction(record, clause, hits, base))) {
            return false;
          }
          continue;
        }
        if (key === '$nor') {
          if (clauses.some((clause) => this.conjunction(record, clause, undefined, base))) {
            return false;
          }
          continue;
        }
        let matched = false;
        for (const clause of clauses) {
          const inner: KeyHit[] = [];
          if (this.conjunction(record, clause, hits ? inner : undefined, base)) {
            matched = true;
            const position = resolvePosition(inner);
            if (hits && position !== undefined) {
              hits.push({ path: '', rank: MATCH_RANK.$or, order: hits.length, position });
            }
            break;
          }
        }
        if (!matched) return false;
        continue;
      }
      if (key === '$comment') continue;
      if (key.startsWith('$')) {
        throw new StoreQueryError(`Unsupported filter operator ${key}`);
      }
      const candidates = candidatesOf(record, key).map((candidate) => ({
        ...candidate,
        path: join(base, candidate.path),
      }));
      if (!this.condition(candidates, condition, hits, key)) return false;
    }
    return true;
  }

  /**
   * Whether `record` matches `filter`; `details.position` receives the positional index (see the
   * module header). `base` is the document path of `record` (an array element: the array's).
   */
  matches(record: unknown, filter: PlainObject, details?: MatchDetails, base = ''): boolean {
    const hits: KeyHit[] | undefined = details ? [] : undefined;
    const matched = this.conjunction(record, filter, hits, base);
    if (details && matched) {
      details.position = resolvePosition(hits as KeyHit[]);
    }
    return matched;
  }
}

/** A position a condition recorded, with what MongoDB orders a conjunction's conditions by. */
interface KeyHit {
  path: string;
  rank: number;
  order: number;
  position: number;
}

/**
 * MongoDB's match expression types in the order its optimizer sorts a conjunction by (after the
 * path): the last condition in that order that records a position gives the positional `$`.
 */
const MATCH_RANK = {
  $or: 1,
  $elemMatchObject: 2,
  $elemMatchValue: 3,
  $size: 4,
  $eq: 5,
  $lte: 6,
  $lt: 7,
  $gt: 8,
  $gte: 9,
  $regex: 10,
  $exists: 12,
  $in: 13,
  $bitsAllSet: 14,
  $bitsAllClear: 15,
  $bitsAnySet: 16,
  $bitsAnyClear: 17,
  $not: 18,
  $type: 20,
} as const;

function operatorRank(operator: string, operand: unknown): number {
  if (operator === '$elemMatch') {
    return isPlainObject(operand) && isValueElemMatch(operand)
      ? MATCH_RANK.$elemMatchValue
      : MATCH_RANK.$elemMatchObject;
  }
  if (operator === '$all') return MATCH_RANK.$eq;
  return (MATCH_RANK as Record<string, number>)[operator] ?? MATCH_RANK.$eq;
}

/** The position of a conjunction: its last recording condition by (path, type, order). */
function resolvePosition(hits: readonly KeyHit[]): number | undefined {
  const sorted = [...hits].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.order - b.order;
  });
  return sorted.length > 0 ? sorted[sorted.length - 1].position : undefined;
}

/** Whether `record` matches `filter` by MongoDB's rules (see the module header). */
export function matchesExtendedFilter(
  record: PlainObject,
  filter: PlainObject,
  options: MatchOptions = {},
): boolean {
  return new FilterMatcher(options).matches(record, filter);
}

/** The index the positional `$` takes from `record` matching `filter`, if any. */
export function positionalIndex(
  record: PlainObject,
  filter: PlainObject,
  options: MatchOptions = {},
): number | undefined {
  const details: MatchDetails = {};
  return new FilterMatcher(options).matches(record, filter, details) ? details.position : undefined;
}

/** The index of the first element of `array` matching the `$elemMatch` operand, or `-1`. */
export function firstElemMatch(
  array: readonly unknown[],
  spec: PlainObject,
  path: string,
  options: MatchOptions = {},
): number {
  const matcher = new FilterMatcher(options);
  return array.findIndex((element) => matcher.elementMatches(element, spec, path));
}

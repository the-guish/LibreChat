/**
 * Updates of the extended evaluator (docs/postgres-port/PHASE4.md §3.3, §8 C2): MongoDB's update
 * rules for everything the collection primitive applies, beyond `applyStoreUpdate` of
 * `ports/query.ts`: positional paths (`a.$`, `a.$[]`, `a.$[x]` with `arrayFilters`, numeric
 * segments), `$pull` by condition, `$push` with `$slice`, `$addToSet` of subdocuments and
 * `$currentDate`. It computes the tier-2 post-image and the shadow check's expected one. Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * - The positional `$` takes the index the filter recorded on the pre-image (`filter.ts`); an
 *   update without one fails as MongoDB does ("did not find the match needed from the query").
 * - `$[x]` selects the elements of the pre-image matching the `arrayFilters` entry of `x` (each
 *   entry names one identifier; one left unused, or a path naming an identifier without one,
 *   fails, as MongoDB refuses them before applying anything); `$[]` every element. The array must
 *   exist and be an array.
 * - A numeric segment on an array is that element; writing past the end pads with `null`.
 * - Writing a field through an array without a position, or through a scalar or `null`, fails;
 *   `$unset` there does nothing; `$unset` of an array element sets it to `null`.
 * - Refused (no store method uses them): `$mul`, `$pop`, `$rename`, `$bit`, `$push`'s `$position`
 *   and `$sort`, and `$currentDate` with `$type: 'timestamp'` (the storage has no timestamps).
 */
import type { MatchOptions } from './filter';
import type { PlainObject } from './values';
import { cloneValue, describeValue, isPlainObject, valuesEqual, compareValues } from './values';
import { FilterMatcher, isValueElemMatch, positionalIndex } from './filter';
import { StoreQueryError } from '~/ports/query';

/** The context of an update. */
export interface ExtendedUpdateContext extends MatchOptions {
  /** The update inserts the record (an upsert that found none): `$setOnInsert` applies. */
  inserting?: boolean;
  /** The filter the record matched (cast), for the positional `$`. */
  filter?: PlainObject;
  /** The `arrayFilters` of the update (cast), for `$[<identifier>]`. */
  arrayFilters?: readonly PlainObject[];
  /** The clock of `$currentDate` (default `new Date()`). */
  now?: () => Date;
}

/** The operators the evaluator applies. */
export const EXTENDED_UPDATE_OPERATORS: ReadonlySet<string> = new Set([
  '$set',
  '$unset',
  '$inc',
  '$min',
  '$max',
  '$push',
  '$addToSet',
  '$pull',
  '$pullAll',
  '$setOnInsert',
  '$currentDate',
]);

/** Operators MongoDB has that the primitive refuses, with the reason. */
export const REFUSED_UPDATE_OPERATORS: Readonly<Record<string, string>> = {
  $mul: 'no store method uses it',
  $pop: 'no store method uses it',
  $rename: 'no store method uses it',
  $bit: 'no store method uses it',
};

const NUMERIC = /^\d+$/;
const FILTERED = /^\$\[([A-Za-z][A-Za-z0-9]*)\]$/;

/** A position segment of an update path. */
type Position =
  | { kind: 'index'; index: number }
  | { kind: 'positional' }
  | { kind: 'all' }
  | { kind: 'filtered'; identifier: string };

function positionOf(segment: string): Position | undefined {
  if (segment === '$') return { kind: 'positional' };
  if (segment === '$[]') return { kind: 'all' };
  const filtered = FILTERED.exec(segment);
  if (filtered) return { kind: 'filtered', identifier: filtered[1] };
  return undefined;
}

/** The identifiers of `$[<identifier>]` segments in a path. */
export function arrayFilterIdentifiers(path: string): string[] {
  return path
    .split('.')
    .map((segment) => FILTERED.exec(segment)?.[1])
    .filter((identifier): identifier is string => identifier !== undefined);
}

/** The identifier an `arrayFilters` entry names (its paths' first segment). */
export function arrayFilterIdentifier(filter: PlainObject): string {
  const names = new Set<string>();
  const visit = (clause: PlainObject) => {
    for (const [key, value] of Object.entries(clause)) {
      if (key === '$and' || key === '$or' || key === '$nor') {
        if (!Array.isArray(value)) {
          throw new StoreQueryError(`${key} takes an array of filters`);
        }
        value.forEach((entry) => visit(entry as PlainObject));
        continue;
      }
      if (key.startsWith('$')) {
        throw new StoreQueryError(`Unsupported operator ${key} in an array filter`);
      }
      names.add(key.split('.')[0]);
    }
  };
  if (!isPlainObject(filter)) {
    throw new StoreQueryError('An array filter must be an object');
  }
  visit(filter);
  if (names.size !== 1) {
    throw new StoreQueryError(
      names.size === 0
        ? 'Cannot use an expression without a top-level field name in arrayFilters'
        : `Error parsing array filter: expected a single top-level field name, found ${[...names]
            .map((name) => `'${name}'`)
            .join(' and ')}`,
    );
  }
  return [...names][0];
}

/**
 * The `arrayFilters` by identifier, checked against the update's paths as MongoDB checks them:
 * one entry per identifier, every entry used, every `$[<identifier>]` with an entry.
 */
export function indexArrayFilters(
  update: PlainObject,
  arrayFilters: readonly PlainObject[] | undefined,
): Map<string, PlainObject> {
  const byIdentifier = new Map<string, PlainObject>();
  for (const filter of arrayFilters ?? []) {
    const identifier = arrayFilterIdentifier(filter);
    if (byIdentifier.has(identifier)) {
      throw new StoreQueryError(
        `Found multiple array filters with the same top-level field name ${identifier}`,
      );
    }
    byIdentifier.set(identifier, filter);
  }
  const used = new Set<string>();
  for (const [operator, fields] of Object.entries(update)) {
    if (!operator.startsWith('$') || !isPlainObject(fields)) continue;
    for (const path of Object.keys(fields)) {
      for (const identifier of arrayFilterIdentifiers(path)) {
        if (!byIdentifier.has(identifier)) {
          throw new StoreQueryError(
            `No array filter found for identifier '${identifier}' in path '${path}'`,
          );
        }
        used.add(identifier);
      }
    }
  }
  for (const identifier of byIdentifier.keys()) {
    if (!used.has(identifier)) {
      throw new StoreQueryError(
        `The array filter for identifier '${identifier}' was not used in the update`,
      );
    }
  }
  return byIdentifier;
}

/** A place an operator writes: a key of an object or an index of an array. */
interface Slot {
  parent: PlainObject | unknown[];
  key: string | number;
}

/** How the walk treats what is missing on the way (see the module header). */
type WalkMode = 'create' | 'unset' | 'existing';

class UpdateApplier {
  private positional?: number;
  private positionalResolved = false;
  private readonly matcher: FilterMatcher;
  private readonly filters: Map<string, PlainObject>;

  constructor(
    private readonly original: PlainObject,
    private readonly update: PlainObject,
    private readonly context: ExtendedUpdateContext,
  ) {
    this.matcher = new FilterMatcher(context);
    this.filters = indexArrayFilters(update, context.arrayFilters);
  }

  private positionalIndexOf(path: string): number {
    if (!this.positionalResolved) {
      this.positionalResolved = true;
      this.positional =
        this.context.filter && !this.context.inserting
          ? positionalIndex(this.original, this.context.filter, this.context)
          : undefined;
    }
    if (this.positional === undefined) {
      throw new StoreQueryError(
        `The positional operator did not find the match needed from the query (path "${path}")`,
      );
    }
    return this.positional;
  }

  /** The indices of `array` a position selects; `before` is the same array in the pre-image. */
  private select(array: unknown[], before: unknown, position: Position, path: string): number[] {
    switch (position.kind) {
      case 'index':
        return [position.index];
      case 'positional':
        return [this.positionalIndexOf(path)];
      case 'all':
        return array.map((_, index) => index);
      case 'filtered': {
        const filter = this.filters.get(position.identifier) as PlainObject;
        const elements = Array.isArray(before) ? before : array;
        const indices: number[] = [];
        elements.forEach((element, index) => {
          if (
            index < array.length &&
            this.matcher.matches({ [position.identifier]: element }, filter)
          ) {
            indices.push(index);
          }
        });
        return indices;
      }
    }
  }

  /**
   * The slots `path` reaches in `root` (several through `$[]` and `$[x]`). The pre-image is walked
   * alongside, so `$[x]` selects by the elements as they were before the update.
   */
  slots(root: PlainObject, path: string, operator: string, mode: WalkMode): Slot[] {
    const segments = path.split('.');
    const out: Slot[] = [];
    const fail = (message: string): never => {
      throw new StoreQueryError(`${operator} "${path}": ${message}`);
    };
    const step = (node: PlainObject | unknown[], before: unknown, at: number, nodePath: string) => {
      const segment = segments[at];
      const last = at === segments.length - 1;
      const position = positionOf(segment);
      let keys: Array<string | number>;
      if (Array.isArray(node)) {
        if (position) {
          keys = this.select(node, before, position, path);
        } else if (NUMERIC.test(segment)) {
          keys = [Number(segment)];
        } else {
          if (mode === 'unset') return;
          return fail(`cannot create field '${segment}' in the array at "${nodePath}"`);
        }
      } else {
        if (position) {
          return fail(`cannot apply array updates to an object at "${nodePath}"`);
        }
        keys = [segment];
      }
      for (const key of keys) {
        const childPath = nodePath ? `${nodePath}.${key}` : String(key);
        if (last) {
          out.push({ parent: node, key });
          continue;
        }
        const child = read({ parent: node, key });
        let previous: unknown;
        if (Array.isArray(before)) {
          previous = before[key as number];
        } else if (isPlainObject(before)) {
          previous = before[key as string];
        }
        const next = segments[at + 1];
        if (child === undefined) {
          if (positionOf(next)) {
            fail(`the path "${childPath}" must exist in the document to apply array updates`);
          }
          if (mode !== 'create') continue;
          const created: PlainObject = {};
          write({ parent: node, key }, created);
          step(created, undefined, at + 1, childPath);
          continue;
        }
        if (Array.isArray(child) || isPlainObject(child)) {
          step(child, previous, at + 1, childPath);
          continue;
        }
        if (positionOf(next)) {
          fail(`cannot apply array updates to ${describeValue(child)} at "${childPath}"`);
        }
        if (mode === 'unset') continue;
        fail(`cannot create field '${next}' in ${describeValue(child)} at "${childPath}"`);
      }
    };
    step(root, this.original, 0, '');
    return out;
  }

  apply(record: PlainObject): PlainObject {
    for (const [operator, fields] of Object.entries(this.update)) {
      if (!operator.startsWith('$')) {
        throw new StoreQueryError(`The update path "${operator}" is not under an operator`);
      }
      if (REFUSED_UPDATE_OPERATORS[operator]) {
        throw new StoreQueryError(
          `The update operator ${operator} is not supported (${REFUSED_UPDATE_OPERATORS[operator]})`,
        );
      }
      if (!EXTENDED_UPDATE_OPERATORS.has(operator)) {
        throw new StoreQueryError(`Unsupported update operator ${operator}`);
      }
      if (!isPlainObject(fields)) {
        throw new StoreQueryError(`${operator} takes an object of paths`);
      }
      for (const [path, value] of Object.entries(fields)) {
        this.applyOne(record, operator, path, value);
      }
    }
    return record;
  }

  private applyOne(record: PlainObject, operator: string, path: string, value: unknown): void {
    switch (operator) {
      case '$setOnInsert':
      case '$set': {
        if (value === undefined || (operator === '$setOnInsert' && !this.context.inserting)) return;
        for (const slot of this.slots(record, path, operator, 'create')) {
          write(slot, cloneValue(value));
        }
        return;
      }
      case '$currentDate': {
        if (isPlainObject(value) && value.$type === 'timestamp') {
          throw new StoreQueryError(
            `$currentDate "${path}": $type 'timestamp' is not supported (the storage has no timestamps)`,
          );
        }
        if (typeof value !== 'boolean' && !(isPlainObject(value) && value.$type === 'date')) {
          throw new StoreQueryError(`$currentDate "${path}" takes true or { $type: 'date' }`);
        }
        const now = this.context.now?.() ?? new Date();
        for (const slot of this.slots(record, path, operator, 'create')) {
          write(slot, new Date(now.getTime()));
        }
        return;
      }
      case '$unset':
        for (const slot of this.slots(record, path, operator, 'unset')) {
          if (Array.isArray(slot.parent)) {
            if ((slot.key as number) < slot.parent.length) slot.parent[slot.key as number] = null;
          } else {
            delete slot.parent[slot.key as string];
          }
        }
        return;
      case '$inc':
        for (const slot of this.slots(record, path, operator, 'create')) {
          const current = read(slot);
          if (current === undefined) {
            write(slot, value);
          } else if (typeof current === 'number' && typeof value === 'number') {
            write(slot, current + value);
          } else {
            throw new StoreQueryError(
              `$inc "${path}": the stored value is ${describeValue(current)}, not a number`,
            );
          }
        }
        return;
      case '$min':
      case '$max':
        for (const slot of this.slots(record, path, operator, 'create')) {
          const current = read(slot);
          const c = current === undefined ? 0 : compareValues(value, current);
          if (current === undefined || (operator === '$max' ? c > 0 : c < 0)) {
            write(slot, cloneValue(value));
          }
        }
        return;
      case '$push':
      case '$addToSet': {
        const { items, slice } = appendedItems(operator, path, value);
        for (const slot of this.slots(record, path, operator, 'create')) {
          const current = read(slot);
          if (current !== undefined && !Array.isArray(current)) {
            throw new StoreQueryError(
              `${operator} "${path}": the stored value is ${describeValue(current)}, not an array`,
            );
          }
          let next = [...((current as unknown[] | undefined) ?? [])];
          for (const item of items) {
            if (operator === '$push' || !next.some((element) => valuesEqual(element, item))) {
              next.push(cloneValue(item));
            }
          }
          if (slice !== undefined) {
            next = slice < 0 ? next.slice(Math.max(next.length + slice, 0)) : next.slice(0, slice);
          }
          write(slot, next);
        }
        return;
      }
      case '$pull':
      case '$pullAll': {
        if (operator === '$pullAll' && !Array.isArray(value)) {
          throw new StoreQueryError(`$pullAll "${path}" takes an array`);
        }
        for (const slot of this.slots(record, path, operator, 'existing')) {
          const current = read(slot);
          if (current === undefined) continue;
          if (!Array.isArray(current)) {
            throw new StoreQueryError(
              `${operator} "${path}": the stored value is ${describeValue(current)}, not an array`,
            );
          }
          const removes = (element: unknown): boolean =>
            operator === '$pullAll'
              ? (value as unknown[]).some((item) => valuesEqual(element, item))
              : this.pullMatches(element, value, path);
          write(
            slot,
            current.filter((element) => !removes(element)),
          );
        }
        return;
      }
    }
  }

  /** Whether `$pull`'s operand removes `element` (a value, a condition, or a filter on objects). */
  private pullMatches(element: unknown, condition: unknown, path: string): boolean {
    if (condition instanceof RegExp) {
      condition.lastIndex = 0;
      return typeof element === 'string' && condition.test(element);
    }
    if (isPlainObject(condition)) {
      const keys = Object.keys(condition);
      if (keys.length > 0 && isValueElemMatch(condition)) {
        return this.matcher.matches({ v: element }, { v: condition }, undefined, '');
      }
      if (keys.length > 0) {
        return isPlainObject(element) && this.matcher.matches(element, condition, undefined, path);
      }
    }
    return valuesEqual(element, condition);
  }
}

function read(slot: Slot): unknown {
  return Array.isArray(slot.parent)
    ? slot.parent[slot.key as number]
    : (slot.parent as PlainObject)[slot.key as string];
}

function write(slot: Slot, value: unknown): void {
  if (Array.isArray(slot.parent)) {
    const index = slot.key as number;
    while (slot.parent.length < index) slot.parent.push(null);
    slot.parent[index] = value;
  } else {
    (slot.parent as PlainObject)[slot.key as string] = value;
  }
}

/** The elements `$push`/`$addToSet` append, and `$push`'s `$slice`. */
function appendedItems(
  operator: string,
  path: string,
  value: unknown,
): { items: unknown[]; slice?: number } {
  if (!isPlainObject(value) || !Object.keys(value).some((key) => key.startsWith('$'))) {
    return { items: [value] };
  }
  for (const key of Object.keys(value)) {
    if (key === '$each') continue;
    if (key === '$slice' && operator === '$push') continue;
    throw new StoreQueryError(
      `${operator} "${path}": the modifier ${key} is not supported${
        key === '$position' || key === '$sort' ? ' (no store method uses it)' : ''
      }`,
    );
  }
  if (!Array.isArray(value.$each)) {
    throw new StoreQueryError(`${operator} "${path}": $each takes an array`);
  }
  const slice = value.$slice;
  if (slice !== undefined && (typeof slice !== 'number' || !Number.isInteger(slice))) {
    throw new StoreQueryError(`$push "${path}": $slice takes an integer`);
  }
  return { items: value.$each, ...(slice !== undefined ? { slice } : {}) };
}

/**
 * The record after `update` (cast already), by MongoDB's rules; `record` is not changed. Throws a
 * `StoreQueryError` for an update MongoDB refuses and for the operators the primitive refuses.
 */
export function applyExtendedUpdate<T extends PlainObject>(
  record: T,
  update: PlainObject,
  context: ExtendedUpdateContext = {},
): T {
  if (!isPlainObject(update)) {
    throw new StoreQueryError('An update must be an object');
  }
  const original = cloneValue(record) as PlainObject;
  const result = cloneValue(record) as PlainObject;
  return new UpdateApplier(original, update, context).apply(result) as T;
}

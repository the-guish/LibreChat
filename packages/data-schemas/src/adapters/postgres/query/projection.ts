/**
 * Projections (docs/postgres-port/PHASE4.md §2.3): a `StoreProjection` (mongoose's string or
 * record form) mapped onto R1's {@link RecordProjection}, which pushes it down to columns (only the
 * projected columns, shape columns and child subselects are selected; `assemble.ts`). Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * - `'a b'` / `{ a: 1, b: 1 }`: inclusion (with `_id` unless `-_id`/`_id: 0`); `'-a'` /
 *   `{ a: 0 }`: exclusion; `+secret`: a hidden (`select: false`) path as well; naming a hidden
 *   path in an inclusion returns it; `''`, `{}`, `null`: the default paths. Inclusion and
 *   exclusion do not mix (except `_id`).
 * - Dotted paths are accepted beyond the language's top-level names: a path through objects and
 *   child arrays is pushed down by `assemble.ts`; a path **into a `json` value** (`edges.to`,
 *   `envelope.event.payload.taskId`, `-attachments.web_search`) selects the whole column, and the
 *   projection inside the value is applied in JavaScript after the fetch ({@link
 *   TranslatedProjection.apply}), so `json` key order is kept. Inside the value it follows
 *   MongoDB: an inclusion keeps the named keys of an object (an object without them becomes
 *   `{}`), of each object element of an array (other elements are dropped) and drops a scalar; an
 *   exclusion removes the named keys wherever they are and keeps everything else.
 * - Refused (`StoreQueryError`): mixing inclusion and exclusion, a path both included and
 *   excluded, a path and a path under it (MongoDB's path collision), values other than `0`/`1`.
 */
import type { RecordProjection } from '../records/assemble';
import type { RecordTable, RecordTables } from './resolve';
import { resolveRecordPath, UndeclaredPathError } from '../records/paths';
import { isPlainRecord } from '../records/extra';
import { StoreQueryError } from '~/ports/query';

/** A projection translated for one collection. */
export interface TranslatedProjection {
  /** What `selectRecord` reads. */
  readonly record: RecordProjection;
  /** Applies the parts that reach into `json` values to a read record (in place); absent when none. */
  readonly apply?: (record: Record<string, unknown>) => Record<string, unknown>;
}

interface Entry {
  path: string;
  include: boolean;
  forced: boolean;
}

function parseEntries(projection: unknown): Entry[] {
  if (projection === null || projection === undefined) {
    return [];
  }
  const entries: Entry[] = [];
  const check = (name: string) => {
    if (name === '' || name.startsWith('$') || name.split('.').some((segment) => segment === '')) {
      throw new StoreQueryError(`Unsupported projection path "${name}"`);
    }
  };
  if (typeof projection === 'string') {
    for (const token of projection.split(/\s+/)) {
      if (token === '') continue;
      const sign = token[0];
      const name = sign === '+' || sign === '-' ? token.slice(1) : token;
      check(name);
      entries.push({ path: name, include: sign !== '-', forced: sign === '+' });
    }
    return entries;
  }
  if (isPlainRecord(projection)) {
    for (const [name, flag] of Object.entries(projection)) {
      check(name);
      if (flag !== 0 && flag !== 1 && flag !== true && flag !== false) {
        throw new StoreQueryError(`The projection of "${name}" must be 0 or 1`);
      }
      entries.push({ path: name, include: flag === 1 || flag === true, forced: false });
    }
    return entries;
  }
  throw new StoreQueryError('A projection must be a string or a record of 0 and 1');
}

/** A tree of subpaths inside one `json` value. */
type PathTree = Map<string, PathTree | true>;

function addToTree(tree: PathTree, segments: readonly string[]): void {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    tree.set(head, true);
    return;
  }
  const existing = tree.get(head);
  if (existing === true) return;
  const child: PathTree = existing ?? new Map();
  tree.set(head, child);
  addToTree(child, rest);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value);
}

/** MongoDB's inclusion inside a value; `undefined` drops it. */
function includeIn(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const element of value) {
      if (isPlainObject(element) || Array.isArray(element)) {
        const projected = includeIn(element, tree);
        if (projected !== undefined) result.push(projected);
      }
    }
    return result;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const branch = tree.get(key);
    if (branch === undefined) continue;
    if (branch === true) {
      result[key] = item;
      continue;
    }
    const projected = includeIn(item, branch);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

/** MongoDB's exclusion inside a value. */
function excludeIn(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => excludeIn(element, tree));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const branch = tree.get(key);
    if (branch === true) continue;
    result[key] = branch === undefined ? item : excludeIn(item, branch);
  }
  return result;
}

/**
 * MongoDB leaves out a field an inclusion reaches through a `null` (`profile.city` of `profile:
 * null`), where the record assembly returns the `null` object: removes it.
 */
function pruneNullParents(record: Record<string, unknown>, segments: readonly string[]): void {
  let current: Record<string, unknown> = record;
  for (let index = 0; index < segments.length - 1; index++) {
    const value = current[segments[index]];
    if (value === null) {
      delete current[segments[index]];
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }
    current = value;
  }
}

/**
 * Translates `projection` for the rows of `table` (a collection table). Throws a
 * `StoreQueryError` for a projection outside the language and its dotted extension.
 */
export function translateProjection(
  tables: RecordTables,
  table: RecordTable,
  projection: unknown,
): TranslatedProjection {
  const entries = parseEntries(projection);
  const seen = new Map<string, boolean>();
  const include: string[] = [];
  const exclude: string[] = [];
  const includeHidden: string[] = [];
  let mode: 'include' | 'exclude' | 'default' = 'default';
  let idEntry: boolean | undefined;
  /** `json` columns (by record path) with the subpaths projected inside them. */
  const jsonTrees = new Map<string, PathTree>();

  for (const entry of entries) {
    const previous = seen.get(entry.path);
    if (previous !== undefined && previous !== entry.include) {
      throw new StoreQueryError(`The projection both includes and excludes "${entry.path}"`);
    }
    seen.set(entry.path, entry.include);
    if (entry.forced) {
      includeHidden.push(entry.path);
      continue;
    }
    if (entry.path === '_id') {
      idEntry = entry.include;
      continue;
    }
    const entryMode = entry.include ? 'include' : 'exclude';
    if (mode !== 'default' && mode !== entryMode) {
      throw new StoreQueryError(
        'A projection cannot mix inclusion and exclusion (except for leaving out _id)',
      );
    }
    mode = entryMode;
    let target = entry.path;
    try {
      const resolved = resolveRecordPath(tables, table, entry.path);
      if (resolved.node.kind === 'json' && resolved.hops.length === 0) {
        const column = resolved.node.field.path;
        const tree = jsonTrees.get(column) ?? new Map();
        addToTree(tree, resolved.node.subpath);
        jsonTrees.set(column, tree);
        target = column;
      }
    } catch (error) {
      if (!(error instanceof UndeclaredPathError)) throw error;
    }
    if (target !== entry.path && !entry.include) {
      /** The column is read whole and the exclusion applied inside it. */
      continue;
    }
    const list = entry.include ? include : exclude;
    if (!list.includes(target)) list.push(target);
  }

  const named = [...entries.filter((entry) => !entry.forced).map((entry) => entry.path)];
  for (const a of named) {
    for (const b of named) {
      if (a !== b && b.startsWith(`${a}.`)) {
        throw new StoreQueryError(`Path collision in the projection: "${a}" and "${b}"`);
      }
    }
  }
  if (mode === 'default' && idEntry !== undefined) {
    /** `'_id'` alone is an inclusion of `_id` only, `'-_id'` alone an exclusion of `_id`. */
    mode = idEntry ? 'include' : 'exclude';
  }
  if (mode === 'include' && include.length === 0) {
    include.push('_id');
  }
  if (idEntry === false) {
    exclude.push('_id');
  }
  const record: RecordProjection = {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(includeHidden.length > 0 ? { includeHidden } : {}),
  };
  const inclusion = mode === 'include';
  /** Typed paths an inclusion reaches through an object or array (`profile.city`). */
  const throughParents = inclusion
    ? include.filter((path) => path.includes('.') && !jsonTrees.has(path))
    : [];
  if (jsonTrees.size === 0 && throughParents.length === 0) {
    return { record };
  }
  return {
    record,
    apply: (read) => {
      for (const path of throughParents) {
        pruneNullParents(read, path.split('.'));
      }
      for (const [column, tree] of jsonTrees) {
        if (!(column in read)) continue;
        const value = inclusion ? includeIn(read[column], tree) : excludeIn(read[column], tree);
        if (value === undefined) {
          delete read[column];
        } else {
          read[column] = value;
        }
      }
      return read;
    },
  };
}

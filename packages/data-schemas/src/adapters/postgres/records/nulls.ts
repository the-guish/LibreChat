/**
 * The `_nulls` column (docs/postgres-port/PHASE4.md §1.2 "Missing versus null"): a typed column
 * holds one `NULL`, so each row (and child row) lists the declared paths explicitly set to `null`
 * in `_nulls` (`text[] COLLATE "C"`, `NULL` when none). Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * Rules, for a declared path `p` stored in column `c` of a row:
 * - `{ p: null }` → `c IS NULL` (null matches missing, as in MongoDB);
 * - `{ p: { $exists: true } }` → `c IS NOT NULL OR 'p' = ANY (_nulls)` ({@link presenceSql}, the
 *   form the partial indexes use);
 * - `{ p: { $exists: false } }` → `c IS NULL AND NOT coalesce('p' = ANY (_nulls), false)`
 *   ({@link absenceSql}): with `_nulls` `NULL`, `'p' = ANY (_nulls)` is `NULL`, so a plain `NOT`
 *   of the presence form would match nothing;
 * - writing `p: null` lists `p`; writing a value or unsetting `p` removes it;
 * - reads emit `p: null` for a listed path whose column is `NULL`, and omit other `NULL` columns.
 *
 * Paths are relative to the row: a collection table's paths are document paths, a child table's
 * are relative to one array element. An object path (shape column) is listed when the object is
 * `null`; its leaves are then `NULL` and not listed. An array stored in a child or element table
 * is listed on the parent row (its element-count column is `NULL`). Tables without system columns
 * (`key_value_entries`) have no `_nulls`: `null` and missing are both `NULL` there.
 */
import { quoteIdentifier, quoteLiteral } from '../schema/naming';

/** The `_nulls` column value of a row: the listed paths, `null` when none. */
export function toNullsColumn(paths: readonly string[]): string[] | null {
  if (paths.length === 0) {
    return null;
  }
  return [...new Set(paths)];
}

/** The listed paths of a `_nulls` value read back (`NULL` → none). */
export function fromNullsColumn(value: unknown): ReadonlySet<string> {
  if (value === null || value === undefined) {
    return EMPTY;
  }
  if (Array.isArray(value)) {
    return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  }
  return EMPTY;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * `nulls` with `path` listed (`set` true) or removed (`set` false), for writes computed in
 * JavaScript. Removing a path also removes the paths listed under it (an object path assigned or
 * unset replaces everything beneath it).
 */
export function updateNulls(
  nulls: readonly string[] | null,
  path: string,
  set: boolean,
): string[] | null {
  const prefix = `${path}.`;
  const kept = (nulls ?? []).filter((entry) => entry !== path && !entry.startsWith(prefix));
  if (set) {
    kept.push(path);
  }
  return toNullsColumn(kept);
}

/**
 * SQL that is true when the declared path `path` (stored in `column`, of a row aliased `alias`)
 * holds a value, `null` included: `$exists: true`. Without `_nulls` (`systemColumns` false) it is
 * `column IS NOT NULL`.
 */
export function presenceSql(
  column: string,
  path: string,
  options: { alias?: string; systemColumns?: boolean } = {},
): string {
  const qualify = (name: string) =>
    options.alias
      ? `${quoteIdentifier(options.alias)}.${quoteIdentifier(name)}`
      : quoteIdentifier(name);
  if (options.systemColumns === false) {
    return `${qualify(column)} IS NOT NULL`;
  }
  return `(${qualify(column)} IS NOT NULL OR ${quoteLiteral(path)} = ANY (${qualify('_nulls')}))`;
}

/**
 * SQL that is true when the declared path `path` (stored in `column`) holds nothing, not even
 * `null`: `$exists: false`. Unlike `NOT` of {@link presenceSql}, it is true (not `NULL`) on rows
 * whose `_nulls` is `NULL`.
 */
export function absenceSql(
  column: string,
  path: string,
  options: { alias?: string; systemColumns?: boolean } = {},
): string {
  const qualify = (name: string) =>
    options.alias
      ? `${quoteIdentifier(options.alias)}.${quoteIdentifier(name)}`
      : quoteIdentifier(name);
  if (options.systemColumns === false) {
    return `${qualify(column)} IS NULL`;
  }
  return `(${qualify(column)} IS NULL AND NOT coalesce(${quoteLiteral(path)} = ANY (${qualify('_nulls')}), false))`;
}

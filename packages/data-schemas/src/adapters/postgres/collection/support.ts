/**
 * Helpers of the collection primitive: projections over every hidden path, which filters read
 * child tables, value comparison of decomposed rows, and MongoDB's `distinct` walk. Must not import
 * `mongoose`, `mongodb` or `bson`.
 */
import type { RecordTable, RecordTables } from '../records/tables';
import type { DecomposedRecord } from '../records/decompose';
import type { RecordProjection } from '../records/assemble';
import type { PgRecord } from './types';
import { resolveRecordPath } from '../records/paths';
import { compareStoreValues } from '~/ports/query';
import { isPlainRecord } from '../records/extra';

/** Every hidden path of `table` and of its child tables (prefixed by their array paths). */
export function allHiddenPaths(tables: RecordTables, table: RecordTable, prefix = ''): string[] {
  const paths = [...table.hidden].map((path) => `${prefix}${path}`);
  for (const field of table.fields.values()) {
    if (field.kind === 'children') {
      paths.push(...allHiddenPaths(tables, tables.table(field.table), `${prefix}${field.path}.`));
    }
  }
  return paths;
}

/** The projection reading every stored path, hidden ones included (raw reads, tier 2). */
export function fullProjection(tables: RecordTables, table: RecordTable): RecordProjection {
  return { includeHidden: allHiddenPaths(tables, table) };
}

const LOGICAL = new Set(['$and', '$or', '$nor']);

/** Whether a condition on a whole subdocument array reads its rows (`$elemMatch`, also under `$not` or `$all`). */
function conditionReadsRows(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([operator, operand]) => {
    if (operator === '$elemMatch') return true;
    if (operator === '$not') return conditionReadsRows(operand);
    if (operator === '$all') {
      return (
        Array.isArray(operand) &&
        operand.some((item) => isPlainRecord(item) && '$elemMatch' in item)
      );
    }
    return false;
  });
}

/**
 * Whether a (cast) filter reads child or element tables: a path through a subdocument array, a
 * condition on an element table, or `$elemMatch` on a subdocument array (§3.5: such filters are
 * re-evaluated in a statement after the lock). The whole-array forms the translator answers from
 * the parent's count column (`$size`, `[]`, `null`, `$exists`, `$type` on a subdocument array)
 * count as parent-only.
 */
export function filterReadsChildren(
  tables: RecordTables,
  table: RecordTable,
  filter: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL.has(key)) {
      if (
        Array.isArray(value) &&
        value.some((entry) => filterReadsChildren(tables, table, entry as PgRecord))
      ) {
        return true;
      }
      continue;
    }
    if (key.startsWith('$')) {
      continue;
    }
    const resolved = resolveRecordPath(tables, table, key);
    if (resolved.hops.length > 0) {
      return true;
    }
    const { node } = resolved;
    if (
      node.kind === 'element' ||
      node.kind === 'childElement' ||
      (node.kind === 'field' && node.field.kind === 'elements')
    ) {
      return true;
    }
    if (node.kind === 'field' && node.field.kind === 'children' && conditionReadsRows(value)) {
      return true;
    }
  }
  return false;
}

/** A comparable key of a column value as decomposed (dates, buffers, arrays, `-0`). */
export function valueKey(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value instanceof Date) {
    return `D${value.getTime()}`;
  }
  if (Buffer.isBuffer(value)) {
    return `B${value.toString('hex')}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(valueKey).join(',')}]`;
  }
  if (typeof value === 'number') {
    return Object.is(value, -0) ? 'N-0' : `N${value}`;
  }
  if (typeof value === 'object') {
    return `O${JSON.stringify(value)}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

/** The columns whose values differ between two decomposed rows of the same table. */
export function changedColumns(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(after).filter(
    (column) => valueKey(before[column]) !== valueKey(after[column]),
  );
}

/** The rows of `table` in a decomposed record, as comparable keys. */
function childKey(record: DecomposedRecord, table: string): string {
  const rows = record.children.find((child) => child.table === table)?.rows ?? [];
  return rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((column) => `${column}=${valueKey(row[column])}`)
        .join(';'),
    )
    .join('\n');
}

/** The child and element tables whose rows differ between two decompositions of one record. */
export function changedChildTables(before: DecomposedRecord, after: DecomposedRecord): string[] {
  return after.childTables.filter((table) => childKey(before, table) !== childKey(after, table));
}

/**
 * The values `distinct(path)` takes from one record, as MongoDB's: the path is walked through
 * arrays of objects; a final array contributes its elements; `null` contributes `null`; a missing
 * path nothing.
 */
export function distinctValues(record: PgRecord, path: string): unknown[] {
  const out: unknown[] = [];
  const walk = (value: unknown, segments: readonly string[]): void => {
    if (value === undefined) {
      return;
    }
    if (segments.length === 0) {
      if (Array.isArray(value)) {
        out.push(...value.filter((item) => item !== undefined));
      } else {
        out.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isPlainRecord(item)) {
          walk(item[segments[0]], segments.slice(1));
        }
      }
      return;
    }
    if (isPlainRecord(value)) {
      walk(value[segments[0]], segments.slice(1));
    }
  };
  walk(record, path.split('.'));
  return out;
}

/** `values` without duplicates (MongoDB's equality), sorted in MongoDB's order. */
export function uniqueSorted(values: readonly unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const value of values) {
    const key = valueKey(value);
    if (!seen.has(key)) {
      seen.set(key, value);
    }
  }
  return [...seen.values()].sort(compareStoreValues);
}

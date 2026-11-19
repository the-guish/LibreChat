/**
 * The snapshot diff (docs/postgres-port/PHASE4.md §5, "What the generator emits per change"): the
 * changes from the descriptor of the latest migration (`snapshot.json`) to a freshly generated
 * one, and the DDL of a migration applying them.
 *
 * - new collection or array of subdocuments → `CREATE TABLE` (and its indexes);
 * - new field → `ALTER TABLE ... ADD COLUMN` (nullable, no default);
 * - removed field → its non-null values (and explicit nulls) moved into `_extra` under their
 *   path, in the tagged encoding of §1.3, then `DROP COLUMN`;
 * - type change → `ALTER COLUMN TYPE ... USING` when the cast is total (String → `json`,
 *   Number → String), otherwise the diff fails and asks for a hand-written migration;
 * - new, changed or removed index or hint `CHECK` → created, dropped and recreated, or dropped;
 *   a new index on a large table is built `CONCURRENTLY` (outside the migration transaction).
 *
 * A removed table, a changed primary key or parent, a column whose role changes or a removed
 * field of a table without `_extra` also fail: they need a hand-written migration. Must not import
 * `mongoose`, `mongodb` or `bson`.
 */
import type {
  IndexDescriptor,
  TableDescriptor,
  CheckDescriptor,
  ColumnDescriptor,
  SchemaDescriptor,
} from './descriptor';
import {
  emitIndexDdl,
  emitTableDdl,
  emitPreludeDdl,
  emitCheckDefinition,
  emitColumnDefinition,
} from './emitDdl';
import { quoteLiteral, quoteIdentifier, SchemaGenerationError } from './naming';

/** One change between two descriptors. */
export type SchemaChange =
  | { kind: 'createTable'; table: TableDescriptor }
  | { kind: 'addColumn'; table: string; column: ColumnDescriptor }
  | { kind: 'dropColumn'; table: string; column: ColumnDescriptor; moveToExtra: boolean }
  | {
      kind: 'alterColumnType';
      table: string;
      column: ColumnDescriptor;
      previous: ColumnDescriptor;
      using: string;
    }
  | { kind: 'addCheck'; table: string; check: CheckDescriptor }
  | { kind: 'dropCheck'; table: string; check: CheckDescriptor }
  | { kind: 'createIndex'; index: IndexDescriptor; concurrently: boolean }
  | { kind: 'dropIndex'; index: IndexDescriptor; concurrently: boolean };

/** One statement of a migration; `concurrently` ones cannot run inside a transaction. */
export interface MigrationStatement {
  sql: string;
  concurrently: boolean;
}

const TOTAL_CASTS: ReadonlyArray<{ from: string; to: string; using: (column: string) => string }> =
  [
    { from: 'text COLLATE "C"', to: 'json', using: (column) => `to_json(${column})` },
    { from: 'double precision', to: 'text COLLATE "C"', using: (column) => `${column}::text` },
  ];

/** Whether an index or check differs in what the database holds (sources are descriptor-only). */
function indexDefinition(index: IndexDescriptor): string {
  return JSON.stringify({
    table: index.table,
    method: index.method,
    keys: index.keys,
    unique: index.unique,
    where: index.where ?? null,
  });
}

function byName<T extends { name: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name, item]));
}

function diffTable(
  previous: TableDescriptor,
  next: TableDescriptor,
  changes: SchemaChange[],
): void {
  const where = `table "${next.name}"`;
  if (
    previous.kind !== next.kind ||
    previous.parent !== next.parent ||
    JSON.stringify(previous.primaryKey) !== JSON.stringify(next.primaryKey)
  ) {
    throw new SchemaGenerationError(
      `${where}: its kind, parent or primary key changed; write this migration by hand`,
    );
  }
  const previousColumns = byName(previous.columns);
  const nextColumns = byName(next.columns);
  for (const column of next.columns) {
    const before = previousColumns.get(column.name);
    if (!before) {
      if (!column.nullable) {
        throw new SchemaGenerationError(`${where}: new column "${column.name}" is NOT NULL`);
      }
      changes.push({ kind: 'addColumn', table: next.name, column });
      continue;
    }
    if (before.sqlType === column.sqlType && before.nullable === column.nullable) {
      continue;
    }
    const cast = TOTAL_CASTS.find(
      (entry) => entry.from === before.sqlType && entry.to === column.sqlType,
    );
    if (!cast || before.nullable !== column.nullable) {
      throw new SchemaGenerationError(
        `${where}: column "${column.name}" changes from ${before.sqlType} to ${column.sqlType}, which is not a total cast; write this migration by hand`,
      );
    }
    changes.push({
      kind: 'alterColumnType',
      table: next.name,
      column,
      previous: before,
      using: cast.using(quoteIdentifier(column.name)),
    });
  }
  for (const column of previous.columns) {
    if (nextColumns.has(column.name)) {
      continue;
    }
    if (column.path === null || column.role === 'id') {
      throw new SchemaGenerationError(
        `${where}: system column "${column.name}" removed; write this migration by hand`,
      );
    }
    if (!next.systemColumns) {
      throw new SchemaGenerationError(
        `${where}: column "${column.name}" removed from a table without _extra; write this migration by hand`,
      );
    }
    changes.push({ kind: 'dropColumn', table: next.name, column, moveToExtra: true });
  }
  const previousChecks = byName(previous.checks);
  const nextChecks = byName(next.checks);
  for (const check of previous.checks) {
    const after = nextChecks.get(check.name);
    if (!after || after.expression !== check.expression) {
      changes.push({ kind: 'dropCheck', table: next.name, check });
    }
  }
  for (const check of next.checks) {
    const before = previousChecks.get(check.name);
    if (!before || before.expression !== check.expression) {
      changes.push({ kind: 'addCheck', table: next.name, check });
    }
  }
  const previousIndexes = byName(previous.indexes);
  const nextIndexes = byName(next.indexes);
  for (const index of previous.indexes) {
    const after = nextIndexes.get(index.name);
    if (!after || indexDefinition(after) !== indexDefinition(index)) {
      changes.push({ kind: 'dropIndex', index, concurrently: next.large });
    }
  }
  for (const index of next.indexes) {
    const before = previousIndexes.get(index.name);
    if (!before || indexDefinition(before) !== indexDefinition(index)) {
      changes.push({ kind: 'createIndex', index, concurrently: next.large });
    }
  }
}

const CHANGE_ORDER: Readonly<Record<SchemaChange['kind'], number>> = {
  dropIndex: 0,
  dropCheck: 1,
  createTable: 2,
  addColumn: 3,
  alterColumnType: 4,
  dropColumn: 5,
  addCheck: 6,
  createIndex: 7,
};

/**
 * The changes from `previous` (the snapshot of the latest migration; `null` for an empty
 * database) to `next`, in the order a migration applies them.
 */
export function diffSchemaDescriptors(
  previous: SchemaDescriptor | null,
  next: SchemaDescriptor,
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const previousTables = byName(previous?.tables ?? []);
  const nextTables = byName(next.tables);
  for (const table of previous?.tables ?? []) {
    if (!nextTables.has(table.name)) {
      throw new SchemaGenerationError(
        `table "${table.name}" (${table.collection}${table.path ? `.${table.path}` : ''}) was removed; write this migration by hand`,
      );
    }
  }
  for (const table of next.tables) {
    const before = previousTables.get(table.name);
    if (!before) {
      changes.push({ kind: 'createTable', table });
      for (const index of table.indexes) {
        changes.push({ kind: 'createIndex', index, concurrently: false });
      }
      continue;
    }
    diffTable(before, table, changes);
  }
  return changes
    .map((change, position) => ({ change, position }))
    .sort(
      (a, b) =>
        CHANGE_ORDER[a.change.kind] - CHANGE_ORDER[b.change.kind] || a.position - b.position,
    )
    .map(({ change }) => change);
}

/** The `jsonb` of a column's value in the tagged encoding of §1.3 (dates and binaries tagged). */
function extraValue(column: ColumnDescriptor): string {
  const name = quoteIdentifier(column.name);
  const tag = (value: string): string => {
    if (column.type === 'date') {
      return `jsonb_build_object('$date', to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
    }
    if (column.type === 'buffer') {
      return `jsonb_build_object('$binary', translate(encode(${value}, 'base64'), E'\\n', ''))`;
    }
    return `to_jsonb(${value})`;
  };
  if (column.role === 'shape') {
    return `'{}'::jsonb`;
  }
  if (column.type === 'json') {
    return `${name}::jsonb`;
  }
  if (column.array && (column.type === 'date' || column.type === 'buffer')) {
    return `(SELECT jsonb_agg(${tag('e')} ORDER BY o) FROM unnest(${name}) WITH ORDINALITY AS u (e, o))`;
  }
  return tag(name);
}

/** `_extra` with `value` set at `path`, intermediate objects created (non-objects replaced). */
function mergeIntoExtra(path: string, value: string): string {
  const segments = path.split('.');
  const objectAt = (depth: number): string => {
    if (depth === 0) {
      return `CASE WHEN jsonb_typeof("_extra") = 'object' THEN "_extra" ELSE '{}'::jsonb END`;
    }
    const at = `("_extra" #> ${quoteLiteral(
      `{${segments
        .slice(0, depth)
        .map((s) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`)
        .join(',')}}`,
    )})`;
    return `CASE WHEN jsonb_typeof(${at}) = 'object' THEN ${at} ELSE '{}'::jsonb END`;
  };
  let merged = value;
  for (let depth = segments.length - 1; depth >= 0; depth--) {
    merged = `(${objectAt(depth)}) || jsonb_build_object(${quoteLiteral(segments[depth])}, ${merged})`;
  }
  return merged;
}

/** The statements moving a removed column's values into `_extra`, then dropping it. */
function dropColumnStatements(table: string, column: ColumnDescriptor): string[] {
  const quotedTable = quoteIdentifier(table);
  const name = quoteIdentifier(column.name);
  const path = column.path!;
  const presence = column.role === 'shape' ? `${name} IS TRUE` : `${name} IS NOT NULL`;
  return [
    `UPDATE ${quotedTable} SET "_extra" = ${mergeIntoExtra(path, extraValue(column))} WHERE ${presence}`,
    `UPDATE ${quotedTable} SET "_extra" = ${mergeIntoExtra(path, `'null'::jsonb`)}, ` +
      `"_nulls" = NULLIF(array_remove("_nulls", ${quoteLiteral(path)}), '{}') ` +
      `WHERE ${quoteLiteral(path)} = ANY ("_nulls")`,
    `ALTER TABLE ${quotedTable} DROP COLUMN ${name}`,
  ];
}

/** The statements of a migration applying `changes` (with the prelude when `prelude` is set). */
export function emitMigrationDdl(
  changes: readonly SchemaChange[],
  options: { prelude?: boolean } = {},
): MigrationStatement[] {
  const statements: MigrationStatement[] = (options.prelude ? emitPreludeDdl() : []).map((sql) => ({
    sql,
    concurrently: false,
  }));
  const add = (sql: string, concurrently = false) => statements.push({ sql, concurrently });
  for (const change of changes) {
    switch (change.kind) {
      case 'createTable':
        add(emitTableDdl(change.table));
        break;
      case 'addColumn':
        add(
          `ALTER TABLE ${quoteIdentifier(change.table)} ADD COLUMN ${emitColumnDefinition(change.column)}`,
        );
        break;
      case 'alterColumnType':
        add(
          `ALTER TABLE ${quoteIdentifier(change.table)} ALTER COLUMN ${quoteIdentifier(change.column.name)} ` +
            `TYPE ${change.column.sqlType} USING ${change.using}`,
        );
        break;
      case 'dropColumn':
        for (const sql of dropColumnStatements(change.table, change.column)) add(sql);
        break;
      case 'addCheck':
        add(
          `ALTER TABLE ${quoteIdentifier(change.table)} ADD ${emitCheckDefinition(change.check)}`,
        );
        break;
      case 'dropCheck':
        add(
          `ALTER TABLE ${quoteIdentifier(change.table)} DROP CONSTRAINT ${quoteIdentifier(change.check.name)}`,
        );
        break;
      case 'createIndex':
        add(emitIndexDdl(change.index, { concurrently: change.concurrently }), change.concurrently);
        break;
      case 'dropIndex':
        add(
          `DROP INDEX ${change.concurrently ? 'CONCURRENTLY ' : ''}${quoteIdentifier(change.index.name)}`,
          change.concurrently,
        );
        break;
    }
  }
  return statements;
}

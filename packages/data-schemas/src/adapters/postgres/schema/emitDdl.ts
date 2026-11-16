/**
 * The DDL of a {@link SchemaDescriptor} (docs/postgres-port/PHASE4.md §1.1, §1.7): the statements
 * creating the `lc_object_id` domain, every table (columns, primary key, parent foreign key, hint
 * `CHECK`s) and every index. Pure string building: the migration generator (F3) and the specs
 * apply them. Must not import `mongoose`, `mongodb` or `bson`.
 */
import type {
  IndexDescriptor,
  TableDescriptor,
  CheckDescriptor,
  ColumnDescriptor,
  SchemaDescriptor,
  IndexKeyDescriptor,
} from './descriptor';
import { parentKeyName, primaryKeyName } from './descriptor';
import { quoteIdentifier } from './naming';

/** The domain every ObjectId column uses: 24 lowercase hex digits, compared in code point order. */
export const OBJECT_ID_DOMAIN_DDL = `CREATE DOMAIN lc_object_id AS text COLLATE "C" CHECK (VALUE ~ '^[0-9a-f]{24}$')`;

/** The statements every schema needs before its tables (the `lc_object_id` domain). */
export function emitPreludeDdl(): string[] {
  return [OBJECT_ID_DOMAIN_DDL];
}

/** A column definition. */
export function emitColumnDefinition(column: ColumnDescriptor): string {
  return `${quoteIdentifier(column.name)} ${column.sqlType}${column.nullable ? '' : ' NOT NULL'}`;
}

/** A hint `CHECK` constraint definition. */
export function emitCheckDefinition(check: CheckDescriptor): string {
  return `CONSTRAINT ${quoteIdentifier(check.name)} CHECK (${check.expression})`;
}

/** The parent foreign key of a child or element table. */
function parentKeyDefinition(table: TableDescriptor): string {
  return (
    `CONSTRAINT ${quoteIdentifier(parentKeyName(table))} FOREIGN KEY ("_parent") ` +
    `REFERENCES ${quoteIdentifier(table.parent!)} ("_id") ON DELETE CASCADE`
  );
}

/** `CREATE TABLE` for `table`. */
export function emitTableDdl(table: TableDescriptor): string {
  const lines = table.columns.map(emitColumnDefinition);
  lines.push(
    `CONSTRAINT ${quoteIdentifier(primaryKeyName(table))} PRIMARY KEY (${table.primaryKey
      .map(quoteIdentifier)
      .join(', ')})`,
  );
  if (table.parent) {
    lines.push(parentKeyDefinition(table));
  }
  lines.push(...table.checks.map(emitCheckDefinition));
  return `CREATE TABLE ${quoteIdentifier(table.name)} (\n  ${lines.join(',\n  ')}\n)`;
}

/** One key of an index: btree keys carry MongoDB's null order for their direction. */
function emitIndexKey(key: IndexKeyDescriptor, method: IndexDescriptor['method']): string {
  const target = key.column !== undefined ? quoteIdentifier(key.column) : `(${key.expression})`;
  if (method === 'gin') {
    return key.opclass ? `${target} ${key.opclass}` : target;
  }
  return `${target} ${key.direction === -1 ? 'DESC NULLS LAST' : 'ASC NULLS FIRST'}`;
}

/** `CREATE INDEX` for `index` (`CONCURRENTLY` when asked, which cannot run in a transaction). */
export function emitIndexDdl(
  index: IndexDescriptor,
  options: { concurrently?: boolean } = {},
): string {
  const keys = index.keys.map((key) => emitIndexKey(key, index.method)).join(', ');
  return (
    `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${options.concurrently ? 'CONCURRENTLY ' : ''}` +
    `${quoteIdentifier(index.name)} ON ${quoteIdentifier(index.table)}` +
    `${index.method === 'gin' ? ' USING gin' : ''} (${keys})` +
    `${index.unique ? ' NULLS NOT DISTINCT' : ''}` +
    `${index.where ? ` WHERE ${index.where}` : ''}`
  );
}

/** The tables of `descriptor` in creation order: every parent before its child tables. */
function inCreationOrder(descriptor: SchemaDescriptor): TableDescriptor[] {
  const created = new Set<string>();
  const ordered: TableDescriptor[] = [];
  const pending = [...descriptor.tables];
  while (pending.length > 0) {
    const index = pending.findIndex((table) => !table.parent || created.has(table.parent));
    if (index < 0) {
      throw new Error(`Tables with a missing parent: ${pending.map((t) => t.name).join(', ')}`);
    }
    const [table] = pending.splice(index, 1);
    created.add(table.name);
    ordered.push(table);
  }
  return ordered;
}

/**
 * Every statement creating the schema of `descriptor`: the prelude (unless `prelude: false`),
 * the tables, then their indexes.
 */
export function emitSchemaDdl(
  descriptor: SchemaDescriptor,
  options: { prelude?: boolean } = {},
): string[] {
  const tables = inCreationOrder(descriptor);
  return [
    ...(options.prelude === false ? [] : emitPreludeDdl()),
    ...tables.map(emitTableDdl),
    ...tables.flatMap((table) => table.indexes.map((index) => emitIndexDdl(index))),
  ];
}

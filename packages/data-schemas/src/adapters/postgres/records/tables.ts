/**
 * Lookups over a {@link SchemaDescriptor} for the record codec (docs/postgres-port/PHASE4.md §1,
 * §3.1): tables by name and by collection, columns by name, the path tree of each table flattened
 * by path, and each table's child and element tables. Built once per descriptor and cached.
 *
 * Paths here are relative to a table's row, as in the descriptor: a collection table's paths are
 * document paths, a child table's are relative to one array element. Must not import `mongoose`,
 * `mongodb` or `bson`.
 */
import type {
  FieldDescriptor,
  TableDescriptor,
  ColumnDescriptor,
  SchemaDescriptor,
} from '../schema/descriptor';
import { StoreQueryError } from '~/ports/query';

/** A table of the descriptor with its lookups. */
export interface RecordTable {
  readonly descriptor: TableDescriptor;
  /** Every column by name. */
  readonly columns: ReadonlyMap<string, ColumnDescriptor>;
  /** Every node of the path tree (nested object fields included) by its path in the row. */
  readonly fields: ReadonlyMap<string, FieldDescriptor>;
  /** The paths of the row hidden by default (`select: false`), relative to the row. */
  readonly hidden: ReadonlySet<string>;
  /** Whether the table has `_nulls` and `_extra`. */
  readonly systemColumns: boolean;
}

/** The descriptor with its lookups (see {@link indexRecordTables}). */
export interface RecordTables {
  readonly descriptor: SchemaDescriptor;
  /** The table named `name`; throws a `StoreQueryError` when there is none. */
  table(name: string): RecordTable;
  /** The table of collection `collection` (a collection or raw table); throws when there is none. */
  collection(collection: string): RecordTable;
  /** Whether `collection` names a collection or raw table. */
  hasCollection(collection: string): boolean;
  /** Collection and raw tables, in descriptor order. */
  readonly roots: readonly RecordTable[];
}

const cache = new WeakMap<SchemaDescriptor, RecordTables>();

/** Every node of `fields`, depth first, objects before their fields. */
function* walkFields(fields: readonly FieldDescriptor[]): Generator<FieldDescriptor> {
  for (const field of fields) {
    yield field;
    if (field.kind === 'object') {
      yield* walkFields(field.fields);
    }
  }
}

function indexTable(table: TableDescriptor): RecordTable {
  const fields = new Map<string, FieldDescriptor>();
  for (const field of walkFields(table.fields)) {
    fields.set(field.path, field);
  }
  return {
    descriptor: table,
    columns: new Map(table.columns.map((column) => [column.name, column])),
    fields,
    hidden: new Set(table.hiddenPaths),
    systemColumns: table.systemColumns,
  };
}

/** The lookups of `descriptor`, built on first use and cached for the descriptor object. */
export function indexRecordTables(descriptor: SchemaDescriptor): RecordTables {
  const cached = cache.get(descriptor);
  if (cached) {
    return cached;
  }
  const byName = new Map<string, RecordTable>();
  const byCollection = new Map<string, RecordTable>();
  const roots: RecordTable[] = [];
  for (const table of descriptor.tables) {
    const indexed = indexTable(table);
    byName.set(table.name, indexed);
    if (table.kind === 'collection' || table.kind === 'raw') {
      byCollection.set(table.collection, indexed);
      roots.push(indexed);
    }
  }
  const tables: RecordTables = {
    descriptor,
    roots,
    table: (name) => {
      const table = byName.get(name);
      if (!table) {
        throw new StoreQueryError(`Unknown table "${name}"`);
      }
      return table;
    },
    collection: (collection) => {
      const table = byCollection.get(collection);
      if (!table) {
        throw new StoreQueryError(`Unknown collection "${collection}"`);
      }
      return table;
    },
    hasCollection: (collection) => byCollection.has(collection),
  };
  cache.set(descriptor, tables);
  return tables;
}

/** The fields of `field`'s children (an object's fields), or none. */
export function childFields(field: FieldDescriptor): readonly FieldDescriptor[] {
  return field.kind === 'object' ? field.fields : [];
}

/** The last segment of a path. */
export function lastSegment(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? path : path.slice(dot + 1);
}

/**
 * The typed schema descriptor of the PostgreSQL backend (docs/postgres-port/PHASE4.md §1) and its
 * builder: the mapping rules of §1.2 and the overrides of §1.6 applied to the introspected
 * collection schemas.
 *
 * The builder works on {@link CollectionSource}s, plain data the generator (`generate.ts`) reads
 * from the mongoose schemas offline; so this module, which the adapter's runtime reads the
 * descriptor types from, never loads `mongoose`, `mongodb` or `bson`.
 *
 * Mapping, per §1.2:
 * - scalars: one column each (`String` `text COLLATE "C"`, `Number` `double precision`, `Boolean`
 *   `boolean`, `Date` `timestamptz`, `ObjectId` `lc_object_id`, `Buffer` `bytea`); the top-level
 *   `_id` is the primary key (`lc_object_id`, or `text COLLATE "C"` for String ids);
 * - single subdocuments and nested objects: flattened, `<path>__<leaf>` columns, plus a `boolean`
 *   shape column named by the object path;
 * - arrays of scalars: `T[]` columns, or element tables `<table>__<path>(_parent, _ord, value)`
 *   where an override says so (with an `integer` element-count column on the parent);
 * - arrays of subdocuments: child tables `<table>__<path>(_parent, _ord, ...)` with the element's
 *   columns by the same rules, `_nulls` and `_extra`, and an `integer` element-count shape column
 *   on the parent; an array of subdocuments inside another is refused;
 * - `Mixed`, arrays of `Mixed` and `Map`s: `json` columns (hinted subpaths get `CHECK`s);
 * - `__v`: `integer`; `_nulls text[] COLLATE "C"` and `_extra jsonb` on every table and child
 *   table.
 *
 * Indexes follow §1.7 (btree keys with MongoDB's null order, GIN for multikey and `Mixed` keys,
 * child-table indexes, `NULLS NOT DISTINCT` uniques, partial, sparse and TTL rules).
 */
import type { SchemaOverrides } from './overrides';
import {
  shortHash,
  PATH_SEPARATOR,
  quoteLiteral,
  childTableName,
  quoteIdentifier,
  columnNameForPath,
  shortenIdentifier,
  IdentifierRegistry,
  SchemaGenerationError,
} from './naming';
import { NO_SCHEMA_OVERRIDES } from './overrides';

/* ------------------------------------------------------------------------------------------ */
/* Sources: the introspected schemas                                                           */
/* ------------------------------------------------------------------------------------------ */

/** A string setter mongoose applies to writes and to filter values. */
export type StringTransform = 'lowercase' | 'uppercase' | 'trim';

/** One field of a collection schema, as the generator reads it from mongoose. */
export type SourceField =
  | {
      kind: 'leaf';
      name: string;
      /** Mongoose's `instance`: `String`, `Number`, `Boolean`, `Date`, `ObjectId`, `Buffer`, `Mixed`, ... */
      instance: string;
      hidden: boolean;
      transforms: StringTransform[];
    }
  | { kind: 'array'; name: string; element: SourceField; hidden: boolean }
  | {
      kind: 'object';
      name: string;
      /** A single subdocument (its own schema) rather than a nested plain object. */
      subdocument: boolean;
      fields: SourceField[];
      hidden: boolean;
    }
  | { kind: 'documentArray'; name: string; fields: SourceField[]; hidden: boolean }
  | { kind: 'map'; name: string; of: SourceField; hidden: boolean };

/** One index of a collection schema (`schema.indexes()`). */
export interface SourceIndex {
  fields: Array<[string, unknown]>;
  options: Record<string, unknown>;
  /** Added by a plugin override rather than declared by the schema. */
  plugin?: boolean;
}

/** A collection schema as the generator reads it. */
export interface CollectionSource {
  collection: string;
  /** `collection` for a registered model, `raw` for a raw collection (`schema/raw`). */
  kind: 'collection' | 'raw';
  modelName?: string;
  /** The fields in `schema.paths` order (nested objects at their first path), `_id` included. */
  fields: SourceField[];
  indexes: SourceIndex[];
  timestamps: TimestampNames | null;
  versionKey: string | null;
  strict: boolean;
  /**
   * A raw table keyed by these columns instead of `_id`, without `_nulls`/`_extra` (the
   * key-value store's `key_value_entries`).
   */
  primaryKey?: string[];
}

/** The paths `timestamps` writes; `null` for one the schema turns off. */
export interface TimestampNames {
  createdAt: string | null;
  updatedAt: string | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Descriptor                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** The value type of a typed column (or of the elements of an array column). */
export type ScalarType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'objectId'
  | 'buffer'
  /** An overridden `Mixed` holding ObjectIds or strings, stored as text (ids as hex). */
  | 'objectIdOrString';

/** The type of a column: a scalar, a system integer, `json` (Mixed) or `jsonb` (`_extra`). */
export type ColumnType = ScalarType | 'integer' | 'json' | 'jsonb';

/** What a column holds. */
export type ColumnRole =
  /** The primary key `_id` (or a column of a raw table's own key). */
  | 'id'
  /** The parent row's `_id` (child and element tables). */
  | '_parent'
  /** The element's position (child and element tables). */
  | '_ord'
  /** An element of an element table. */
  | 'value'
  /** A scalar leaf. */
  | 'leaf'
  /** An array of scalars. */
  | 'array'
  /** `Mixed`, an array of `Mixed`, or a `Map`. */
  | 'json'
  /** An object path: `true` when present. */
  | 'shape'
  /** An array stored in a child or element table: its element count. */
  | 'count'
  /** The version key (`__v`). */
  | 'version'
  /** The declared paths explicitly set to `null`. */
  | '_nulls'
  /** Values the schema does not describe (D7). */
  | '_extra';

/** One column of a table. */
export interface ColumnDescriptor {
  name: string;
  /** The path it stores, relative to the table's row; `null` for the system columns. */
  path: string | null;
  role: ColumnRole;
  type: ColumnType;
  array: boolean;
  /** The SQL type as written in `CREATE TABLE`. */
  sqlType: string;
  nullable: boolean;
}

/** One node of a table's path tree; paths are relative to the table's row. */
export type FieldDescriptor =
  | {
      kind: 'scalar';
      path: string;
      column: string;
      type: ScalarType;
      hidden?: true;
      transforms?: StringTransform[];
      /** The schema's `_id` (primary key) or version key. */
      system?: 'id' | 'version';
    }
  | {
      kind: 'array';
      path: string;
      column: string;
      element: ScalarType;
      hidden?: true;
      transforms?: StringTransform[];
    }
  | {
      kind: 'elements';
      path: string;
      /** The element-count column on this table. */
      column: string;
      table: string;
      element: ScalarType;
      hidden?: true;
      transforms?: StringTransform[];
    }
  | {
      kind: 'object';
      path: string;
      /** The shape column. */
      column: string;
      subdocument: boolean;
      hidden?: true;
      fields: FieldDescriptor[];
    }
  | {
      kind: 'children';
      path: string;
      /** The element-count column on this table. */
      column: string;
      table: string;
      hidden?: true;
    }
  | {
      kind: 'json';
      path: string;
      column: string;
      json: 'mixed' | 'mixedArray' | 'map';
      /** A `Map`'s value type. */
      mapOf?: ScalarType | 'mixed';
      hidden?: true;
      /** Subpaths with a hint `CHECK` (§1.6). */
      hints?: string[];
    };

/** A `CHECK` constraint. */
export interface CheckDescriptor {
  name: string;
  /** `jsonHint`: the subpath `path` of `column` has no array step and a scalar leaf. */
  kind: 'jsonHint';
  column: string;
  path: string;
  expression: string;
}

/** One key of an index. */
export interface IndexKeyDescriptor {
  /** The path, relative to the indexed table's row (`value` for an element table). */
  path: string;
  direction: 1 | -1;
  /** The column, for a key on a column. */
  column?: string;
  /** The expression, for a key on a hinted `json` subpath or a GIN key on a `json` column. */
  expression?: string;
  /** The operator class (`jsonb_path_ops` on `json` GIN keys). */
  opclass?: string;
}

/** A MongoDB index an SQL index serves (several when identical SQL indexes were merged). */
export interface IndexSourceDescriptor {
  /** The MongoDB index name (given, or MongoDB's default `<path>_<dir>_...`). */
  mongoName: string;
  /** Its keys, paths relative to the collection's documents. */
  fields: Array<[string, 1 | -1]>;
  unique: boolean;
  sparse: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
  /** Declared by a plugin override (§1.6) rather than by the schema. */
  plugin?: true;
}

/** An SQL index. */
export interface IndexDescriptor {
  name: string;
  table: string;
  method: 'btree' | 'gin';
  keys: IndexKeyDescriptor[];
  unique: boolean;
  /** The partial or sparse predicate. */
  where?: string;
  sources: IndexSourceDescriptor[];
}

/** A TTL rule the sweeper (I4) applies: rows whose `column` + `expireAfterSeconds` has passed. */
export interface TtlDescriptor {
  column: string;
  path: string;
  expireAfterSeconds: number;
  /** The partial predicate rows must also match. */
  where?: string;
  /** The SQL index serving it. */
  index: string;
  mongoName: string;
}

/** A table: a collection's, a raw collection's, or a child or element table. */
export interface TableDescriptor {
  name: string;
  kind: 'collection' | 'raw' | 'child' | 'element';
  /** The collection the rows belong to. */
  collection: string;
  modelName?: string;
  /** Child and element tables: the array's path in the collection's documents. */
  path?: string;
  /** Child and element tables: the parent table. */
  parent?: string;
  /** `_id`'s type on collection and raw tables keyed by `_id`. */
  idType?: 'objectId' | 'string';
  primaryKey: string[];
  columns: ColumnDescriptor[];
  /** The path tree of a row (empty for element tables). */
  fields: FieldDescriptor[];
  /** Paths (relative to the row) declared `select: false`. */
  hiddenPaths: string[];
  timestamps: TimestampNames | null;
  versionKey: string | null;
  /** Whether the table has `_nulls` and `_extra`. */
  systemColumns: boolean;
  /** New indexes are built `CONCURRENTLY` (§5). */
  large: boolean;
  checks: CheckDescriptor[];
  indexes: IndexDescriptor[];
  ttl: TtlDescriptor[];
}

/** The whole PostgreSQL schema: every table, parents before their child and element tables. */
export interface SchemaDescriptor {
  version: 1;
  tables: TableDescriptor[];
}

/* ------------------------------------------------------------------------------------------ */
/* Constants                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** The system columns a declared field may not be named like. */
export const SYSTEM_COLUMN_NAMES: readonly string[] = ['_parent', '_ord', '_nulls', '_extra'];

const TEXT_COLLATED = 'text COLLATE "C"';

/** The SQL type of each scalar. */
export const SCALAR_SQL_TYPES: Readonly<Record<ScalarType, string>> = {
  string: TEXT_COLLATED,
  number: 'double precision',
  boolean: 'boolean',
  date: 'timestamptz',
  objectId: 'lc_object_id',
  buffer: 'bytea',
  objectIdOrString: TEXT_COLLATED,
};

const SCALAR_INSTANCES: Readonly<Record<string, ScalarType>> = {
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
  Date: 'date',
  ObjectId: 'objectId',
  Buffer: 'buffer',
};

/** The SQL type of an array of `type`. */
export function arraySqlType(type: ScalarType): string {
  const base = SCALAR_SQL_TYPES[type];
  return base === TEXT_COLLATED ? 'text[] COLLATE "C"' : `${base}[]`;
}

/** The SQL type of a column of `type` (an array of it when `array`). */
function sqlTypeOf(type: ColumnType, array: boolean): string {
  if (type === 'integer' || type === 'json' || type === 'jsonb') {
    return type;
  }
  return array ? arraySqlType(type) : SCALAR_SQL_TYPES[type];
}

/** A nullable, non-array column unless `options` says otherwise; the SQL type follows the type. */
function makeColumn(
  name: string,
  path: string | null,
  role: ColumnRole,
  type: ColumnType,
  options: { array?: boolean; nullable?: boolean; sqlType?: string } = {},
): ColumnDescriptor {
  const array = options.array ?? false;
  return {
    name,
    path,
    role,
    type,
    array,
    sqlType: options.sqlType ?? sqlTypeOf(type, array),
    nullable: options.nullable ?? true,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Builder                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Where a dotted document path lives once mapped. */
interface PathLocation {
  table: TableDescriptor;
  field: FieldDescriptor;
}

/** The state of one collection while its tables are built. */
interface CollectionState {
  source: CollectionSource;
  root: TableDescriptor;
  tables: TableDescriptor[];
  /** Every declared node, by its path in the collection's documents. */
  paths: Map<string, PathLocation>;
}

/** The overrides applying to one collection. */
interface CollectionOverrides {
  columnTypes: Map<string, 'objectIdOrString'>;
  jsonHints: Map<string, string[]>;
  elementTables: Set<string>;
  large: boolean;
}

/** One table's columns under construction, with the collision check of their names. */
class TableBuilder {
  readonly columnNames: IdentifierRegistry;
  constructor(readonly table: TableDescriptor) {
    this.columnNames = new IdentifierRegistry(`table "${table.name}" columns`);
  }

  addColumn(column: ColumnDescriptor, owner: string): string {
    this.columnNames.register(column.name, owner);
    this.table.columns.push(column);
    return column.name;
  }
}

/** The document path of `relative` in the collection, for a table at `prefix`. */
function documentPath(prefix: string, relative: string): string {
  return prefix ? `${prefix}.${relative}` : relative;
}

/** MongoDB's default index name: `<path>_<direction>` joined with `_`. */
export function defaultMongoIndexName(fields: ReadonlyArray<[string, unknown]>): string {
  return fields.map(([path, direction]) => `${path}_${String(direction)}`).join('_');
}

function assertFieldName(name: string, where: string, options: { topLevel: boolean }): void {
  if (name.includes(PATH_SEPARATOR) && !(options.topLevel && name === '__v')) {
    throw new SchemaGenerationError(
      `${where}: field "${name}" contains "${PATH_SEPARATOR}", which separates path segments in column names`,
    );
  }
  if (SYSTEM_COLUMN_NAMES.includes(name)) {
    throw new SchemaGenerationError(
      `${where}: field "${name}" collides with the system column of the same name`,
    );
  }
}

function scalarTypeOf(field: SourceField, where: string): ScalarType {
  const type = field.kind === 'leaf' ? SCALAR_INSTANCES[field.instance] : undefined;
  if (type === undefined) {
    const shape = field.kind === 'leaf' ? field.instance : field.kind;
    throw new SchemaGenerationError(`${where}: unsupported schema type ${shape}`);
  }
  return type;
}

/** The overrides of `collection`, each target checked against the sources at the end. */
function overridesFor(overrides: SchemaOverrides, collection: string): CollectionOverrides {
  return {
    columnTypes: new Map(
      overrides.columnTypes
        .filter((entry) => entry.collection === collection)
        .map((entry) => [entry.path, entry.type]),
    ),
    jsonHints: new Map(
      overrides.jsonHints
        .filter((entry) => entry.collection === collection)
        .map((entry) => [entry.path, [...entry.subpaths]]),
    ),
    elementTables: new Set(
      overrides.elementTables
        .filter((entry) => entry.collection === collection)
        .map((entry) => entry.path),
    ),
    large: overrides.largeTables.collections.includes(collection),
  };
}

/** A new, empty table. */
function newTable(
  partial: Pick<TableDescriptor, 'name' | 'kind' | 'collection'> & Partial<TableDescriptor>,
): TableDescriptor {
  return {
    primaryKey: [],
    columns: [],
    fields: [],
    hiddenPaths: [],
    timestamps: null,
    versionKey: null,
    systemColumns: true,
    large: false,
    checks: [],
    indexes: [],
    ttl: [],
    ...partial,
  };
}

/** The `jsonb` expression of a `json` column. */
function jsonbOf(column: string): string {
  return `(${quoteIdentifier(column)}::jsonb)`;
}

/** A `text[]` literal of path segments for `#>` (each segment double-quoted). */
function jsonPathLiteral(segments: readonly string[]): string {
  const elements = segments.map((segment) => `"${segment.replace(/["\\]/g, (c) => `\\${c}`)}"`);
  return quoteLiteral(`{${elements.join(',')}}`);
}

/** The expression of a hinted subpath: `(col::jsonb #> '{a,b}')`. */
export function jsonHintExpression(column: string, subpath: string): string {
  return `(${jsonbOf(column)} #> ${jsonPathLiteral(subpath.split('.'))})`;
}

/** The hint `CHECK`: no step of `subpath` is an array, and its leaf is a scalar. */
function jsonHintCheck(column: string, subpath: string): string {
  const segments = subpath.split('.');
  const conditions = [`jsonb_typeof(${jsonbOf(column)}) <> 'array'`];
  for (let i = 1; i < segments.length; i++) {
    conditions.push(
      `jsonb_typeof(${jsonbOf(column)} #> ${jsonPathLiteral(segments.slice(0, i))}) <> 'array'`,
    );
  }
  conditions.push(
    `jsonb_typeof(${jsonHintExpression(column, subpath)}) NOT IN ('array', 'object')`,
  );
  return conditions.join(' AND ');
}

/** Builds the tables of one collection. */
class CollectionBuilder {
  readonly state: CollectionState;
  private readonly usedOverrides = new Set<string>();

  constructor(
    readonly source: CollectionSource,
    private readonly overrides: CollectionOverrides,
    private readonly relations: IdentifierRegistry,
  ) {
    const name = shortenIdentifier(source.collection);
    const root = newTable({
      name,
      kind: source.kind,
      collection: source.collection,
      ...(source.modelName ? { modelName: source.modelName } : {}),
      timestamps: source.timestamps,
      versionKey: source.versionKey,
      systemColumns: source.primaryKey === undefined,
      large: overrides.large,
    });
    this.state = {
      source,
      root,
      tables: [root],
      paths: new Map(),
    };
  }

  build(): CollectionState {
    const { source, root } = this.state;
    const where = `collection "${source.collection}"`;
    this.relations.register(root.name, `the table of ${where}`);
    const builder = new TableBuilder(root);

    if (source.primaryKey) {
      if (source.fields.some((field) => field.name === '_id')) {
        throw new SchemaGenerationError(`${where}: a table keyed by its own columns has no _id`);
      }
    } else {
      const idField = source.fields.find((field) => field.name === '_id');
      if (!idField) {
        throw new SchemaGenerationError(`${where}: no _id path`);
      }
      const idType = scalarTypeOf(idField, `${where} _id`);
      if (idType !== 'objectId' && idType !== 'string') {
        throw new SchemaGenerationError(`${where}: unsupported _id type ${idType}`);
      }
      root.idType = idType;
    }

    this.addFields(builder, source.fields, '', { inChild: false, topLevel: true });

    if (source.primaryKey) {
      for (const key of source.primaryKey) {
        const location = this.state.paths.get(key);
        if (!location || location.field.kind !== 'scalar') {
          throw new SchemaGenerationError(`${where}: primary key "${key}" is not a scalar path`);
        }
        const column = root.columns.find((entry) => entry.name === location.field.column)!;
        column.role = 'id';
        column.nullable = false;
        root.primaryKey.push(column.name);
      }
    } else {
      root.primaryKey.push('_id');
    }
    if (root.systemColumns) {
      this.addSystemColumns(builder, where);
    }
    this.relations.register(shortenIdentifier(`${root.name}__pkey`), `the primary key of ${where}`);
    this.checkOverridesUsed();
    return this.state;
  }

  private addSystemColumns(builder: TableBuilder, owner: string): void {
    builder.addColumn(
      makeColumn('_nulls', null, '_nulls', 'string', { array: true }),
      `the _nulls column of ${owner}`,
    );
    builder.addColumn(
      makeColumn('_extra', null, '_extra', 'jsonb'),
      `the _extra column of ${owner}`,
    );
  }

  /** The child or element table for the array at `path` (document path). */
  private childTable(
    kind: 'child' | 'element',
    path: string,
    parent: TableDescriptor,
  ): { table: TableDescriptor; builder: TableBuilder } {
    const name = childTableName(this.state.root.name, path);
    const table = newTable({
      name,
      kind,
      collection: this.source.collection,
      path,
      parent: parent.name,
      systemColumns: kind === 'child',
      large: this.overrides.large,
    });
    const owner = `the ${kind} table of ${this.source.collection}.${path}`;
    this.relations.register(name, owner);
    this.relations.register(shortenIdentifier(`${name}__pkey`), `the primary key of ${owner}`);
    const builder = new TableBuilder(table);
    builder.addColumn(
      makeColumn(
        '_parent',
        null,
        '_parent',
        this.state.root.idType === 'string' ? 'string' : 'objectId',
        { nullable: false },
      ),
      `the _parent column of ${owner}`,
    );
    builder.addColumn(
      makeColumn('_ord', null, '_ord', 'integer', { nullable: false }),
      `the _ord column of ${owner}`,
    );
    table.primaryKey.push('_parent', '_ord');
    this.state.tables.push(table);
    return { table, builder };
  }

  private register(path: string, table: TableDescriptor, field: FieldDescriptor): void {
    this.state.paths.set(path, { table, field });
  }

  /**
   * Adds `fields` (at `prefix`, relative to `builder`'s row; `docPrefix` is the row's own path in
   * the documents) and returns their descriptors.
   */
  private addFields(
    builder: TableBuilder,
    fields: SourceField[],
    prefix: string,
    context: { inChild: boolean; topLevel: boolean; docPrefix?: string },
  ): FieldDescriptor[] {
    const descriptors: FieldDescriptor[] = [];
    const target = prefix === '' ? builder.table.fields : undefined;
    for (const field of fields) {
      const descriptor = this.addField(builder, field, prefix, context);
      if (descriptor) {
        descriptors.push(descriptor);
        target?.push(descriptor);
      }
    }
    return descriptors;
  }

  private addField(
    builder: TableBuilder,
    field: SourceField,
    prefix: string,
    context: { inChild: boolean; topLevel: boolean; docPrefix?: string },
  ): FieldDescriptor | undefined {
    const table = builder.table;
    const relPath = prefix ? `${prefix}.${field.name}` : field.name;
    const docPath = documentPath(context.docPrefix ?? '', relPath);
    const where = `${this.source.collection}.${docPath}`;
    const topLevel = context.topLevel && prefix === '';
    assertFieldName(field.name, this.source.collection + (prefix ? `.${prefix}` : ''), {
      topLevel,
    });
    const column = columnNameForPath(relPath);
    const hidden = field.hidden ? ({ hidden: true } as const) : {};
    if (field.hidden) {
      table.hiddenPaths.push(relPath);
    }
    const owner = `path "${where}"`;

    if (topLevel && !context.inChild && field.name === '_id' && !this.source.primaryKey) {
      const type = this.state.root.idType!;
      builder.addColumn(makeColumn('_id', '_id', 'id', type, { nullable: false }), owner);
      const descriptor: FieldDescriptor = {
        kind: 'scalar',
        path: '_id',
        column: '_id',
        type,
        system: 'id',
        ...hidden,
      };
      this.register(docPath, table, descriptor);
      return descriptor;
    }

    if (topLevel && !context.inChild && field.name === this.source.versionKey) {
      if (scalarTypeOf(field, where) !== 'number') {
        throw new SchemaGenerationError(`${where}: the version key must be a Number`);
      }
      builder.addColumn(makeColumn(column, relPath, 'version', 'integer'), owner);
      const descriptor: FieldDescriptor = {
        kind: 'scalar',
        path: relPath,
        column,
        type: 'number',
        system: 'version',
        ...hidden,
      };
      this.register(docPath, table, descriptor);
      return descriptor;
    }

    const columnTypeOverride = !context.inChild
      ? this.overrides.columnTypes.get(docPath)
      : undefined;
    if (columnTypeOverride) {
      this.usedOverrides.add(`columnType:${docPath}`);
      if (field.kind !== 'leaf' || field.instance !== 'Mixed') {
        throw new SchemaGenerationError(
          `${where}: the column type override expects a Mixed path, found ${field.kind === 'leaf' ? field.instance : field.kind}`,
        );
      }
      builder.addColumn(makeColumn(column, relPath, 'leaf', columnTypeOverride), owner);
      const descriptor: FieldDescriptor = {
        kind: 'scalar',
        path: relPath,
        column,
        type: columnTypeOverride,
        ...hidden,
      };
      this.register(docPath, table, descriptor);
      return descriptor;
    }

    switch (field.kind) {
      case 'leaf': {
        if (field.instance === 'Mixed') {
          return this.addJson(builder, relPath, docPath, column, 'mixed', hidden, context);
        }
        const type = scalarTypeOf(field, where);
        builder.addColumn(makeColumn(column, relPath, 'leaf', type), owner);
        const descriptor: FieldDescriptor = {
          kind: 'scalar',
          path: relPath,
          column,
          type,
          ...hidden,
          ...(field.transforms.length > 0 ? { transforms: [...field.transforms] } : {}),
        };
        this.register(docPath, table, descriptor);
        return descriptor;
      }
      case 'map': {
        const of = field.of;
        let mapOf: ScalarType | 'mixed';
        if (of.kind === 'leaf' && of.instance === 'Mixed') {
          mapOf = 'mixed';
        } else if (of.kind === 'leaf') {
          mapOf = scalarTypeOf(of, `${where} (Map value)`);
        } else {
          throw new SchemaGenerationError(
            `${where}: unsupported Map of ${of.kind === 'documentArray' ? 'subdocument arrays' : of.kind}`,
          );
        }
        return this.addJson(builder, relPath, docPath, column, 'map', hidden, context, mapOf);
      }
      case 'array':
        return this.addArray(builder, field, relPath, docPath, column, hidden, context);
      case 'object': {
        builder.addColumn(makeColumn(column, relPath, 'shape', 'boolean'), owner);
        const descriptor: FieldDescriptor = {
          kind: 'object',
          path: relPath,
          column,
          subdocument: field.subdocument,
          ...hidden,
          fields: [],
        };
        this.register(docPath, table, descriptor);
        descriptor.fields = this.addFields(builder, field.fields, relPath, {
          ...context,
          topLevel: false,
        });
        return descriptor;
      }
      case 'documentArray': {
        if (context.inChild) {
          throw new SchemaGenerationError(
            `${where}: an array of subdocuments inside another array of subdocuments is not supported`,
          );
        }
        if (this.overrides.elementTables.has(docPath)) {
          throw new SchemaGenerationError(
            `${where}: the element table override expects an array of scalars, found an array of subdocuments`,
          );
        }
        builder.addColumn(makeColumn(column, relPath, 'count', 'integer'), owner);
        const child = this.childTable('child', docPath, table);
        const descriptor: FieldDescriptor = {
          kind: 'children',
          path: relPath,
          column,
          table: child.table.name,
          ...hidden,
        };
        this.register(docPath, table, descriptor);
        this.addFields(child.builder, field.fields, '', {
          inChild: true,
          topLevel: true,
          docPrefix: docPath,
        });
        this.addSystemColumns(child.builder, `the child table of ${where}`);
        return descriptor;
      }
    }
  }

  private addJson(
    builder: TableBuilder,
    relPath: string,
    docPath: string,
    column: string,
    json: 'mixed' | 'mixedArray' | 'map',
    hidden: { hidden?: true },
    context: { inChild: boolean },
    mapOf?: ScalarType | 'mixed',
  ): FieldDescriptor {
    const table = builder.table;
    builder.addColumn(
      makeColumn(column, relPath, 'json', 'json'),
      `path "${this.source.collection}.${docPath}"`,
    );
    const hints = !context.inChild ? this.overrides.jsonHints.get(docPath) : undefined;
    if (hints) {
      this.usedOverrides.add(`jsonHint:${docPath}`);
      if (json === 'mixedArray') {
        throw new SchemaGenerationError(
          `${this.source.collection}.${docPath}: hints need a Mixed or Map path, not an array`,
        );
      }
      for (const subpath of hints) {
        if (subpath.split('.').some((segment) => segment === '' || /^\d+$/.test(segment))) {
          throw new SchemaGenerationError(
            `${this.source.collection}.${docPath}: invalid hint subpath "${subpath}"`,
          );
        }
        table.checks.push({
          name: shortenIdentifier(
            `${table.name}__${column}__${subpath.split('.').join('_')}__hint`,
          ),
          kind: 'jsonHint',
          column,
          path: subpath,
          expression: jsonHintCheck(column, subpath),
        });
      }
    }
    const descriptor: FieldDescriptor = {
      kind: 'json',
      path: relPath,
      column,
      json,
      ...(mapOf ? { mapOf } : {}),
      ...hidden,
      ...(hints ? { hints: [...hints] } : {}),
    };
    this.register(docPath, table, descriptor);
    return descriptor;
  }

  private addArray(
    builder: TableBuilder,
    field: Extract<SourceField, { kind: 'array' }>,
    relPath: string,
    docPath: string,
    column: string,
    hidden: { hidden?: true },
    context: { inChild: boolean },
  ): FieldDescriptor {
    const where = `${this.source.collection}.${docPath}`;
    const table = builder.table;
    const element = field.element;
    if (element.kind === 'leaf' && element.instance === 'Mixed') {
      if (this.overrides.elementTables.has(docPath)) {
        throw new SchemaGenerationError(
          `${where}: the element table override expects an array of scalars, found an array of Mixed`,
        );
      }
      return this.addJson(builder, relPath, docPath, column, 'mixedArray', hidden, context);
    }
    if (element.kind === 'array') {
      throw new SchemaGenerationError(`${where}: arrays of arrays are not supported`);
    }
    if (element.kind !== 'leaf') {
      throw new SchemaGenerationError(`${where}: unsupported array of ${element.kind}`);
    }
    const type = scalarTypeOf(element, `${where} (array element)`);
    const transforms = element.transforms.length > 0 ? { transforms: [...element.transforms] } : {};
    const owner = `path "${where}"`;
    if (!context.inChild && this.overrides.elementTables.has(docPath)) {
      this.usedOverrides.add(`elementTable:${docPath}`);
      builder.addColumn(makeColumn(column, relPath, 'count', 'integer'), owner);
      const child = this.childTable('element', docPath, table);
      child.builder.addColumn(
        makeColumn('value', null, 'value', type),
        `the value column of the element table of ${where}`,
      );
      const descriptor: FieldDescriptor = {
        kind: 'elements',
        path: relPath,
        column,
        table: child.table.name,
        element: type,
        ...hidden,
        ...transforms,
      };
      this.register(docPath, table, descriptor);
      return descriptor;
    }
    builder.addColumn(makeColumn(column, relPath, 'array', type, { array: true }), owner);
    const descriptor: FieldDescriptor = {
      kind: 'array',
      path: relPath,
      column,
      element: type,
      ...hidden,
      ...transforms,
    };
    this.register(docPath, table, descriptor);
    return descriptor;
  }

  /** Fails on an override of this collection that matched no path. */
  private checkOverridesUsed(): void {
    const expected = [
      ...[...this.overrides.columnTypes.keys()].map((path) => `columnType:${path}`),
      ...[...this.overrides.jsonHints.keys()].map((path) => `jsonHint:${path}`),
      ...[...this.overrides.elementTables].map((path) => `elementTable:${path}`),
    ];
    for (const key of expected) {
      if (!this.usedOverrides.has(key)) {
        const [kind, path] = key.split(/:(.*)/s);
        throw new SchemaGenerationError(
          `stale override: ${kind} on ${this.source.collection}.${path} matches no top-level path of the expected kind`,
        );
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Indexes                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** An SQL index before its name is settled. */
interface PendingIndex {
  table: TableDescriptor;
  method: 'btree' | 'gin';
  keys: IndexKeyDescriptor[];
  unique: boolean;
  where?: string;
  sources: IndexSourceDescriptor[];
  ttl?: { column: string; path: string; expireAfterSeconds: number; mongoName: string };
  baseName: string;
  definition: string;
}

/** A resolved index key or filter path. */
interface ResolvedPath {
  table: TableDescriptor;
  field: FieldDescriptor;
  /** The subpath inside a `json` column. */
  jsonSubpath?: string;
  /** The path relative to the table's row. */
  relPath: string;
}

function resolvePath(state: CollectionState, path: string, where: string): ResolvedPath {
  const exact = state.paths.get(path);
  if (exact) {
    return { ...exact, relPath: exact.field.path };
  }
  const segments = path.split('.');
  for (let i = segments.length - 1; i > 0; i--) {
    const location = state.paths.get(segments.slice(0, i).join('.'));
    if (location) {
      if (location.field.kind === 'json') {
        return {
          ...location,
          relPath: location.field.path,
          jsonSubpath: segments.slice(i).join('.'),
        };
      }
      break;
    }
  }
  throw new SchemaGenerationError(`${where}: "${path}" is not a declared path`);
}

/** The column a `$exists`/sparse condition reads for a resolved path, with its `_nulls` path. */
function presenceCondition(resolved: ResolvedPath, where: string): string {
  if (resolved.jsonSubpath !== undefined) {
    const hinted =
      resolved.field.kind === 'json' && resolved.field.hints?.includes(resolved.jsonSubpath);
    if (!hinted) {
      throw new SchemaGenerationError(
        `${where}: a presence condition on the unhinted Mixed subpath "${resolved.relPath}.${resolved.jsonSubpath}" is not supported`,
      );
    }
    return `${jsonHintExpression(resolved.field.column, resolved.jsonSubpath)} IS NOT NULL`;
  }
  const column = quoteIdentifier(resolved.field.column);
  if (!resolved.table.systemColumns) {
    return `${column} IS NOT NULL`;
  }
  return `(${column} IS NOT NULL OR ${quoteLiteral(resolved.relPath)} = ANY ("_nulls"))`;
}

const TYPE_ALIASES: Readonly<Record<string, ScalarType[]>> = {
  number: ['number'],
  double: ['number'],
  int: ['number'],
  long: ['number'],
  string: ['string', 'objectIdOrString'],
  bool: ['boolean'],
  date: ['date'],
  objectId: ['objectId'],
};

/** An SQL literal of `value` for a column of `type`. */
function scalarLiteral(value: unknown, type: ScalarType, where: string): string {
  switch (type) {
    case 'string':
    case 'objectIdOrString':
      if (typeof value === 'string') return quoteLiteral(value);
      break;
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      break;
    case 'date':
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${quoteLiteral(value.toISOString())}::timestamptz`;
      }
      break;
    case 'objectId': {
      let hex: string | undefined;
      if (typeof value === 'string') {
        hex = value;
      } else if (
        value != null &&
        typeof (value as { toHexString?: unknown }).toHexString === 'function'
      ) {
        hex = (value as { toHexString(): string }).toHexString();
      }
      if (hex !== undefined && /^[0-9a-fA-F]{24}$/.test(hex)) {
        return quoteLiteral(hex.toLowerCase());
      }
      break;
    }
    case 'buffer':
      break;
  }
  throw new SchemaGenerationError(
    `${where}: cannot compare a ${type} column with ${String(value)}`,
  );
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).every((key) => key.startsWith('$'))
  );
}

/** The SQL predicate of a `partialFilterExpression` on `table`. */
function compilePartialFilter(
  state: CollectionState,
  filter: Record<string, unknown>,
  table: TableDescriptor,
  where: string,
): string {
  const conditions: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and') {
      if (!Array.isArray(value)) {
        throw new SchemaGenerationError(`${where}: $and takes an array`);
      }
      for (const part of value) {
        conditions.push(compilePartialFilter(state, part as Record<string, unknown>, table, where));
      }
      continue;
    }
    if (key.startsWith('$')) {
      throw new SchemaGenerationError(`${where}: unsupported partial filter operator ${key}`);
    }
    const resolved = resolvePath(state, key, where);
    if (resolved.table !== table) {
      throw new SchemaGenerationError(
        `${where}: the partial filter path "${key}" is not on the indexed table ${table.name}`,
      );
    }
    const operators = isOperatorObject(value) ? value : { $eq: value };
    for (const [operator, operand] of Object.entries(operators)) {
      conditions.push(compileCondition(resolved, operator, operand, `${where} ${key}`));
    }
  }
  if (conditions.length === 0) {
    throw new SchemaGenerationError(`${where}: empty partial filter`);
  }
  return conditions.length === 1 ? conditions[0] : conditions.map((c) => `(${c})`).join(' AND ');
}

function compileCondition(
  resolved: ResolvedPath,
  operator: string,
  operand: unknown,
  where: string,
): string {
  if (operator === '$exists') {
    if (operand !== true) {
      throw new SchemaGenerationError(
        `${where}: only $exists: true is supported in partial filters`,
      );
    }
    return presenceCondition(resolved, where);
  }
  const field = resolved.field;
  if (resolved.jsonSubpath !== undefined || field.kind !== 'scalar') {
    throw new SchemaGenerationError(
      `${where}: ${operator} in a partial filter needs a scalar column (found ${resolved.jsonSubpath !== undefined ? 'a Mixed subpath' : field.kind})`,
    );
  }
  const column = quoteIdentifier(field.column);
  switch (operator) {
    case '$eq':
      return operand === null
        ? `${column} IS NULL`
        : `${column} = ${scalarLiteral(operand, field.type, where)}`;
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte': {
      const sqlOperator = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[operator];
      return `${column} ${sqlOperator} ${scalarLiteral(operand, field.type, where)}`;
    }
    case '$type': {
      const types = typeof operand === 'string' ? TYPE_ALIASES[operand] : undefined;
      if (!types) {
        throw new SchemaGenerationError(`${where}: unsupported $type ${String(operand)}`);
      }
      if (!types.includes(field.type)) {
        throw new SchemaGenerationError(
          `${where}: $type ${String(operand)} never matches the ${field.type} column ${field.column}`,
        );
      }
      return `${column} IS NOT NULL`;
    }
    default:
      throw new SchemaGenerationError(`${where}: unsupported partial filter operator ${operator}`);
  }
}

/** The SQL index(es) one MongoDB index maps to. */
function mapIndex(state: CollectionState, index: SourceIndex): PendingIndex[] {
  const collection = state.source.collection;
  const fields: Array<[string, 1 | -1]> = index.fields.map(([path, direction]) => {
    if (direction !== 1 && direction !== -1) {
      throw new SchemaGenerationError(
        `${collection} index ${JSON.stringify(Object.fromEntries(index.fields))}: unsupported key type ${String(direction)}`,
      );
    }
    return [path, direction];
  });
  const options = index.options;
  const mongoName =
    typeof options.name === 'string' ? options.name : defaultMongoIndexName(index.fields);
  const where = `${collection} index ${mongoName}`;
  if (options.collation !== undefined) {
    throw new SchemaGenerationError(`${where}: collations are not supported`);
  }
  for (const unsupported of [
    'weights',
    'default_language',
    '2dsphereIndexVersion',
    'wildcardProjection',
  ]) {
    if (options[unsupported] !== undefined) {
      throw new SchemaGenerationError(`${where}: unsupported index option ${unsupported}`);
    }
  }
  const unique = options.unique === true;
  const sparse = options.sparse === true;
  const partial = options.partialFilterExpression as Record<string, unknown> | undefined;
  const expireAfterSeconds =
    typeof options.expireAfterSeconds === 'number' ? options.expireAfterSeconds : undefined;
  const source: IndexSourceDescriptor = {
    mongoName,
    fields,
    unique,
    sparse,
    ...(partial ? { partialFilterExpression: partial } : {}),
    ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}),
    ...(index.plugin ? { plugin: true as const } : {}),
  };

  /** Keys grouped by table and method: btree per table, one GIN per multikey key. */
  const btrees = new Map<
    TableDescriptor,
    { keys: IndexKeyDescriptor[]; resolved: ResolvedPath[] }
  >();
  const gins: Array<{ table: TableDescriptor; key: IndexKeyDescriptor; resolved: ResolvedPath }> =
    [];
  const addBtree = (table: TableDescriptor, key: IndexKeyDescriptor, resolved: ResolvedPath) => {
    const group = btrees.get(table) ?? { keys: [], resolved: [] };
    group.keys.push(key);
    group.resolved.push(resolved);
    btrees.set(table, group);
  };
  let multikey = false;

  for (const [path, direction] of fields) {
    const resolved = resolvePath(state, path, where);
    const { field, table } = resolved;
    if (table.kind === 'child') {
      multikey = true;
    }
    if (resolved.jsonSubpath !== undefined || field.kind === 'json') {
      if (field.kind !== 'json') {
        throw new SchemaGenerationError(`${where}: unexpected subpath of ${path}`);
      }
      if (resolved.jsonSubpath !== undefined && field.hints?.includes(resolved.jsonSubpath)) {
        addBtree(
          table,
          {
            path: `${resolved.relPath}.${resolved.jsonSubpath}`,
            direction,
            expression: jsonHintExpression(field.column, resolved.jsonSubpath),
          },
          resolved,
        );
      } else {
        multikey = true;
        gins.push({
          table,
          key: {
            path: field.path,
            direction: 1,
            expression: jsonbOf(field.column),
            opclass: 'jsonb_path_ops',
          },
          resolved,
        });
      }
      continue;
    }
    switch (field.kind) {
      case 'scalar':
        addBtree(table, { path: resolved.relPath, direction, column: field.column }, resolved);
        break;
      case 'array':
        multikey = true;
        gins.push({
          table,
          key: { path: resolved.relPath, direction: 1, column: field.column },
          resolved,
        });
        break;
      case 'elements': {
        multikey = true;
        const elementTable = state.tables.find((entry) => entry.name === field.table)!;
        addBtree(
          elementTable,
          { path: 'value', direction, column: 'value' },
          {
            ...resolved,
            table: elementTable,
            relPath: 'value',
          },
        );
        break;
      }
      case 'object':
      case 'children':
        throw new SchemaGenerationError(
          `${where}: an index key on the ${field.kind === 'object' ? 'object' : 'subdocument array'} path "${path}" is not supported`,
        );
    }
  }

  if (unique && multikey) {
    throw new SchemaGenerationError(
      `${where}: a unique index over an array, child or Mixed path (multikey uniqueness) has no PostgreSQL equivalent`,
    );
  }
  if (expireAfterSeconds !== undefined) {
    const resolved = fields.length === 1 ? resolvePath(state, fields[0][0], where) : undefined;
    if (
      !resolved ||
      resolved.table !== state.root ||
      resolved.jsonSubpath !== undefined ||
      resolved.field.kind !== 'scalar' ||
      resolved.field.type !== 'date'
    ) {
      throw new SchemaGenerationError(`${where}: a TTL index needs a single top-level Date key`);
    }
  }

  const pending: PendingIndex[] = [];
  const predicate = (table: TableDescriptor, resolvedKeys: ResolvedPath[]): string | undefined => {
    const parts: string[] = [];
    if (partial) {
      parts.push(compilePartialFilter(state, partial, table, where));
    }
    if (sparse && table.kind !== 'element') {
      const presence = resolvedKeys.map((resolved) => presenceCondition(resolved, where));
      parts.push(presence.length === 1 ? presence[0] : `(${presence.join(' OR ')})`);
    }
    if (parts.length === 0) return undefined;
    return parts.length === 1 ? parts[0] : parts.map((part) => `(${part})`).join(' AND ');
  };
  const keyName = (key: IndexKeyDescriptor): string =>
    key.path.split('.').join('_') + (key.direction === -1 ? '_desc' : '');
  const push = (
    table: TableDescriptor,
    method: 'btree' | 'gin',
    keys: IndexKeyDescriptor[],
    resolvedKeys: ResolvedPath[],
  ) => {
    const sqlWhere = predicate(table, resolvedKeys);
    const definition = JSON.stringify({ table: table.name, method, keys, unique, where: sqlWhere });
    const baseName =
      `${table.name}__${keys.map(keyName).join('__')}` +
      (method === 'gin' ? '__gin' : '') +
      (sqlWhere ? '__p' : '');
    const ttl =
      expireAfterSeconds !== undefined
        ? {
            column: keys[0].column!,
            path: keys[0].path,
            expireAfterSeconds,
            mongoName,
          }
        : undefined;
    pending.push({
      table,
      method,
      keys,
      unique,
      ...(sqlWhere ? { where: sqlWhere } : {}),
      sources: [source],
      ...(ttl ? { ttl } : {}),
      baseName,
      definition,
    });
  };
  for (const [table, group] of btrees) {
    push(table, 'btree', group.keys, group.resolved);
  }
  for (const gin of gins) {
    push(gin.table, 'gin', [gin.key], [gin.resolved]);
  }
  return pending;
}

/** Merges identical SQL indexes, settles every name (hashing collisions), attaches them. */
function settleIndexes(pending: PendingIndex[], relations: IdentifierRegistry): void {
  const byDefinition = new Map<string, PendingIndex>();
  const unique: PendingIndex[] = [];
  for (const index of pending) {
    const existing = byDefinition.get(index.definition);
    if (existing) {
      existing.sources.push(...index.sources);
      if (index.ttl && !existing.ttl) existing.ttl = index.ttl;
      continue;
    }
    byDefinition.set(index.definition, index);
    unique.push(index);
  }
  const candidates = new Map<string, PendingIndex[]>();
  for (const index of unique) {
    const candidate = shortenIdentifier(index.baseName);
    candidates.set(candidate, [...(candidates.get(candidate) ?? []), index]);
  }
  for (const [candidate, group] of candidates) {
    const collides = group.length > 1 || relations.has(candidate);
    for (const index of group) {
      const name = collides
        ? shortenIdentifier(`${index.baseName}_${shortHash(index.definition)}`)
        : candidate;
      relations.register(
        name,
        `the index ${index.sources[0].mongoName} of ${index.table.collection}`,
      );
      const descriptor: IndexDescriptor = {
        name,
        table: index.table.name,
        method: index.method,
        keys: index.keys,
        unique: index.unique,
        ...(index.where ? { where: index.where } : {}),
        sources: index.sources,
      };
      index.table.indexes.push(descriptor);
      if (index.ttl) {
        index.table.ttl.push({
          column: index.ttl.column,
          path: index.ttl.path,
          expireAfterSeconds: index.ttl.expireAfterSeconds,
          ...(index.where ? { where: index.where } : {}),
          index: name,
          mongoName: index.ttl.mongoName,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Entry point                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * The schema descriptor of `sources` under `overrides`: tables in source order (each followed
 * by its child and element tables), their columns, path trees, checks, indexes and TTL rules.
 * Throws a {@link SchemaGenerationError} on an unsupported shape, a naming collision, or an
 * override matching nothing.
 */
export function buildSchemaDescriptor(
  sources: readonly CollectionSource[],
  overrides: SchemaOverrides = NO_SCHEMA_OVERRIDES,
): SchemaDescriptor {
  const collections = new Set<string>();
  for (const source of sources) {
    if (collections.has(source.collection)) {
      throw new SchemaGenerationError(`collection "${source.collection}" is declared twice`);
    }
    collections.add(source.collection);
  }
  const targets = [
    ...overrides.columnTypes,
    ...overrides.jsonHints,
    ...overrides.elementTables,
    ...overrides.pluginPaths,
    ...overrides.largeTables.collections.map((collection) => ({ collection })),
  ];
  for (const target of targets) {
    if (!collections.has(target.collection)) {
      throw new SchemaGenerationError(
        `stale override: collection "${target.collection}" is not among the schemas`,
      );
    }
  }

  const relations = new IdentifierRegistry('schema relations');
  const states = sources.map((source) =>
    new CollectionBuilder(source, overridesFor(overrides, source.collection), relations).build(),
  );
  const pending = states.flatMap((state) =>
    state.source.indexes.flatMap((index) => mapIndex(state, index)),
  );
  settleIndexes(pending, relations);

  for (const state of states) {
    for (const table of state.tables) {
      const constraints = new IdentifierRegistry(`table "${table.name}" constraints`);
      constraints.register(shortenIdentifier(`${table.name}__pkey`), 'the primary key');
      if (table.parent) {
        constraints.register(shortenIdentifier(`${table.name}__parent_fkey`), 'the parent key');
      }
      for (const check of table.checks) {
        constraints.register(check.name, `the hint check of ${check.column}.${check.path}`);
      }
    }
  }
  return { version: 1, tables: states.flatMap((state) => state.tables) };
}

/** The table named `name` of `descriptor`. */
export function getTable(descriptor: SchemaDescriptor, name: string): TableDescriptor | undefined {
  return descriptor.tables.find((table) => table.name === name);
}

/** The primary key constraint name of a table. */
export function primaryKeyName(table: Pick<TableDescriptor, 'name'>): string {
  return shortenIdentifier(`${table.name}__pkey`);
}

/** The parent foreign key constraint name of a child or element table. */
export function parentKeyName(table: Pick<TableDescriptor, 'name'>): string {
  return shortenIdentifier(`${table.name}__parent_fkey`);
}

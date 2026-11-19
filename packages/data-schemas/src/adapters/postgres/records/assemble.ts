/**
 * Rows → record (docs/postgres-port/PHASE4.md §3.1): the select list that reads a record of a
 * collection, and the decoder turning the selected row back into the record a lean MongoDB read
 * returns. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - **One statement per read.** The parent's columns are selected, and each projected child or
 *   element table is a correlated subselect aggregating its rows with `json_agg(json_build_array
 *   (...) ORDER BY _ord)`, guarded by the parent's element-count column so empty arrays (most rows)
 *   skip it. With `children: 'batched'` (streaming and keyset readers, which hold a batch of
 *   parents) the child tables are read instead by {@link readChildRows}, one query per child table
 *   for the whole batch (`WHERE _parent = ANY ($1) ORDER BY _parent, _ord`).
 * - **Values** are decoded per the descriptor: `json` text through the tag reviver (key order
 *   kept), `bytea`, dates (inside `json_agg` they travel as epoch milliseconds, exact for the
 *   millisecond precision written), `lc_object_id[]` selected as `text[]` (`pg` leaves arrays of a
 *   domain unparsed), `NaN`/`Infinity` read back from their JSON spelling.
 * - **Nulls and shapes:** a `NULL` column is omitted unless its path is listed in `_nulls`, which
 *   gives `null`; an object is present when its shape column is `true`; an array stored in a child
 *   or element table is present when its count is not `NULL`.
 * - **Key order** matches what MongoDB returns for a document mongoose built with every path set
 *   (`new Model(doc).toObject()` saved and read back): `_id` first (the server moves it to the
 *   front), then the declared paths in `schema.paths` order (timestamps and plugin paths after the
 *   declared fields, as the schema holds them), then the version key (added last on insert), then
 *   the `_extra` keys (D7). Objects and child elements keep their schema's order (a subdocument's
 *   `_id` last, as its schema holds it); `json` contents keep the order they were written in. A
 *   field MongoDB would place elsewhere (a default applied after the given fields, or a path
 *   added later by `$set`) is in schema order here (R7).
 * - **Projection** ({@link RecordProjection}): only the columns and child tables a projection
 *   needs are selected; paths hidden by the schema (`select: false`) are left out unless named.
 */
import type { ColumnDescriptor, FieldDescriptor } from '../schema/descriptor';
import type { RecordTable, RecordTables } from './tables';
import type { ExtraValues } from './extra';
import {
  decodeJsonColumn,
  fromByteaColumn,
  fromTimestampColumn,
  reviveTaggedJson,
} from '../values';
import { decodeExtraColumn, mergeExtra } from './extra';
import { quoteIdentifier } from '../schema/naming';
import { StoreQueryError } from '~/ports/query';
import { fromNullsColumn } from './nulls';
import { lastSegment } from './tables';

/* ------------------------------------------------------------------------------------------ */
/* Projection                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Which paths a read returns (the query translator maps a `StoreProjection` onto it). Paths are
 * dotted paths of the records, at any depth (a path inside an array of subdocuments names that
 * path of every element).
 *
 * - neither `include` nor `exclude`: every path the schema does not hide, and every `_extra` key;
 * - `include`: only those paths (with what is under them), and `_id` unless `exclude` names it;
 * - `exclude`: every path but those;
 * - `includeHidden`: hidden paths to return as well (`+path`); in an inclusion they are included.
 *
 * A hidden path is returned only when it, a path under it or a path above it is named in `include`
 * or `includeHidden`.
 */
export interface RecordProjection {
  include?: readonly string[];
  exclude?: readonly string[];
  includeHidden?: readonly string[];
}

/** The state of one path under a projection. */
export type PathSelection = 'whole' | 'partial' | 'none';

/** A projection resolved against one table's rows (a child table's: its elements). */
class ProjectionPlan {
  private constructor(
    private readonly mode: 'all' | 'include' | 'exclude',
    private readonly include: readonly string[],
    private readonly exclude: readonly string[],
    private readonly named: readonly string[],
    private readonly root: boolean,
  ) {}

  static of(projection: RecordProjection = {}): ProjectionPlan {
    const includeHidden = projection.includeHidden ?? [];
    const include = projection.include ?? [];
    const exclude = projection.exclude ?? [];
    const nonId = exclude.filter((path) => path !== '_id');
    let mode: 'all' | 'include' | 'exclude' = 'all';
    if (include.length > 0) {
      mode = 'include';
    } else if (exclude.length > 0) {
      mode = 'exclude';
    }
    if (mode === 'include' && nonId.length > 0) {
      throw new StoreQueryError('A projection cannot mix inclusion and exclusion (except _id)');
    }
    return new ProjectionPlan(
      mode,
      mode === 'include' ? [...include, ...includeHidden] : [],
      exclude,
      [...include, ...includeHidden],
      true,
    );
  }

  /** The state of `path` (relative to this plan's rows), the schema's hiding ignored. */
  state(path: string): PathSelection {
    if (this.root && path === '_id') {
      return this.exclude.includes('_id') ? 'none' : 'whole';
    }
    switch (this.mode) {
      case 'all':
        return 'whole';
      case 'include':
        if (this.include.some((entry) => covers(entry, path))) return 'whole';
        if (this.include.some((entry) => covers(path, entry))) return 'partial';
        return 'none';
      case 'exclude':
        if (this.exclude.some((entry) => covers(entry, path))) return 'none';
        if (this.exclude.some((entry) => covers(path, entry))) return 'partial';
        return 'whole';
    }
  }

  /** Whether a hidden path is named (itself, above or below it). */
  names(path: string): boolean {
    return this.named.some((entry) => covers(entry, path) || covers(path, entry));
  }

  /** The plan of the elements of the array at `path`, whose state is `state`. */
  child(path: string, state: PathSelection): ProjectionPlan {
    const strip = (entries: readonly string[]) =>
      entries
        .filter((entry) => entry.startsWith(`${path}.`))
        .map((entry) => entry.slice(path.length + 1));
    const named = strip(this.named);
    if (state === 'whole') {
      return new ProjectionPlan('all', [], [], named, false);
    }
    return new ProjectionPlan(this.mode, strip(this.include), strip(this.exclude), named, false);
  }
}

/** Whether `ancestor` is `path` or one of the paths above it. */
function covers(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/* ------------------------------------------------------------------------------------------ */
/* Column values                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** Decodes a value as `pg` returned it for a column (the backend pool reads `json` as text). */
function decodeTyped(column: ColumnDescriptor, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (column.type) {
    case 'json':
      return decodeJsonColumn(value);
    case 'jsonb':
      return decodeExtraColumn(value);
    case 'buffer':
      return column.array
        ? (value as unknown[]).map((item) => fromByteaColumn(item))
        : fromByteaColumn(value);
    case 'date':
      return column.array
        ? (value as unknown[]).map((item) => fromTimestampColumn(item))
        : fromTimestampColumn(value);
    default:
      return value;
  }
}

const JSON_NUMBERS: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
};

/** Decodes one scalar of `type` from its JSON form inside a `json_agg` result. */
function decodeJsonScalar(type: ColumnDescriptor['type'], value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (type) {
    case 'number':
      return typeof value === 'string' ? (JSON_NUMBERS[value] ?? Number(value)) : value;
    case 'date':
      return new Date(Number(value));
    case 'buffer':
      return fromByteaColumn(value);
    case 'json':
      return reviveTaggedJson(value);
    case 'jsonb':
      return decodeExtraColumn(value, { parsed: true });
    default:
      return value;
  }
}

/** Decodes a column's value from its JSON form inside a `json_agg` result. */
function decodeJson(column: ColumnDescriptor, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.array) {
    return (value as unknown[]).map((item) => decodeJsonScalar(column.type, item));
  }
  return decodeJsonScalar(column.type, value);
}

/** The select expression of a column of `alias` (pg-typed reads). */
function typedExpression(alias: string, column: ColumnDescriptor): string {
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(column.name)}`;
  return column.array && column.type === 'objectId' ? `${ref}::text[]` : ref;
}

/** The expression of a column inside `json_build_array` (decoded by {@link decodeJson}). */
function jsonExpression(alias: string, column: ColumnDescriptor): string {
  const ref = `${quoteIdentifier(alias)}.${quoteIdentifier(column.name)}`;
  if (column.type === 'date') {
    if (!column.array) {
      return `(extract(epoch FROM ${ref}) * 1000)`;
    }
    return (
      `CASE WHEN ${ref} IS NULL THEN NULL ELSE (SELECT coalesce(json_agg(extract(epoch FROM u.e) * 1000 ` +
      `ORDER BY u.o), '[]'::json) FROM unnest(${ref}) WITH ORDINALITY AS u (e, o)) END`
    );
  }
  if (column.array && column.type === 'objectId') {
    return `${ref}::text[]`;
  }
  return ref;
}

/** `json_build_array` takes at most 100 arguments; wider rows are built in chunks of this size. */
const JSON_ARRAY_CHUNK = 90;

function jsonBuildArray(expressions: readonly string[]): { sql: string; chunked: boolean } {
  if (expressions.length <= JSON_ARRAY_CHUNK) {
    return { sql: `json_build_array(${expressions.join(', ')})`, chunked: false };
  }
  const chunks: string[] = [];
  for (let start = 0; start < expressions.length; start += JSON_ARRAY_CHUNK) {
    chunks.push(
      `json_build_array(${expressions.slice(start, start + JSON_ARRAY_CHUNK).join(', ')})`,
    );
  }
  if (chunks.length > JSON_ARRAY_CHUNK) {
    throw new StoreQueryError('A child table is too wide to aggregate');
  }
  return { sql: `json_build_array(${chunks.join(', ')})`, chunked: true };
}

/* ------------------------------------------------------------------------------------------ */
/* Selection                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** How child and element tables are read. */
export type ChildReadMode = 'subselect' | 'batched';

/** Options of {@link selectRecord}. */
export interface SelectRecordOptions {
  /** The alias of the parent table in the query (default `t`). */
  alias?: string;
  projection?: RecordProjection;
  /** Subselects in the parent's select list (default), or {@link readChildRows} per batch. */
  children?: ChildReadMode;
}

/** The read of one child or element table. */
export interface ChildSelect {
  /** The alias of its subselect in the select list (`subselect` mode). */
  readonly key: string;
  readonly table: RecordTable;
  /** The columns read, in order. */
  readonly columns: readonly ColumnDescriptor[];
  /** The rows of each parent (`batched` mode): `SELECT _parent, <columns> ... ORDER BY _parent, _ord`. */
  readonly batchSql: string;
  /** The `json_build_array` of one row (`subselect` mode), over the alias `key`. */
  readonly jsonSql: string;
  /** Whether `jsonSql` nests chunks of columns (rows wider than `json_build_array` takes). */
  readonly chunked: boolean;
  /** The position of each column in `columns`. */
  readonly positions: ReadonlyMap<string, number>;
  readonly plan: ProjectionPlan;
  readonly field: Extract<FieldDescriptor, { kind: 'children' | 'elements' }>;
}

/** Child rows read for a batch of parents ({@link readChildRows}): per child key, per parent id. */
export type ChildRowBatch = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>
>;

/** A record read: the select list and the decoder of its rows. */
export interface RecordSelect {
  readonly table: RecordTable;
  readonly alias: string;
  /** The select list, for `SELECT <sql> FROM <table> AS <alias> ...`. */
  readonly sql: string;
  /** The parent columns selected (by alias = column name). */
  readonly columns: readonly ColumnDescriptor[];
  /** The child and element tables read. */
  readonly children: readonly ChildSelect[];
  readonly mode: ChildReadMode;
  /** The record of a selected row (`batch`: the child rows in `batched` mode). */
  decode(row: Record<string, unknown>, batch?: ChildRowBatch): Record<string, unknown>;
}

/** The node selection of a field: none, or whole or partial (objects). */
function fieldSelection(
  table: RecordTable,
  plan: ProjectionPlan,
  field: FieldDescriptor,
): PathSelection {
  if (table.hidden.has(field.path) && !plan.names(field.path)) {
    return 'none';
  }
  if (field.kind === 'object') {
    for (const hidden of table.hidden) {
      if (hidden.startsWith(`${field.path}.`)) {
        const state = plan.state(field.path);
        return state === 'none' ? 'none' : 'partial';
      }
    }
  }
  return plan.state(field.path);
}

interface TableRead {
  columns: ColumnDescriptor[];
  children: ChildSelect[];
}

/** Collects the columns and child tables `fields` need under `plan`. */
function collectReads(
  tables: RecordTables,
  table: RecordTable,
  plan: ProjectionPlan,
  fields: readonly FieldDescriptor[],
  read: TableRead,
  childAlias: () => string,
): void {
  const column = (name: string) => {
    const descriptor = table.columns.get(name);
    if (descriptor && !read.columns.includes(descriptor)) {
      read.columns.push(descriptor);
    }
  };
  for (const field of fields) {
    const state = fieldSelection(table, plan, field);
    if (state === 'none') {
      continue;
    }
    column(field.column);
    if (field.kind === 'object') {
      collectReads(tables, table, plan, field.fields, read, childAlias);
    } else if (field.kind === 'children' || field.kind === 'elements') {
      const child = tables.table(field.table);
      const childPlan = plan.child(field.path, state);
      const childRead: TableRead = { columns: [], children: [] };
      if (field.kind === 'elements') {
        childRead.columns.push(child.columns.get('value')!);
      } else {
        collectReads(tables, child, childPlan, child.descriptor.fields, childRead, childAlias);
        for (const name of ['_nulls', '_extra']) {
          const system = child.columns.get(name);
          if (system) childRead.columns.push(system);
        }
      }
      const inner = childAlias();
      const built = jsonBuildArray(childRead.columns.map((c) => jsonExpression(inner, c)));
      read.children.push({
        key: inner,
        table: child,
        columns: childRead.columns,
        jsonSql: built.sql,
        chunked: built.chunked,
        positions: new Map(childRead.columns.map((c, index) => [c.name, index])),
        plan: childPlan,
        field,
        batchSql:
          `SELECT "_parent", ${childRead.columns.map((c) => `${typedExpression('c', c)} AS ${quoteIdentifier(c.name)}`).join(', ')} ` +
          `FROM ${quoteIdentifier(child.descriptor.name)} AS "c" WHERE "_parent" = ANY ($1) ORDER BY "_parent", "_ord"`,
      });
    }
  }
}

/**
 * The read of `collection`'s records (see the module header): the select list over the parent
 * table aliased `alias`, and the decoder of the rows it gives.
 */
export function selectRecord(
  tables: RecordTables,
  collection: string,
  options: SelectRecordOptions = {},
): RecordSelect {
  const table = tables.collection(collection);
  const alias = options.alias ?? 't';
  const mode = options.children ?? 'subselect';
  const plan = ProjectionPlan.of(options.projection);
  const read: TableRead = { columns: [], children: [] };
  let counter = 0;
  const childAlias = () => `_child_${counter++}`;
  const idColumn = table.columns.get('_id');
  if (idColumn) {
    read.columns.push(idColumn);
  }
  collectReads(tables, table, plan, table.descriptor.fields, read, childAlias);
  for (const name of ['_nulls', '_extra']) {
    const system = table.columns.get(name);
    if (system) read.columns.push(system);
  }
  for (const child of read.children) {
    if (table.columns.has(child.key)) {
      throw new StoreQueryError(`The column "${child.key}" collides with a child read alias`);
    }
  }
  const items = read.columns.map(
    (column) => `${typedExpression(alias, column)} AS ${quoteIdentifier(column.name)}`,
  );
  if (mode === 'subselect') {
    const parent = quoteIdentifier(alias);
    for (const child of read.children) {
      const inner = quoteIdentifier(child.key);
      items.push(
        `CASE WHEN ${parent}.${quoteIdentifier(child.field.column)} > 0 THEN ` +
          `(SELECT json_agg(${child.jsonSql} ORDER BY ${inner}."_ord") ` +
          `FROM ${quoteIdentifier(child.table.descriptor.name)} AS ${inner} ` +
          `WHERE ${inner}."_parent" = ${parent}."_id") END AS ${inner}`,
      );
    }
  }
  const select: RecordSelect = {
    table,
    alias,
    sql: items.join(', '),
    columns: read.columns,
    children: read.children,
    mode,
    decode: (row, batch) => decodeRecord(tables, table, plan, read, row, mode, batch),
  };
  return select;
}

/** The record of a selected parent row. */
function decodeRecord(
  tables: RecordTables,
  table: RecordTable,
  plan: ProjectionPlan,
  read: TableRead,
  row: Record<string, unknown>,
  mode: ChildReadMode,
  batch: ChildRowBatch | undefined,
): Record<string, unknown> {
  const id = row._id as string | undefined;
  const childrenOf = (
    child: ChildSelect,
  ): Array<Record<string, unknown>> | unknown[] | undefined => {
    if (mode === 'subselect') {
      const value = row[child.key];
      if (value === null || value === undefined) return undefined;
      const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as unknown[];
      return child.chunked ? parsed.map((chunks) => (chunks as unknown[][]).flat()) : parsed;
    }
    return id === undefined
      ? undefined
      : (batch?.get(child.key)?.get(id) as Array<Record<string, unknown>> | undefined);
  };
  const record: Record<string, unknown> = {};
  if (row._id !== undefined && plan.state('_id') !== 'none') {
    record._id = row._id;
  }
  const getter = (name: string) => decodeTyped(table.columns.get(name)!, row[name]);
  buildRow(
    tables,
    table,
    plan,
    read.children,
    getter,
    childrenOf,
    mode === 'subselect' ? 'json' : 'typed',
    record,
  );
  return record;
}

/** Fills `target` with the declared fields of a row, then the version key, then `_extra`. */
function buildRow(
  tables: RecordTables,
  table: RecordTable,
  plan: ProjectionPlan,
  children: readonly ChildSelect[],
  get: (column: string) => unknown,
  childrenOf: (child: ChildSelect) => unknown[] | undefined,
  childSource: 'json' | 'typed',
  target: Record<string, unknown>,
): void {
  const nulls = table.systemColumns ? fromNullsColumn(get('_nulls')) : new Set<string>();
  let version: FieldDescriptor | undefined;
  const fill = (fields: readonly FieldDescriptor[], into: Record<string, unknown>) => {
    for (const field of fields) {
      if (field.kind === 'scalar' && field.system === 'id') {
        continue;
      }
      if (field.kind === 'scalar' && field.system === 'version') {
        version = field;
        continue;
      }
      const state = fieldSelection(table, plan, field);
      if (state === 'none') {
        continue;
      }
      const name = lastSegment(field.path);
      const value = get(field.column);
      if (value === null) {
        if (nulls.has(field.path)) {
          into[name] = null;
        }
        continue;
      }
      switch (field.kind) {
        case 'object': {
          const object: Record<string, unknown> = {};
          fill(field.fields, object);
          into[name] = object;
          break;
        }
        case 'children':
        case 'elements': {
          const child = children.find((entry) => entry.field === field);
          const rows = (child && childrenOf(child)) ?? [];
          into[name] = child
            ? rows.map((item) => decodeChild(tables, child, item, childSource))
            : [];
          break;
        }
        default:
          into[name] = value;
      }
    }
  };
  fill(table.descriptor.fields, target);
  if (version && fieldSelection(table, plan, version) !== 'none') {
    const value = get(version.column);
    if (value !== null) {
      target[lastSegment(version.path)] = value;
    } else if (nulls.has(version.path)) {
      target[lastSegment(version.path)] = null;
    }
  }
  if (table.systemColumns) {
    const extra = get('_extra') as ExtraValues | null;
    mergeExtra(target, extra, (path) => {
      const field = table.fields.get(path);
      if (field && table.hidden.has(path) && !plan.names(path)) {
        return 'none';
      }
      return plan.state(path);
    });
  }
}

/** One element of a child or element table, from its JSON array or its typed row. */
function decodeChild(
  tables: RecordTables,
  child: ChildSelect,
  item: unknown,
  source: 'json' | 'typed',
): unknown {
  const get =
    source === 'json'
      ? (name: string) => {
          const index = child.positions.get(name);
          return index === undefined
            ? null
            : decodeJson(child.columns[index], (item as unknown[])[index]);
        }
      : (name: string) =>
          decodeTyped(child.table.columns.get(name)!, (item as Record<string, unknown>)[name]);
  if (child.field.kind === 'elements') {
    return get('value');
  }
  const element: Record<string, unknown> = {};
  buildRow(tables, child.table, child.plan, [], get, () => undefined, source, element);
  return element;
}

/* ------------------------------------------------------------------------------------------ */
/* Execution                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** Anything that runs a parameterized query the way `pg`'s `Pool` and `PoolClient` do. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Reads the child and element rows of a batch of parents for a `batched` selection: one query
 * per child table (`WHERE _parent = ANY ($1) ORDER BY _parent, _ord`).
 */
export async function readChildRows(
  queryable: Queryable,
  select: RecordSelect,
  parentIds: readonly string[],
): Promise<ChildRowBatch> {
  const batch = new Map<string, Map<string, Array<Record<string, unknown>>>>();
  if (parentIds.length === 0) {
    return batch;
  }
  for (const child of select.children) {
    const { rows } = await queryable.query(child.batchSql, [parentIds]);
    const byParent = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const parent = row._parent as string;
      const list = byParent.get(parent) ?? [];
      list.push(row);
      byParent.set(parent, list);
    }
    batch.set(child.key, byParent);
  }
  return batch;
}

/** Options of {@link readRecords}. */
export interface ReadRecordsOptions extends SelectRecordOptions {
  /** An SQL condition on the parent alias (`t` unless `alias` says otherwise). */
  where?: string;
  /** The parameters `where` refers to (`$1`, ...). */
  values?: unknown[];
  /** An SQL `ORDER BY` list. */
  orderBy?: string;
  limit?: number;
}

/** Reads the records of `collection` matching `where` (for specs, raw reads and simple lookups). */
export async function readRecords(
  queryable: Queryable,
  tables: RecordTables,
  collection: string,
  options: ReadRecordsOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const select = selectRecord(tables, collection, options);
  const alias = quoteIdentifier(select.alias);
  const text =
    `SELECT ${select.sql} FROM ${quoteIdentifier(select.table.descriptor.name)} AS ${alias}` +
    (options.where ? ` WHERE ${options.where}` : '') +
    (options.orderBy ? ` ORDER BY ${options.orderBy}` : '') +
    (options.limit !== undefined ? ` LIMIT ${Math.floor(options.limit)}` : '');
  const { rows } = await queryable.query(text, options.values ?? []);
  if (select.mode === 'batched') {
    const batch = await readChildRows(
      queryable,
      select,
      rows.map((row) => row._id as string),
    );
    return rows.map((row) => select.decode(row, batch));
  }
  return rows.map((row) => select.decode(row));
}

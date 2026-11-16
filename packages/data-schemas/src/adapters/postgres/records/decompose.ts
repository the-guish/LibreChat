/**
 * Document → rows (docs/postgres-port/PHASE4.md §1.2, §3.2): a record of a collection decomposed
 * into its parent row, the rows of its child tables (arrays of subdocuments) and element tables
 * (scalar arrays stored as rows), with the shape columns, `_nulls` and `_extra` filled. Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * Two modes:
 * - `document` (default): the record was built by the schema engine (`schema/engine.ts`, D2), so
 *   every declared value already has its type. A value that does not fit its column is a bug and
 *   throws a `StoreQueryError`; undeclared keys (a record computed in JavaScript from an assembled
 *   one, which carries its `_extra` keys) go back to `_extra`.
 * - `raw` (the e2e facade, contract `seedRaw`, the copy tool): no defaults or validators, like a
 *   driver insert. Declared values are cast by the descriptor caster without setters (`rawValues:
 *   'cast'`, as `Model.castObject` does for MongoDB's `seedRaw`) or must already have their type
 *   (`'exact'`, the copy tool); a value that does not fit goes whole to `_extra` under its path,
 *   and so do undeclared keys and child arrays holding a non-object or null element (D7). Every
 *   such value is reported in `diverted`.
 *
 * Storage rules: a scalar `null` lists its path in `_nulls` and leaves its column `NULL`; an object
 * sets its shape column (`true`, even when empty) and its leaves; an array of subdocuments sets its
 * element-count column and gives one child row per element (`_ord` 0, 1, ...); a scalar array is a
 * `T[]` column (or an element table with a count column); `Mixed`, arrays of `Mixed` and `Map`s
 * are `json` text in the tagged encoding (`values.ts`). U+0000 becomes U+FFFD in every string
 * written (D8), counted unless `countNul: false`. Numbers keep `-0` (sent as the text `-0`).
 */
import type { FieldDescriptor, ScalarType } from '../schema/descriptor';
import type { RecordTable, RecordTables } from './tables';
import type { ExtraValues } from './extra';
import {
  isIdValue,
  replaceNul,
  toIdColumn,
  isBinaryValue,
  toByteaColumn,
  encodeJsonColumn,
  toTimestampColumn,
} from '../values';
import { encodeExtraColumn, isPlainRecord, setExtraValue } from './extra';
import { quoteIdentifier } from '../schema/naming';
import { StoreQueryError } from '~/ports/query';
import { toNullsColumn } from './nulls';
import { lastSegment } from './tables';
import { castScalar } from './cast';

/** How values are taken: built by the schema engine, or raw. */
export type DecomposeMode = 'document' | 'raw';

/** Options of {@link decomposeRecord}. */
export interface DecomposeOptions {
  mode?: DecomposeMode;
  /** Raw mode: cast declared values (default) or require their exact type (the copy tool). */
  rawValues?: 'cast' | 'exact';
  /** Count U+0000 replacements (default true). */
  countNul?: boolean;
}

/** A value raw mode moved to `_extra`. */
export interface DivertedValue {
  /** The table whose `_extra` holds it. */
  table: string;
  /** Its path, relative to that table's row. */
  path: string;
  reason: 'undeclared' | 'misfit';
}

/** The rows of one child or element table. */
export interface ChildRows {
  table: string;
  /** The array's path in the collection's documents. */
  path: string;
  /** Rows keyed by column name (every column of the table). */
  rows: Array<Record<string, unknown>>;
}

/** A record decomposed into rows. */
export interface DecomposedRecord {
  /** The parent table. */
  table: string;
  /** The primary key value (`_id`), or `null` for a table keyed by its own columns. */
  id: string | null;
  /** The parent row: every column of the table, keyed by name (`NULL` columns as `null`). */
  row: Record<string, unknown>;
  /** The child and element tables with rows, in descriptor order. */
  children: ChildRows[];
  /** Every child and element table of the collection (those a replacement clears). */
  childTables: string[];
  /** Values raw mode moved to `_extra`. */
  diverted: DivertedValue[];
}

/** The marker of a value that does not fit its column. */
const MISFIT = Symbol('misfit');

interface Context {
  tables: RecordTables;
  mode: DecomposeMode;
  rawValues: 'cast' | 'exact';
  countNul: boolean;
  id: string | null;
  children: Map<string, ChildRows>;
  diverted: DivertedValue[];
}

/** One row being filled. */
class RowWriter {
  readonly row: Record<string, unknown> = {};
  readonly nulls: string[] = [];
  readonly extra: ExtraValues = {};

  constructor(readonly table: RecordTable) {
    for (const column of table.descriptor.columns) {
      this.row[column.name] = null;
    }
  }

  finish(countNul: boolean): Record<string, unknown> {
    if (this.table.systemColumns) {
      this.row._nulls = toNullsColumn(this.nulls);
      this.row._extra = encodeExtraColumn(this.extra, { countNul });
    }
    return this.row;
  }
}

/** A number as a parameter: `-0` is sent as text, which `pg` would otherwise send as `0`. */
function numberParameter(value: number): number | string {
  return Object.is(value, -0) ? '-0' : value;
}

/** Whether a string is 24 lowercase hex characters. */
const CANONICAL_ID = /^[0-9a-f]{24}$/;

/** The column value of a scalar of `type`, or {@link MISFIT}. */
function scalarValue(
  context: Context,
  type: ScalarType,
  value: unknown,
  path: string,
): unknown | typeof MISFIT {
  if (context.mode === 'raw' && context.rawValues === 'cast') {
    try {
      const cast = castScalar(type, value, { path, countNul: context.countNul });
      return typeof cast === 'number' ? numberParameter(cast) : cast;
    } catch (error) {
      if (error instanceof StoreQueryError) {
        return MISFIT;
      }
      throw error;
    }
  }
  const exact = context.mode === 'raw';
  switch (type) {
    case 'string':
      return typeof value === 'string' ? replaceNul(value, { countNul: context.countNul }) : MISFIT;
    case 'number':
      return typeof value === 'number' ? numberParameter(value) : MISFIT;
    case 'boolean':
      return typeof value === 'boolean' ? value : MISFIT;
    case 'date':
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return MISFIT;
      }
      try {
        return toTimestampColumn(value);
      } catch (error) {
        if (exact && error instanceof StoreQueryError) {
          return MISFIT;
        }
        throw error;
      }
    case 'objectId':
      if (typeof value === 'string') {
        return (exact ? CANONICAL_ID.test(value) : isIdValue(value)) ? toIdColumn(value) : MISFIT;
      }
      return isIdValue(value) ? toIdColumn(value) : MISFIT;
    case 'buffer':
      return isBinaryValue(value) ? toByteaColumn(value) : MISFIT;
    case 'objectIdOrString':
      if (typeof value === 'string') {
        return replaceNul(value, { countNul: context.countNul });
      }
      return typeof value === 'object' && isIdValue(value) ? toIdColumn(value) : MISFIT;
  }
}

/** Records a value that does not fit: thrown in document mode, moved to `_extra` in raw mode. */
function misfit(
  context: Context,
  writer: RowWriter,
  path: string,
  value: unknown,
  reason: DivertedValue['reason'],
  detail: string,
): void {
  if (context.mode === 'document' && reason === 'misfit') {
    throw new StoreQueryError(
      `Cannot store the value at "${path}" of ${writer.table.descriptor.name}: ${detail}`,
    );
  }
  if (!writer.table.systemColumns) {
    throw new StoreQueryError(
      `Cannot store the value at "${path}" of ${writer.table.descriptor.name}: ${detail} (the table has no _extra)`,
    );
  }
  setExtraValue(writer.extra, path.split('.'), value);
  context.diverted.push({ table: writer.table.descriptor.name, path, reason });
}

/** The entries of a `Map` value (a `Map` instance or a plain object), or `undefined`. */
function mapEntries(value: unknown): Array<[string, unknown]> | undefined {
  if (value instanceof Map) {
    return [...value.entries()].map(([key, item]) => [String(key), item]);
  }
  return isPlainRecord(value) ? Object.entries(value) : undefined;
}

/** Writes the declared `fields` of `source` (an object at `prefix` of the row) into `writer`. */
function writeObject(
  context: Context,
  writer: RowWriter,
  fields: readonly FieldDescriptor[],
  source: Record<string, unknown>,
  prefix: string,
): void {
  const declared = new Set<string>();
  for (const field of fields) {
    const name = lastSegment(field.path);
    declared.add(name);
    if (!Object.prototype.hasOwnProperty.call(source, name)) {
      continue;
    }
    const value = source[name];
    if (value === undefined) {
      continue;
    }
    writeField(context, writer, field, value);
  }
  for (const key of Object.keys(source)) {
    if (!declared.has(key) && source[key] !== undefined) {
      misfit(
        context,
        writer,
        prefix ? `${prefix}.${key}` : key,
        source[key],
        'undeclared',
        'undeclared',
      );
    }
  }
}

/** Writes one declared field of the row. */
function writeField(
  context: Context,
  writer: RowWriter,
  field: FieldDescriptor,
  value: unknown,
): void {
  const { path } = field;
  if (field.kind === 'scalar' && field.system === 'id') {
    return;
  }
  if (value === null) {
    if (writer.table.systemColumns) {
      writer.nulls.push(path);
    }
    return;
  }
  switch (field.kind) {
    case 'scalar': {
      if (field.system === 'version') {
        if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 2 ** 31) {
          writer.row[field.column] = value;
        } else {
          misfit(context, writer, path, value, 'misfit', 'the version key must be an integer');
        }
        return;
      }
      const cast = scalarValue(context, field.type, value, path);
      if (cast === MISFIT) {
        misfit(context, writer, path, value, 'misfit', `not a ${field.type}`);
      } else {
        writer.row[field.column] = cast;
      }
      return;
    }
    case 'array':
    case 'elements': {
      let list: unknown[] | undefined;
      if (Array.isArray(value)) {
        list = value;
      } else if (context.mode === 'raw' && context.rawValues === 'cast') {
        list = [value];
      }
      const cast = list?.map((item) =>
        item === null || item === undefined
          ? null
          : scalarValue(context, field.element, item, path),
      );
      if (!cast || cast.includes(MISFIT)) {
        misfit(context, writer, path, value, 'misfit', `not an array of ${field.element}`);
        return;
      }
      if (field.kind === 'array') {
        writer.row[field.column] = cast;
        return;
      }
      writer.row[field.column] = cast.length;
      addChildRows(
        context,
        field.table,
        cast.map((item, ord) => ({ _parent: context.id, _ord: ord, value: item })),
      );
      return;
    }
    case 'object':
      if (!isPlainRecord(value)) {
        misfit(context, writer, path, value, 'misfit', 'not an object');
        return;
      }
      writer.row[field.column] = true;
      writeObject(context, writer, field.fields, value, path);
      return;
    case 'children': {
      let list: unknown[] | undefined;
      if (Array.isArray(value)) {
        list = value;
      } else if (context.mode === 'raw' && context.rawValues === 'cast' && isPlainRecord(value)) {
        list = [value];
      }
      if (!list || !list.every((item) => isPlainRecord(item))) {
        misfit(
          context,
          writer,
          path,
          value,
          'misfit',
          'not an array of objects (null elements are refused)',
        );
        return;
      }
      const child = context.tables.table(field.table);
      writer.row[field.column] = list.length;
      addChildRows(
        context,
        field.table,
        list.map((item, ord) => {
          const childWriter = new RowWriter(child);
          childWriter.row._parent = context.id;
          childWriter.row._ord = ord;
          writeObject(
            context,
            childWriter,
            child.descriptor.fields,
            item as Record<string, unknown>,
            '',
          );
          return childWriter.finish(context.countNul);
        }),
      );
      return;
    }
    case 'json': {
      let stored: unknown = value;
      if (field.json === 'map') {
        const entries = mapEntries(value);
        if (!entries) {
          misfit(context, writer, path, value, 'misfit', 'not a Map');
          return;
        }
        const map: Record<string, unknown> = {};
        for (const [key, item] of entries) {
          if (item === undefined) continue;
          if (field.mapOf && field.mapOf !== 'mixed' && item !== null) {
            const cast = scalarValue(context, field.mapOf, item, `${path}.${key}`);
            if (cast === MISFIT) {
              misfit(context, writer, `${path}.${key}`, item, 'misfit', `not a ${field.mapOf}`);
              continue;
            }
            map[key] = typeof cast === 'string' && field.mapOf === 'number' ? Number(cast) : cast;
          } else {
            map[key] = item;
          }
        }
        stored = map;
      } else if (field.json === 'mixedArray' && !Array.isArray(value)) {
        if (context.mode === 'raw' && context.rawValues === 'cast') {
          stored = [value];
        } else {
          misfit(context, writer, path, value, 'misfit', 'not an array');
          return;
        }
      }
      try {
        writer.row[field.column] = encodeJsonColumn(stored, { countNul: context.countNul });
      } catch (error) {
        if (context.mode === 'raw' && error instanceof StoreQueryError) {
          misfit(context, writer, path, value, 'misfit', error.message);
          return;
        }
        throw error;
      }
      return;
    }
  }
}

function addChildRows(context: Context, table: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    return;
  }
  const descriptor = context.tables.table(table).descriptor;
  context.children.set(table, { table, path: descriptor.path!, rows });
}

/**
 * Decomposes `record`, a record of `collection`, into rows (see the module header). Throws a
 * `StoreQueryError` for a record without its primary key, and in document mode for a value that
 * does not fit its column.
 */
export function decomposeRecord(
  tables: RecordTables,
  collection: string,
  record: Record<string, unknown>,
  options: DecomposeOptions = {},
): DecomposedRecord {
  const root = tables.collection(collection);
  const descriptor = root.descriptor;
  if (!isPlainRecord(record)) {
    throw new StoreQueryError(`A ${collection} record must be an object`);
  }
  let id: string | null = null;
  if (descriptor.idType) {
    const raw = record._id;
    if (raw === undefined || raw === null) {
      throw new StoreQueryError(`A ${collection} record needs an _id`);
    }
    if (descriptor.idType === 'objectId') {
      if (!isIdValue(raw)) {
        throw new StoreQueryError(`The _id of a ${collection} record is not a valid id`);
      }
      id = toIdColumn(raw);
    } else {
      const cast =
        typeof raw !== 'string' && options.mode === 'raw' ? castScalar('string', raw) : raw;
      if (typeof cast !== 'string') {
        throw new StoreQueryError(`The _id of a ${collection} record must be a string`);
      }
      id = replaceNul(cast, { countNul: options.countNul ?? true });
    }
  }
  const context: Context = {
    tables,
    mode: options.mode ?? 'document',
    rawValues: options.rawValues ?? 'cast',
    countNul: options.countNul ?? true,
    id,
    children: new Map(),
    diverted: [],
  };
  const writer = new RowWriter(root);
  if (id !== null) {
    writer.row._id = id;
  }
  writeObject(context, writer, descriptor.fields, record, '');
  for (const key of descriptor.primaryKey) {
    if (writer.row[key] === null || writer.row[key] === undefined) {
      throw new StoreQueryError(`A ${collection} record needs its key "${key}"`);
    }
  }
  const childTables = tables.descriptor.tables
    .filter((table) => table.parent === descriptor.name)
    .map((table) => table.name);
  return {
    table: descriptor.name,
    id,
    row: writer.finish(context.countNul),
    children: childTables.flatMap((table) => {
      const rows = context.children.get(table);
      return rows ? [rows] : [];
    }),
    childTables,
    diverted: context.diverted,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Insert statements                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** A parameterized SQL statement, as `pg`'s `query(text, values)` takes it. */
export interface SqlStatement {
  text: string;
  values: unknown[];
}

/** PostgreSQL's limit on the parameters of one statement. */
const MAX_PARAMETERS = 65_535;

/** `INSERT` statements for `rows` of `table` (several when the parameters would not fit one). */
export function insertRowsStatements(
  tables: RecordTables,
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): SqlStatement[] {
  if (rows.length === 0) {
    return [];
  }
  const columns = tables.table(table).descriptor.columns.map((column) => column.name);
  const perStatement = Math.max(1, Math.floor(MAX_PARAMETERS / columns.length));
  const statements: SqlStatement[] = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    const batch = rows.slice(start, start + perStatement);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(row[column] ?? null);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    statements.push({
      text: `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    });
  }
  return statements;
}

/**
 * The statements inserting decomposed records: the parent rows of each table first, then the
 * child and element rows, so the parent keys exist. Run them in one transaction.
 */
export function insertStatements(
  tables: RecordTables,
  records: readonly DecomposedRecord[],
): SqlStatement[] {
  const byTable = new Map<string, Array<Record<string, unknown>>>();
  const add = (table: string, rows: ReadonlyArray<Record<string, unknown>>) => {
    const list = byTable.get(table) ?? [];
    list.push(...rows);
    byTable.set(table, list);
  };
  for (const record of records) {
    add(record.table, [record.row]);
  }
  for (const record of records) {
    for (const child of record.children) {
      add(child.table, child.rows);
    }
  }
  return [...byTable].flatMap(([table, rows]) => insertRowsStatements(tables, table, rows));
}

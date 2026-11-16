/**
 * Update planning for the collection primitive (docs/postgres-port/PHASE4.md §3.3): the checks
 * every update goes through, and the tier-1 compiler, which turns an update of parent-row columns
 * into one SQL `SET` list. Updates it cannot compile take tier 2 (read-modify-write in
 * `collection.ts`). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Tier 1 (parent rows; C2 adds child tables):
 * - scalar columns: `$set`, `$unset`, `$inc` (Number and `__v` columns; `lc_fail` on a stored
 *   `null`, as MongoDB refuses it), `$min`/`$max` (MongoDB's rules for a missing or `null` value);
 * - object paths (flattened, shape column) without child or element tables beneath: `$set` and
 *   `$unset` of the whole object (every column beneath, `_nulls` cleared beneath);
 * - `T[]` columns: `$set`, `$unset`, `$push` (`$each`), `$addToSet` (`$each`; first-occurrence
 *   order, existing duplicates kept), `$pull` of a value or `$in`, `$pullAll`;
 * - `json` columns assigned or unset as a whole;
 * - `$unset` of a path the schema does not declare (an `_extra` value, raw mode).
 * Writing into a missing object creates it (its shape column becomes `true`); writing through an
 * object stored as `null` fails (`lc_fail`), as MongoDB does. A declared path written also drops
 * any `_extra` value at that path (a raw-mode misfit it replaces).
 *
 * Everything else is tier 2: child and element tables, `json` subpaths, `$pull` by other
 * conditions, `$min`/`$max` with `null`, `_id`, undeclared `$set`, and operators on the wrong kind
 * of path (the evaluator then raises MongoDB's error).
 */
import type { ColumnDescriptor, FieldDescriptor } from '../schema/descriptor';
import type { RecordTable, RecordTables } from '../records/tables';
import type { ResolvedPath } from '../records/paths';
import type { SqlFragment } from '../query/sql';
import type { PgRecord } from './types';
import { resolveRecordPath, UndeclaredPathError } from '../records/paths';
import { encodeJsonColumn, toIdColumn, isIdValue } from '../values';
import { arrayColumnType, literal, param, sql } from '../query/sql';
import { isPlainRecord } from '../records/extra';
import { StoreQueryError } from '~/ports/query';
import { lastSegment } from '../records/tables';
import { isPullCondition } from './evaluate';

/** The operators the primitive applies. */
export const UPDATE_OPERATORS: ReadonlySet<string> = new Set([
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
]);

/** One path an update writes. */
export interface UpdateWrite {
  operator: string;
  path: string;
  value: unknown;
}

/** The writes of a cast update (plain paths are already under `$set`). */
export function updateWrites(update: PgRecord): UpdateWrite[] {
  const writes: UpdateWrite[] = [];
  for (const [operator, fields] of Object.entries(update)) {
    if (!isPlainRecord(fields)) {
      continue;
    }
    for (const [path, value] of Object.entries(fields)) {
      writes.push({ operator, path, value });
    }
  }
  return writes;
}

/**
 * Refuses what the primitive does not apply: unknown operators, positional paths (C2), and two
 * operators writing the same path or a path and one beneath it (MongoDB's "would create a
 * conflict"). `$setOnInsert` paths conflict only among themselves and with `$set`.
 */
export function checkUpdate(update: PgRecord): void {
  const seen: Array<{ path: string; operator: string }> = [];
  for (const { operator, path } of updateWrites(update)) {
    if (!UPDATE_OPERATORS.has(operator)) {
      throw new StoreQueryError(`Unsupported update operator ${operator}`);
    }
    if (path.split('.').some((segment) => segment.startsWith('$') || /^\d+$/.test(segment))) {
      throw new StoreQueryError(
        `Positional update paths are not supported yet ("${path}"; extended operators come with C2)`,
      );
    }
    for (const other of seen) {
      if (
        other.path === path ||
        other.path.startsWith(`${path}.`) ||
        path.startsWith(`${other.path}.`)
      ) {
        throw new StoreQueryError(
          `Updating the path "${path}" would create a conflict at "${other.path}"`,
        );
      }
    }
    seen.push({ path, operator });
  }
  for (const key of Object.keys(update)) {
    if (!key.startsWith('$')) {
      throw new StoreQueryError(`The update path "${key}" is not under an operator`);
    }
  }
}

/** The paths an update writes, outside `$setOnInsert` (for `runValidators`). */
export function updatedPaths(update: PgRecord): string[] {
  return updateWrites(update)
    .filter((write) => write.operator !== '$setOnInsert')
    .map((write) => write.path);
}

/* ------------------------------------------------------------------------------------------ */
/* Tier 1                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** A compiled tier-1 update: the `SET` list over the row aliased `t`. */
export interface Tier1Plan {
  readonly set: SqlFragment;
}

const ALIAS = 't';
const NUMBER_TYPES: ReadonlySet<ColumnDescriptor['type']> = new Set(['number', 'integer']);
const ORDERED_TYPES: ReadonlySet<ColumnDescriptor['type']> = new Set([
  'number',
  'integer',
  'date',
  'string',
  'objectId',
  'objectIdOrString',
  'boolean',
]);
const TEXT_TYPES: ReadonlySet<ColumnDescriptor['type']> = new Set([
  'string',
  'objectId',
  'objectIdOrString',
]);

/** Thrown inside the compiler when an update needs tier 2. */
class NeedsTier2 extends Error {}

const tier2 = (): never => {
  throw new NeedsTier2();
};

/** A number parameter: `-0` as text (`pg` would send `0`). */
function numberValue(value: unknown): unknown {
  return typeof value === 'number' && Object.is(value, -0) ? '-0' : value;
}

/** The column value of an (already cast) scalar of `column`'s type. */
function scalarColumnValue(column: ColumnDescriptor, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  switch (column.type) {
    case 'number':
    case 'integer':
      return typeof value === 'number' ? numberValue(value) : tier2();
    case 'string':
      return typeof value === 'string' ? value : tier2();
    case 'boolean':
      return typeof value === 'boolean' ? value : tier2();
    case 'date':
      return value instanceof Date ? value : tier2();
    case 'objectId':
      return isIdValue(value) ? toIdColumn(value) : tier2();
    case 'objectIdOrString':
      if (typeof value === 'string') return value;
      return isIdValue(value) ? toIdColumn(value) : tier2();
    case 'buffer':
      return Buffer.isBuffer(value) ? value : tier2();
    default:
      return tier2();
  }
}

/** The tier-1 compiler of one table's updates. */
class SetBuilder {
  private readonly assignments = new Map<string, SqlFragment>();
  private nulls: SqlFragment;
  private nullsChanged = false;
  private readonly extraPaths: string[][] = [];

  constructor(
    private readonly tables: RecordTables,
    private readonly table: RecordTable,
  ) {
    this.nulls = sql.id(ALIAS, '_nulls');
  }

  private get systemColumns(): boolean {
    return this.table.systemColumns;
  }

  ref(column: string): SqlFragment {
    return sql.id(ALIAS, column);
  }

  column(name: string): ColumnDescriptor {
    const column = this.table.columns.get(name);
    if (!column) {
      throw new StoreQueryError(`Unknown column "${name}" of ${this.table.descriptor.name}`);
    }
    return column;
  }

  type(column: ColumnDescriptor): string {
    return arrayColumnType(column);
  }

  /** `true` when `path` is listed in `_nulls` (`false` without system columns). */
  listed(path: string): SqlFragment {
    if (!this.systemColumns) {
      return sql`FALSE`;
    }
    return sql`coalesce(${literal(path)} = ANY (${this.ref('_nulls')}), FALSE)`;
  }

  /** `true` when the value at `path` (column `column`) is a stored `null`. */
  storedNull(column: string, path: string): SqlFragment {
    return sql`(${this.ref(column)} IS NULL AND ${this.listed(path)})`;
  }

  assign(column: string, expression: SqlFragment): void {
    if (this.assignments.has(column)) {
      throw new StoreQueryError(`The update writes the column "${column}" twice`);
    }
    this.assignments.set(column, expression);
  }

  setNull(path: string, isNull: boolean): void {
    if (!this.systemColumns) return;
    this.nulls = sql`lc_nulls_set(${this.nulls}, ${literal(path)}, ${sql.raw(isNull ? 'TRUE' : 'FALSE')})`;
    this.nullsChanged = true;
  }

  clearNulls(path: string): void {
    if (!this.systemColumns) return;
    this.nulls = sql`lc_nulls_clear(${this.nulls}, ${literal(path)})`;
    this.nullsChanged = true;
  }

  addNulls(paths: readonly string[]): void {
    if (!this.systemColumns) return;
    for (const path of paths) {
      this.setNull(path, true);
    }
  }

  removeExtra(path: string): void {
    if (this.systemColumns) {
      this.extraPaths.push(path.split('.'));
    }
  }

  /**
   * Creates the objects above `field` that are missing (shape `true`), failing on one stored as
   * `null` (MongoDB: "cannot create field in element {a: null}").
   */
  createAncestors(field: FieldDescriptor, operator: string): void {
    for (const ancestor of this.ancestors(field)) {
      const expression = sql`CASE WHEN ${this.storedNull(ancestor.column, ancestor.path)} THEN lc_fail(${param(
        `${operator} "${field.path}": cannot write through null at "${ancestor.path}"`,
        'text',
      )}, NULL::boolean) ELSE TRUE END`;
      if (!this.assignments.has(ancestor.column)) {
        this.assignments.set(ancestor.column, expression);
      }
    }
  }

  /** A guard failing when an object above `field` is stored as `null` (`$pull`'s rule). */
  ancestorNullGuard(field: FieldDescriptor): SqlFragment | undefined {
    const checks = this.ancestors(field).map((ancestor) =>
      this.storedNull(ancestor.column, ancestor.path),
    );
    if (checks.length === 0) {
      return undefined;
    }
    return sql`(${sql.join(checks, sql` OR `)})`;
  }

  private ancestors(field: FieldDescriptor): Array<Extract<FieldDescriptor, { kind: 'object' }>> {
    const segments = field.path.split('.');
    const result: Array<Extract<FieldDescriptor, { kind: 'object' }>> = [];
    for (let end = 1; end < segments.length; end++) {
      const ancestor = this.table.fields.get(segments.slice(0, end).join('.'));
      if (ancestor?.kind === 'object') {
        result.push(ancestor);
      }
    }
    return result;
  }

  build(): Tier1Plan {
    if (this.nullsChanged) {
      this.assign('_nulls', this.nulls);
    }
    if (this.extraPaths.length > 0) {
      let extra: SqlFragment = sql`${this.ref('_extra')}`;
      for (const segments of this.extraPaths) {
        extra = sql`(${extra} #- ${param(segments, 'text[]')})`;
      }
      this.assign(
        '_extra',
        sql`CASE WHEN ${this.ref('_extra')} IS NULL THEN NULL ELSE nullif(${extra}, '{}'::jsonb) END`,
      );
    }
    if (this.assignments.size === 0) {
      const key = this.table.descriptor.primaryKey[0];
      this.assignments.set(key, this.ref(key));
    }
    return {
      set: sql.join(
        [...this.assignments].map(([column, expression]) => sql`${sql.id(column)} = ${expression}`),
        sql`, `,
      ),
    };
  }

  /* ---- writes ---- */

  write(operator: string, resolved: ResolvedPath, value: unknown): void {
    const { node } = resolved;
    if (resolved.hops.length > 0 || node.kind !== 'field') {
      tier2();
    }
    const field = (node as { field: FieldDescriptor }).field;
    switch (field.kind) {
      case 'scalar':
        return this.writeScalar(operator, field, value);
      case 'object':
        return this.writeObject(operator, field, value);
      case 'array':
        return this.writeArray(operator, field, value);
      case 'json':
        return this.writeJson(operator, field, value);
      default:
        tier2();
    }
  }

  private writeScalar(
    operator: string,
    field: Extract<FieldDescriptor, { kind: 'scalar' }>,
    value: unknown,
  ): void {
    if (field.system === 'id') {
      tier2();
    }
    const column = this.column(field.column);
    const ref = this.ref(field.column);
    const type = this.type(column);
    switch (operator) {
      case '$set':
        this.createAncestors(field, operator);
        this.assign(field.column, param(scalarColumnValue(column, value), type));
        this.setNull(field.path, value === null);
        this.removeExtra(field.path);
        return;
      case '$unset':
        this.assign(field.column, sql`NULL::${sql.raw(type)}`);
        this.setNull(field.path, false);
        this.removeExtra(field.path);
        return;
      case '$inc': {
        if (!NUMBER_TYPES.has(column.type) || typeof value !== 'number') tier2();
        this.createAncestors(field, operator);
        this.assign(
          field.column,
          sql`CASE WHEN ${this.storedNull(field.column, field.path)} THEN lc_fail(${param(
            `$inc "${field.path}": the stored value is null, not a number`,
            'text',
          )}, NULL::${sql.raw(type)}) ELSE coalesce(${ref}, 0) + ${param(numberValue(value), type)} END`,
        );
        this.removeExtra(field.path);
        return;
      }
      case '$min':
      case '$max': {
        if (!ORDERED_TYPES.has(column.type) || value === null || value === undefined) tier2();
        this.createAncestors(field, operator);
        const operand = param(scalarColumnValue(column, value), type);
        const compared = TEXT_TYPES.has(column.type) ? sql`(${operand} COLLATE "C")` : operand;
        const wins = operator === '$max' ? sql`${compared} > ${ref}` : sql`${compared} < ${ref}`;
        const overNull = operator === '$max' ? operand : sql`NULL::${sql.raw(type)}`;
        this.assign(
          field.column,
          sql`CASE WHEN ${ref} IS NULL THEN (CASE WHEN ${this.listed(field.path)} THEN ${overNull} ELSE ${operand} END) WHEN ${wins} THEN ${operand} ELSE ${ref} END`,
        );
        if (operator === '$max') {
          this.setNull(field.path, false);
        }
        this.removeExtra(field.path);
        return;
      }
      default:
        tier2();
    }
  }

  /** The fields beneath an object, depth first; tier 2 when a child or element table is among them. */
  private objectColumns(field: Extract<FieldDescriptor, { kind: 'object' }>): ColumnDescriptor[] {
    const columns: ColumnDescriptor[] = [];
    const visit = (current: FieldDescriptor) => {
      if (current.kind === 'children' || current.kind === 'elements') {
        tier2();
      }
      columns.push(this.column(current.column));
      if (current.kind === 'object') {
        current.fields.forEach(visit);
      }
    };
    visit(field);
    return columns;
  }

  /** The column values of an object value (`undefined` columns are `NULL`) and its null paths. */
  private encodeObject(
    field: Extract<FieldDescriptor, { kind: 'object' }>,
    value: PgRecord,
    values: Map<string, unknown>,
    nulls: string[],
  ): void {
    values.set(field.column, true);
    for (const child of field.fields) {
      const item = value[lastSegment(child.path)];
      if (item === undefined) {
        continue;
      }
      if (item === null) {
        nulls.push(child.path);
        continue;
      }
      const column = this.column(child.column);
      switch (child.kind) {
        case 'scalar':
          values.set(child.column, scalarColumnValue(column, item));
          break;
        case 'array':
          if (!Array.isArray(item)) tier2();
          values.set(
            child.column,
            (item as unknown[]).map((element) =>
              scalarColumnValue({ ...column, array: false }, element),
            ),
          );
          break;
        case 'object':
          if (!isPlainRecord(item)) tier2();
          this.encodeObject(child, item as PgRecord, values, nulls);
          break;
        case 'json':
          values.set(child.column, encodeJsonColumn(item));
          break;
        default:
          tier2();
      }
    }
  }

  private writeObject(
    operator: string,
    field: Extract<FieldDescriptor, { kind: 'object' }>,
    value: unknown,
  ): void {
    if (operator !== '$set' && operator !== '$unset') {
      tier2();
    }
    const columns = this.objectColumns(field);
    const values = new Map<string, unknown>();
    const nulls: string[] = [];
    if (operator === '$set') {
      if (value !== null && !isPlainRecord(value)) tier2();
      this.createAncestors(field, operator);
      if (value !== null) {
        this.encodeObject(field, value as PgRecord, values, nulls);
      }
    }
    for (const column of columns) {
      const type = this.type(column);
      const item = values.get(column.name);
      this.assign(
        column.name,
        item === undefined || item === null ? sql`NULL::${sql.raw(type)}` : param(item, type),
      );
    }
    this.clearNulls(field.path);
    if (operator === '$set' && value === null) {
      this.setNull(field.path, true);
    }
    this.addNulls(nulls);
    this.removeExtra(field.path);
  }

  private writeArray(
    operator: string,
    field: Extract<FieldDescriptor, { kind: 'array' }>,
    value: unknown,
  ): void {
    const column = this.column(field.column);
    const ref = this.ref(field.column);
    const type = this.type(column);
    const elementColumn: ColumnDescriptor = { ...column, array: false };
    const elements = (list: unknown[]) =>
      list.map((item) => scalarColumnValue(elementColumn, item));
    const failOnNull = (message: string, expression: SqlFragment): SqlFragment =>
      sql`CASE WHEN ${this.storedNull(field.column, field.path)} THEN lc_fail(${param(
        message,
        'text',
      )}, NULL::${sql.raw(type)}) ELSE ${expression} END`;
    const each = (operand: unknown): unknown[] =>
      isPlainRecord(operand) && Array.isArray(operand.$each) ? operand.$each : [operand];
    switch (operator) {
      case '$set':
        if (value !== null && !Array.isArray(value)) tier2();
        this.createAncestors(field, operator);
        this.assign(
          field.column,
          value === null ? sql`NULL::${sql.raw(type)}` : param(elements(value as unknown[]), type),
        );
        this.setNull(field.path, value === null);
        this.removeExtra(field.path);
        return;
      case '$unset':
        this.assign(field.column, sql`NULL::${sql.raw(type)}`);
        this.setNull(field.path, false);
        this.removeExtra(field.path);
        return;
      case '$push': {
        const items = elements(each(value));
        this.createAncestors(field, operator);
        this.assign(
          field.column,
          failOnNull(
            `$push "${field.path}": the stored value is null, not an array`,
            sql`coalesce(${ref}, '{}'::${sql.raw(type)}) || ${param(items, type)}`,
          ),
        );
        return;
      }
      case '$addToSet': {
        const items = elements(each(value));
        this.createAncestors(field, operator);
        this.assign(
          field.column,
          failOnNull(
            `$addToSet "${field.path}": the stored value is null, not an array`,
            sql`coalesce(${ref}, '{}'::${sql.raw(type)}) || ARRAY(SELECT "u"."e" FROM unnest(${param(
              items,
              type,
            )}) WITH ORDINALITY AS "u" ("e", "o") WHERE NOT EXISTS (SELECT 1 FROM unnest(coalesce(${ref}, '{}'::${sql.raw(
              type,
            )})) AS "x" ("e") WHERE "x"."e" IS NOT DISTINCT FROM "u"."e") AND NOT EXISTS (SELECT 1 FROM unnest(${param(
              items,
              type,
            )}) WITH ORDINALITY AS "p" ("e", "o") WHERE "p"."o" < "u"."o" AND "p"."e" IS NOT DISTINCT FROM "u"."e") ORDER BY "u"."o")`,
          ),
        );
        return;
      }
      case '$pull':
      case '$pullAll': {
        let removed: unknown[];
        if (operator === '$pullAll') {
          if (!Array.isArray(value)) tier2();
          removed = elements(value as unknown[]);
        } else if (isPullCondition(value)) {
          const condition = value as PgRecord;
          const keys = Object.keys(condition);
          if (keys.length !== 1 || keys[0] !== '$in' || !Array.isArray(condition.$in)) tier2();
          removed = elements(condition.$in as unknown[]);
        } else {
          removed = elements([value]);
        }
        const guard = this.ancestorNullGuard(field);
        const message = `${operator} "${field.path}": the stored value is null, not an array`;
        let expression = sql`CASE WHEN ${ref} IS NULL THEN (CASE WHEN ${this.listed(
          field.path,
        )} THEN lc_fail(${param(message, 'text')}, NULL::${sql.raw(type)}) ELSE NULL END) ELSE ARRAY(SELECT "u"."e" FROM unnest(${ref}) WITH ORDINALITY AS "u" ("e", "o") WHERE NOT EXISTS (SELECT 1 FROM unnest(${param(
          removed,
          type,
        )}) AS "r" ("e") WHERE "r"."e" IS NOT DISTINCT FROM "u"."e") ORDER BY "u"."o") END`;
        if (guard) {
          expression = sql`CASE WHEN ${guard} THEN lc_fail(${param(
            `${operator} "${field.path}": cannot write through null`,
            'text',
          )}, NULL::${sql.raw(type)}) ELSE ${expression} END`;
        }
        this.assign(field.column, expression);
        return;
      }
      default:
        tier2();
    }
  }

  private writeJson(
    operator: string,
    field: Extract<FieldDescriptor, { kind: 'json' }>,
    value: unknown,
  ): void {
    switch (operator) {
      case '$set':
        this.createAncestors(field, operator);
        this.assign(
          field.column,
          value === null ? sql`NULL::json` : param(encodeJsonColumn(value), 'json'),
        );
        this.setNull(field.path, value === null);
        this.removeExtra(field.path);
        return;
      case '$unset':
        this.assign(field.column, sql`NULL::json`);
        this.setNull(field.path, false);
        this.removeExtra(field.path);
        return;
      default:
        tier2();
    }
  }

  /** `$unset` of a path the schema does not declare: its `_extra` value. */
  unsetUndeclared(path: string): void {
    if (!this.systemColumns) tier2();
    this.removeExtra(path);
  }
}

/**
 * The tier-1 plan of a cast update over `table`'s rows (an update path, not an insert:
 * `$setOnInsert` is left out), or `null` when the update needs tier 2.
 */
export function planTier1(
  tables: RecordTables,
  table: RecordTable,
  update: PgRecord,
): Tier1Plan | null {
  const builder = new SetBuilder(tables, table);
  try {
    for (const { operator, path, value } of updateWrites(update)) {
      if (operator === '$setOnInsert' || value === undefined) {
        continue;
      }
      let resolved: ResolvedPath;
      try {
        resolved = resolveRecordPath(tables, table, path);
      } catch (error) {
        if (error instanceof UndeclaredPathError && operator === '$unset') {
          builder.unsetUndeclared(path);
          continue;
        }
        if (error instanceof UndeclaredPathError) {
          tier2();
        }
        throw error;
      }
      builder.write(operator, resolved, value);
    }
    return builder.build();
  } catch (error) {
    if (error instanceof NeedsTier2) {
      return null;
    }
    throw error;
  }
}

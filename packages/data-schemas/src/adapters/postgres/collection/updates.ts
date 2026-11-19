/**
 * Update planning for the collection primitive (docs/postgres-port/PHASE4.md §3.3): the checks
 * every update goes through, and the tier-1 compiler, which turns an update of parent-row columns
 * into one SQL `SET` list. Updates it cannot compile take tier 2 (read-modify-write in
 * `collection.ts`). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Tier 1 (parent rows):
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
 * Tier 1 on child tables (C2, §3.3), as statements run after the lock and the recheck, before the
 * parent's `SET` (which recounts the element count and keeps MongoDB's refusals on `null`):
 * - `$push` (`$each`, `$slice`): `INSERT ... SELECT` after each parent's last `_ord`, then a
 *   `DELETE` of the elements past the slice; `$addToSet` of subdocuments: the same `INSERT` with
 *   `WHERE NOT EXISTS` (every element column `IS NOT DISTINCT FROM`, `json` by its text, so key
 *   order counts as in MongoDB), duplicates among the added ones removed first;
 * - `$pull` by a filter on the elements: `DELETE ... WHERE`;
 * - positional writes into elements (`a.$.f`, `a.$[].f`, `a.$[x].f`, and `$set` of `a.$` as a
 *   whole): `UPDATE child ... WHERE _parent = ANY(ids) AND <position>`, the position being every
 *   row (`$[]`), the `arrayFilters` entry on the rows (`$[x]`), or the first row matching the
 *   filter's one condition that records MongoDB's positional index (`$`); `$[]`/`$[x]` fail on a
 *   missing or `null` array, as MongoDB does;
 * - `$set` of `tags.$` on a `T[]`: the element at the first position matching the filter's one
 *   condition on `tags`; `$push`'s `$slice` on `T[]` slices the concatenation.
 *
 * Everything else is tier 2: element tables, `json` subpaths (positional ones included), `$pull`
 * by other conditions on `T[]`, `$min`/`$max` with `null`, `_id`, undeclared `$set`, numeric
 * positions (`a.0.f`, which MongoDB pads), a positional `$` whose index more than one filter
 * condition may record (MongoDB orders them; the evaluator applies that order), and operators on
 * the wrong kind of path (the evaluator then raises MongoDB's error).
 */
import type { ColumnDescriptor, FieldDescriptor } from '../schema/descriptor';
import type { PathPosition, ResolvedPath } from '../records/paths';
import type { RecordTable, RecordTables } from '../records/tables';
import type { SqlFragment } from '../query/sql';
import type { PgRecord } from './types';
import { translateCastFilter, translateScalarCondition } from '../query/filter';
import { resolveRecordPath, UndeclaredPathError } from '../records/paths';
import { arrayColumnType, literal, param, sql, TRUE } from '../query/sql';
import { encodeJsonColumn, toIdColumn, isIdValue } from '../values';
import { REFUSED_UPDATE_OPERATORS } from '../evaluator/update';
import { decomposeRecord } from '../records/decompose';
import { isPlainRecord } from '../records/extra';
import { StoreQueryError } from '~/ports/query';
import { lastSegment } from '../records/tables';
import { QueryContext } from '../query/resolve';
import { isPullCondition } from './evaluate';
import { valueKey } from './support';

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
 * Refuses what the primitive does not apply: unknown operators (`$mul`, `$pop`, `$rename` and
 * `$bit` with their reason), and two operators writing the same path or a path and one beneath it
 * (MongoDB's "would create a conflict"). Positional paths (`a.$`, `a.$[]`, `a.$[x]`, `a.0`) are
 * applied (C2).
 */
export function checkUpdate(update: PgRecord): void {
  const seen: Array<{ path: string; operator: string }> = [];
  for (const { operator, path } of updateWrites(update)) {
    if (REFUSED_UPDATE_OPERATORS[operator]) {
      throw new StoreQueryError(
        `The update operator ${operator} is not supported (${REFUSED_UPDATE_OPERATORS[operator]})`,
      );
    }
    if (!UPDATE_OPERATORS.has(operator)) {
      throw new StoreQueryError(`Unsupported update operator ${operator}`);
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

/**
 * The paths an update writes (for `runValidators`): outside `$setOnInsert`, unless `inserting`
 * (an upsert's insert, whose `$setOnInsert` values mongoose's update validators check too).
 */
export function updatedPaths(update: PgRecord, options: { inserting?: boolean } = {}): string[] {
  return updateWrites(update)
    .filter((write) => options.inserting === true || write.operator !== '$setOnInsert')
    .map((write) => write.path);
}

/* ------------------------------------------------------------------------------------------ */
/* Tier 1                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * A statement on a child table for the parents whose keys `ids` holds (a bound key array). It
 * returns `lc_key` (the parent's key) for each row it wrote, and `lc_modified` when a written row
 * may be unchanged.
 */
export type ChildStatement = (ids: SqlFragment) => SqlFragment;

/**
 * A compiled tier-1 update: the `SET` list over the parent row aliased `t`, and the child-table
 * statements (C2) to run first, after the lock and the recheck (§3.5), on the matching parents.
 */
export interface Tier1Plan {
  readonly set: SqlFragment;
  readonly children: readonly ChildStatement[];
}

/** What tier 1 needs beyond the update: the cast filter (`$`) and `arrayFilters` (`$[x]`). */
export interface Tier1Context {
  filter: PgRecord;
  arrayFilters: ReadonlyMap<string, PgRecord>;
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
      children: [],
    };
  }

  /** The element count of a child array after a statement changed its rows (a recount). */
  childCount(
    field: Extract<FieldDescriptor, { kind: 'children' }>,
    operator: string,
    child: string,
  ): void {
    const ref = this.ref(field.column);
    const key = this.table.descriptor.primaryKey[0];
    const recount = sql`(SELECT count(*)::integer FROM ${sql.id(child)} AS "lc_n" WHERE "lc_n"."_parent" = ${this.ref(
      key,
    )})`;
    const message = `${operator} "${field.path}": the stored value is null, not an array`;
    if (operator === '$pull') {
      let expression = sql`CASE WHEN ${ref} IS NULL THEN (CASE WHEN ${this.listed(
        field.path,
      )} THEN lc_fail(${param(message, 'text')}, NULL::integer) ELSE NULL::integer END) ELSE ${recount} END`;
      const guard = this.ancestorNullGuard(field);
      if (guard) {
        expression = sql`CASE WHEN ${guard} THEN lc_fail(${param(
          `$pull "${field.path}": cannot write through null`,
          'text',
        )}, NULL::integer) ELSE ${expression} END`;
      }
      this.assign(field.column, expression);
      return;
    }
    this.createAncestors(field, operator);
    this.assign(
      field.column,
      sql`CASE WHEN ${this.storedNull(field.column, field.path)} THEN lc_fail(${param(
        message,
        'text',
      )}, NULL::integer) ELSE ${recount} END`,
    );
  }

  /** `$[]`/`$[x]` need the array: it fails when missing or `null`, as MongoDB does. */
  requireArray(field: Extract<FieldDescriptor, { kind: 'children' }>, path: string): void {
    const ref = this.ref(field.column);
    this.assign(
      field.column,
      sql`CASE WHEN ${ref} IS NULL THEN lc_fail(${param(
        `"${path}": the array "${field.path}" must exist (and not be null) to apply array updates`,
        'text',
      )}, NULL::integer) ELSE ${ref} END`,
    );
  }

  /** `$set` of `tags.$` on a `T[]` column: the element at the filter's position (C2). */
  setArrayPosition(
    field: Extract<FieldDescriptor, { kind: 'array' }>,
    value: unknown,
    condition: (element: SqlFragment) => SqlFragment,
  ): void {
    const column = this.column(field.column);
    const type = this.type(column);
    const elementType = type.replace(/\[\]$/, '');
    const ref = this.ref(field.column);
    const item = param(scalarColumnValue({ ...column, array: false }, value), elementType);
    this.assign(
      field.column,
      sql`(SELECT CASE WHEN "lc_s"."p" IS NULL THEN lc_fail(${param(
        `$set "${field.path}.$": the positional operator did not find the match needed from the query`,
        'text',
      )}, NULL::${sql.raw(type)}) ELSE ${ref}[1:"lc_s"."p" - 1] || ${item} || ${ref}["lc_s"."p" + 1:] END FROM (SELECT min("lc_u"."o") AS "p" FROM unnest(${ref}) WITH ORDINALITY AS "lc_u" ("v", "o") WHERE ${condition(
        sql`"lc_u"."v"`,
      )}) AS "lc_s")`,
    );
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
        let pushed = sql`coalesce(${ref}, '{}'::${sql.raw(type)}) || ${param(items, type)}`;
        const slice = isPlainRecord(value) ? value.$slice : undefined;
        if (typeof slice === 'number') {
          if (slice === 0) {
            pushed = sql`'{}'::${sql.raw(type)}`;
          } else if (slice > 0) {
            pushed = sql`(SELECT "lc_a"."a"[1:${sql.lit(slice)}] FROM (SELECT ${pushed} AS "a") AS "lc_a")`;
          } else {
            pushed = sql`(SELECT "lc_a"."a"[greatest(cardinality("lc_a"."a") - ${sql.lit(
              -slice,
            )} + 1, 1):] FROM (SELECT ${pushed} AS "a") AS "lc_a")`;
          }
        }
        this.assign(
          field.column,
          failOnNull(`$push "${field.path}": the stored value is null, not an array`, pushed),
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

/* ------------------------------------------------------------------------------------------ */
/* Tier 1 on child tables (C2)                                                                 */
/* ------------------------------------------------------------------------------------------ */

type ChildrenField = Extract<FieldDescriptor, { kind: 'children' }>;

/** Where the positional `$` takes its index from (see {@link positionalSource}). */
type PositionalSource =
  | { kind: 'children'; table: string; filter: PgRecord }
  | { kind: 'array'; field: Extract<FieldDescriptor, { kind: 'array' }>; condition: unknown }
  | 'unknown';

const KEYLESS = new Set(['$ne', '$nin', '$not', '$size', '$comment', '$options']);

/**
 * The part of a condition on a path through an array that records the positional index (the
 * last operator that does, as MongoDB's matcher records it), `null` when none does, or
 * `unknown` when it may or may not (a `null` operand, which also matches a missing array).
 */
function keySetting(value: unknown, wholeArray: boolean): PgRecord | RegExp | null | 'unknown' {
  if (value instanceof RegExp) return value;
  if (value === null || value === undefined) return 'unknown';
  if (!isPlainRecord(value) || !Object.keys(value).every((key) => key.startsWith('$'))) {
    return Array.isArray(value) || isPlainRecord(value) ? 'unknown' : { $eq: value };
  }
  let last: PgRecord | RegExp | null | 'unknown' = null;
  for (const [operator, operand] of Object.entries(value)) {
    if (KEYLESS.has(operator)) continue;
    if (last !== null && !(operator === '$exists' && (operand === false || wholeArray))) {
      /** Several operators recording a position: MongoDB picks by expression type (tier 2). */
      return 'unknown';
    }
    switch (operator) {
      case '$exists':
        if (operand === false) continue;
        last = wholeArray ? last : { $exists: true };
        continue;
      case '$eq':
        last = operand === null || Array.isArray(operand) ? 'unknown' : { $eq: operand };
        continue;
      case '$in':
        last =
          Array.isArray(operand) &&
          operand.every((item) => item !== null && item !== undefined && !Array.isArray(item))
            ? { $in: operand }
            : 'unknown';
        continue;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        last = operand === null || operand === undefined ? 'unknown' : { [operator]: operand };
        continue;
      case '$regex':
        last = {
          $regex: operand,
          ...(value.$options !== undefined ? { $options: value.$options } : {}),
        };
        continue;
      case '$all': {
        const items = Array.isArray(operand) ? operand : [];
        if (items.length > 1) {
          last = 'unknown';
          continue;
        }
        const item = items[items.length - 1];
        if (isPlainRecord(item) && '$elemMatch' in item) {
          last = { $elemMatch: item.$elemMatch };
        } else if (item === null || item === undefined || Array.isArray(item)) {
          last = 'unknown';
        } else {
          last = { $eq: item };
        }
        continue;
      }
      case '$elemMatch':
        last = { $elemMatch: operand };
        continue;
      default:
        last = 'unknown';
    }
  }
  return last;
}

/**
 * Where the positional `$` of an update over `table` takes its index from: the one condition of
 * the filter's top level and `$and` clauses that records an index (a child table's element filter
 * or a `T[]`'s element condition), `unknown` when several may (MongoDB then orders them by path
 * and expression type; the evaluator states that rule, so tier 2 applies it) or one may or may not,
 * or `undefined` (none: the update fails).
 */
function positionalSource(
  tables: RecordTables,
  table: RecordTable,
  filter: PgRecord,
): PositionalSource | undefined {
  let source: PositionalSource | undefined;
  let count = 0;
  const found = (next: PositionalSource) => {
    count += 1;
    source = source === 'unknown' ? source : next;
  };
  const visit = (clause: PgRecord) => {
    for (const [key, value] of Object.entries(clause)) {
      if ((key === '$and' || key === '$or') && Array.isArray(value)) {
        const before = count;
        value.forEach((entry) => visit(entry as PgRecord));
        if (key === '$or' && value.length > 1 && count > before) {
          found('unknown');
        }
        continue;
      }
      if (key.startsWith('$')) continue;
      const { node, hops } = resolveRecordPath(tables, table, key);
      if (hops.length > 0) {
        const condition = keySetting(value, false);
        if (condition === null) continue;
        const hop = hops[0];
        if (condition === 'unknown' || hop.position || hops.length > 1) {
          found('unknown');
          continue;
        }
        found({
          kind: 'children',
          table: hop.table.descriptor.name,
          filter: { [key.slice(hop.field.path.length + 1)]: condition },
        });
        continue;
      }
      if (node.kind === 'field' && (node.field.kind === 'scalar' || node.field.kind === 'object')) {
        continue;
      }
      const condition = keySetting(value, true);
      if (condition === null) continue;
      if (condition === 'unknown') {
        found('unknown');
      } else if (node.kind === 'field' && node.field.kind === 'children') {
        found(
          isPlainRecord(condition) && isPlainRecord(condition.$elemMatch)
            ? { kind: 'children', table: node.field.table, filter: condition.$elemMatch }
            : 'unknown',
        );
      } else if (node.kind === 'field' && node.field.kind === 'array') {
        found({ kind: 'array', field: node.field, condition });
      } else {
        found('unknown');
      }
    }
  };
  visit(filter);
  return count > 1 ? 'unknown' : source;
}

/** The writes of one positional selection of a child table (`a.$`, `a.$[]`, `a.$[x]`). */
interface ChildGroup {
  field: ChildrenField;
  table: RecordTable;
  position: PathPosition;
  builder: SetBuilder;
  /** `$set` of the whole element: its row. */
  replace?: Record<string, unknown>;
}

const DUMMY_ID = '000000000000000000000000';

/** The child rows of `elements` (cast already) appended to the array `field` of `collection`. */
function elementRows(
  tables: RecordTables,
  root: RecordTable,
  field: ChildrenField,
  elements: readonly unknown[],
): Array<Record<string, unknown>> {
  const record: PgRecord = { _id: root.descriptor.idType === 'string' ? 'lc' : DUMMY_ID };
  let parent = record;
  const segments = field.path.split('.');
  segments.slice(0, -1).forEach((segment) => {
    const next: PgRecord = {};
    parent[segment] = next;
    parent = next;
  });
  parent[segments[segments.length - 1]] = elements;
  const decomposed = decomposeRecord(tables, root.descriptor.collection, record, {
    mode: 'raw',
    rawValues: 'exact',
  });
  return decomposed.children.find((child) => child.table === field.table)?.rows ?? [];
}

/** The element columns of a child table (all but `_parent` and `_ord`). */
function elementColumns(table: RecordTable): ColumnDescriptor[] {
  return table.descriptor.columns.filter(
    (column) => column.name !== '_parent' && column.name !== '_ord',
  );
}

/** `INSERT` of child rows after each parent's last element (`$addToSet`: those not present). */
function insertChildren(
  table: RecordTable,
  rows: ReadonlyArray<Record<string, unknown>>,
  unique: boolean,
): ChildStatement {
  const name = sql.id(table.descriptor.name);
  const columns = elementColumns(table);
  const tuples = rows.map(
    (row, index) =>
      sql`(${sql.join(
        [
          sql.lit(index),
          ...columns.map((column) => param(row[column.name] ?? null, arrayColumnType(column))),
        ],
        sql`, `,
      )})`,
  );
  const aliases = ['k', ...columns.map((_, index) => `c${index}`)].map((alias) => sql.id(alias));
  const value = (index: number) => sql.id('lc_v', `c${index}`);
  const same = columns.map((column, index) => {
    const stored = sql.id('lc_x', column.name);
    return column.sqlType.startsWith('json ') || column.sqlType === 'json'
      ? sql`${stored}::text IS NOT DISTINCT FROM ${value(index)}::text`
      : sql`${stored} IS NOT DISTINCT FROM ${value(index)}`;
  });
  return (ids) =>
    sql`INSERT INTO ${name} (${sql.join(
      [sql.id('_parent'), sql.id('_ord'), ...columns.map((column) => sql.id(column.name))],
      sql`, `,
    )}) SELECT "lc_p"."id", (coalesce((SELECT max("lc_x"."_ord") FROM ${name} AS "lc_x" WHERE "lc_x"."_parent" = "lc_p"."id"), -1) + row_number() OVER (PARTITION BY "lc_p"."id" ORDER BY "lc_v"."k"))::integer, ${sql.join(
      columns.map((_, index) => value(index)),
      sql`, `,
    )} FROM unnest(${ids}) AS "lc_p" ("id") CROSS JOIN (VALUES ${sql.join(tuples, sql`, `)}) AS "lc_v" (${sql.join(
      aliases,
      sql`, `,
    )})${
      unique
        ? sql` WHERE NOT EXISTS (SELECT 1 FROM ${name} AS "lc_x" WHERE "lc_x"."_parent" = "lc_p"."id" AND ${sql.join(
            same,
            sql` AND `,
          )})`
        : sql``
    } RETURNING "_parent" AS "lc_key"`;
}

/** `DELETE` of the elements past `$push`'s `$slice`. */
function sliceChildren(table: RecordTable, slice: number): ChildStatement {
  const name = sql.id(table.descriptor.name);
  if (slice === 0) {
    return (ids) =>
      sql`DELETE FROM ${name} AS "lc_d" WHERE "lc_d"."_parent" = ANY (${ids}) RETURNING "lc_d"."_parent" AS "lc_key"`;
  }
  const order = slice < 0 ? sql`DESC` : sql`ASC`;
  return (ids) =>
    sql`DELETE FROM ${name} AS "lc_d" WHERE "lc_d"."_parent" = ANY (${ids}) AND "lc_d"."_ord" NOT IN (SELECT "lc_k"."_ord" FROM ${name} AS "lc_k" WHERE "lc_k"."_parent" = "lc_d"."_parent" ORDER BY "lc_k"."_ord" ${order} LIMIT ${sql.lit(
      Math.abs(slice),
    )}) RETURNING "lc_d"."_parent" AS "lc_key"`;
}

/** The tier-1 compiler of a whole update (parent `SET` list plus child statements). */
class Tier1Compiler {
  private readonly builder: SetBuilder;
  private readonly children: ChildStatement[] = [];
  private readonly groups = new Map<string, ChildGroup>();

  constructor(
    private readonly tables: RecordTables,
    private readonly table: RecordTable,
    private readonly context: Tier1Context,
  ) {
    this.builder = new SetBuilder(tables, table);
  }

  write(operator: string, path: string, value: unknown): void {
    let resolved: ResolvedPath;
    try {
      resolved = resolveRecordPath(this.tables, this.table, path, { positional: true });
    } catch (error) {
      if (error instanceof UndeclaredPathError && operator === '$unset') {
        this.builder.unsetUndeclared(path);
        return;
      }
      if (error instanceof UndeclaredPathError) {
        tier2();
      }
      throw error;
    }
    const { node, hops } = resolved;
    if (hops.length === 0) {
      if (node.kind === 'field' && node.field.kind === 'children') {
        return this.writeChildArray(operator, node.field, value);
      }
      if (node.kind === 'element') {
        return this.writeArrayElement(operator, node.field, node.position, value);
      }
      if (node.kind === 'childElement') {
        if (operator !== '$set' || !isPlainRecord(value)) tier2();
        const group = this.group(node.field, node.table, node.position, path);
        group.replace = elementRows(this.tables, this.table, node.field, [value])[0];
        return;
      }
      return this.builder.write(operator, resolved, value);
    }
    const hop = hops[0];
    if (hops.length > 1 || !hop.position || node.kind !== 'field') tier2();
    const group = this.group(hop.field, hop.table, hop.position as PathPosition, path);
    const relative = resolveRecordPath(
      this.tables,
      hop.table,
      (node as { field: FieldDescriptor }).field.path,
    );
    group.builder.write(operator, relative, value);
  }

  /** The group of writes on `table` under `position` (one per child table, or tier 2). */
  private group(
    field: ChildrenField,
    table: RecordTable,
    position: PathPosition,
    path: string,
  ): ChildGroup {
    if (position.kind === 'index') tier2();
    const name = table.descriptor.name;
    const existing = this.groups.get(name);
    if (existing) {
      const same =
        existing.position.kind === position.kind &&
        (position.kind !== 'filtered' ||
          (existing.position as { identifier: string }).identifier === position.identifier);
      if (!same) tier2();
      return existing;
    }
    const group: ChildGroup = {
      field,
      table,
      position,
      builder: new SetBuilder(this.tables, table),
    };
    if (position.kind !== 'positional') {
      this.builder.requireArray(field, path);
    }
    this.groups.set(name, group);
    return group;
  }

  private writeChildArray(operator: string, field: ChildrenField, value: unknown): void {
    const child = this.tables.table(field.table);
    switch (operator) {
      case '$push':
      case '$addToSet': {
        const each = isPlainRecord(value) && Array.isArray(value.$each);
        const items = each ? ((value as PgRecord).$each as unknown[]) : [value];
        if (!items.every((item) => isPlainRecord(item))) tier2();
        let rows = elementRows(this.tables, this.table, field, items);
        if (operator === '$addToSet') {
          const seen = new Set<string>();
          rows = rows.filter((row) => {
            const key = elementColumns(child)
              .map((column) => valueKey(row[column.name]))
              .join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (rows.length > 0) {
          this.children.push(insertChildren(child, rows, operator === '$addToSet'));
        }
        const slice = isPlainRecord(value) ? value.$slice : undefined;
        if (operator === '$push' && typeof slice === 'number') {
          this.children.push(sliceChildren(child, slice));
        }
        this.builder.childCount(field, operator, child.descriptor.name);
        return;
      }
      case '$pull': {
        if (!isPullCondition(value) || value instanceof RegExp) tier2();
        const condition = value as PgRecord;
        if (
          Object.keys(condition).length === 0 ||
          Object.keys(condition).every(
            (key) => key.startsWith('$') && key !== '$and' && key !== '$or' && key !== '$nor',
          )
        ) {
          tier2();
        }
        const where = translateCastFilter(
          new QueryContext(this.tables),
          { table: child, alias: 't' },
          condition,
        );
        const name = sql.id(child.descriptor.name);
        this.children.push(
          (ids) =>
            sql`DELETE FROM ${name} AS "t" WHERE "t"."_parent" = ANY (${ids}) AND ${where} RETURNING "t"."_parent" AS "lc_key"`,
        );
        this.builder.childCount(field, operator, child.descriptor.name);
        return;
      }
      default:
        tier2();
    }
  }

  private writeArrayElement(
    operator: string,
    field: Extract<FieldDescriptor, { kind: 'array' | 'elements' }>,
    position: PathPosition,
    value: unknown,
  ): void {
    if (operator !== '$set' || field.kind !== 'array' || position.kind !== 'positional') tier2();
    const source = positionalSource(this.tables, this.table, this.context.filter);
    if (
      !source ||
      source === 'unknown' ||
      source.kind !== 'array' ||
      source.field.path !== field.path
    ) {
      tier2();
    }
    const { condition } = source as Extract<PositionalSource, { kind: 'array' }>;
    const elementCondition =
      isPlainRecord(condition) && '$elemMatch' in condition ? condition.$elemMatch : condition;
    const context = new QueryContext(this.tables);
    this.builder.setArrayPosition(
      field as Extract<FieldDescriptor, { kind: 'array' }>,
      value,
      (element) =>
        translateScalarCondition(context, element, field.element, elementCondition, field.path),
    );
  }

  /** The condition selecting a group's rows (alias `t` of the child table). */
  private positionCondition(group: ChildGroup): SqlFragment {
    const { position, table } = group;
    const name = table.descriptor.name;
    switch (position.kind) {
      case 'all':
        return TRUE;
      case 'filtered': {
        const filter = this.context.arrayFilters.get(position.identifier);
        if (!filter) tier2();
        const prefix = `${position.identifier}.`;
        const relative = stripFilterPrefix(filter as PgRecord, prefix);
        return translateCastFilter(new QueryContext(this.tables), { table, alias: 't' }, relative);
      }
      case 'positional': {
        const source = positionalSource(this.tables, this.table, this.context.filter);
        if (
          !source ||
          source === 'unknown' ||
          source.kind !== 'children' ||
          source.table !== name
        ) {
          tier2();
        }
        const where = translateCastFilter(
          new QueryContext(this.tables),
          { table, alias: 'lc_m' },
          (source as Extract<PositionalSource, { kind: 'children' }>).filter,
        );
        return sql`"t"."_ord" = (SELECT min("lc_m"."_ord") FROM ${sql.id(name)} AS "lc_m" WHERE "lc_m"."_parent" = "t"."_parent" AND ${where})`;
      }
      default:
        return tier2();
    }
  }

  private groupStatement(group: ChildGroup): ChildStatement {
    const name = sql.id(group.table.descriptor.name);
    let set: SqlFragment;
    if (group.replace) {
      const row = group.replace;
      set = sql.join(
        elementColumns(group.table).map(
          (column) =>
            sql`${sql.id(column.name)} = ${param(row[column.name] ?? null, arrayColumnType(column))}`,
        ),
        sql`, `,
      );
    } else {
      set = group.builder.build().set;
    }
    const where = this.positionCondition(group);
    return (ids) =>
      sql`UPDATE ${name} AS "t" SET ${set} FROM ${name} AS "lc_o" WHERE "lc_o"."_parent" = "t"."_parent" AND "lc_o"."_ord" = "t"."_ord" AND "t"."_parent" = ANY (${ids}) AND ${where} RETURNING "t"."_parent" AS "lc_key", ("t"::text IS DISTINCT FROM "lc_o"::text) AS "lc_modified"`;
  }

  build(): Tier1Plan {
    const statements = [...this.children];
    for (const group of this.groups.values()) {
      statements.push(this.groupStatement(group));
    }
    return { set: this.builder.build().set, children: statements };
  }
}

/** A filter's paths without `prefix` (an `arrayFilters` entry on a child table's elements). */
function stripFilterPrefix(filter: PgRecord, prefix: string): PgRecord {
  const result: PgRecord = {};
  for (const [key, value] of Object.entries(filter)) {
    if ((key === '$and' || key === '$or' || key === '$nor') && Array.isArray(value)) {
      result[key] = value.map((entry) => stripFilterPrefix(entry as PgRecord, prefix));
      continue;
    }
    if (key.startsWith('$')) {
      result[key] = value;
      continue;
    }
    if (!key.startsWith(prefix)) tier2();
    result[key.slice(prefix.length)] = value;
  }
  return result;
}

/**
 * The tier-1 plan of a cast update over `table`'s rows (an update path, not an insert:
 * `$setOnInsert` is left out), or `null` when the update needs tier 2.
 */
export function planTier1(
  tables: RecordTables,
  table: RecordTable,
  update: PgRecord,
  context: Tier1Context = { filter: {}, arrayFilters: new Map() },
): Tier1Plan | null {
  const compiler = new Tier1Compiler(tables, table, context);
  try {
    for (const { operator, path, value } of updateWrites(update)) {
      if (operator === '$setOnInsert' || value === undefined) {
        continue;
      }
      compiler.write(operator, path, value);
    }
    return compiler.build();
  } catch (error) {
    if (error instanceof NeedsTier2) {
      return null;
    }
    throw error;
  }
}

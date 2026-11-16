/**
 * Path resolution over the schema descriptor (docs/postgres-port/PHASE4.md §2.1): a dotted path of
 * a record, resolved against a table's path tree to the node it reaches, the child tables it
 * crosses and the subpath inside a `json` value. The descriptor caster (`cast.ts`) and the query
 * translator (Q1) share it, so a path is resolved once. Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * At each step the longest declared prefix is taken, then the node kind decides:
 * - scalar leaf, object path, `json` column: the node itself; a `json` node takes the rest of the
 *   path as its subpath (a `Map`'s first subpath segment is its key);
 * - scalar array (`T[]` or element table): the array, or one element when followed by a position;
 * - child array: the array itself, one element (`a.0`, `a.$`) when followed by a position alone,
 *   or a path inside the elements (`a.f`, `a.0.f`), resolved in the child table;
 * - anything else is undeclared, which a filter refuses with a `StoreQueryError` (R9) and an update
 *   strips (mongoose's `strict`).
 *
 * Positions: a numeric segment (`a.0`, an index), and, in updates, the positional `$`, `$[]` and
 * `$[<identifier>]` (`arrayFilters`).
 */
import type { FieldDescriptor, ScalarType, StringTransform } from '../schema/descriptor';
import type { RecordTable, RecordTables } from './tables';
import { StoreQueryError } from '~/ports/query';

/** A position segment after an array path. */
export type PathPosition =
  | { kind: 'index'; index: number }
  /** `$`: the first element the filter matched (updates). */
  | { kind: 'positional' }
  /** `$[]`: every element (updates). */
  | { kind: 'all' }
  /** `$[<identifier>]`: the elements `arrayFilters` select (updates). */
  | { kind: 'filtered'; identifier: string };

/** A child array crossed by a path. */
export interface PathHop {
  /** The table holding the child array field. */
  readonly outer: RecordTable;
  /** The child array field (in `outer`). */
  readonly field: Extract<FieldDescriptor, { kind: 'children' }>;
  /** The child table. */
  readonly table: RecordTable;
  /** The element position, when the path names one (`a.0.f`). */
  readonly position?: PathPosition;
}

/** What a resolved path reaches. */
export type ResolvedNode =
  /** A declared node, whole: a scalar, an object path, an array, a child array or a `json` column. */
  | { kind: 'field'; field: FieldDescriptor }
  /** One element of a scalar array (`tags.0`, `tags.$`). */
  | {
      kind: 'element';
      field: Extract<FieldDescriptor, { kind: 'array' | 'elements' }>;
      position: PathPosition;
    }
  /** One element of a child array, as a whole (`a.0`, `a.$`). */
  | {
      kind: 'childElement';
      field: Extract<FieldDescriptor, { kind: 'children' }>;
      table: RecordTable;
      position: PathPosition;
    }
  /** A subpath inside a `json` column (`envelope.event.type`, `skillStates.<id>`). */
  | { kind: 'json'; field: Extract<FieldDescriptor, { kind: 'json' }>; subpath: string[] };

/** A path resolved against a table. */
export interface ResolvedPath {
  /** The path as given. */
  readonly path: string;
  /** The table the node lives in (the innermost child table crossed, or the starting table). */
  readonly table: RecordTable;
  /** The child arrays crossed, outermost first. */
  readonly hops: readonly PathHop[];
  readonly node: ResolvedNode;
}

/** Options of {@link resolveRecordPath}. */
export interface ResolveOptions {
  /** Accept the update positions `$`, `$[]` and `$[<identifier>]` (default: numeric only). */
  positional?: boolean;
}

const NUMERIC = /^\d+$/;
const FILTERED = /^\$\[([A-Za-z][A-Za-z0-9]*)\]$/;

/** The position a segment names, or `undefined`. */
export function parsePosition(segment: string, positional: boolean): PathPosition | undefined {
  if (NUMERIC.test(segment)) {
    return { kind: 'index', index: Number(segment) };
  }
  if (!positional) {
    return undefined;
  }
  if (segment === '$') {
    return { kind: 'positional' };
  }
  if (segment === '$[]') {
    return { kind: 'all' };
  }
  const filtered = FILTERED.exec(segment);
  return filtered ? { kind: 'filtered', identifier: filtered[1] } : undefined;
}

/** Raised for a path the schema does not declare (a filter refuses it; an update strips it). */
export class UndeclaredPathError extends StoreQueryError {
  constructor(
    readonly path: string,
    where: string,
  ) {
    super(`The path "${path}" is not declared by the schema of ${where}`);
    this.name = 'UndeclaredPathError';
  }
}

/**
 * Resolves `path` (relative to `start`'s rows) against the descriptor. Throws an
 * {@link UndeclaredPathError} (a `StoreQueryError`) for a path the schema does not declare, and a
 * `StoreQueryError` for a malformed one.
 */
export function resolveRecordPath(
  tables: RecordTables,
  start: RecordTable,
  path: string,
  options: ResolveOptions = {},
): ResolvedPath {
  const segments = path.split('.');
  if (segments.some((segment) => segment === '')) {
    throw new StoreQueryError(`Invalid path "${path}"`);
  }
  const positional = options.positional ?? false;
  const hops: PathHop[] = [];
  const where = start.descriptor.collection;
  let table = start;
  let index = 0;

  for (;;) {
    let field: FieldDescriptor | undefined;
    let end = segments.length;
    for (; end > index; end--) {
      field = table.fields.get(segments.slice(index, end).join('.'));
      if (field) {
        break;
      }
    }
    if (!field) {
      throw new UndeclaredPathError(path, where);
    }
    const rest = segments.slice(end);
    const done = (node: ResolvedNode): ResolvedPath => ({ path, table, hops, node });
    if (rest.length === 0) {
      return done({ kind: 'field', field });
    }
    switch (field.kind) {
      case 'json':
        return done({ kind: 'json', field, subpath: rest });
      case 'array':
      case 'elements': {
        const position = parsePosition(rest[0], positional);
        if (position && rest.length === 1) {
          return done({ kind: 'element', field, position });
        }
        throw new UndeclaredPathError(path, where);
      }
      case 'children': {
        const child = tables.table(field.table);
        const position = parsePosition(rest[0], positional);
        if (position && rest.length === 1) {
          return done({ kind: 'childElement', field, table: child, position });
        }
        hops.push({ outer: table, field, table: child, ...(position ? { position } : {}) });
        index = end + (position ? 1 : 0);
        table = child;
        continue;
      }
      default:
        throw new UndeclaredPathError(path, where);
    }
  }
}

/** The value type a resolved path casts to (see `cast.ts`). */
export type CastTarget =
  | { kind: 'scalar'; type: ScalarType; transforms: readonly StringTransform[] }
  /** A whole scalar array: elements of `element`. */
  | { kind: 'array'; element: ScalarType; transforms: readonly StringTransform[] }
  /** An object path, or one element of a child array as a whole. */
  | {
      kind: 'object';
      table: RecordTable;
      /** The object's fields (a child element's: the child table's fields). */
      fields: readonly FieldDescriptor[];
      /** A single subdocument or a child element (built by the engine), not a nested object. */
      subdocument: boolean;
    }
  /** A whole child array. */
  | { kind: 'children'; table: RecordTable }
  /** A `json` column or a subpath of one: not cast (mongoose leaves `Mixed` alone). */
  | { kind: 'json' }
  /** A whole `Map`: an object whose values are of `of` (`mixed`: not cast). */
  | { kind: 'map'; of: ScalarType | 'mixed' };

/** The cast target of a resolved path. */
export function castTargetOf(tables: RecordTables, resolved: ResolvedPath): CastTarget {
  const { node } = resolved;
  switch (node.kind) {
    case 'element':
      return { kind: 'scalar', type: node.field.element, transforms: node.field.transforms ?? [] };
    case 'childElement':
      return {
        kind: 'object',
        table: node.table,
        fields: node.table.descriptor.fields,
        subdocument: true,
      };
    case 'json': {
      const { mapOf } = node.field;
      if (node.field.json === 'map' && mapOf && mapOf !== 'mixed' && node.subpath.length === 1) {
        return { kind: 'scalar', type: mapOf, transforms: [] };
      }
      return { kind: 'json' };
    }
    case 'field': {
      const { field } = node;
      switch (field.kind) {
        case 'scalar':
          return { kind: 'scalar', type: field.type, transforms: field.transforms ?? [] };
        case 'array':
        case 'elements':
          return { kind: 'array', element: field.element, transforms: field.transforms ?? [] };
        case 'object':
          return {
            kind: 'object',
            table: resolved.table,
            fields: field.fields,
            subdocument: field.subdocument,
          };
        case 'children':
          return { kind: 'children', table: tables.table(field.table) };
        case 'json':
          return field.json === 'map'
            ? { kind: 'map', of: field.mapOf ?? 'mixed' }
            : { kind: 'json' };
      }
    }
  }
}

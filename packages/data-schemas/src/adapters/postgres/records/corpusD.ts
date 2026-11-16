/**
 * Corpus D (docs/postgres-port/PHASE4.md §2.5): documents generated per production table from the
 * schema descriptor, exercising every declared path, for the record codec's round trips (R1) and
 * the translator's filters on every leaf path (Q1). Test data only: nothing at runtime uses it.
 * Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Variants:
 * - `full`: every declared path holds a value (nested objects filled, two elements per array and
 *   per array of subdocuments, `Mixed` values with dates, binaries, nested arrays and key orders
 *   that are not alphabetical, `-0` and `Infinity` in number arrays, strings with characters that
 *   need escaping in array literals);
 * - `nulls`: every leaf `null` at every depth, objects present, one child element of `null`s;
 * - `topNulls`: every top-level path `null`;
 * - `empty`: only the primary key (defaults then come from the engine).
 *
 * `enumOf(path)` (a document path) returns the values an `enum` allows, so `full` documents also
 * pass validation where an enum is the only constraint.
 */
import type { FieldDescriptor, ScalarType } from '../schema/descriptor';
import type { RecordTable, RecordTables } from './tables';
import { lastSegment } from './tables';

/** A corpus D variant. */
export type CorpusVariant = 'full' | 'nulls' | 'topNulls' | 'empty';

/** Options of {@link generateCorpusDocument}. */
export interface CorpusOptions {
  /** Distinguishes the documents of one table (ids, values). */
  seed?: number;
  /** The values an `enum` allows at a document path, if any. */
  enumOf?: (path: string) => readonly unknown[] | undefined;
}

/** A 24-hex id from a number. */
export function corpusId(n: number): string {
  return n.toString(16).padStart(24, '0');
}

const STRING_EDGE = 'a "q", \\ {x} é😀';

/** A value of `type` for the document path `path`. */
function scalarFor(type: ScalarType, path: string, seed: number, index = 0): unknown {
  switch (type) {
    case 'string':
      return index === 1 ? STRING_EDGE : `${lastSegment(path)}-${seed}-${index}`;
    case 'number':
      return seed + 0.25 + index;
    case 'boolean':
      return index % 2 === 0;
    case 'date':
      return new Date(Date.UTC(2024, 0, 1 + seed, 12, 34, 56, 789 - index));
    case 'objectId':
      return corpusId(0xabc000 + seed * 16 + index);
    case 'buffer':
      return Buffer.from([1, 2, 3, seed & 0xff, index]);
    case 'objectIdOrString':
      return index === 0 ? corpusId(0xdef000 + seed) : `principal-${seed}`;
  }
}

/** The elements of a generated scalar array. */
function arrayFor(type: ScalarType, path: string, seed: number): unknown[] {
  if (type === 'number') {
    return [-0, Number.POSITIVE_INFINITY, seed + 1.5];
  }
  if (type === 'date') {
    return [new Date(Date.UTC(1969, 6, 20, 20, 17, 40, 1)), new Date(Date.UTC(2999, 11, 31))];
  }
  return [scalarFor(type, path, seed, 0), scalarFor(type, path, seed, 1)];
}

/** A `Mixed` value whose key order is not alphabetical, with tagged values inside. */
function mixedFor(seed: number): Record<string, unknown> {
  return {
    zeta: seed,
    alpha: {
      nested: [1, 'two', true, null, { b: 2, a: 1 }],
      when: new Date(Date.UTC(2023, 4, 5, 6, 7, 8, 9)),
      bytes: Buffer.from('mixed'),
    },
    middle: 'x"y\\z',
  };
}

function jsonFor(field: Extract<FieldDescriptor, { kind: 'json' }>, seed: number): unknown {
  switch (field.json) {
    case 'mixed':
      return mixedFor(seed);
    case 'mixedArray':
      return [{ b: 1, a: 2 }, 'text', 3, [false, null]];
    case 'map':
      if (!field.mapOf || field.mapOf === 'mixed') {
        return { second: mixedFor(seed), first: 'one' };
      }
      return {
        second: scalarFor(field.mapOf, field.path, seed, 0),
        first: scalarFor(field.mapOf, field.path, seed, 1),
      };
  }
}

/** The document path of a field of `table` whose rows sit at `base`. */
function docPath(table: RecordTable, field: FieldDescriptor): string {
  const base = table.descriptor.path;
  return base ? `${base}.${field.path}` : field.path;
}

function fill(
  tables: RecordTables,
  table: RecordTable,
  fields: readonly FieldDescriptor[],
  variant: 'full' | 'nulls',
  seed: number,
  options: CorpusOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const name = lastSegment(field.path);
    const path = docPath(table, field);
    if (field.kind === 'scalar' && field.system === 'version') {
      result[name] = 0;
      continue;
    }
    if (field.kind === 'scalar' && field.system === 'id') {
      continue;
    }
    switch (field.kind) {
      case 'scalar': {
        if (variant === 'nulls') {
          result[name] = null;
          break;
        }
        const allowed = options
          .enumOf?.(path)
          ?.filter((value) => value !== null && value !== undefined);
        result[name] =
          allowed && allowed.length > 0
            ? allowed[seed % allowed.length]
            : scalarFor(field.type, path, seed);
        break;
      }
      case 'array':
      case 'elements': {
        if (variant === 'nulls') {
          result[name] = null;
          break;
        }
        const allowed = options
          .enumOf?.(path)
          ?.filter((value) => value !== null && value !== undefined);
        result[name] =
          allowed && allowed.length > 0 ? allowed.slice(0, 2) : arrayFor(field.element, path, seed);
        break;
      }
      case 'object':
        result[name] = fill(tables, table, field.fields, variant, seed, options);
        break;
      case 'children': {
        const child = tables.table(field.table);
        const count = variant === 'nulls' ? 1 : 2;
        result[name] = Array.from({ length: count }, (_, index) =>
          fill(tables, child, child.descriptor.fields, variant, seed * 10 + index, options),
        );
        break;
      }
      case 'json':
        result[name] = variant === 'nulls' ? null : jsonFor(field, seed);
        break;
    }
  }
  return result;
}

/** The primary key fields of a generated document of `table`. */
function keyOf(table: RecordTable, seed: number): Record<string, unknown> {
  const descriptor = table.descriptor;
  if (descriptor.idType === 'objectId') {
    return { _id: corpusId(0x5eed0000 + seed) };
  }
  if (descriptor.idType === 'string') {
    return { _id: `${descriptor.collection}-id-${seed}` };
  }
  const key: Record<string, unknown> = {};
  for (const column of descriptor.primaryKey) {
    const field = descriptor.fields.find((entry) => 'column' in entry && entry.column === column);
    if (field?.kind === 'scalar') {
      key[field.path] = scalarFor(field.type, field.path, seed);
    }
  }
  return key;
}

/** A corpus D document of `collection`, in the requested variant. */
export function generateCorpusDocument(
  tables: RecordTables,
  collection: string,
  variant: CorpusVariant,
  options: CorpusOptions = {},
): Record<string, unknown> {
  const table = tables.collection(collection);
  const seed = options.seed ?? 1;
  const key = keyOf(table, seed);
  const keyPaths = new Set(Object.keys(key));
  if (variant === 'empty') {
    return key;
  }
  if (variant === 'topNulls') {
    const document: Record<string, unknown> = { ...key };
    for (const field of table.descriptor.fields) {
      if (!keyPaths.has(field.path) && !(field.kind === 'scalar' && field.system)) {
        document[lastSegment(field.path)] = null;
      }
    }
    return document;
  }
  const document = fill(tables, table, table.descriptor.fields, variant, seed, options);
  for (const path of keyPaths) {
    delete document[path];
  }
  return { ...key, ...document };
}

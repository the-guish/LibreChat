/**
 * Corpus B of the query language (docs/postgres-port/PHASE4.md §2.5): corpus A
 * (`query.corpus.ts`) on a typed schema, plus cases only a typed schema has. Test data only:
 * nothing outside specs imports this module, and it names no database (the schema definition is
 * built from the schema types the spec passes, so this module loads no mongoose).
 *
 * - The schema declares a type per field: `name` String, `email` String with `lowercase`, `n`
 *   Number, `flag` Boolean, `at` Date, `tags` [String], `scores` [Number], `ref` ObjectId, `refs`
 *   [ObjectId], `profile` a single subdocument `{ city, zip: Number, tags, geo: { lat, lng } }`,
 *   `items` an array of `{ sku, qty: Number, tags }`, hidden `secret`/`pin`, `subagentTask` a
 *   subdocument, `memberIds` [String], and a `Mixed` `meta`.
 * - Records are corpus A's plus {@link TYPED_EXTRA_RECORDS}, cast through the schema (a value that
 *   cannot be cast drops its top-level field), as the spec does with mongoose.
 * - Cases: corpus A's filters, projections and sorts whose paths the schema declares, run on the
 *   cast records, plus the typed cases below. `query.typed.differential.spec.ts` asserts that the
 *   reference evaluator over the cast filter and the cast records equals MongoDB through
 *   mongoose, and that `castFails` filters fail on both sides (`CastError` ↔ `StoreQueryError`).
 *   Cases marked `beyondEvaluator` (`$size`, numeric path segments, equality with an array,
 *   dotted projections) are outside the evaluator's language: MongoDB alone is their ground truth.
 * - `query.typed.postgres.spec.ts` runs the same cases on PostgreSQL's typed columns, child
 *   tables and `json` column, against the evaluator and against MongoDB itself.
 */
import type { FilterCase, ProjectionCase, SortCase } from './query.corpus';
import type { StoreFilter } from './query';

/** The schema types a spec passes to build {@link typedCorpusSchemaDefinition}. */
export interface TypedCorpusSchemaTypes {
  ObjectId: unknown;
  Mixed: unknown;
  /** A single-subdocument (or array element) schema without `_id`. */
  subdocument(definition: Record<string, unknown>): unknown;
}

/** The collection the typed corpus lives in. */
export const TYPED_CORPUS_COLLECTION = 'storequerytyped';

/** Top-level paths the typed schema declares (filters on other paths are left out). */
export const TYPED_CORPUS_PATHS: readonly string[] = [
  '_id',
  'label',
  'name',
  'email',
  'n',
  'flag',
  'at',
  'tags',
  'scores',
  'ref',
  'refs',
  'tenantId',
  'profile',
  'items',
  'secret',
  'pin',
  'status',
  'subagentTask',
  'memberIds',
  'expiredAt',
  'langfuseSampled',
  'langfuseDestinationIds',
  'meta',
];

/** The mongoose schema definition of the typed corpus (arrays have no default: missing stays missing). */
export function typedCorpusSchemaDefinition(
  types: TypedCorpusSchemaTypes,
): Record<string, unknown> {
  const strings = { type: [String], default: undefined };
  return {
    label: String,
    name: String,
    email: { type: String, lowercase: true },
    n: Number,
    flag: Boolean,
    at: Date,
    tags: strings,
    scores: { type: [Number], default: undefined },
    ref: types.ObjectId,
    refs: { type: [types.ObjectId], default: undefined },
    tenantId: String,
    profile: {
      type: types.subdocument({
        city: String,
        zip: Number,
        tags: strings,
        geo: { lat: Number, lng: Number },
      }),
      default: undefined,
    },
    items: {
      type: [types.subdocument({ sku: String, qty: Number, tags: strings })],
      default: undefined,
    },
    secret: { type: String, select: false },
    pin: { type: String, select: false },
    status: String,
    subagentTask: {
      type: types.subdocument({ status: String, attemptKey: String }),
      default: undefined,
    },
    memberIds: strings,
    expiredAt: Date,
    langfuseSampled: Boolean,
    langfuseDestinationIds: strings,
    meta: types.Mixed,
  };
}

/** Records only the typed corpus has: explicit nulls and empty values on every kind of path. */
export const TYPED_EXTRA_RECORDS: ReadonlyArray<Record<string, unknown>> = [
  {
    label: 'typed-nulls',
    tags: null,
    items: null,
    profile: null,
    refs: null,
    meta: null,
    n: null,
  },
  {
    label: 'typed-empties',
    tags: [],
    scores: [],
    items: [],
    profile: {},
    meta: {},
  },
  {
    label: 'typed-meta',
    meta: {
      kind: 'a',
      list: [{ to: 'x', from: 'y' }, 'scalar', { to: ['x2', 'x3'] }],
      nested: { deep: { value: 3 }, other: true },
    },
    items: [{ sku: 'm1', qty: 1, tags: ['t'] }, { sku: 'm2' }, { qty: 7, tags: [] }],
  },
];

/**
 * A record cast through the typed schema, as the specs do it with mongoose: `build` returns the
 * built document (`toObject` without minimizing) and the paths that failed to cast; a field that
 * cannot be cast is dropped and the record built again, and empty objects the schema added (nested
 * paths the input did not have) are removed.
 */
export function castTypedRecord(
  record: Record<string, unknown>,
  build: (input: Record<string, unknown>) => {
    object: Record<string, unknown>;
    castErrors: string[];
  },
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...record };
  for (;;) {
    const { object, castErrors } = build(input);
    if (castErrors.length === 0) {
      return pruneAddedObjects(object, record) as Record<string, unknown>;
    }
    for (const path of castErrors) {
      delete input[path.split('.')[0]];
    }
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** `built` without the empty objects that `input` does not have at the same place. */
function pruneAddedObjects(built: unknown, input: unknown): unknown {
  if (Array.isArray(built)) {
    return built.map((item, index) =>
      pruneAddedObjects(item, Array.isArray(input) ? input[index] : undefined),
    );
  }
  if (!isPlain(built)) {
    return built;
  }
  const source = isPlain(input) ? input : {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(built)) {
    if (isPlain(value) && Object.keys(value).length === 0 && source[key] === undefined) {
      continue;
    }
    result[key] = pruneAddedObjects(value, source[key]);
  }
  return result;
}

/** The hex of the typed-only records' ids (after corpus A's). */
export const typedRecordHex = (n: number): string =>
  `66000000000000000000${String(n).padStart(4, '0')}`;

/** A typed filter case (beyond the language where `beyondEvaluator`: `$size`, numeric segments). */
export interface TypedFilterCase {
  name: string;
  filter: StoreFilter | Record<string, unknown>;
  /** mongoose refuses the filter (a `CastError`, or its own error); the caster a `StoreQueryError`. */
  castFails?: boolean;
  /** Outside the evaluator's language: MongoDB alone gives the expected records. */
  beyondEvaluator?: boolean;
}

/** A typed projection case. */
export interface TypedProjectionCase extends ProjectionCase {
  /** Outside the evaluator's language (dotted paths): MongoDB alone gives the expected records. */
  beyondEvaluator?: boolean;
}

export interface TypedCorpusCases {
  filters: TypedFilterCase[];
  projections: TypedProjectionCase[];
  sorts: SortCase[];
}

/** The top-level paths a filter names. */
function filterPaths(filter: StoreFilter): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or' || key === '$and') {
      (value as StoreFilter[]).forEach((clause) => paths.push(...filterPaths(clause)));
    } else {
      paths.push(key.split('.')[0]);
    }
  }
  return paths;
}

const declared = (path: string) => TYPED_CORPUS_PATHS.includes(path.split('.')[0]);

/**
 * Corpus A filters a typed schema refuses: `$regex` on a Number or Date path (mongoose: "Can't use
 * $regex with ..."; the caster: a `StoreQueryError`).
 */
export const TYPED_CAST_FAILURES: readonly string[] = [
  '$regex never matches numbers',
  '$regex never matches Dates',
];

/**
 * Sorts by a whole object: refused on typed object paths (MongoDB compares the objects field by
 * field; the typed storage has no single value to order by).
 */
export const TYPED_REFUSED_SORTS: readonly string[] = ['profile'];

/** The typed corpus cases built over corpus A's (`corpusA` from `buildStoreQueryCorpus`). */
export function buildTypedCorpusCases(corpusA: {
  filters: FilterCase[];
  projections: ProjectionCase[];
  sorts: SortCase[];
}): TypedCorpusCases {
  const filters: TypedFilterCase[] = corpusA.filters
    .filter(({ filter }) => filterPaths(filter).every(declared))
    .map((entry) =>
      TYPED_CAST_FAILURES.includes(entry.name) ? { ...entry, castFails: true } : entry,
    );
  filters.push(
    /* Filter values cast to the declared type */
    { name: 'typed: number from a string', filter: { n: '1' } },
    { name: 'typed: number $in from strings', filter: { n: { $in: ['1', 2] } } },
    { name: 'typed: Date from an ISO string', filter: { at: '2024-01-01T00:00:00.000Z' } },
    { name: 'typed: Date range from a string', filter: { at: { $gte: '2024-06-01' } } },
    { name: 'typed: lowercase applies to filter values', filter: { email: 'ALICE@EXAMPLE.ORG' } },
    { name: 'typed: lowercase in $in', filter: { email: { $in: ['Frank@Example.com'] } } },
    { name: 'typed: boolean from a string', filter: { flag: 'true' } },
    { name: 'typed: id from upper-case hex', filter: { ref: 'AA0000000000000000000001' } },
    { name: 'typed: array element from a string', filter: { scores: '9' } },
    { name: 'typed: child path number from a string', filter: { 'items.qty': '5' } },
    { name: 'typed: nested number from a string', filter: { 'profile.zip': '75002' } },

    /* Cast failures */
    { name: 'typed: number cast fails', filter: { n: 'abc' }, castFails: true },
    { name: 'typed: Date cast fails', filter: { at: 'not a date' }, castFails: true },
    { name: 'typed: id cast fails', filter: { ref: 'xyz' }, castFails: true },
    { name: 'typed: boolean cast fails', filter: { flag: 'maybe' }, castFails: true },
    { name: 'typed: $in cast fails', filter: { n: { $in: [1, 'x'] } }, castFails: true },
    { name: 'typed: child path cast fails', filter: { 'items.qty': 'many' }, castFails: true },

    /* Explicit null versus missing */
    { name: 'typed: null scalar array', filter: { tags: null } },
    { name: 'typed: scalar array exists', filter: { tags: { $exists: true } } },
    { name: 'typed: scalar array exists false', filter: { tags: { $exists: false } } },
    { name: 'typed: null child array', filter: { items: null } },
    { name: 'typed: child array exists', filter: { items: { $exists: true } } },
    { name: 'typed: child array exists false', filter: { items: { $exists: false } } },
    { name: 'typed: child path null', filter: { 'items.qty': null } },
    { name: 'typed: child path exists', filter: { 'items.qty': { $exists: true } } },
    { name: 'typed: child path exists false', filter: { 'items.qty': { $exists: false } } },
    { name: 'typed: null object', filter: { profile: null } },
    { name: 'typed: object exists', filter: { profile: { $exists: true } } },
    { name: 'typed: object exists false', filter: { profile: { $exists: false } } },
    { name: 'typed: object $ne null', filter: { profile: { $ne: null } } },
    { name: 'typed: nested object leaf null', filter: { 'profile.geo.lat': null } },
    { name: 'typed: nested object exists', filter: { 'profile.geo': { $exists: true } } },
    { name: 'typed: null id array', filter: { refs: null } },
    { name: 'typed: $ne null on a scalar', filter: { n: { $ne: null } } },
    { name: 'typed: $nin with null on a child path', filter: { 'items.sku': { $nin: [null] } } },
    {
      name: 'typed: $in with null on a child path',
      filter: { 'items.sku': { $in: ['a2', null] } },
    },
    { name: 'typed: child array nested array contains', filter: { 'items.tags': 't' } },
    {
      name: 'typed: child array nested array $exists',
      filter: { 'items.tags': { $exists: true } },
    },

    /* Mixed (`json`) inside a typed record */
    { name: 'typed: Mixed subpath', filter: { 'meta.kind': 'a' } },
    { name: 'typed: Mixed through an array', filter: { 'meta.list.to': 'x' } },
    { name: 'typed: Mixed through an array into an array', filter: { 'meta.list.to': 'x3' } },
    { name: 'typed: Mixed deep', filter: { 'meta.nested.deep.value': { $gt: 2 } } },
    { name: 'typed: Mixed null', filter: { meta: null } },
    { name: 'typed: Mixed exists', filter: { meta: { $exists: true } } },
    { name: 'typed: Mixed subpath null', filter: { 'meta.kind': null } },
    { name: 'typed: Mixed subpath exists false', filter: { 'meta.list.from': { $exists: false } } },

    /* $size, numeric segments and array equality (no evaluator: MongoDB's results) */
    {
      name: 'typed: $size 0 on a scalar array',
      filter: { tags: { $size: 0 } },
      beyondEvaluator: true,
    },
    {
      name: 'typed: $size 1 on a scalar array',
      filter: { scores: { $size: 1 } },
      beyondEvaluator: true,
    },
    {
      name: 'typed: $size on a child array',
      filter: { items: { $size: 2 } },
      beyondEvaluator: true,
    },
    {
      name: 'typed: $size 0 on a child array',
      filter: { items: { $size: 0 } },
      beyondEvaluator: true,
    },
    { name: 'typed: $size on Mixed', filter: { 'meta.list': { $size: 3 } }, beyondEvaluator: true },
    { name: 'typed: empty array equality', filter: { tags: [] }, beyondEvaluator: true },
    { name: 'typed: empty child array equality', filter: { items: [] }, beyondEvaluator: true },
    {
      name: 'typed: numeric segment in a child array',
      filter: { 'items.0.sku': 'a1' },
      beyondEvaluator: true,
    },
    {
      name: 'typed: numeric segment, second element',
      filter: { 'items.1.qty': { $gte: 5 } },
      beyondEvaluator: true,
    },
    { name: 'typed: numeric segment null', filter: { 'items.1.sku': null }, beyondEvaluator: true },
    {
      name: 'typed: numeric segment exists',
      filter: { 'items.2': { $exists: true } },
      beyondEvaluator: true,
    },
    { name: 'typed: scalar array element', filter: { 'tags.0': 'x' }, beyondEvaluator: true },
    {
      name: 'typed: scalar array element exists',
      filter: { 'scores.2': { $exists: true } },
      beyondEvaluator: true,
    },
    {
      name: 'typed: Mixed array element',
      filter: { 'meta.list.0.to': 'x' },
      beyondEvaluator: true,
    },
    { name: 'typed: scalar array element null', filter: { 'tags.0': null }, beyondEvaluator: true },
    {
      name: 'typed: scalar array element past the end null',
      filter: { 'tags.5': null },
      beyondEvaluator: true,
    },
    {
      name: 'typed: scalar array element $ne',
      filter: { 'tags.0': { $ne: 'x' } },
      beyondEvaluator: true,
    },
    { name: 'typed: child element null', filter: { 'items.0': null }, beyondEvaluator: true },
    {
      name: 'typed: child element past the end exists false',
      filter: { 'items.5': { $exists: false } },
      beyondEvaluator: true,
    },
    {
      name: 'typed: numeric segment past the end null',
      filter: { 'items.5.sku': null },
      beyondEvaluator: true,
    },
    {
      name: 'typed: Mixed array element null',
      filter: { 'meta.list.1': null },
      beyondEvaluator: true,
    },
    {
      name: 'typed: Mixed array element exists false',
      filter: { 'meta.list.0': { $exists: false } },
      beyondEvaluator: true,
    },
  );

  const dotted = (name: string, projection: string): TypedProjectionCase => ({
    name,
    projection,
    beyondEvaluator: true,
  });
  const projections: TypedProjectionCase[] = [
    ...corpusA.projections,
    dotted('typed: nested object leaf', 'profile.city'),
    dotted('typed: child array leaf', 'items.sku'),
    dotted('typed: exclude a child array leaf', '-items.qty'),
    dotted('typed: Mixed subpath', 'meta.kind'),
    dotted('typed: Mixed through an array', 'meta.list.to'),
    dotted('typed: exclude a Mixed subpath', '-meta.nested.deep'),
  ];

  const sorts: SortCase[] = corpusA.sorts.filter(
    ({ sort }) =>
      Object.keys(sort).every(declared) &&
      !Object.keys(sort).some((path) => TYPED_REFUSED_SORTS.includes(path)),
  );
  sorts.push(
    { name: 'typed: child path with nulls ascending', sort: { 'items.sku': 1 } },
    { name: 'typed: child path nested array descending', sort: { 'items.tags': -1 } },
    { name: 'typed: id array ascending', sort: { refs: 1 } },
    { name: 'typed: Mixed subpath through arrays', sort: { 'meta.list.to': 1 } },
    { name: 'typed: nested object leaf descending', sort: { 'profile.geo.lat': -1 } },
  );
  return { filters, projections, sorts };
}

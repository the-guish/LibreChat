/**
 * Test corpus for the query language of `./query`: records and the filters, projections, sorts,
 * paging options and updates to run over them, covering every supported form and the MongoDB
 * corner cases the reference evaluator defines.
 *
 * `query.differential.spec.ts` asserts that the reference evaluator and MongoDB give the same
 * result for every case. An adapter for another database is tested against the same corpus (and
 * so against MongoDB's behavior) by comparing its results with the evaluator's.
 *
 * Test data only: nothing outside specs imports this module. It names no database: ids are built
 * by the `id` factory the test passes (an ObjectId for MongoDB, whatever id type another adapter
 * stores).
 */
import type {
  StoreFilter,
  StoreProjection,
  StoreQueryOptions,
  StoreSort,
  StoreUpdate,
} from './query';
import type { IdLike } from './common';

/** The schema's hidden (`select: false`) fields of the corpus records. */
export const CORPUS_HIDDEN_FIELDS: readonly string[] = ['secret', 'pin'];

/** Fields the schema declares as ids, which an adapter casts from strings. */
export const CORPUS_ID_FIELDS: readonly string[] = ['_id', 'ref', 'refs'];

export interface FilterCase {
  name: string;
  filter: StoreFilter;
}

export interface ProjectionCase {
  name: string;
  projection: StoreProjection | null;
}

export interface SortCase {
  name: string;
  sort: StoreSort;
}

export interface QueryOptionsCase {
  name: string;
  options: StoreQueryOptions & { sort: StoreSort };
}

export interface UpdateCase {
  name: string;
  /** The `label` of the corpus record the update applies to. */
  target: string;
  update: StoreUpdate;
  /** The update is refused (by MongoDB, and by the evaluator with a `StoreQueryError`). */
  fails?: boolean;
}

export interface UpsertCase {
  name: string;
  /** Matches nothing in an empty collection, so the update inserts. */
  filter: StoreFilter;
  update: StoreUpdate;
}

export interface StoreQueryCorpus {
  records: Array<Record<string, unknown>>;
  filters: FilterCase[];
  projections: ProjectionCase[];
  sorts: SortCase[];
  queryOptions: QueryOptionsCase[];
  updates: UpdateCase[];
  upserts: UpsertCase[];
}

/** Fixed hex ids: records are `r01`..., referenced ids `R1`.... */
export const recordHex = (n: number): string => `65000000000000000000${String(n).padStart(4, '0')}`;
export const refHex = (n: number): string => `aa0000000000000000000${String(n).padStart(3, '0')}`;

/** The instant the corpus treats as "now" (for expiry filters). */
export const CORPUS_NOW: Date = new Date('2025-06-01T00:00:00.000Z');

export function buildStoreQueryCorpus(id: (hex: string) => IdLike): StoreQueryCorpus {
  const R1 = id(refHex(1));
  const R2 = id(refHex(2));
  const R3 = id(refHex(3));
  const d = (iso: string): Date => new Date(iso);

  /* Records: one per label, each probing a different shape. `_id`s ascend with the label. */
  const records: Array<Record<string, unknown>> = [
    {
      label: 'alice',
      name: 'alice',
      email: 'alice@example.com',
      n: 1,
      flag: true,
      at: d('2024-01-01T00:00:00.000Z'),
      tags: ['x', 'y'],
      scores: [1, 5, 9],
      ref: R1,
      refs: [R1, R2],
      tenantId: 't1',
      profile: { city: 'Paris', zip: 75001, tags: ['red'] },
      items: [
        { sku: 'a1', qty: 2, tags: ['red', 'blue'] },
        { sku: 'a2', qty: 5 },
      ],
      secret: 's-alice',
      pin: '1111',
      status: 'active',
      subagentTask: { status: 'completed', attemptKey: 'k1' },
      memberIds: ['m1', 'm2'],
    },
    {
      label: 'Alice',
      name: 'Alice',
      email: 'ALICE@EXAMPLE.ORG',
      n: 1.5,
      flag: false,
      at: d('2024-06-01T12:00:00.000Z'),
      tags: ['y'],
      scores: [2],
      ref: R2,
      refs: [R2],
      tenantId: 't2',
      profile: { city: 'paris', zip: 75002 },
      items: [{ sku: 'a1', qty: 1 }],
      secret: 's-Alice',
      status: 'pending',
      memberIds: ['m2'],
    },
    {
      label: 'bob',
      name: 'bob',
      n: 2,
      at: null,
      tags: [],
      scores: [],
      ref: null,
      refs: [],
      tenantId: null,
      profile: { city: 'Lyon' },
      items: [],
      status: 'active',
      subagentTask: { status: 'running' },
    },
    {
      label: 'no-name',
      n: -2,
      flag: true,
      tags: 'solo',
      scores: 7,
      profile: null,
      items: [{ qty: 3 }, { sku: null, qty: 4 }],
      status: 'disabled',
      pin: '2222',
    },
    {
      label: 'null-name',
      name: null,
      n: 0,
      tags: [null, 'x'],
      scores: [3, '4'],
      profile: 5,
      items: [{ sku: 'b1', qty: 10 }, 'junk', [{ sku: 'nested' }]],
    },
    {
      label: 'carol',
      name: 'carol',
      email: 'carol@example.com',
      n: '5',
      at: '2024-01-01T00:00:00.000Z',
      tags: ['X'],
      tenantId: 't1',
      profile: { city: null, zip: '75003' },
      items: [{ sku: 'a2', qty: 2.5 }],
      status: 'active',
    },
    {
      label: 'elodie',
      name: 'Élodie',
      n: 10,
      at: d('2023-12-31T23:59:59.999Z'),
      tags: ['y', 'x', 'y'],
      scores: [0, -1],
      tenantId: '',
      profile: {},
      items: [{ sku: 'A1', qty: 0 }],
      memberIds: [],
    },
    { label: 'empty' },
    {
      label: 'dave',
      name: 'dave',
      n: 1,
      tags: ['x'],
      refs: [R3],
      profile: { city: 'Paris', geo: { lat: 48.8, lng: 2.3 }, tags: [] },
      items: [
        { sku: 'c1', tags: ['blue'] },
        { sku: 'c2', tags: [] },
      ],
      expiredAt: null,
    },
    {
      label: 'erin',
      name: 'erin',
      n: 3,
      at: d('2025-01-01T00:00:00.000Z'),
      tenantId: 't1',
      status: 'active',
      expiredAt: d('2026-01-01T00:00:00.000Z'),
      secret: 's-erin',
    },
    {
      label: 'frank',
      name: 'frank',
      n: 1000,
      expiredAt: d('2024-01-01T00:00:00.000Z'),
      email: 'frank@Example.com',
    },
    {
      label: 'zed',
      name: '😀 smile',
      email: 'zed@example.com',
      n: 2.0,
      tags: ['a.b'],
      ref: R3,
    },
    {
      label: 'flag-false',
      name: '',
      flag: false,
      n: null,
      status: 'active',
      subagentTask: { status: 'error', attemptKey: 'k1' },
      langfuseSampled: true,
      langfuseDestinationIds: ['dest1', 'dest2'],
    },
    {
      label: 'flag-null',
      name: 'ünïcödé',
      flag: null,
      subagentTask: null,
      langfuseSampled: false,
      langfuseDestinationIds: 'dest1',
      memberIds: ['m1'],
    },
    {
      label: 'fullwidth',
      name: 'ｚｅｄ',
      n: -0.5,
      tags: ['ｚ', '😀'],
      at: d('1969-12-31T00:00:00.000Z'),
    },
  ].map((record, index) => ({ _id: id(recordHex(index + 1)), ...record }));

  const filters: FilterCase[] = [
    /* Equality on scalars */
    { name: 'empty filter matches all', filter: {} },
    { name: 'string equality is case-sensitive', filter: { name: 'alice' } },
    { name: 'string equality (capitalized)', filter: { name: 'Alice' } },
    { name: 'empty string equality', filter: { name: '' } },
    { name: 'unicode string equality', filter: { name: 'Élodie' } },
    { name: 'number equality, int', filter: { n: 1 } },
    { name: 'number equality, double', filter: { n: 1.5 } },
    { name: 'number equality, 2.0 equals 2', filter: { n: 2.0 } },
    { name: 'number does not equal its string', filter: { n: 5 } },
    { name: 'string does not equal the number', filter: { n: '5' } },
    { name: 'boolean true', filter: { flag: true } },
    { name: 'boolean false', filter: { flag: false } },
    { name: 'Date equality', filter: { at: d('2024-01-01T00:00:00.000Z') } },
    { name: 'Date does not equal its ISO string', filter: { at: '2024-01-01T00:00:00.000Z' } },
    { name: 'two fields', filter: { name: 'alice', tenantId: 't1' } },
    { name: 'two fields, one wrong', filter: { name: 'alice', tenantId: 't2' } },

    /* null, undefined and missing */
    { name: 'null matches null and missing', filter: { name: null } },
    { name: 'undefined means null', filter: { name: undefined } },
    { name: 'null on a Date field', filter: { at: null } },
    { name: 'null on an array field (holding null, missing)', filter: { tags: null } },
    { name: 'null tenant (null or missing)', filter: { tenantId: null } },
    { name: 'empty-string tenant is not null', filter: { tenantId: '' } },
    { name: 'null on a nested path', filter: { 'profile.city': null } },
    { name: 'null on a deep missing path', filter: { 'profile.geo.lat': null } },
    { name: 'null through an array of objects', filter: { 'items.sku': null } },
    { name: 'null on an object field (empty object is not null)', filter: { profile: null } },
    { name: 'null on a field of a null object', filter: { 'subagentTask.status': null } },

    /* Ids */
    { name: 'id equality', filter: { ref: R1 } },
    { name: 'id equality by hex string', filter: { ref: refHex(2) } },
    { name: '_id by id', filter: { _id: id(recordHex(3)) } },
    { name: '_id by hex string', filter: { _id: recordHex(4) } },
    { name: 'array of ids contains id', filter: { refs: R2 } },
    { name: 'array of ids contains hex string', filter: { refs: refHex(1) } },
    { name: 'null id (null or missing)', filter: { ref: null } },

    /* Arrays */
    { name: 'array contains', filter: { tags: 'x' } },
    { name: 'array contains, case-sensitive', filter: { tags: 'X' } },
    { name: 'scalar field equals (not an array)', filter: { tags: 'solo' } },
    { name: 'array of numbers contains', filter: { scores: 5 } },
    { name: 'mixed array contains string', filter: { scores: '4' } },
    { name: 'scalar where others hold arrays', filter: { scores: 7 } },
    { name: 'array element with a dot in it', filter: { tags: 'a.b' } },
    {
      name: 'array contains (caller: langfuse destinations)',
      filter: { langfuseDestinationIds: 'dest1' },
    },

    /* Dotted paths */
    { name: 'nested object field', filter: { 'profile.city': 'Paris' } },
    { name: 'nested number', filter: { 'profile.zip': 75001 } },
    { name: 'deep nested', filter: { 'profile.geo.lat': 48.8 } },
    { name: 'nested array contains', filter: { 'profile.tags': 'red' } },
    { name: 'through array of objects', filter: { 'items.sku': 'a1' } },
    { name: 'through array of objects, number', filter: { 'items.qty': 2 } },
    { name: 'through array into nested array', filter: { 'items.tags': 'blue' } },
    { name: 'nested arrays are not traversed', filter: { 'items.sku': 'nested' } },
    { name: 'path through a scalar', filter: { 'profile.city': 5 } },
    { name: 'nested field of task', filter: { 'subagentTask.status': 'completed' } },
    {
      name: 'two nested fields',
      filter: { 'subagentTask.attemptKey': 'k1', 'subagentTask.status': 'error' },
    },

    /* $in / $nin */
    { name: '$in strings', filter: { name: { $in: ['alice', 'bob', 'nobody'] } } },
    { name: '$in with null', filter: { name: { $in: ['alice', null] } } },
    { name: '$in empty', filter: { name: { $in: [] } } },
    { name: '$in on array field', filter: { tags: { $in: ['y', 'z'] } } },
    { name: '$in mixed types', filter: { n: { $in: [1, '5', true] } } },
    { name: '$in ids and hex strings', filter: { ref: { $in: [R1, refHex(3)] } } },
    { name: '$in on _id', filter: { _id: { $in: [id(recordHex(1)), recordHex(2)] } } },
    {
      name: '$in Dates',
      filter: { at: { $in: [d('2024-01-01T00:00:00.000Z'), d('2025-01-01T00:00:00.000Z')] } },
    },
    { name: '$in through array of objects', filter: { 'items.sku': { $in: ['a2', 'b1'] } } },
    { name: '$nin strings (matches missing)', filter: { name: { $nin: ['alice', 'bob'] } } },
    { name: '$in [null] on arrays', filter: { tags: { $in: [null] } } },
    { name: '$nin [null] on arrays', filter: { tags: { $nin: [null] } } },
    {
      name: '$in and $nin together',
      filter: { status: { $in: ['active', 'pending'], $nin: ['pending'] } },
    },
    { name: '$nin with null', filter: { name: { $nin: ['alice', null] } } },
    { name: '$nin empty', filter: { name: { $nin: [] } } },
    { name: '$nin on array field', filter: { tags: { $nin: ['x'] } } },
    { name: '$nin ids (matches null and missing)', filter: { ref: { $nin: [R1, R2] } } },
    { name: '$nin through array of objects', filter: { 'items.sku': { $nin: ['a1'] } } },

    /* $ne */
    { name: '$ne string (matches missing)', filter: { name: { $ne: 'alice' } } },
    { name: '$ne null', filter: { name: { $ne: null } } },
    { name: '$ne null on array field', filter: { tags: { $ne: null } } },
    { name: '$ne on array field', filter: { tags: { $ne: 'x' } } },
    { name: '$ne true (caller: is_promoted)', filter: { flag: { $ne: true } } },
    { name: '$ne through array of objects', filter: { 'items.sku': { $ne: 'a1' } } },
    { name: '$ne null through array of objects', filter: { 'items.sku': { $ne: null } } },
    { name: '$ne nested', filter: { 'profile.city': { $ne: 'Paris' } } },
    { name: '$ne on _id by hex string', filter: { _id: { $ne: recordHex(1) } } },
    { name: '$ne empty string', filter: { tenantId: { $ne: '' } } },
    { name: '$ne id', filter: { ref: { $ne: R1 } } },
    { name: '$ne on members (caller: bulkUpdateGroups)', filter: { memberIds: { $ne: 'm1' } } },

    /* $exists */
    { name: '$exists true', filter: { name: { $exists: true } } },
    { name: '$exists false', filter: { name: { $exists: false } } },
    { name: '$exists true holds for null', filter: { at: { $exists: true } } },
    { name: '$exists on empty array', filter: { memberIds: { $exists: true } } },
    { name: '$exists nested', filter: { 'profile.city': { $exists: true } } },
    { name: '$exists false nested', filter: { 'profile.city': { $exists: false } } },
    { name: '$exists through array of objects', filter: { 'items.sku': { $exists: true } } },
    { name: '$exists false through array of objects', filter: { 'items.sku': { $exists: false } } },
    {
      name: '$exists false tenant (caller: tenant scope)',
      filter: { tenantId: { $exists: false } },
    },

    /* Ranges */
    { name: '$gt number', filter: { n: { $gt: 1 } } },
    { name: '$gte number', filter: { n: { $gte: 1 } } },
    { name: '$lt number', filter: { n: { $lt: 1 } } },
    { name: '$lte number (never matches strings or null)', filter: { n: { $lte: 2 } } },
    { name: '$gt string compares strings only', filter: { n: { $gt: '' } } },
    { name: '$gte string by code point', filter: { name: { $gte: 'b' } } },
    { name: '$lt string: capitals before lowercase', filter: { name: { $lt: 'a' } } },
    { name: '$gt string: accents and emoji after ASCII', filter: { name: { $gt: 'z' } } },
    {
      name: '$gt Date compares Dates only',
      filter: { at: { $gt: d('2024-01-01T00:00:00.000Z') } },
    },
    { name: '$lte Date', filter: { at: { $lte: d('2024-01-01T00:00:00.000Z') } } },
    { name: 'range on array elements', filter: { scores: { $gt: 6 } } },
    { name: 'range on mixed array', filter: { scores: { $gte: 3 } } },
    { name: 'two-sided range, same element or not', filter: { scores: { $gt: 1, $lt: 3 } } },
    { name: 'two-sided range on a scalar', filter: { n: { $gt: 0, $lt: 3 } } },
    { name: 'range through array of objects', filter: { 'items.qty': { $gte: 5 } } },
    { name: 'range nested', filter: { 'profile.zip': { $lt: 75002 } } },
    { name: 'range on ids (hex order)', filter: { ref: { $gt: refHex(1) } } },
    { name: 'range with $ne', filter: { n: { $gte: 1, $ne: 2 } } },

    /* Regular expressions */
    { name: '$regex prefix', filter: { name: { $regex: '^al' } } },
    { name: '$regex case-insensitive', filter: { name: { $regex: '^al', $options: 'i' } } },
    { name: '$regex empty options', filter: { name: { $regex: 'o', $options: '' } } },
    { name: 'RegExp value', filter: { name: /^A/ } },
    { name: 'RegExp value, i', filter: { email: /@example\.com$/i } },
    { name: '$regex escaped dot', filter: { tags: { $regex: '^a\\.b$' } } },
    { name: '$regex on array elements', filter: { tags: { $regex: '^[xy]$' } } },
    {
      name: '$regex through array of objects',
      filter: { 'items.sku': { $regex: '^a', $options: 'i' } },
    },
    { name: '$regex never matches numbers', filter: { n: { $regex: '5' } } },
    { name: '$regex never matches Dates', filter: { at: { $regex: '2024' } } },
    { name: '$regex unicode', filter: { name: { $regex: 'É' } } },
    {
      name: '$regex i folds non-ASCII letters',
      filter: { name: { $regex: '^élo', $options: 'i' } },
    },
    { name: '$regex i on emoji text', filter: { name: { $regex: 'SMILE$', $options: 'i' } } },
    {
      name: '$regex character class and anchors',
      filter: { email: { $regex: '^[a-z]+@example\\.(com|org)$' } },
    },
    { name: '$regex with $exists', filter: { email: { $regex: 'example', $exists: true } } },
    {
      name: 'caller: agent search ($or of i-regex on name/description)',
      filter: { $or: [{ name: /ali/i }, { description: /ali/i }] },
    },
    {
      name: 'caller: token-prefix search (search tokens or legacy regex)',
      filter: {
        $or: [{ nameTokens: /^al/ }, { nameTokens: { $exists: false }, name: /^al/i }],
      },
    },

    /* Logical */
    { name: '$or of equalities', filter: { $or: [{ name: 'alice' }, { name: 'bob' }] } },
    { name: '$or of different fields', filter: { $or: [{ n: 1000 }, { tags: 'solo' }] } },
    { name: '$or with one clause', filter: { $or: [{ flag: true }] } },
    {
      name: '$or with field condition',
      filter: { status: 'active', $or: [{ n: { $gt: 2 } }, { name: null }] },
    },
    { name: '$and', filter: { $and: [{ n: { $gte: 1 } }, { n: { $lte: 2 } }] } },
    {
      name: '$and of $or',
      filter: {
        $and: [{ $or: [{ name: 'alice' }, { name: 'dave' }] }, { $or: [{ tags: 'x' }, { n: 2 }] }],
      },
    },
    { name: '$or inside $or', filter: { $or: [{ $or: [{ n: 0 }, { n: -2 }] }, { name: 'erin' }] } },
    {
      name: 'caller: email identity without tenant',
      filter: {
        email: 'frank@Example.com',
        $or: [{ tenantId: { $exists: false } }, { tenantId: null }],
      },
    },
    {
      name: 'caller: unexpired (null expiry or in the future)',
      filter: { $or: [{ expiredAt: null }, { expiredAt: { $gt: CORPUS_NOW } }] },
    },
    {
      name: 'caller: task results by status',
      filter: {
        'subagentTask.status': { $in: ['completed', 'error', 'cancelled'] },
        'subagentTask.attemptKey': 'k1',
      },
    },
    {
      name: 'caller: tenant scope ($exists false) with fields',
      filter: { status: 'active', tenantId: { $exists: false } },
    },
    {
      name: 'caller: openid legacy issuer conditions',
      filter: {
        $or: [{ issuer: { $exists: false } }, { issuer: null }, { issuer: '' }],
        name: 'bob',
      },
    },
    {
      name: 'caller: group membership sync',
      filter: { memberIds: { $ne: 'm2' }, status: { $in: ['active', 'pending'] } },
    },
    {
      name: 'caller: members to remove',
      filter: { memberIds: 'm1', label: { $nin: ['alice'] } },
    },
    {
      name: 'caller: langfuse sampled message',
      filter: { langfuseSampled: true, langfuseDestinationIds: 'dest2' },
    },
  ];

  const projections: ProjectionCase[] = [
    { name: 'none', projection: null },
    { name: 'empty string', projection: '' },
    { name: 'empty record', projection: {} },
    { name: 'one field', projection: 'name' },
    { name: 'several fields', projection: 'name n tags' },
    { name: 'only _id', projection: '_id' },
    { name: 'inclusion without _id', projection: '-_id name' },
    { name: 'exclusion', projection: '-name' },
    { name: 'exclusion of several', projection: '-name -n -tags' },
    { name: 'exclusion of _id only', projection: '-_id' },
    { name: 'hidden field added', projection: '+secret' },
    { name: 'two hidden fields added', projection: '+secret +pin' },
    { name: 'inclusion with hidden field', projection: 'name +secret' },
    { name: 'exclusion with hidden field', projection: '-name -n +secret' },
    { name: 'hidden field without _id', projection: '+secret -_id' },
    { name: 'hidden field named in inclusion', projection: 'secret' },
    { name: 'hidden field excluded', projection: '-secret' },
    { name: 'plus on a field that is not hidden', projection: '+name' },
    { name: 'extra spaces', projection: '  name   email ' },
    { name: 'record inclusion', projection: { name: 1, email: 1 } },
    { name: 'record inclusion without _id', projection: { name: 1, _id: 0 } },
    { name: 'record only _id', projection: { _id: 1 } },
    { name: 'record exclusion', projection: { tags: 0, items: 0 } },
    { name: 'record exclusion of _id', projection: { _id: 0 } },
    { name: 'record hidden field', projection: { secret: 1 } },
    { name: 'record hidden field excluded', projection: { secret: 0 } },
    { name: 'caller: safe user projection', projection: '-password -__v -totpSecret -backupCodes' },
    { name: 'caller: projection with hidden field', projection: 'n status +pin' },
    { name: 'caller: file text excluded', projection: { text: 0 } },
  ];

  const sorts: SortCase[] = [
    { name: 'string ascending', sort: { name: 1 } },
    { name: 'string descending', sort: { name: -1 } },
    { name: 'mixed-type ascending', sort: { n: 1 } },
    { name: 'mixed-type descending', sort: { n: -1 } },
    { name: 'Date and string ascending', sort: { at: 1 } },
    { name: 'Date descending', sort: { at: -1 } },
    { name: 'array ascending (smallest element)', sort: { tags: 1 } },
    { name: 'array descending (largest element)', sort: { tags: -1 } },
    { name: 'numeric arrays ascending', sort: { scores: 1 } },
    { name: 'numeric arrays descending', sort: { scores: -1 } },
    { name: 'through array of objects ascending', sort: { 'items.qty': 1 } },
    { name: 'through array of objects descending', sort: { 'items.qty': -1 } },
    { name: 'through array of objects, strings', sort: { 'items.sku': 1 } },
    { name: 'through array of objects, strings descending', sort: { 'items.sku': -1 } },
    { name: 'nested ascending', sort: { 'profile.city': 1 } },
    { name: 'nested mixed descending', sort: { 'profile.zip': -1 } },
    { name: 'booleans', sort: { flag: 1 } },
    { name: 'booleans descending', sort: { flag: -1 } },
    { name: 'two keys', sort: { tenantId: 1, name: -1 } },
    { name: 'ids', sort: { ref: 1 } },
    { name: 'ids descending', sort: { ref: -1 } },
    { name: 'objects', sort: { profile: 1 } },
    { name: 'objects descending', sort: { profile: -1 } },
    { name: 'nested task status', sort: { 'subagentTask.status': 1 } },
    { name: 'expiry descending', sort: { expiredAt: -1 } },
    { name: 'caller: newest first', sort: { at: -1, _id: -1 } },
    { name: 'caller: oldest first', sort: { at: 1, _id: 1 } },
  ];

  const queryOptions: QueryOptionsCase[] = [
    { name: 'limit', options: { sort: { n: 1 }, limit: 3 } },
    { name: 'offset and limit', options: { sort: { n: -1 }, offset: 2, limit: 4 } },
    { name: 'offset only', options: { sort: { name: 1 }, offset: 10 } },
    { name: 'limit 0 means no limit', options: { sort: { name: 1 }, limit: 0 } },
    { name: 'negative limit means no limit', options: { sort: { name: -1 }, limit: -1 } },
    { name: 'offset past the end', options: { sort: { name: 1 }, offset: 100 } },
    { name: 'caller: latest one', options: { sort: { at: -1 }, limit: 1 } },
  ];

  const updates: UpdateCase[] = [
    /* Plain records and $set */
    { name: 'plain record sets fields', target: 'alice', update: { name: 'alicia', n: 2 } },
    {
      name: 'plain record writes an object',
      target: 'alice',
      update: { extra: { a: 1, b: [1, 2] } },
    },
    {
      name: '$set creates missing parents',
      target: 'empty',
      update: { $set: { 'profile.city': 'Rome' } },
    },
    {
      name: '$set into an existing object',
      target: 'alice',
      update: { $set: { 'profile.zip': 1 } },
    },
    {
      name: '$set creates a deep path',
      target: 'alice',
      update: { $set: { 'profile.geo.lat': 1 } },
    },
    {
      name: '$set into an empty object',
      target: 'elodie',
      update: { $set: { 'profile.city': 'Nice' } },
    },
    {
      name: '$set through null fails',
      target: 'no-name',
      update: { $set: { 'profile.city': 'x' } },
      fails: true,
    },
    {
      name: '$set through a scalar fails',
      target: 'null-name',
      update: { $set: { 'profile.city': 'x' } },
      fails: true,
    },
    {
      name: '$set through an array fails',
      target: 'alice',
      update: { $set: { 'items.sku': 'z' } },
      fails: true,
    },
    {
      name: '$set Date, id and null',
      target: 'Alice',
      update: { $set: { at: d('2030-01-01T00:00:00.000Z'), ref: R3, name: null } },
    },
    { name: '$set replaces an array', target: 'alice', update: { $set: { tags: ['z'] } } },
    {
      name: '$set replaces an object',
      target: 'alice',
      update: { $set: { profile: { city: 'Oslo' } } },
    },
    {
      name: '$set skips undefined values',
      target: 'alice',
      update: { $set: { name: undefined, n: 4 } },
    },
    {
      name: 'plain record skips undefined values',
      target: 'alice',
      update: { name: undefined, email: 'e@x' },
    },
    {
      name: '$set an empty array and object',
      target: 'alice',
      update: { $set: { tags: [], profile: {} } },
    },
    { name: '$set an empty record is a no-op', target: 'alice', update: { $set: {} } },

    /* $unset */
    { name: '$unset fields', target: 'alice', update: { $unset: { name: 1, 'profile.city': 1 } } },
    {
      name: '$unset missing fields',
      target: 'empty',
      update: { $unset: { name: 1, 'profile.city': 1 } },
    },
    {
      name: '$unset through a scalar',
      target: 'null-name',
      update: { $unset: { 'profile.city': 1 } },
    },
    { name: '$unset through null', target: 'no-name', update: { $unset: { 'profile.city': 1 } } },
    { name: '$unset through an array', target: 'alice', update: { $unset: { 'items.sku': 1 } } },
    { name: '$unset a nested field', target: 'dave', update: { $unset: { 'profile.geo.lat': 1 } } },
    {
      name: '$unset with true and empty string',
      target: 'alice',
      update: { $unset: { email: true, status: '' } },
    },

    /* $inc */
    { name: '$inc an int', target: 'alice', update: { $inc: { n: 2 } } },
    { name: '$inc a double', target: 'Alice', update: { $inc: { n: 0.25 } } },
    { name: '$inc negative', target: 'erin', update: { $inc: { n: -5 } } },
    { name: '$inc missing paths', target: 'empty', update: { $inc: { n: 1, 'stats.count': 3 } } },
    { name: '$inc a string fails', target: 'carol', update: { $inc: { n: 1 } }, fails: true },
    { name: '$inc null fails', target: 'flag-false', update: { $inc: { n: 1 } }, fails: true },

    /* $max / $min */
    { name: '$max greater', target: 'alice', update: { $max: { n: 5 } } },
    { name: '$max smaller', target: 'alice', update: { $max: { n: 0 } } },
    { name: '$max missing', target: 'empty', update: { $max: { n: 5 } } },
    { name: '$max over null', target: 'flag-false', update: { $max: { n: 5 } } },
    {
      name: '$max under a string (strings order after numbers)',
      target: 'carol',
      update: { $max: { n: 100 } },
    },
    { name: '$max Date', target: 'alice', update: { $max: { at: d('2030-01-01T00:00:00.000Z') } } },
    {
      name: '$max Date over null',
      target: 'bob',
      update: { $max: { at: d('2030-01-01T00:00:00.000Z') } },
    },
    { name: '$min smaller', target: 'alice', update: { $min: { n: -1 } } },
    { name: '$min greater', target: 'alice', update: { $min: { n: 7 } } },
    { name: '$min missing', target: 'empty', update: { $min: { 'stats.low': 4 } } },
    { name: '$min over null keeps null', target: 'flag-false', update: { $min: { n: 5 } } },
    { name: '$min under a string', target: 'carol', update: { $min: { n: 100 } } },
    { name: '$min Date', target: 'alice', update: { $min: { at: d('2000-01-01T00:00:00.000Z') } } },

    /* $push */
    { name: '$push onto an array', target: 'alice', update: { $push: { tags: 'z' } } },
    { name: '$push onto a missing path', target: 'empty', update: { $push: { tags: 'z' } } },
    {
      name: '$push onto a scalar fails',
      target: 'no-name',
      update: { $push: { tags: 'z' } },
      fails: true,
    },
    { name: '$push onto null fails', target: 'bob', update: { $push: { at: 1 } }, fails: true },
    { name: '$push $each', target: 'alice', update: { $push: { scores: { $each: [1, 2] } } } },
    { name: '$push $each empty', target: 'alice', update: { $push: { scores: { $each: [] } } } },
    {
      name: '$push $each objects',
      target: 'bob',
      update: { $push: { items: { $each: [{ sku: 'p' }, { sku: 'q', qty: 1 }] } } },
    },
    {
      name: '$push an object',
      target: 'alice',
      update: { $push: { items: { sku: 'n1', qty: 1 } } },
    },
    {
      name: '$push an array as one element',
      target: 'alice',
      update: { $push: { tags: ['p', 'q'] } },
    },
    { name: '$push a duplicate', target: 'alice', update: { $push: { tags: 'x' } } },
    {
      name: '$push into a nested missing path',
      target: 'alice',
      update: { $push: { 'profile.log': 1 } },
    },

    /* $addToSet */
    { name: '$addToSet present value', target: 'alice', update: { $addToSet: { tags: 'x' } } },
    { name: '$addToSet new value', target: 'alice', update: { $addToSet: { tags: 'z' } } },
    {
      name: '$addToSet onto a missing path',
      target: 'empty',
      update: { $addToSet: { tags: 'z' } },
    },
    {
      name: '$addToSet $each with duplicates',
      target: 'alice',
      update: { $addToSet: { tags: { $each: ['x', 'z', 'z'] } } },
    },
    {
      name: '$addToSet $each onto a missing path',
      target: 'empty',
      update: { $addToSet: { tags: { $each: ['a', 'a', 'b'] } } },
    },
    {
      name: '$addToSet keeps existing duplicates',
      target: 'elodie',
      update: { $addToSet: { tags: 'y' } },
    },
    {
      name: '$addToSet onto a scalar fails',
      target: 'no-name',
      update: { $addToSet: { tags: 'z' } },
      fails: true,
    },
    {
      name: '$addToSet $each ids',
      target: 'bob',
      update: { $addToSet: { refs: { $each: [R1, R1, R2] } } },
    },
    { name: '$addToSet present id', target: 'alice', update: { $addToSet: { refs: R1 } } },
    { name: '$addToSet new id', target: 'alice', update: { $addToSet: { refs: R3 } } },
    { name: '$addToSet 1.0 equals 1', target: 'alice', update: { $addToSet: { scores: 1.0 } } },
    {
      name: '$addToSet string beside a number',
      target: 'null-name',
      update: { $addToSet: { scores: '3' } },
    },
    { name: '$addToSet null', target: 'alice', update: { $addToSet: { tags: null } } },
    { name: 'caller: add member', target: 'Alice', update: { $addToSet: { memberIds: 'm9' } } },

    /* $pull / $pullAll */
    {
      name: '$pull removes every equal element',
      target: 'elodie',
      update: { $pull: { tags: 'y' } },
    },
    { name: '$pull an absent value', target: 'alice', update: { $pull: { tags: 'q' } } },
    { name: '$pull from a missing path', target: 'empty', update: { $pull: { tags: 'x' } } },
    {
      name: '$pull from a scalar fails',
      target: 'no-name',
      update: { $pull: { tags: 'solo' } },
      fails: true,
    },
    {
      name: '$pull through a scalar fails',
      target: 'null-name',
      update: { $pull: { 'profile.tags': 'x' } },
      fails: true,
    },
    {
      name: '$pull through null fails',
      target: 'no-name',
      update: { $pull: { 'profile.tags': 'x' } },
      fails: true,
    },
    {
      name: '$pull through a missing parent',
      target: 'empty',
      update: { $pull: { 'stats.tags': 'x' } },
    },
    {
      name: '$pull from null fails',
      target: 'flag-null',
      update: { $pull: { flag: 'x' } },
      fails: true,
    },
    { name: '$pull nested', target: 'alice', update: { $pull: { 'profile.tags': 'red' } } },
    { name: '$pull an id', target: 'alice', update: { $pull: { refs: R1 } } },
    { name: '$pull null', target: 'null-name', update: { $pull: { tags: null } } },
    { name: '$pull a number (1.0 equals 1)', target: 'alice', update: { $pull: { scores: 1.0 } } },
    { name: '$pullAll', target: 'elodie', update: { $pullAll: { tags: ['y', 'x'] } } },
    { name: 'caller: remove member', target: 'alice', update: { $pullAll: { memberIds: ['m1'] } } },
    {
      name: '$pullAll from a missing path',
      target: 'empty',
      update: { $pullAll: { memberIds: ['m1'] } },
    },

    /* $setOnInsert and combinations */
    {
      name: '$setOnInsert is ignored on update',
      target: 'alice',
      update: { $set: { n: 9 }, $setOnInsert: { created: true } },
    },
    {
      name: 'caller: plain fields with $unset',
      target: 'alice',
      update: { name: 'x', $unset: { email: 1 } },
    },
    {
      name: 'several operators',
      target: 'alice',
      update: {
        $set: { name: 'q' },
        $inc: { n: 1 },
        $push: { tags: 'w' },
        $unset: { email: 1 },
        $addToSet: { memberIds: 'm3' },
      },
    },
    { name: 'empty update is a no-op', target: 'alice', update: {} },
  ];

  const upserts: UpsertCase[] = [
    {
      name: 'caller: upsert group by external id',
      filter: { idOnTheSource: 'g1', source: 'entra' },
      update: { $setOnInsert: { name: 'Group' }, $set: { email: 'g@example.com' } },
    },
    {
      name: 'dotted equality seeds nested objects',
      filter: { 'profile.city': 'Rome', n: 1 },
      update: { $set: { name: 'r' } },
    },
    {
      name: 'operators do not seed',
      filter: { email: 'x', tenantId: { $exists: false }, n: { $gt: 1 } },
      update: { $set: { name: 'y' } },
    },
    {
      name: '$and seeds, $in does not',
      filter: { $and: [{ a: 1 }, { b: 'x' }], c: { $in: [1, 2] } },
      update: { $inc: { count: 1 } },
    },
    {
      name: 'null seeds null',
      filter: { key: 'k', name: null },
      update: { $addToSet: { tags: 'x' } },
    },
    {
      name: 'undefined seeds null',
      filter: { key: 'k', tenantId: undefined },
      update: { $set: { v: 1 } },
    },
    {
      name: 'regular expressions do not seed',
      filter: { key: 'k', name: /x/ },
      update: { $set: { v: 1 } },
    },
    {
      name: '$or does not seed',
      filter: { $or: [{ a: 1 }, { a: 2 }] },
      update: { $set: { b: 1 } },
    },
    {
      name: 'every operator on insert',
      filter: { ref: R1, d: d('2024-01-01T00:00:00.000Z') },
      update: {
        $push: { log: { $each: [1, 2] } },
        $max: { hi: 5 },
        $min: { lo: 3 },
        $inc: { count: 2 },
        $unset: { gone: 1 },
        $pull: { none: 'x' },
        $setOnInsert: { createdBy: 'seed' },
      },
    },
    { name: 'plain record on insert', filter: { key: 'k' }, update: { other: 'v' } },
    {
      name: '$set overrides a seeded field',
      filter: { key: 'k', n: 1 },
      update: { $set: { n: 2 } },
    },
  ];

  return { records, filters, projections, sorts, queryOptions, updates, upserts };
}

/**
 * Corpus C, the extended operators (docs/postgres-port/PHASE4.md §2.5, §8 C2): one case per
 * call-site shape of the store code's `$elemMatch` (filters, under `$not`, projections), `$all`,
 * `$size`, `$type`, bit tests, positional `$`, `$[]` and `$[x]` with `arrayFilters`, `$push` (with
 * `$each`/`$slice`), `$pull` by predicate and `$addToSet` on child tables, `T[]` and `json`, plus
 * the corner cases around them. Test data only: nothing outside specs imports this module, and it
 * names no database (the schema definition is built from the schema types a spec passes, so this
 * module loads no mongoose).
 *
 * The schema mirrors the shapes of §1.4: `recs` (the reconciliations: nested `checkpoint`,
 * `action` and `error` subdocuments), `codes` (backup codes), `reservations`, `nonces`,
 * `allocations` (with a nested `session`), `history`, `workspaces` (a scalar array inside
 * elements), `lastRun.mcp` (a child array under a subdocument), scalar arrays of strings,
 * numbers, dates and ids, and `json` columns shaped like message `content`, `mcpConsent`,
 * `attachments` and a free-form `meta`.
 *
 * - `extended.differential.spec.ts` checks the extended evaluator (over values cast by the
 *   descriptor caster) against MongoDB through mongoose;
 * - `collection.extended.postgres.spec.ts` checks `PgCollection` (SQL, tier 1 and tier 2, the
 *   shadow check on and off) against the evaluator and MongoDB.
 * The helpers at the end run the cases on the evaluator over records held in memory.
 */
import type { MatchOptions } from './filter';
import { storeFilterInsertSeed, StoreQueryError } from '~/ports/query';
import { applyElemMatchProjection } from './projection';
import { matchesExtendedFilter } from './filter';
import { applyExtendedUpdate } from './update';

/** The schema types a spec passes to build {@link extendedCorpusSchemaDefinition}. */
export interface ExtendedCorpusSchemaTypes {
  ObjectId: unknown;
  Mixed: unknown;
  /** A single-subdocument (or array element) schema without `_id`. */
  subdocument(definition: Record<string, unknown>): unknown;
}

/** The collection corpus C lives in. */
export const EXTENDED_CORPUS_COLLECTION = 'storequeryextended';

/** The mongoose schema definition of corpus C (no defaults: missing stays missing). */
export function extendedCorpusSchemaDefinition(
  types: ExtendedCorpusSchemaTypes,
): Record<string, unknown> {
  const list = (type: unknown) => ({ type: [type], default: undefined });
  const one = (definition: Record<string, unknown>) => ({
    type: types.subdocument(definition),
    default: undefined,
  });
  const many = (definition: Record<string, unknown>) => ({
    type: [types.subdocument(definition)],
    default: undefined,
  });
  return {
    label: String,
    user: String,
    n: Number,
    permBits: Number,
    flag: Boolean,
    at: Date,
    ref: types.ObjectId,
    tags: list(String),
    skills: list(String),
    servers: list(String),
    scores: list(Number),
    countedFor: list(Date),
    refs: list(types.ObjectId),
    recs: many({
      invocationId: String,
      status: String,
      resolution: String,
      observedAt: Date,
      attempt: Number,
      actionAdmitted: Boolean,
      checkpoint: one({ threadId: String, checkpointNs: String, checkpointId: String }),
      action: one({ name: String }),
      error: one({ message: String }),
    }),
    codes: many({ codeHash: String, used: Boolean, usedAt: Date }),
    reservations: many({ id: String, amount: Number, expiresAt: Date }),
    nonces: many({ nonce: String, expiresAt: Date }),
    allocations: many({
      attemptId: String,
      ipHash: String,
      session: one({ attemptId: String, code: String }),
    }),
    history: many({ attempt: Number, outcome: String, at: Date, error: one({ code: String }) }),
    workspaces: many({ environmentId: String, workspaceId: String, agentIds: list(String) }),
    lastRun: one({
      status: String,
      mcp: many({ server: String, status: String, reason: String }),
    }),
    content: list(types.Mixed),
    consent: types.Mixed,
    attachments: list(types.Mixed),
    meta: types.Mixed,
  };
}

export const D1: Date = new Date('2024-01-01T00:00:00.000Z');
export const D2: Date = new Date('2024-06-01T00:00:00.000Z');
export const D3: Date = new Date('2030-01-01T00:00:00.000Z');
export const NOW: Date = D2;

const ID1 = 'aa0000000000000000000001';
const ID2 = 'aa0000000000000000000002';

/** The hex of a corpus C record's `_id`. */
export const extendedRecordHex = (n: number): string =>
  `67000000000000000000${String(n).padStart(4, '0')}`;

/** The records (raw: each spec casts them through the schema). */
export const EXTENDED_RECORDS: ReadonlyArray<Record<string, unknown>> = [
  {
    _id: extendedRecordHex(1),
    label: 'alpha',
    user: 'u1',
    n: 5,
    permBits: 3,
    flag: true,
    at: D1,
    ref: ID1,
    tags: ['a', 'b'],
    skills: ['s1', 's2'],
    servers: ['srv1'],
    scores: [1, 2.5, 10],
    countedFor: [D1, D2, D3],
    refs: [ID1],
    recs: [
      {
        invocationId: 'i1',
        status: 'settled',
        resolution: 'checkpoint_verified',
        observedAt: D1,
        attempt: 1,
        checkpoint: { threadId: 't1', checkpointNs: 'ns' },
      },
      {
        invocationId: 'i2',
        status: 'invocation_pending',
        attempt: 2,
        checkpoint: { threadId: 't2', checkpointNs: 'ns', checkpointId: 'c2' },
        error: { message: 'boom' },
      },
    ],
    codes: [
      { codeHash: 'h1', used: false, usedAt: null },
      { codeHash: 'h2', used: true, usedAt: D1 },
    ],
    reservations: [
      { id: 'r1', amount: 5, expiresAt: D1 },
      { id: 'r2', amount: 7, expiresAt: D3 },
    ],
    nonces: [
      { nonce: 'n1', expiresAt: D1 },
      { nonce: 'n2', expiresAt: D3 },
    ],
    allocations: [
      { attemptId: 'a1', ipHash: 'x', session: { attemptId: 'a1', code: 'c1' } },
      { attemptId: 'a2', ipHash: 'y', session: { attemptId: 'a2', code: 'c2' } },
    ],
    history: [
      { attempt: 1, outcome: 'retry', at: D1 },
      { attempt: 2, outcome: 'retry', at: D2, error: { code: 'E' } },
    ],
    workspaces: [{ environmentId: 'e1', workspaceId: 'w1', agentIds: ['ag1'] }],
    lastRun: {
      status: 'failed',
      mcp: [
        { server: 'm1', status: 'failed', reason: 'auth' },
        { server: 'm2', status: 'ready', reason: 'none' },
      ],
    },
    content: [
      { type: 'text', text: 'hi' },
      {
        type: 'tool_call',
        tool_call: {
          id: 'tc1',
          stepId: 's1',
          output: '{"background_task_id": "bt1"}',
          backgroundTask: { taskId: 'bt1', status: 'completed', resultClaim: null },
        },
      },
      {
        type: 'tool_call',
        tool_call: {
          id: 'tc2',
          backgroundTask: { taskId: 'bt2', status: 'running', completionWakeup: true },
        },
      },
    ],
    consent: {
      consents: [
        { id: 'c1', revision: 1, revokedAtMs: null, absoluteExpiresAtMs: 9_000_000_000_000 },
        { id: 'c2', revision: 2, revokedAtMs: 5 },
      ],
    },
    attachments: [{ file_id: 'f1', filepath: '/a' }, { filepath: '' }],
    meta: { bits: 6, list: [1, 'x', [2]], n: 2.5, i: 7 },
  },
  {
    _id: extendedRecordHex(2),
    label: 'beta',
    user: 'u1',
    n: 2.5,
    permBits: 1,
    tags: ['b'],
    skills: ['s1'],
    servers: [],
    scores: [],
    recs: [{ invocationId: 'i3', status: 'settled', attempt: 1 }],
    codes: [{ codeHash: 'h3', used: false }],
    reservations: [],
    nonces: [{ nonce: 'n1', expiresAt: D3 }],
    workspaces: [],
    content: [{ type: 'text', text: 'x' }],
    consent: { consents: [] },
    attachments: [{ file_id: 7 }],
    meta: { bits: -1 },
  },
  {
    _id: extendedRecordHex(3),
    label: 'gamma',
    user: 'u2',
    n: -3,
    permBits: 0,
    tags: [],
    skills: [],
    servers: ['srv2', 'srv3'],
    scores: [3, 4],
    recs: [],
    history: [{ attempt: 1, outcome: 'dead', at: D3 }],
    lastRun: { status: 'ok' },
    consent: { consents: [{ id: 'c1', revision: 1, revokedAtMs: null }] },
    meta: null,
  },
  {
    _id: extendedRecordHex(4),
    label: 'delta',
    user: 'u2',
    n: null,
    tags: null,
    recs: null,
    codes: null,
    lastRun: null,
    content: [],
    consent: { consents: 'x' },
    meta: 5,
  },
  { _id: extendedRecordHex(5), label: 'epsilon', user: 'u3' },
  {
    _id: extendedRecordHex(6),
    label: 'zeta',
    user: 'u3',
    n: 2_147_483_648,
    permBits: 1025,
    scores: [3, 4.5],
    refs: [ID2, ID1],
    meta: { list: [{ to: 'x' }], d: D1 },
    content: [
      {
        type: 'tool_call',
        tool_call: {
          id: 'tc1',
          backgroundTask: {
            taskId: 'bt1',
            status: 'error',
            resultClaim: { kind: 'k', claimId: 'cl1', batchId: null },
            completionWakeup: true,
          },
        },
      },
    ],
  },
];

/** A filter case: the labels MongoDB returns are the ground truth. */
export interface ExtendedFilterCase {
  name: string;
  filter: Record<string, unknown>;
  /** mongoose refuses the filter; so does the descriptor caster (`StoreQueryError`). */
  castFails?: true;
}

/** A projection case (over every record). */
export interface ExtendedProjectionCase {
  name: string;
  projection: Record<string, unknown>;
}

/** Why the primitive refuses a case MongoDB accepts. */
export type ExtendedRefusal =
  | 'operator not used by the store code'
  | 'no timestamp type'
  | 'null elements in a child array';

/** An update case. */
export interface ExtendedUpdateCase {
  name: string;
  /** The record updated: the filter is `{ label: target, ...filter }`; without it, every record. */
  target?: string;
  filter?: Record<string, unknown>;
  update: Record<string, unknown>;
  arrayFilters?: Array<Record<string, unknown>>;
  /** `updateMany` (default `updateOne`). */
  many?: boolean;
  /** Paths whose value is the clock's (`$currentDate`): compared by type only. */
  volatile?: string[];
  /** The primitive (and the evaluator, where it applies) refuses what MongoDB accepts. */
  refused?: ExtendedRefusal;
  /** Refused by PostgreSQL only (the evaluator follows MongoDB). */
  refusedByPostgres?: ExtendedRefusal;
}

/** An upsert case (on the full set of records). */
export interface ExtendedUpsertCase {
  name: string;
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  arrayFilters?: Array<Record<string, unknown>>;
}

const pendingFilter = { $elemMatch: { status: { $ne: 'settled' } } };

export const EXTENDED_FILTERS: ExtendedFilterCase[] = [
  /* $elemMatch on child tables */
  {
    name: 'child $elemMatch, two fields (conversation reconciliations)',
    filter: { recs: { $elemMatch: { invocationId: 'i2', status: 'invocation_pending' } } },
  },
  {
    name: 'child $elemMatch through a nested subdocument',
    filter: {
      recs: { $elemMatch: { 'checkpoint.threadId': 't2', 'checkpoint.checkpointNs': 'ns' } },
    },
  },
  {
    name: 'child $elemMatch with $exists false on a nested path',
    filter: { recs: { $elemMatch: { 'checkpoint.checkpointId': { $exists: false } } } },
  },
  { name: 'child $elemMatch with $ne', filter: { recs: pendingFilter } },
  { name: 'child $not $elemMatch', filter: { recs: { $not: pendingFilter } } },
  {
    name: 'child $elemMatch with $in and $ne true',
    filter: {
      recs: { $elemMatch: { invocationId: { $in: ['i1', 'i9'] }, actionAdmitted: { $ne: true } } },
    },
  },
  {
    name: 'child $elemMatch backup code',
    filter: { codes: { $elemMatch: { codeHash: 'h1', used: false } } },
  },
  {
    name: 'child $not $elemMatch with a date range (nonces)',
    filter: { nonces: { $not: { $elemMatch: { nonce: 'n1', expiresAt: { $gt: D2 } } } } },
  },
  {
    name: 'child $elemMatch with a date bound (reservations)',
    filter: { reservations: { $elemMatch: { id: 'r1', amount: 5, expiresAt: { $lte: D2 } } } },
  },
  {
    name: 'child $elemMatch with a string cast to a number',
    filter: { reservations: { $elemMatch: { amount: '7' } } },
  },
  {
    name: 'child $elemMatch, workspaces',
    filter: { workspaces: { $elemMatch: { environmentId: 'e1', workspaceId: 'w1' } } },
  },
  {
    name: 'child $elemMatch under a subdocument (lastRun.mcp)',
    filter: {
      'lastRun.mcp': {
        $elemMatch: { reason: { $in: ['auth', 'x'] }, status: { $ne: 'ready' } },
      },
    },
  },
  {
    name: '$nor with child $elemMatch',
    filter: { $nor: [{ 'lastRun.mcp': { $elemMatch: { status: 'failed' } } }] },
  },
  {
    name: 'child $elemMatch through a nested subdocument (allocations)',
    filter: { allocations: { $elemMatch: { 'session.attemptId': 'a2' } } },
  },
  {
    name: 'child $elemMatch with $or',
    filter: {
      recs: { $elemMatch: { $or: [{ status: 'settled' }, { attempt: { $gte: 2 } }] } },
    },
  },
  {
    name: 'child $all of $elemMatch',
    filter: {
      recs: {
        $all: [
          { $elemMatch: { status: 'settled' } },
          { $elemMatch: { status: 'invocation_pending' } },
        ],
      },
    },
  },
  { name: 'child $elemMatch with null', filter: { codes: { $elemMatch: { usedAt: null } } } },
  {
    name: 'child $elemMatch on a scalar array inside elements',
    filter: { workspaces: { $elemMatch: { agentIds: 'ag1' } } },
  },
  {
    name: 'child $elemMatch with a nested-array $elemMatch',
    filter: { workspaces: { $elemMatch: { agentIds: { $elemMatch: { $regex: '^ag' } } } } },
  },
  {
    name: 'child path $elemMatch history error code',
    filter: { history: { $elemMatch: { 'error.code': 'E' } } },
  },
  { name: 'child path under a subdocument', filter: { 'lastRun.mcp.status': 'failed' } },
  { name: 'child path $not $in', filter: { 'recs.status': { $not: { $in: ['settled'] } } } },
  /* $elemMatch on scalar arrays */
  {
    name: 'scalar $in with $not $elemMatch $nin (skills)',
    filter: { skills: { $in: ['s1'], $not: { $elemMatch: { $nin: ['s1', 's2'] } } } },
  },
  { name: 'scalar $elemMatch range', filter: { scores: { $elemMatch: { $gt: 2, $lt: 5 } } } },
  { name: 'scalar $elemMatch $regex', filter: { tags: { $elemMatch: { $regex: '^a' } } } },
  { name: 'scalar $elemMatch on dates', filter: { countedFor: { $elemMatch: { $gte: D2 } } } },
  { name: 'scalar $elemMatch on ids', filter: { refs: { $elemMatch: { $eq: ID2 } } } },
  { name: 'scalar $elemMatch $ne', filter: { tags: { $elemMatch: { $ne: 'a' } } } },
  { name: 'scalar $all', filter: { tags: { $all: ['a', 'b'] } } },
  { name: 'scalar $all of one', filter: { scores: { $all: [3] } } },
  { name: 'scalar $all empty', filter: { tags: { $all: [] } } },
  { name: 'scalar $not $regex', filter: { tags: { $not: /^a/ } } },
  { name: '$not $gt on a scalar', filter: { n: { $not: { $gt: 3 } } } },
  /* $type */
  {
    name: '$type string on a string array (mcpServerNames)',
    filter: { servers: { $type: 'string' } },
  },
  { name: '$type double on numbers', filter: { scores: { $type: 'double' } } },
  { name: '$type int on numbers', filter: { scores: { $type: 'int' } } },
  { name: '$type number', filter: { n: { $type: 'number' } } },
  { name: '$type int on a scalar', filter: { n: { $type: 'int' } } },
  { name: '$type double on a scalar', filter: { n: { $type: 'double' } } },
  { name: '$type null', filter: { n: { $type: 'null' } } },
  { name: '$type array on a scalar array', filter: { tags: { $type: 'array' } } },
  { name: '$not $type array', filter: { tags: { $not: { $type: 'array' } } } },
  { name: '$type array on a child array', filter: { recs: { $type: 'array' } } },
  { name: '$type object on a child array', filter: { recs: { $type: 'object' } } },
  { name: '$type object on a subdocument', filter: { lastRun: { $type: 'object' } } },
  { name: '$type date', filter: { at: { $type: 'date' } } },
  { name: '$type objectId', filter: { ref: { $type: 'objectId' } } },
  { name: '$type objectId on an id array', filter: { refs: { $type: 'objectId' } } },
  { name: '$type bool', filter: { flag: { $type: 'bool' } } },
  { name: '$type by code', filter: { label: { $type: 2 } } },
  { name: '$type list with null', filter: { tags: { $type: ['null', 'array'] } } },
  { name: '$type date on a date array', filter: { countedFor: { $type: 'date' } } },
  { name: '$type string on a child path', filter: { 'recs.resolution': { $type: 'string' } } },
  /* json */
  { name: 'json $type array (message content)', filter: { content: { $type: 'array' } } },
  { name: 'json $not $type array', filter: { content: { $not: { $type: 'array' } } } },
  {
    name: 'json $elemMatch on a nested path (background task)',
    filter: { content: { $elemMatch: { 'tool_call.backgroundTask.taskId': 'bt1' } } },
  },
  {
    name: 'json $elemMatch with a regular expression',
    filter: {
      content: {
        $elemMatch: {
          type: 'tool_call',
          'tool_call.output': /"background_task_id"\s*:\s*"bt1"/,
        },
      },
    },
  },
  {
    name: 'json $elemMatch with $in and null (claims)',
    filter: {
      content: {
        $elemMatch: {
          type: 'tool_call',
          'tool_call.backgroundTask.status': { $in: ['completed', 'error'] },
          'tool_call.backgroundTask.resultClaim': null,
        },
      },
    },
  },
  {
    name: 'json $elemMatch, element index exists and $nor (schedule consent)',
    filter: {
      'consent.consents': { $elemMatch: { id: 'c1', revision: 1, revokedAtMs: null } },
      'consent.consents.0': { $exists: true },
      $nor: [
        {
          'consent.consents': {
            $elemMatch: {
              $or: [{ revokedAtMs: { $ne: null } }, { absoluteExpiresAtMs: { $lte: 1e12 } }],
            },
          },
        },
      ],
    },
  },
  {
    name: 'json $type string through an array',
    filter: { 'attachments.file_id': { $type: 'string' } },
  },
  {
    name: 'json $type string with a range',
    filter: { 'attachments.filepath': { $type: 'string', $gt: '' } },
  },
  { name: 'json $type double', filter: { 'meta.n': { $type: 'double' } } },
  { name: 'json $type int', filter: { 'meta.i': { $type: 'int' } } },
  { name: 'json $type string in an array', filter: { 'meta.list': { $type: 'string' } } },
  { name: 'json $type array', filter: { 'meta.list': { $type: 'array' } } },
  { name: 'json $type object', filter: { meta: { $type: 'object' } } },
  { name: 'json $type number', filter: { meta: { $type: 'number' } } },
  { name: 'json $type date', filter: { 'meta.d': { $type: 'date' } } },
  { name: 'json $type null', filter: { meta: { $type: 'null' } } },
  { name: 'json $all', filter: { 'meta.list': { $all: [1, 'x'] } } },
  {
    name: 'json value-form $elemMatch',
    filter: { 'meta.list': { $elemMatch: { $type: 'array' } } },
  },
  { name: 'json $elemMatch with $gt', filter: { 'meta.list': { $elemMatch: { $gte: 1 } } } },
  {
    name: 'json $elemMatch on objects',
    filter: { content: { $elemMatch: { $type: 'object' } } },
  },
  { name: 'json $size', filter: { 'consent.consents': { $size: 2 } } },
  /* bit tests */
  { name: '$bitsAnySet with a mask (mcpServer)', filter: { permBits: { $bitsAnySet: 1 } } },
  { name: '$bitsAllSet with a mask', filter: { permBits: { $bitsAllSet: 3 } } },
  { name: '$bitsAllSet with positions', filter: { permBits: { $bitsAllSet: [0, 1] } } },
  { name: '$bitsAllClear', filter: { permBits: { $bitsAllClear: 2 } } },
  { name: '$bitsAnyClear with positions', filter: { permBits: { $bitsAnyClear: [0, 10] } } },
  { name: 'bits on fractions and negatives', filter: { n: { $bitsAnySet: 1 } } },
  { name: 'bits: the sign bit', filter: { n: { $bitsAllSet: [63] } } },
  {
    name: 'bits on a scalar array (mongoose refuses it)',
    filter: { scores: { $bitsAnySet: 2 } },
    castFails: true,
  },
  {
    name: 'bits on scalar array elements through $elemMatch (mongoose refuses it)',
    filter: { scores: { $elemMatch: { $bitsAnySet: 2 } } },
    castFails: true,
  },
  { name: 'bits in json', filter: { 'meta.bits': { $bitsAllSet: 6 } } },
  /* $size and its company */
  { name: 'child $size 0', filter: { workspaces: { $size: 0 } } },
  {
    name: '$exists with $not $size 0',
    filter: { recs: { $exists: true, $not: { $size: 0 } } },
  },
  {
    name: '$or of $in [null] and $size 0 (codeWorkspaces)',
    filter: { $or: [{ workspaces: { $in: [null] } }, { workspaces: { $size: 0 } }] },
  },
  { name: 'child element past a count does not exist', filter: { 'nonces.1': { $exists: false } } },
];

export const EXTENDED_PROJECTIONS: ExtendedProjectionCase[] = [
  {
    name: 'child $elemMatch through a nested subdocument (allocations)',
    projection: { allocations: { $elemMatch: { 'session.attemptId': 'a2' } } },
  },
  {
    name: 'child $elemMatch with another field',
    projection: { label: 1, recs: { $elemMatch: { status: 'invocation_pending' } } },
  },
  {
    name: 'child $elemMatch, first of several',
    projection: { label: 1, codes: { $elemMatch: { used: false } } },
  },
  { name: 'scalar $elemMatch', projection: { label: 1, scores: { $elemMatch: { $gt: 2 } } } },
  {
    name: 'json $elemMatch',
    projection: { label: 1, content: { $elemMatch: { type: 'tool_call' } } },
  },
  {
    name: '$elemMatch without a match',
    projection: { label: 1, tags: { $elemMatch: { $eq: 'zz' } } },
  },
];

const claimFilter = {
  'part.type': 'tool_call',
  'part.tool_call.backgroundTask.taskId': { $in: ['bt1'] },
  'part.tool_call.backgroundTask.status': { $in: ['completed', 'error'] },
  $and: [{ 'part.tool_call.backgroundTask.resultClaim': null }],
};

export const EXTENDED_UPDATES: ExtendedUpdateCase[] = [
  /* positional $ on child tables */
  {
    name: '$ from $elemMatch (backup code)',
    target: 'alpha',
    filter: { codes: { $elemMatch: { codeHash: 'h1', used: false } } },
    update: { $set: { 'codes.$.used': true, 'codes.$.usedAt': D2 } },
  },
  {
    name: '$ from $elemMatch without a match',
    target: 'alpha',
    filter: { codes: { $elemMatch: { codeHash: 'hX' } } },
    update: { $set: { 'codes.$.used': true } },
  },
  {
    name: '$ set of fields, subdocuments and an unset (reconciliation persistence)',
    target: 'alpha',
    filter: { recs: { $elemMatch: { invocationId: 'i2', status: 'invocation_pending' } } },
    update: {
      $set: {
        'recs.$.status': 'persistence_pending',
        'recs.$.checkpoint': { threadId: 't9', checkpointNs: 'ns9' },
        'recs.$.action': { name: 'act' },
        'recs.$.observedAt': D2,
      },
      $unset: { 'recs.$.error': 1 },
    },
  },
  {
    name: '$ replacing the whole element',
    target: 'alpha',
    filter: { recs: { $elemMatch: { invocationId: 'i1' } } },
    update: { $set: { 'recs.$': { invocationId: 'i1', status: 'reopened', attempt: 3 } } },
  },
  {
    name: '$ from a dotted path',
    target: 'alpha',
    filter: { 'recs.invocationId': 'i2' },
    update: { $set: { 'recs.$.resolution': 'x' } },
  },
  {
    name: '$ from the last of several operators',
    target: 'alpha',
    filter: { 'recs.attempt': { $gte: 2, $lte: 5 } },
    update: { $set: { 'recs.$.resolution': 'last' } },
  },
  {
    name: '$ with $inc',
    target: 'alpha',
    filter: { 'recs.invocationId': 'i1' },
    update: { $inc: { 'recs.$.attempt': 1 } },
  },
  {
    name: '$ on a nested child path (nonce expiry)',
    target: 'alpha',
    filter: { nonces: { $elemMatch: { nonce: 'n2' } } },
    update: { $set: { 'nonces.$.expiresAt': D1 } },
  },
  {
    name: '$ under a subdocument array (lastRun.mcp)',
    target: 'alpha',
    filter: { 'lastRun.mcp.server': 'm2' },
    update: { $set: { 'lastRun.mcp.$.status': 'failed' } },
  },
  {
    name: '$ without an array condition',
    target: 'alpha',
    update: { $set: { 'recs.$.status': 'x' } },
  },
  {
    name: '$ taken from the last array condition',
    target: 'alpha',
    filter: { tags: 'b', codes: { $elemMatch: { used: true } } },
    update: { $set: { 'codes.$.usedAt': D3 } },
  },
  {
    name: '$ taken from another array (MongoDB applies its index)',
    target: 'alpha',
    filter: { codes: { $elemMatch: { used: false } }, tags: 'b' },
    update: { $set: { 'codes.$.usedAt': D3 } },
  },
  {
    name: '$ in updateMany',
    many: true,
    filter: { 'reservations.amount': { $gt: 6 } },
    update: { $set: { 'reservations.$.amount': 0 } },
  },
  /* positional $ on a scalar array */
  {
    name: 'scalar $ (conversation tag rename)',
    many: true,
    filter: { user: 'u1', tags: 'b' },
    update: { $set: { 'tags.$': 'B' } },
  },
  {
    name: 'scalar $ from $in',
    target: 'alpha',
    filter: { scores: { $in: [10, 2.5] } },
    update: { $set: { 'scores.$': 0 } },
  },
  /* $[] and $[x] */
  { name: '$[] on a child array', target: 'alpha', update: { $set: { 'codes.$[].used': true } } },
  {
    name: '$[] in updateMany',
    many: true,
    filter: { user: 'u1' },
    update: { $set: { 'codes.$[].used': false } },
  },
  {
    name: '$[x] (balance reservation renewal)',
    target: 'alpha',
    update: { $set: { 'reservations.$[held].expiresAt': D2 } },
    arrayFilters: [{ 'held.id': 'r2' }],
  },
  {
    name: '$[x] with a range and $max',
    target: 'alpha',
    update: { $max: { 'reservations.$[r].amount': 6 } },
    arrayFilters: [{ 'r.amount': { $lt: 6 } }],
  },
  {
    name: '$[x] with $or',
    target: 'alpha',
    update: { $set: { 'recs.$[r].resolution': 'or' } },
    arrayFilters: [{ $or: [{ 'r.attempt': 2 }, { 'r.invocationId': 'i1' }] }],
  },
  {
    name: '$[x] matching nothing',
    target: 'alpha',
    update: { $set: { 'reservations.$[held].expiresAt': D2 } },
    arrayFilters: [{ 'held.id': 'none' }],
  },
  {
    name: '$[x] with an unused filter',
    target: 'alpha',
    update: { $set: { 'reservations.$[held].expiresAt': D2 } },
    arrayFilters: [{ 'held.id': 'r2' }, { 'other.id': 'x' }],
  },
  {
    name: '$[x] without its filter',
    target: 'alpha',
    update: { $set: { 'reservations.$[held].expiresAt': D2 } },
  },
  {
    name: '$[x] on a missing array',
    target: 'epsilon',
    update: { $set: { 'reservations.$[held].expiresAt': D2 } },
    arrayFilters: [{ 'held.id': 'r2' }],
  },
  {
    name: '$[x] on a null array',
    target: 'delta',
    update: { $set: { 'codes.$[c].used': true } },
    arrayFilters: [{ 'c.used': false }],
  },
  {
    name: 'json $[part] stamping a claim (message claims)',
    target: 'alpha',
    update: {
      $set: { 'content.$[part].tool_call.backgroundTask.resultClaim': { kind: 'k', claimId: 'c' } },
    },
    arrayFilters: [claimFilter],
  },
  {
    name: 'json $[part] unset (claim release)',
    target: 'zeta',
    filter: { content: { $type: 'array' } },
    update: { $unset: { 'content.$[part].tool_call.backgroundTask.resultClaim': 1 } },
    arrayFilters: [
      {
        'part.tool_call.backgroundTask.resultClaim.kind': 'k',
        'part.tool_call.backgroundTask.resultClaim.claimId': 'cl1',
        'part.tool_call.backgroundTask.resultClaim.batchId': null,
      },
    ],
  },
  {
    name: 'json $[part] settle with $set and $unset (tool call result)',
    target: 'alpha',
    filter: { content: { $elemMatch: { type: 'tool_call', 'tool_call.id': 'tc2' } } },
    update: {
      $set: {
        'content.$[part].tool_call.output': 'done',
        'content.$[part].tool_call.backgrounded': true,
        'content.$[part].tool_call.backgroundTask.status': 'completed',
      },
      $unset: { 'content.$[part].tool_call.backgroundTask.completionWakeup': 1 },
    },
    arrayFilters: [{ 'part.type': 'tool_call', 'part.tool_call.id': 'tc2' }],
  },
  {
    name: 'json $ from $elemMatch',
    target: 'alpha',
    filter: { 'consent.consents': { $elemMatch: { id: 'c2' } } },
    update: { $set: { 'consent.consents.$.revokedAtMs': 9 } },
  },
  {
    name: 'scalar $[x]',
    target: 'alpha',
    update: { $set: { 'scores.$[s]': 0 } },
    arrayFilters: [{ s: { $gt: 2 } }],
  },
  /* numeric segments */
  {
    name: 'numeric segment in a child array',
    target: 'alpha',
    update: { $set: { 'recs.0.status': 'zero' } },
  },
  {
    name: 'numeric segment past the end of a scalar array',
    target: 'alpha',
    update: { $set: { 'tags.4': 'z' } },
  },
  {
    name: 'numeric segment past the end of a child array',
    target: 'alpha',
    update: { $set: { 'codes.3.used': true } },
    refusedByPostgres: 'null elements in a child array',
  },
  /* $push, $pull, $addToSet on child tables */
  {
    name: '$push under $not $elemMatch (reconciliation admission)',
    target: 'beta',
    filter: { recs: { $not: pendingFilter } },
    update: { $push: { recs: { invocationId: 'i9', status: 'invocation_pending' } } },
  },
  {
    name: '$push $each $slice negative (delivery history)',
    target: 'alpha',
    update: {
      $push: {
        history: {
          $each: [
            { attempt: 3, outcome: 'dead', at: D3, error: { code: 'X' } },
            { attempt: 4, outcome: 'retry', at: D3 },
          ],
          $slice: -3,
        },
      },
    },
  },
  {
    name: '$push $slice keeping fewer than pushed',
    target: 'gamma',
    update: { $push: { history: { $each: [{ attempt: 9 }, { attempt: 10 }], $slice: -1 } } },
  },
  {
    name: '$push $slice positive',
    target: 'alpha',
    update: { $push: { history: { $each: [{ attempt: 5 }], $slice: 1 } } },
  },
  {
    name: '$push $slice 0',
    target: 'alpha',
    update: { $push: { history: { $each: [{ attempt: 5 }], $slice: 0 } } },
  },
  {
    name: '$push $slice on a date array (schedule counters)',
    target: 'alpha',
    update: { $push: { countedFor: { $each: [D3], $slice: -2 } } },
  },
  {
    name: '$push $slice on a missing scalar array',
    target: 'epsilon',
    update: { $push: { countedFor: { $each: [D3], $slice: -2 } } },
  },
  {
    name: '$push to a missing child array',
    target: 'epsilon',
    update: { $push: { nonces: { nonce: 'n9', expiresAt: D3 } }, $inc: { n: 1 } },
  },
  {
    name: '$push onto a null child array',
    target: 'delta',
    update: { $push: { recs: { status: 'x' } } },
  },
  {
    name: '$push under a subdocument',
    target: 'alpha',
    update: { $push: { 'lastRun.mcp': { server: 'm3' } } },
  },
  {
    name: '$push under a subdocument without the array',
    target: 'gamma',
    update: { $push: { 'lastRun.mcp': { server: 'm3' } } },
  },
  {
    name: '$push creating the subdocument',
    target: 'epsilon',
    update: { $push: { 'lastRun.mcp': { server: 'm3' } } },
  },
  {
    name: '$push through a null subdocument',
    target: 'delta',
    update: { $push: { 'lastRun.mcp': { server: 'm3' } } },
  },
  {
    name: '$pull by a predicate (nonce expiry)',
    target: 'alpha',
    update: { $pull: { nonces: { expiresAt: { $lte: D2 } } } },
  },
  {
    name: '$pull by equality with $inc (reservation release)',
    target: 'alpha',
    filter: { reservations: { $elemMatch: { id: 'r1', amount: 5 } } },
    update: { $pull: { reservations: { id: 'r1' } }, $inc: { n: -5 } },
  },
  {
    name: '$pull with $in (allocations)',
    target: 'alpha',
    update: { $pull: { allocations: { attemptId: { $in: ['a1', 'zz'] } } } },
  },
  {
    name: '$pull by nested fields (reconciliation lifecycle)',
    target: 'alpha',
    filter: { recs: { $elemMatch: { invocationId: 'i2', 'checkpoint.threadId': 't2' } } },
    update: {
      $set: { flag: false },
      $pull: {
        recs: { invocationId: 'i2', status: 'invocation_pending', 'checkpoint.threadId': 't2' },
      },
    },
  },
  {
    name: '$pull from a missing child array',
    target: 'epsilon',
    update: { $pull: { recs: { status: 'x' } } },
  },
  {
    name: '$pull from a null child array',
    target: 'delta',
    update: { $pull: { recs: { status: 'x' } } },
  },
  {
    name: '$pull everything in updateMany',
    many: true,
    filter: { recs: { $exists: true, $ne: null } },
    update: { $pull: { recs: { status: { $exists: true } } } },
  },
  {
    name: '$pull from a scalar array with $in',
    target: 'alpha',
    update: { $pull: { skills: { $in: ['s1'] } } },
  },
  {
    name: '$addToSet of an equal subdocument',
    target: 'alpha',
    update: {
      $addToSet: { workspaces: { environmentId: 'e1', workspaceId: 'w1', agentIds: ['ag1'] } },
    },
  },
  {
    name: '$addToSet $each with duplicates (schedule run receipts)',
    target: 'alpha',
    update: {
      $addToSet: {
        'lastRun.mcp': {
          $each: [
            { server: 'm9' },
            { server: 'm9' },
            { server: 'm1', status: 'failed', reason: 'auth' },
          ],
        },
      },
    },
  },
  {
    name: '$addToSet to a missing child array',
    target: 'epsilon',
    update: { $addToSet: { codes: { codeHash: 'h', used: false } } },
  },
  {
    name: '$addToSet $each on a scalar array',
    target: 'alpha',
    update: { $addToSet: { tags: { $each: ['b', 'c', 'c'] } } },
  },
  /* $currentDate and refused operators */
  {
    name: '$currentDate',
    target: 'alpha',
    update: { $currentDate: { at: true, 'recs.$.observedAt': { $type: 'date' } } },
    filter: { 'recs.invocationId': 'i1' },
    volatile: ['at', 'recs.0.observedAt'],
  },
  {
    name: '$currentDate timestamp',
    target: 'alpha',
    update: { $currentDate: { at: { $type: 'timestamp' } } },
    refused: 'no timestamp type',
  },
  {
    name: '$mul',
    target: 'alpha',
    update: { $mul: { n: 2 } },
    refused: 'operator not used by the store code',
  },
  {
    name: '$pop',
    target: 'alpha',
    update: { $pop: { tags: 1 } },
    refused: 'operator not used by the store code',
  },
  {
    name: '$rename',
    target: 'alpha',
    update: { $rename: { user: 'owner' } },
    refused: 'operator not used by the store code',
  },
  {
    name: '$push $position',
    target: 'alpha',
    update: { $push: { tags: { $each: ['z'], $position: 0 } } },
    refused: 'operator not used by the store code',
  },
];

export const EXTENDED_UPSERTS: ExtendedUpsertCase[] = [
  {
    name: 'upsert with $push to a child array',
    filter: { label: 'new', user: 'u9' },
    update: { $push: { recs: { invocationId: 'n1', status: 'invocation_pending' } } },
  },
  {
    name: 'upsert with $setOnInsert of a child array',
    filter: { label: 'new2' },
    update: { $set: { n: 1 }, $setOnInsert: { codes: [{ codeHash: 'h', used: false }] } },
  },
  {
    name: 'upsert inserting with a positional $',
    filter: { label: 'new3', 'codes.codeHash': 'h' },
    update: { $set: { 'codes.$.used': true } },
  },
  {
    name: 'upsert inserting with $[x]',
    filter: { label: 'new4' },
    update: { $set: { 'codes.$[c].used': true } },
    arrayFilters: [{ 'c.used': false }],
  },
  {
    name: 'upsert updating with a positional $',
    filter: { label: 'alpha', codes: { $elemMatch: { codeHash: 'h2' } } },
    update: { $set: { 'codes.$.used': false } },
  },
  {
    name: 'upsert with $addToSet $each',
    filter: { label: 'new5' },
    update: { $addToSet: { tags: { $each: ['x', 'x', 'y'] } } },
  },
];

/* ------------------------------------------------------------------------------------------ */
/* Running the cases on the evaluator                                                          */
/* ------------------------------------------------------------------------------------------ */

type Doc = Record<string, unknown>;

const hexOf = (value: unknown): string | undefined =>
  value !== null &&
  typeof value === 'object' &&
  !(value instanceof Date) &&
  typeof (value as { toHexString?: unknown }).toHexString === 'function'
    ? (value as { toHexString(): string }).toHexString().toLowerCase()
    : undefined;

/** A comparable form of a record: ids as hex (R7), dates and binaries tagged, `undefined` dropped. */
export function canonicalRecord(value: unknown): unknown {
  const hex = hexOf(value);
  if (hex !== undefined) return hex;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(canonicalRecord);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .map(([key, nested]) => [key, canonicalRecord(nested)]),
    );
  }
  return value;
}

/** A record as the PostgreSQL store takes it: ids as hex, everything else as it is. */
export function storeRecordForm(value: unknown): unknown {
  const hex = hexOf(value);
  if (hex !== undefined) return hex;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(storeRecordForm);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, storeRecordForm(nested)]),
    );
  }
  return value;
}

/** Replaces the dates at `paths` (dotted, numeric segments for array elements) with a marker. */
export function maskVolatile(record: unknown, paths: readonly string[] = []): unknown {
  const copy = canonicalRecord(record) as Doc;
  for (const path of paths) {
    const segments = path.split('.');
    let parent: unknown = copy;
    for (const segment of segments.slice(0, -1)) {
      parent = (parent as Record<string, unknown> | undefined)?.[segment];
    }
    const last = segments[segments.length - 1];
    const holder = parent as Record<string, unknown> | undefined;
    if (holder && typeof holder === 'object' && holder[last] !== undefined) {
      const value = holder[last] as { $date?: unknown };
      holder[last] = value && typeof value === 'object' && '$date' in value ? 'a Date' : value;
    }
  }
  return copy;
}

/** The filter of an update case. */
export function updateCaseFilter(entry: ExtendedUpdateCase): Doc {
  return entry.target
    ? { label: entry.target, ...(entry.filter ?? {}) }
    : { ...(entry.filter ?? {}) };
}

/** The labels of the records matching a (cast) filter, sorted. */
export function evaluateFilterLabels(
  records: readonly Doc[],
  filter: Doc,
  options: MatchOptions = {},
): string[] {
  return records
    .filter((record) => matchesExtendedFilter(record, filter, options))
    .map((record) => record.label as string)
    .sort();
}

/** A record read with a projection of corpus C (top-level inclusions and `$elemMatch`). */
export function evaluateProjection(
  record: Doc,
  projection: Doc,
  elemMatches: ReadonlyMap<string, Doc>,
  options: MatchOptions = {},
): Doc {
  const result: Doc = { _id: record._id };
  for (const field of Object.keys(projection)) {
    if (record[field] !== undefined) result[field] = record[field];
  }
  return applyElemMatchProjection(result, elemMatches, options);
}

/** The outcome of an update case on the evaluator. */
export interface EvaluatedUpdate {
  records: Doc[];
  failed: unknown;
  matched: number;
}

/**
 * Runs a (cast) update on the records as MongoDB does: the first matching record (`updateOne`) or
 * each in turn (`updateMany`, stopping at the first failure, the earlier writes kept); with
 * `upsert`, the filter's seed with the update when none matches.
 */
export function evaluateUpdate(
  records: readonly Doc[],
  cast: { filter: Doc; update: Doc; arrayFilters?: Doc[] },
  options: MatchOptions & { many?: boolean; upsert?: boolean; now?: () => Date } = {},
): EvaluatedUpdate {
  const result = records.map((record) => ({ ...record }));
  let matched = 0;
  try {
    for (let index = 0; index < result.length; index++) {
      if (!matchesExtendedFilter(result[index], cast.filter, options)) continue;
      matched += 1;
      result[index] = applyExtendedUpdate(result[index], cast.update, {
        ...options,
        filter: cast.filter,
        arrayFilters: cast.arrayFilters,
      });
      if (!options.many) break;
    }
    if (matched === 0 && options.upsert) {
      const seed = storeFilterInsertSeed(cast.filter as never);
      result.push(
        applyExtendedUpdate(seed, cast.update, {
          ...options,
          inserting: true,
          filter: cast.filter,
          arrayFilters: cast.arrayFilters,
        }),
      );
    }
  } catch (error) {
    if (!(error instanceof StoreQueryError)) throw error;
    return { records: result, failed: error, matched };
  }
  return { records: result, failed: null, matched };
}

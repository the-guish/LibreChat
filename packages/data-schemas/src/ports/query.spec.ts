import { Types } from 'mongoose';
import type {
  FilterQuery,
  ProjectionType,
  Query,
  QueryOptions,
  SortOrder,
  UpdateQuery,
} from 'mongoose';
import type {
  StoreFieldValues,
  StoreFilter,
  StoreProjection,
  StoreProjectionRecord,
  StoreProjectionString,
  StoreQueryOptions,
  StoreSort,
  StoreUpdate,
} from './query';
import type { IAgent, IGroup, IMessage, IMongoFile, IRole, IToken, IUser } from '~/types';
import type { UserGroupMethods } from '~/methods/userGroup';
import type { MessageMethods } from '~/methods/message';
import type { Assert, Satisfies } from './conformance';
import type { AgentMethods } from '~/methods/agent';
import type { TokenMethods } from '~/methods/token';
import type { RoleMethods } from '~/methods/role';
import type { FileMethods } from '~/methods/file';
import type { UserMethods } from '~/methods/user';
import type { DeleteCount } from './common';
import {
  applyStoreProjection,
  applyStoreQueryOptions,
  applyStoreUpdate,
  assertStoreFilter,
  assertStoreProjection,
  assertStoreSort,
  assertStoreUpdate,
  compareByStoreSort,
  compareStoreValues,
  matchesStoreFilter,
  storeFilterInsertSeed,
  StoreQueryError,
} from './query';
import { buildStoreQueryCorpus, CORPUS_HIDDEN_FIELDS } from './query.corpus';

/* ------------------------------------------------------------------------------------------ */
/* Type level: fails `npm run typecheck`, not Jest                                            */
/* ------------------------------------------------------------------------------------------ */

type Extends<A, B> = [A] extends [B] ? true : false;

/** The parameter types mongoose's query builder takes for a sort and a select. */
type MongooseSortArg = Parameters<Query<unknown, unknown>['sort']>[0];
type MongooseSelectArg = Parameters<Query<unknown, unknown>['select']>[0];

/** The language is assignable to mongoose's own parameter types, for any record type. */
type MongooseChecks = [
  Assert<Extends<StoreFilter, FilterQuery<IUser>>>,
  Assert<Extends<StoreFilter, FilterQuery<IMessage>>>,
  Assert<Extends<StoreFilter, FilterQuery<IAgent>>>,
  Assert<Extends<StoreFilter, FilterQuery<IMongoFile>>>,
  Assert<Extends<StoreUpdate, UpdateQuery<IAgent>>>,
  Assert<Extends<StoreUpdate, UpdateQuery<IGroup>>>,
  Assert<Extends<StoreUpdate, Record<string, unknown>>>,
  Assert<Extends<StoreProjection, ProjectionType<IUser>>>,
  Assert<Extends<StoreProjection, MongooseSelectArg>>,
  Assert<Extends<StoreSort, MongooseSortArg>>,
  Assert<Extends<StoreSort, Record<string, SortOrder>>>,
  Assert<Extends<StoreQueryOptions, QueryOptions<IToken>>>,
];

/**
 * Ports for some of the excluded methods, stated in the language, as later units will state
 * them. Function-typed properties, so parameters are checked contravariantly: the MongoDB method
 * must accept everything the port lets a caller pass.
 */
interface UserQueryPort {
  findUser: (
    filter: StoreFilter,
    projection?: StoreProjectionString | null,
  ) => Promise<IUser | null>;
  findUsers: (
    filter: StoreFilter,
    projection?: StoreProjectionString | null,
    options?: StoreQueryOptions,
  ) => Promise<IUser[]>;
  countUsers: (filter?: StoreFilter) => Promise<number>;
  getUserById: (userId: string, projection?: StoreProjectionString | null) => Promise<IUser | null>;
}

interface MessageQueryPort {
  getMessages: (
    filter: StoreFilter,
    projection?: StoreProjectionString,
    /** `sort: false` asks for no order (the method otherwise sorts by `createdAt`). */
    options?: { sort?: StoreSort | false; limit?: number },
  ) => Promise<IMessage[]>;
  deleteMessages: (filter: StoreFilter) => Promise<DeleteCount>;
}

interface FileQueryPort {
  getFiles: (
    filter: StoreFilter,
    sort?: StoreSort | null,
    projection?: StoreProjection | null,
    limit?: number | null,
  ) => Promise<IMongoFile[] | null>;
}

interface AgentQueryPort {
  getAgents: (filter: StoreFilter, projection?: StoreProjection) => Promise<IAgent[]>;
  updateAgent: (
    filter: StoreFilter,
    update: StoreUpdate,
    options?: { updatingUserId?: string | null; forceVersion?: boolean; skipVersioning?: boolean },
  ) => Promise<IAgent | null>;
}

interface GroupQueryPort {
  findGroupById: (groupId: string, projection?: StoreProjectionRecord) => Promise<IGroup | null>;
  updateGroupById: (groupId: string, data: StoreFieldValues) => Promise<IGroup | null>;
  bulkUpdateGroups: (filter: StoreFilter, update: StoreUpdate) => Promise<unknown>;
}

interface TokenQueryPort {
  findToken: (
    query: Parameters<TokenMethods['findToken']>[0],
    options?: StoreQueryOptions,
  ) => Promise<IToken | null>;
}

interface RoleQueryPort {
  getRoleByName: (roleName: string, projection?: StoreProjectionString | null) => Promise<IRole>;
}

type PortChecks = [
  Assert<Satisfies<UserQueryPort, UserMethods>>,
  Assert<Satisfies<MessageQueryPort, MessageMethods>>,
  Assert<Satisfies<FileQueryPort, FileMethods>>,
  Assert<Satisfies<AgentQueryPort, AgentMethods>>,
  Assert<Satisfies<GroupQueryPort, UserGroupMethods>>,
  Assert<Satisfies<TokenQueryPort, TokenMethods>>,
  Assert<Satisfies<RoleQueryPort, RoleMethods>>,
];

/** Shapes the callers of the excluded methods pass today (see the report of this unit). */
const userId: string = 'aa0000000000000000000001';
const maybeEmail: string | undefined = undefined as string | undefined;
const tenantId: string | null = null as string | null;
const objectIds: Types.ObjectId[] = [new Types.ObjectId()];
const legacyIssuer: { $exists: false } | null | '' = null as { $exists: false } | null | '';
const issuerField: 'openidId' | 'idOnTheSource' = 'openidId' as 'openidId' | 'idOnTheSource';

const callerFilters: StoreFilter[] = [
  { _id: userId },
  { email: maybeEmail?.trim() },
  { email: 'a@b.c', $or: [{ tenantId: { $exists: false } }, { tenantId: null }] },
  { [issuerField]: 'sub', openidIssuer: legacyIssuer },
  { _id: { $in: objectIds } },
  { $or: [{ idOnTheSource: { $in: ['a'] } }, { _id: { $in: objectIds } }] },
  { user: userId, conversationId: 'c', messageId: { $in: ['m1', 'm2'] } },
  { user: userId, ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }) },
  { 'subagentTask.status': { $in: ['completed', 'error', 'cancelled'] } },
  { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
  { user: userId, langfuseSampled: true, langfuseDestinationIds: 'd' },
  { is_promoted: { $ne: true }, $or: [{ name: /x/i }, { description: /x/i }] },
  { file_id: { $in: ['f'] }, height: { $exists: true }, width: { $exists: true } },
  { id: 'agent', 'avatar.filepath': { $in: ['p'] } },
  { idOnTheSource: { $in: ['g'] }, source: 'entra', memberIds: { $ne: 'u' } },
];

const callerUpdates: StoreUpdate[] = [
  { tools: ['t'], actions: ['a'] },
  { avatar: { filepath: 'p', source: 's' } },
  { name: 'n', $unset: { code_environment_id: 1, git_identity: 1 } },
  { $addToSet: { memberIds: 'u' } },
  { $pullAll: { memberIds: ['u'] } },
  { $set: { name: 'g' } },
  { $unset: { disabledReason: 1, chatProjectId: 1 } },
];

const callerProjections: StoreProjection[] = [
  '_id',
  '+password',
  'email _id emailVerified',
  '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
  'messageId error unfinished +subagentTask',
  { text: 0 },
  { file_id: 1, user: 1 },
  {},
];

const callerOptions: StoreQueryOptions[] = [
  { sort: { createdAt: -1 } },
  { limit: 20, offset: 40, sort: { createdAt: -1 } },
  { limit: 1, sort: { name: 1 } },
  { sort: { createdAt: 1, _id: 1 } },
];

/* Forms outside the subset do not compile. */
// @ts-expect-error `$expr` is not in the subset
const rejectedWhere: StoreFilter = { $expr: { $gt: ['$a', 1] } };
// @ts-expect-error `$elemMatch` is not in the subset
const rejectedElemMatch: StoreFilter = { items: { $elemMatch: { sku: 'a' } } };
// @ts-expect-error equality with an embedded document is not in the subset
const rejectedEmbedded: StoreFilter = { profile: { city: 'Paris' } };
// @ts-expect-error `$options` takes `i` at most
const rejectedOptions: StoreFilter = { name: { $regex: 'a', $options: 'g' } };
// @ts-expect-error `$inc` takes numbers
const rejectedInc: StoreUpdate = { $inc: { n: 'one' } };
// @ts-expect-error sort directions are 1 and -1
const rejectedSort: StoreSort = { name: 'asc' };
// @ts-expect-error projection records take 0 and 1
const rejectedProjection: StoreProjection = { name: true };

describe('query language types', () => {
  it('are assignable to mongoose and satisfied by the MongoDB methods (type level)', () => {
    const mongooseChecks: MongooseChecks = [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ];
    const portChecks: PortChecks = [true, true, true, true, true, true, true];
    expect(mongooseChecks.every(Boolean) && portChecks.every(Boolean)).toBe(true);
  });

  it('accept the shapes callers pass, which the validator accepts too', () => {
    for (const filter of callerFilters) {
      expect(() => assertStoreFilter(filter)).not.toThrow();
    }
    for (const update of callerUpdates) {
      expect(() => assertStoreUpdate(update)).not.toThrow();
    }
    for (const projection of callerProjections) {
      expect(() => assertStoreProjection(projection)).not.toThrow();
    }
    for (const options of callerOptions) {
      expect(() => assertStoreSort(options.sort)).not.toThrow();
    }
    const rejected = [
      rejectedWhere,
      rejectedElemMatch,
      rejectedEmbedded,
      rejectedOptions,
      rejectedInc,
      rejectedSort,
      rejectedProjection,
    ];
    expect(rejected).toHaveLength(7);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Validator                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const corpus = buildStoreQueryCorpus((hex) => new Types.ObjectId(hex));

describe('assertStoreFilter', () => {
  it('accepts every corpus filter', () => {
    for (const { filter } of corpus.filters) {
      expect(() => assertStoreFilter(filter)).not.toThrow();
    }
  });

  it.each<[string, unknown, string]>([
    ['a non-object', 'name', 'a filter must be a plain object, got string'],
    ['an array', [{ a: 1 }], 'a filter must be a plain object, got an array'],
    ['$where', { $where: 'x' }, 'unsupported operator "$where"'],
    ['$expr', { $expr: { $gt: ['$a', 1] } }, 'unsupported operator "$expr"'],
    ['$text', { $text: { $search: 'x' } }, 'unsupported operator "$text"'],
    ['$nor', { $nor: [{ a: 1 }] }, 'unsupported operator "$nor"'],
    [
      '$elemMatch',
      { a: { $elemMatch: { b: 1 } } },
      'filter "a": unsupported operator "$elemMatch"',
    ],
    ['$all', { a: { $all: [1] } }, 'unsupported operator "$all"'],
    ['$size', { a: { $size: 1 } }, 'unsupported operator "$size"'],
    ['$not', { a: { $not: /x/ } }, 'unsupported operator "$not"'],
    ['$eq', { a: { $eq: 1 } }, 'unsupported operator "$eq"'],
    [
      'embedded document',
      { a: { b: 1 } },
      'equality with an embedded document is not supported (key "b")',
    ],
    ['empty object', { a: {} }, 'an empty object is equality with an embedded document'],
    ['array equality', { a: [1, 2] }, 'equality with an array is not supported'],
    ['empty $or', { $or: [] }, 'filter $or: expects a non-empty array of filters'],
    ['$and not an array', { $and: { a: 1 } }, 'filter $and: expects a non-empty array of filters'],
    ['nested invalid clause', { $or: [{ a: { $where: 1 } }] }, 'unsupported operator "$where"'],
    ['$in not an array', { a: { $in: 'x' } }, '$in: expects an array, got string'],
    [
      '$in with RegExp',
      { a: { $in: [/x/] } },
      '$in: elements must be scalars or ids, got a RegExp',
    ],
    [
      '$in with objects',
      { a: { $in: [{ b: 1 }] } },
      'elements must be scalars or ids, got an object',
    ],
    [
      '$nin with undefined',
      { a: { $nin: [undefined] } },
      'elements must be scalars or ids, got undefined',
    ],
    ['$ne with an array', { a: { $ne: [1] } }, '$ne: expects a scalar or an id, got an array'],
    ['$exists not boolean', { a: { $exists: 1 } }, '$exists: expects a boolean, got number'],
    ['$gt with null', { a: { $gt: null } }, '$gt: expects a number, a string or a Date, got null'],
    [
      '$lt with boolean',
      { a: { $lt: true } },
      '$lt: expects a number, a string or a Date, got boolean',
    ],
    ['$regex RegExp', { a: { $regex: /x/ } }, '$regex: expects a pattern string, got a RegExp'],
    ['$regex invalid', { a: { $regex: '(' } }, '$regex: invalid pattern'],
    ['$options without $regex', { a: { $options: 'i' } }, '$options: only allowed with $regex'],
    ['$options m', { a: { $regex: 'x', $options: 'm' } }, 'unsupported options "m"'],
    ['RegExp flag g', { a: /x/g }, 'regular expression flags "g" are not supported'],
    ['NaN', { a: NaN }, 'unsupported value NaN'],
    ['invalid Date', { a: new Date('nope') }, 'unsupported value a Date'],
    ['a function', { a: () => 1 }, 'unsupported value function'],
    ['positional path', { 'a.$': 1 }, 'unsupported operator or positional path "a.$"'],
    ['numeric segment', { 'items.0.sku': 'a' }, 'numeric segment "0"'],
    ['empty segment', { 'a..b': 1 }, 'path "a..b" has an empty segment'],
  ])('rejects %s', (_label, filter, message) => {
    expect(() => assertStoreFilter(filter)).toThrow(StoreQueryError);
    expect(() => assertStoreFilter(filter)).toThrow(message);
  });
});

describe('assertStoreProjection', () => {
  it('accepts every corpus projection', () => {
    for (const { projection } of corpus.projections) {
      expect(() => assertStoreProjection(projection)).not.toThrow();
    }
    expect(() => assertStoreProjection(undefined)).not.toThrow();
  });

  it.each<[string, unknown, string]>([
    ['mixed string', 'name -email', 'inclusion and exclusion cannot be mixed'],
    ['mixed record', { name: 1, email: 0 }, 'inclusion and exclusion cannot be mixed'],
    [
      'dotted path',
      'profile.city',
      'unsupported field "profile.city" (top-level field names only)',
    ],
    ['operator', { $slice: 1 }, 'unsupported field "$slice"'],
    ['record value 2', { name: 2 }, 'projection "name": expects 0 or 1, got 2'],
    ['record value true', { name: true }, 'expects 0 or 1, got true'],
    [
      'both included and excluded',
      '+secret -secret',
      'field "secret" is both included and excluded',
    ],
    ['an array', ['name'], 'a projection must be a string or a record of 0 and 1, got an array'],
    ['a number', 1, 'got number'],
  ])('rejects %s', (_label, projection, message) => {
    expect(() => assertStoreProjection(projection)).toThrow(StoreQueryError);
    expect(() => assertStoreProjection(projection)).toThrow(message);
  });
});

describe('assertStoreSort', () => {
  it('accepts every corpus sort', () => {
    for (const { sort } of corpus.sorts) {
      expect(() => assertStoreSort(sort)).not.toThrow();
    }
  });

  it.each<[string, unknown, string]>([
    ['asc', { name: 'asc' }, 'sort "name": expects 1 or -1, got "asc"'],
    ['0', { name: 0 }, 'expects 1 or -1, got 0'],
    ['$meta', { score: { $meta: 'textScore' } }, 'expects 1 or -1, got {"$meta":"textScore"}'],
    ['a string', 'name -at', 'a sort must be a record of paths, got string'],
    ['operator path', { $natural: 1 }, 'unsupported operator or positional path "$natural"'],
  ])('rejects %s', (_label, sort, message) => {
    expect(() => assertStoreSort(sort)).toThrow(StoreQueryError);
    expect(() => assertStoreSort(sort)).toThrow(message);
  });
});

describe('assertStoreUpdate', () => {
  it('accepts every corpus update', () => {
    for (const { update } of [...corpus.updates, ...corpus.upserts]) {
      expect(() => assertStoreUpdate(update)).not.toThrow();
    }
  });

  it.each<[string, unknown, string]>([
    ['a non-object', [{ $set: {} }], 'an update must be a plain object, got an array'],
    ['$rename', { $rename: { a: 'b' } }, 'update: unsupported operator "$rename"'],
    ['$mul', { $mul: { a: 2 } }, 'unsupported operator "$mul"'],
    ['$currentDate', { $currentDate: { a: true } }, 'unsupported operator "$currentDate"'],
    ['$pop', { $pop: { a: 1 } }, 'unsupported operator "$pop"'],
    ['operator not a record', { $set: 1 }, 'update $set: expects a record of paths, got number'],
    ['_id', { $set: { _id: 'x' } }, 'writing "_id" is not supported'],
    ['nested _id', { $setOnInsert: { '_id.a': 1 } }, 'writing "_id" is not supported'],
    ['positional path', { $set: { 'items.$.sku': 'a' } }, 'positional path "items.$.sku"'],
    ['array index', { $inc: { 'scores.0': 1 } }, 'numeric segment "0"'],
    ['same path twice', { $set: { a: 1 }, $inc: { a: 1 } }, 'paths "a" and "a" conflict'],
    [
      'parent and child',
      { $set: { a: { b: 1 } }, $unset: { 'a.b': 1 } },
      'paths "a" and "a.b" conflict',
    ],
    ['plain and $set', { a: 1, $set: { a: 2 } }, 'path "a" is both a plain field and in $set'],
    ['$inc string', { $inc: { a: '1' } }, '$inc "a": expects a number, got string'],
    ['$inc Infinity', { $inc: { a: Infinity } }, 'expects a number, got Infinity'],
    ['$max string', { $max: { a: 'z' } }, '$max "a": expects a number or a Date, got string'],
    ['$unset 0', { $unset: { a: 0 } }, '$unset "a": expects 1, got number'],
    [
      '$push $slice',
      { $push: { a: { $each: [1], $slice: 2 } } },
      'unsupported modifier "$slice" (only $each)',
    ],
    ['$push $each not array', { $push: { a: { $each: 1 } } }, '$push "a" $each: expects an array'],
    [
      '$addToSet object',
      { $addToSet: { a: { b: 1 } } },
      'expects a scalar or an id, got an object',
    ],
    ['$addToSet $each object', { $addToSet: { a: { $each: [{ b: 1 }] } } }, 'got an object'],
    ['$pull by condition', { $pull: { a: { $gte: 1 } } }, '$pull by condition is not supported'],
    ['$pullAll not array', { $pullAll: { a: 1 } }, '$pullAll "a": expects an array, got number'],
    ['$inc undefined', { $inc: { a: undefined } }, '$inc "a": expects a value, got undefined'],
    ['writing a function', { a: () => 1 }, 'cannot write function'],
    ['writing a Map', { a: new Map() }, 'cannot write a Map'],
    ['dotted key in a written object', { $set: { a: { 'b.c': 1 } } }, 'unsupported key "b.c"'],
    ['$ key in a written object', { a: { $gt: 1 } }, 'unsupported key "$gt"'],
  ])('rejects %s', (_label, update, message) => {
    expect(() => assertStoreUpdate(update)).toThrow(StoreQueryError);
    expect(() => assertStoreUpdate(update)).toThrow(message);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Evaluator                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** A database-neutral id: what another adapter might hand out. */
class TextId {
  constructor(private readonly hex: string) {}
  toHexString(): string {
    return this.hex;
  }
}

describe('matchesStoreFilter', () => {
  const id = new TextId('aa0000000000000000000001');
  const record = {
    _id: new TextId('650000000000000000000001'),
    name: 'alice',
    owner: id,
    members: [id, new TextId('aa0000000000000000000002')],
    tags: ['x', null],
    items: [{ sku: 'a', qty: 1 }, { qty: 3 }],
  };

  it.each<[string, StoreFilter, boolean]>([
    ['an id equals its hex string', { owner: 'aa0000000000000000000001' }, true],
    [
      'a hex string field equals an id',
      { name: 'alice', _id: new TextId('650000000000000000000001') },
      true,
    ],
    ['an array of ids contains a hex string', { members: 'aa0000000000000000000002' }, true],
    ['$in with an id', { owner: { $in: [new TextId('aa0000000000000000000001')] } }, true],
    ['an id never matches a regex', { owner: { $regex: '^aa' } }, false],
    ['uppercase hex is another string', { owner: 'AA0000000000000000000001' }, false],
    ['null matches an array holding null', { tags: null }, true],
    ['missing field through objects counts as null', { 'items.sku': null }, true],
    ['$exists through objects', { 'items.sku': { $exists: true } }, true],
    ['ranges may hold on different elements', { 'items.qty': { $gt: 2, $lt: 2 } }, true],
    ['$and', { $and: [{ name: 'alice' }, { 'items.qty': 3 }] }, true],
    ['$or', { $or: [{ name: 'bob' }, { 'items.qty': 4 }] }, false],
  ])('%s', (_label, filter, expected) => {
    expect(matchesStoreFilter(record, filter)).toBe(expected);
  });

  it('gives the same result as the corpus expects for neutral ids and ObjectIds', () => {
    const neutral = buildStoreQueryCorpus((hex) => new TextId(hex));
    for (let i = 0; i < corpus.filters.length; i++) {
      const withObjectIds = corpus.records.filter((r) =>
        matchesStoreFilter(r, corpus.filters[i].filter),
      );
      const withTextIds = neutral.records.filter((r) =>
        matchesStoreFilter(r, neutral.filters[i].filter),
      );
      expect(withTextIds.map((r) => r.label)).toEqual(withObjectIds.map((r) => r.label));
    }
  });
});

describe('applyStoreProjection', () => {
  const record = { _id: 'r1', name: 'a', email: 'e', secret: 's', pin: 'p' };

  it.each<[string, StoreProjection | null, Record<string, unknown>]>([
    ['default hides hidden fields', null, { _id: 'r1', name: 'a', email: 'e' }],
    ['inclusion', 'name', { _id: 'r1', name: 'a' }],
    ['inclusion of a hidden field', { secret: 1 }, { _id: 'r1', secret: 's' }],
    ['plus adds a hidden field', '+pin', { _id: 'r1', name: 'a', email: 'e', pin: 'p' }],
    ['exclusion with plus', '-_id -email +secret', { name: 'a', secret: 's' }],
    ['only _id', '_id', { _id: 'r1' }],
    ['no _id', { _id: 0 }, { name: 'a', email: 'e' }],
  ])('%s', (_label, projection, expected) => {
    expect(applyStoreProjection(record, projection, CORPUS_HIDDEN_FIELDS)).toEqual(expected);
  });

  it('does not change the record', () => {
    const copy = { ...record };
    applyStoreProjection(record, '-name');
    expect(record).toEqual(copy);
  });
});

describe('compareStoreValues and compareByStoreSort', () => {
  it('orders types like MongoDB', () => {
    const values = [new Date(0), true, ['a'], { a: 1 }, 'b', new TextId('00'), 2, null];
    const sorted = [...values].sort(compareStoreValues);
    expect(sorted).toEqual([null, 2, new TextId('00'), 'b', { a: 1 }, ['a'], true, new Date(0)]);
  });

  it('orders strings by code point, not locale', () => {
    expect(['é', 'z', 'Z', '😀', 'ｚ'].sort(compareStoreValues)).toEqual([
      'Z',
      'z',
      'é',
      'ｚ',
      '😀',
    ]);
  });

  it('sorts arrays by their smallest element ascending and largest descending', () => {
    const records = [{ k: 'a', v: [1, 9] }, { k: 'b', v: 5 }, { k: 'c', v: [] }, { k: 'd' }];
    expect([...records].sort(compareByStoreSort({ v: 1 })).map((r) => r.k)).toEqual([
      'c',
      'd',
      'a',
      'b',
    ]);
    expect([...records].sort(compareByStoreSort({ v: -1 })).map((r) => r.k)).toEqual([
      'a',
      'b',
      'd',
      'c',
    ]);
  });

  it('pages with applyStoreQueryOptions', () => {
    const records = [1, 2, 3, 4, 5].map((n) => ({ n }));
    expect(applyStoreQueryOptions(records, { sort: { n: -1 }, offset: 1, limit: 2 })).toEqual([
      { n: 4 },
      { n: 3 },
    ]);
    expect(applyStoreQueryOptions(records, { limit: 0 })).toEqual(records);
    expect(applyStoreQueryOptions(records)).not.toBe(records);
  });
});

describe('applyStoreUpdate', () => {
  it('does not change the record', () => {
    const record = { a: { b: [1] }, n: 1 };
    const updated = applyStoreUpdate(record, { $push: { 'a.b': 2 }, $inc: { n: 1 } });
    expect(updated).toEqual({ a: { b: [1, 2] }, n: 2 });
    expect(record).toEqual({ a: { b: [1] }, n: 1 });
  });

  it('copies written values', () => {
    const value = { list: [1] };
    const updated = applyStoreUpdate<Record<string, unknown>>({}, { $set: { v: value } });
    value.list.push(2);
    expect(updated).toEqual({ v: { list: [1] } });
  });

  it('compares ids by hex string', () => {
    const id = new TextId('aa0000000000000000000001');
    expect(
      applyStoreUpdate({ ids: [id] }, { $addToSet: { ids: 'aa0000000000000000000001' } }),
    ).toEqual({
      ids: [id],
    });
    expect(applyStoreUpdate({ ids: [id] }, { $pull: { ids: 'aa0000000000000000000001' } })).toEqual(
      {
        ids: [],
      },
    );
  });

  it('applies $setOnInsert only when inserting', () => {
    expect(applyStoreUpdate({}, { $setOnInsert: { a: 1 } })).toEqual({});
    expect(applyStoreUpdate({}, { $setOnInsert: { a: 1 } }, { inserting: true })).toEqual({ a: 1 });
  });

  it.each<[string, Record<string, unknown>, StoreUpdate, string]>([
    [
      '$inc on a string',
      { n: '1' },
      { $inc: { n: 1 } },
      '$inc "n": the stored value is string, not a number',
    ],
    [
      '$push on a scalar',
      { a: 1 },
      { $push: { a: 2 } },
      '$push "a": the stored value is number, not an array',
    ],
    [
      '$set through an array',
      { a: [{}] },
      { $set: { 'a.b': 1 } },
      'cannot write through an array at "a"',
    ],
  ])('refuses %s with a StoreQueryError', (_label, record, update, message) => {
    expect(() => applyStoreUpdate(record, update)).toThrow(StoreQueryError);
    expect(() => applyStoreUpdate(record, update)).toThrow(message);
  });
});

describe('storeFilterInsertSeed', () => {
  it('takes equality from the top level and $and', () => {
    const owner = new TextId('aa0000000000000000000001');
    expect(
      storeFilterInsertSeed({
        key: 'k',
        owner,
        'a.b': 1,
        gone: undefined,
        n: { $gt: 1 },
        r: /x/,
        $and: [{ c: true }],
        $or: [{ d: 1 }, { d: 2 }],
      }),
    ).toEqual({ key: 'k', owner, a: { b: 1 }, gone: null, c: true });
  });
});

/**
 * `indexSync` against the data store backend `DATABASE_BACKEND` names (MongoDB by default,
 * PostgreSQL under `jest.postgres.config.js`): the boot sync reads the progress of the real
 * search index sync (`getDataStoreBackend().getSearchIndexSync()`) on a test database and runs
 * the step it decides on, against an in-memory MeiliSearch (the `meilisearch` package is replaced
 * here, for this module and for the backend's search code alike).
 */
process.env.SEARCH = 'true';
process.env.MEILI_HOST = 'http://meili.index-sync.test';
process.env.MEILI_MASTER_KEY = 'index-sync-key';
process.env.MEILI_SYNC_BATCH_SIZE = '2';
process.env.MEILI_SYNC_DELAY_MS = '0';
delete process.env.MEILI_NO_SYNC;

const { createTestDataStore } = require('@librechat/data-schemas/testing');

jest.mock('meilisearch', () => {
  /** Index name → { primaryKey, documents (by primary key), settings }. */
  const mockIndexes = new Map();
  let mockTaskUid = 0;
  const indexOf = (name) => {
    if (!mockIndexes.has(name)) {
      mockIndexes.set(name, { primaryKey: undefined, documents: new Map(), settings: {} });
    }
    return mockIndexes.get(name);
  };
  const task = async () => ({ taskUid: ++mockTaskUid, status: 'enqueued' });
  const put = (name, documents, options, merge) => {
    const index = indexOf(name);
    index.primaryKey = index.primaryKey ?? options?.primaryKey;
    for (const document of documents) {
      const key = String(document[index.primaryKey]);
      index.documents.set(key, merge ? { ...index.documents.get(key), ...document } : document);
    }
    return task();
  };
  const userOf = (filter) => /^user = "(.*)"$/.exec(filter ?? '')?.[1];
  class MeiliSearch {
    index(name) {
      return {
        uid: name,
        getRawInfo: async () => ({ uid: name }),
        getSettings: async () => ({ ...indexOf(name).settings }),
        updateSettings: async (settings) => {
          Object.assign(indexOf(name).settings, settings);
          return task();
        },
        addDocuments: async (documents, options) => put(name, documents, options, false),
        addDocumentsInBatches: async (documents, _size, options) => [
          await put(name, documents, options, false),
        ],
        updateDocuments: async (documents, options) => put(name, documents, options, true),
        deleteDocument: async (id) => {
          indexOf(name).documents.delete(String(id));
          return task();
        },
        deleteDocuments: async (ids) => {
          ids.forEach((id) => indexOf(name).documents.delete(String(id)));
          return task();
        },
        getDocuments: async ({ limit = 20, offset = 0 } = {}) => ({
          results: [...indexOf(name).documents.values()].slice(offset, offset + limit),
        }),
        search: async (_query, { filter, limit = 20, offset = 0 } = {}) => {
          const user = userOf(filter);
          const hits = [...indexOf(name).documents.values()].filter(
            (document) => user === undefined || document.user === user,
          );
          return { hits: hits.slice(offset, offset + limit) };
        },
      };
    }
    createIndex(name, options) {
      indexOf(name).primaryKey = indexOf(name).primaryKey ?? options?.primaryKey;
      return task();
    }
    async waitForTask(taskUid) {
      return { taskUid, status: 'succeeded', error: null };
    }
    async health() {
      return { status: 'available' };
    }
  }
  class MeiliSearchTimeOutError extends Error {}
  return { MeiliSearch, MeiliSearchTimeOutError, mockIndexes };
});

/** No flow cache: the sync runs directly (the flow lock is not under test here). */
jest.mock('~/cache', () => ({ getLogStores: () => null }));

const { mockIndexes } = require('meilisearch');
const indexSync = require('./indexSync');

const USER = 'index-sync-user';
const created = new Date('2026-04-01T08:00:00.000Z');

/** The documents of the fake index `name`, by primary key. */
const indexed = (name) => [...(mockIndexes.get(name)?.documents.keys() ?? [])].sort();

/** Empties the fake indexes; `filterable` presets the `user` filter the sync checks for. */
const resetIndexes = (filterable) => {
  for (const name of ['messages', 'convos']) {
    if (!mockIndexes.has(name)) {
      mockIndexes.set(name, { primaryKey: undefined, documents: new Map(), settings: {} });
    }
    const index = mockIndexes.get(name);
    index.documents.clear();
    index.settings = filterable ? { filterableAttributes: ['user'] } : {};
  }
};

/** Puts index entries straight into the fake index `name`. */
const seedIndex = (name, primaryKey, documents) => {
  const index = mockIndexes.get(name);
  index.primaryKey = index.primaryKey ?? primaryKey;
  documents.forEach((document) => index.documents.set(String(document[primaryKey]), document));
};

const indexedFlags = { _meiliIndex: true, _meiliIndexSchemaVersion: 1, _meiliCleanupVersion: 1 };

describe('indexSync on the data store backend', () => {
  let store;

  beforeAll(async () => {
    store = await createTestDataStore();
  });

  afterAll(async () => {
    await store?.close();
  });

  beforeEach(async () => {
    await store.reset();
  });

  const message = (messageId, fields = {}) => ({
    _id: store.ids.generate(),
    messageId,
    conversationId: `convo-of-${messageId}`,
    user: USER,
    text: `text of ${messageId}`,
    isCreatedByUser: true,
    createdAt: created,
    updatedAt: created,
    ...fields,
  });
  const conversation = (conversationId, fields = {}) => ({
    _id: store.ids.generate(),
    conversationId,
    user: USER,
    title: `title of ${conversationId}`,
    endpoint: 'openAI',
    createdAt: created,
    updatedAt: created,
    ...fields,
  });
  const flagsOf = async (collection, key, value) =>
    (await store.read(collection)).find((record) => record[key] === value);

  it('indexes the unindexed messages and conversations it finds', async () => {
    resetIndexes(true);
    await store.seed('messages', [message('m1'), message('m2'), message('m3')]);
    await store.seed('conversations', [conversation('c1'), conversation('c2')]);

    await indexSync();

    expect(indexed('messages')).toEqual(['m1', 'm2', 'm3']);
    expect(indexed('convos')).toEqual(['c1', 'c2']);
    for (const messageId of ['m1', 'm2', 'm3']) {
      expect(await flagsOf('messages', 'messageId', messageId)).toMatchObject(indexedFlags);
    }
    for (const conversationId of ['c1', 'c2']) {
      expect(await flagsOf('conversations', 'conversationId', conversationId)).toMatchObject(
        indexedFlags,
      );
    }
    const synced = await store.read('messages');
    expect(synced.every((record) => record.updatedAt.getTime() === created.getTime())).toBe(true);
  });

  it('cleans excluded conversations without a full sync when only cleanup is pending', async () => {
    resetIndexes(true);
    const current = conversation('c-current', { ...indexedFlags, isTemporary: false });
    const excluded = conversation('c-child', {
      ...indexedFlags,
      isTemporary: false,
      subagentThread: {
        rootConversationId: 'c-current',
        parentConversationId: 'c-current',
        parentMessageId: 'm-parent',
        parentToolCallId: 'call-1',
        subagentType: 'researcher',
        subagentKind: 'agent',
        depth: 1,
      },
    });
    await store.seed('conversations', [current, excluded]);
    await store.seed('messages', [message('m-current', { ...indexedFlags, isTemporary: false })]);
    seedIndex('convos', 'conversationId', [
      { conversationId: 'c-current', user: USER, title: current.title },
      { conversationId: 'c-child', user: USER, title: excluded.title },
    ]);
    seedIndex('messages', 'messageId', [{ messageId: 'm-current', user: USER, text: 'x' }]);

    await indexSync();

    expect(indexed('convos')).toEqual(['c-current']);
    expect(indexed('messages')).toEqual(['m-current']);
    const cleaned = await flagsOf('conversations', 'conversationId', 'c-child');
    expect(cleaned._meiliIndex ?? null).toBeNull();
    expect(cleaned._meiliCleanupVersion).toBe(1);
    expect(await flagsOf('conversations', 'conversationId', 'c-current')).toMatchObject(
      indexedFlags,
    );
  });

  it('resets the flags and reindexes everything when the index settings change', async () => {
    resetIndexes(false);
    await store.seed('messages', [
      message('m1', { ...indexedFlags, isTemporary: false }),
      message('m2', { ...indexedFlags, isTemporary: false }),
      message('m-temp', { isTemporary: true, expiredAt: new Date(Date.now() + 3600_000) }),
    ]);
    await store.seed('conversations', [
      conversation('c1', { ...indexedFlags, isTemporary: false }),
    ]);

    await indexSync();

    expect(mockIndexes.get('messages').settings.filterableAttributes).toEqual(['user']);
    expect(mockIndexes.get('convos').settings.filterableAttributes).toEqual(['user']);
    expect(indexed('messages')).toEqual(['m1', 'm2']);
    expect(indexed('convos')).toEqual(['c1']);
    expect(await flagsOf('messages', 'messageId', 'm1')).toMatchObject(indexedFlags);
    expect((await flagsOf('messages', 'messageId', 'm-temp'))._meiliIndex ?? null).toBeNull();
  });
});

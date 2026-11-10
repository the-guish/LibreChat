import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MessagePageSortField } from '~/ports/message';
import { createMessageMethods, CLIENT_MESSAGE_SELECT } from './message';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/**
 * `getMessagesPage` and `searchUserMessages` restate `getMessagesByCursor` and the messages
 * route's `searchMessages` call in the message port's terms. These tests pin that each returns
 * exactly what the old call returns for the same inputs.
 */

let server: MongoMemoryServer;
const methods = createMessageMethods(mongoose);

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  await mongoose.connect(server.getUri());
  await mongoose.models.Message.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('getMessagesPage', () => {
  const user = 'user-page';
  const conversationId = uuid();

  beforeAll(async () => {
    const tied = new Date('2026-01-01T00:00:00.123Z');
    const later = new Date('2026-01-02T00:00:00.456Z');
    const endpoints = [undefined, '', 'agents', 'agents', null, 'openAI', undefined, 'agents'];
    const rows = endpoints.map((endpoint, index) => ({
      messageId: `page-${index}-${uuid()}`,
      conversationId,
      user,
      text: `message ${index}`,
      isCreatedByUser: index % 2 === 0,
      contextMeta: { calibrationRatio: 1 },
      createdAt: index < 5 ? tied : later,
      ...(index === 6 ? {} : { updatedAt: index % 3 === 0 ? tied : later }),
      ...(endpoint === undefined ? {} : { endpoint }),
    }));
    /** Another user's and another conversation's rows, which no page of this read may show. */
    const others = [
      { messageId: `other-user-${uuid()}`, conversationId, user: 'user-other' },
      { messageId: `other-convo-${uuid()}`, conversationId: uuid(), user },
    ].map((row) => ({ ...row, text: 'x', createdAt: tied, updatedAt: tied }));
    await mongoose.models.Message.collection.insertMany([...rows, ...others]);
  });

  afterAll(async () => {
    await mongoose.models.Message.deleteMany({});
  });

  const cases: Array<[MessagePageSortField, 1 | -1, number, string | undefined]> = [];
  for (const field of ['createdAt', 'updatedAt', 'endpoint'] as const) {
    for (const order of [1, -1] as const) {
      for (const limit of [1, 3, 25]) {
        cases.push([field, order, limit, undefined]);
      }
      cases.push([field, order, 2, CLIENT_MESSAGE_SELECT]);
      /** An inclusion projection keeps the sort field (see `MessagePageOptions.select`). */
      cases.push([field, order, 2, `messageId text ${field}`]);
    }
  }

  it.each(cases)(
    'returns the pages getMessagesByCursor returns (sort %s %i, limit %i, select %s)',
    async (field, order, limit, select) => {
      const filter = { conversationId, user };
      let cursor: string | null = null;
      let pages = 0;
      let rows = 0;
      for (; pages < 20; pages++) {
        const old = await methods.getMessagesByCursor(filter, {
          sortField: field,
          sortOrder: order,
          limit,
          cursor,
          select,
        });
        const page = await methods.getMessagesPage(filter, {
          sort: { field, order },
          limit,
          after: cursor,
          select,
        });
        expect(page).toEqual(old);
        rows += page.messages.length;
        if (page.nextCursor == null) {
          break;
        }
        cursor = page.nextCursor;
      }
      expect(rows).toBe(8);
      expect(pages).toBeLessThan(20);
    },
  );

  it('accepts a legacy bare sort value as getMessagesByCursor does', async () => {
    const filter = { conversationId, user };
    const bare = '2026-01-01T00:00:00.123Z';
    const old = await methods.getMessagesByCursor(filter, {
      sortField: 'createdAt',
      sortOrder: 1,
      limit: 25,
      cursor: bare,
    });
    const page = await methods.getMessagesPage(filter, {
      sort: { field: 'createdAt', order: 1 },
      limit: 25,
      after: bare,
    });
    expect(page).toEqual(old);
    expect(page.messages).toHaveLength(3);
  });

  it('starts at the first row without a cursor, whether `after` is null or absent', async () => {
    const filter = { conversationId, user };
    const old = await methods.getMessagesByCursor(filter, {
      sortField: 'updatedAt',
      sortOrder: -1,
      limit: 4,
      cursor: null,
    });
    const absent = await methods.getMessagesPage(filter, {
      sort: { field: 'updatedAt', order: -1 },
      limit: 4,
    });
    const explicitNull = await methods.getMessagesPage(filter, {
      sort: { field: 'updatedAt', order: -1 },
      limit: 4,
      after: null,
    });
    expect(absent).toEqual(old);
    expect(explicitNull).toEqual(old);
  });
});

describe('searchUserMessages', () => {
  type MeiliStub = jest.Mock<Promise<{ hits: unknown[]; [key: string]: unknown }>, unknown[]>;
  const model = () => mongoose.models.Message as unknown as { meiliSearch?: MeiliStub };

  afterEach(() => {
    delete model().meiliSearch;
  });

  /**
   * Without MEILI_HOST and MEILI_MASTER_KEY (as in every test run) the model has no meilisearch
   * plugin, so no real engine is reachable here; the tests below stub the plugin's
   * `meiliSearch` on the model and check what each method hands it and what each resolves.
   */
  it('rejects as searchMessages does when no search index is configured', async () => {
    expect(model().meiliSearch).toBeUndefined();
    const old = methods.searchMessages('needle', { filter: 'user = "u1"', limit: 5 }, true);
    const search = methods.searchUserMessages({ user: 'u1', text: 'needle', limit: 5 });
    await expect(old).rejects.toThrow('MeiliSearch plugin not registered on Message model');
    await expect(search).rejects.toThrow('MeiliSearch plugin not registered on Message model');
  });

  it.each([
    { name: 'hydrated', hydrate: true as const },
    { name: 'index-only', hydrate: false as const },
    { name: 'default', hydrate: undefined },
  ])(
    'runs the route search with the same engine arguments and hits ($name)',
    async ({ hydrate }) => {
      const user = new mongoose.Types.ObjectId().toString();
      const response = {
        hits: [
          { messageId: 'hit-1', conversationId: 'convo-1', user, text: 'needle', _id: 'x' },
          { messageId: 'hit-2', conversationId: 'convo--2', user, text: 'needles' },
        ],
        query: 'needle',
        limit: 40,
        offset: 0,
        estimatedTotalHits: 2,
        processingTimeMs: 1,
      };
      const meiliSearch: MeiliStub = jest.fn().mockResolvedValue(response);
      model().meiliSearch = meiliSearch;

      const old = await methods.searchMessages(
        'needle',
        { filter: `user = "${user}"`, limit: 40 },
        hydrate,
      );
      const result = await methods.searchUserMessages({
        user,
        text: 'needle',
        limit: 40,
        ...(hydrate === undefined ? {} : { hydrate }),
      });

      expect(meiliSearch).toHaveBeenCalledTimes(2);
      expect(meiliSearch.mock.calls[1]).toEqual(meiliSearch.mock.calls[0]);
      expect(meiliSearch.mock.calls[1]).toEqual([
        'needle',
        { filter: `user = "${user}"`, limit: 40 },
        hydrate,
      ]);
      expect(result).toEqual({ hits: old.hits });
    },
  );

  it('rejects with the engine error as searchMessages does', async () => {
    model().meiliSearch = jest.fn().mockRejectedValue(new Error('engine down'));
    await expect(
      methods.searchMessages('needle', { filter: 'user = "u1"', limit: 5 }, true),
    ).rejects.toThrow('engine down');
    await expect(
      methods.searchUserMessages({ user: 'u1', text: 'needle', limit: 5, hydrate: true }),
    ).rejects.toThrow('engine down');
  });

  it('escapes quotes and backslashes in the user id, which a stored id never contains', async () => {
    const meiliSearch: MeiliStub = jest.fn().mockResolvedValue({ hits: [] });
    model().meiliSearch = meiliSearch;
    await methods.searchUserMessages({ user: 'a" OR user = "b\\', text: 'q', limit: 1 });
    expect(meiliSearch).toHaveBeenCalledWith(
      'q',
      { filter: 'user = "a\\" OR user = \\"b\\\\"', limit: 1 },
      undefined,
    );
  });
});

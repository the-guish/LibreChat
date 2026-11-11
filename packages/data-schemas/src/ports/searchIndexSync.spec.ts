import { Mongoose } from 'mongoose';
import type { SearchIndexSync, SearchIndexSyncProgress } from './searchIndexSync';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import type { Assert, Satisfies } from './conformance';
import { batchResetMeiliFlags, createMongoSearchIndexSync } from '~/adapters/mongo/searchIndexSync';
import { createMongoDataStoreBackend } from '~/adapters/mongo/backend';
import { SEARCH_INDEX_SYNC_METHODS } from './searchIndexSync';

/**
 * The mongoMeili plugin's progress has every field the port states (plus an unused optional
 * `lastSyncedId`), hence `Satisfies` on the progress object.
 */
type PluginProgress = Awaited<ReturnType<SchemaWithMeiliMethods['getSyncProgress']>>;
type Checks = [Assert<Satisfies<SearchIndexSyncProgress, PluginProgress>>];

/** A model with the mongoMeili statics the sync uses, recording each call. */
function fakeModel(collectionName: string, calls: string[]) {
  const progress: SearchIndexSyncProgress = {
    totalProcessed: 1,
    totalDocuments: 2,
    pendingIndexing: 0,
    pendingCleanup: 0,
    isComplete: false,
  };
  return {
    collection: {
      collectionName,
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      updateMany: async () => ({ modifiedCount: 0 }),
    },
    getSyncProgress: jest.fn(async function (this: unknown) {
      calls.push(`${collectionName}.getSyncProgress`);
      expect(this).toBe(models[collectionName]);
      return progress;
    }),
    syncWithMeili: jest.fn(async function (this: unknown) {
      calls.push(`${collectionName}.syncWithMeili`);
      expect(this).toBe(models[collectionName]);
    }),
    cleanupExcludedMeiliIndex: jest.fn(async function (this: unknown) {
      calls.push(`${collectionName}.cleanupExcludedMeiliIndex`);
      expect(this).toBe(models[collectionName]);
    }),
  };
}

const models: Record<string, unknown> = {};

describe('SearchIndexSync port', () => {
  it('matches the mongoMeili plugin at the type level', () => {
    const typeChecks: Checks = [true];
    expect(typeChecks).toEqual([true]);
  });

  it('lists each method once', () => {
    expect(new Set(SEARCH_INDEX_SYNC_METHODS).size).toBe(SEARCH_INDEX_SYNC_METHODS.length);
  });

  it('is null until the Message and Conversation models are registered', () => {
    const mongoose = new Mongoose();
    expect(createMongoSearchIndexSync(mongoose)).toBeNull();
    expect(createMongoDataStoreBackend(mongoose).getSearchIndexSync()).toBeNull();
    mongoose.models.Message = fakeModel('messages', []) as unknown as SchemaWithMeiliMethods;
    expect(createMongoSearchIndexSync(mongoose)).toBeNull();
  });

  it('runs the mongoMeili statics of the matching model', async () => {
    const mongoose = new Mongoose();
    const calls: string[] = [];
    models.messages = fakeModel('messages', calls);
    models.conversations = fakeModel('conversations', calls);
    mongoose.models.Message = models.messages as SchemaWithMeiliMethods;
    mongoose.models.Conversation = models.conversations as SchemaWithMeiliMethods;

    const sync: SearchIndexSync | null = createMongoDataStoreBackend(mongoose).getSearchIndexSync();
    expect(sync).not.toBeNull();
    expect(Object.keys(sync!).sort()).toEqual([...SEARCH_INDEX_SYNC_METHODS].sort());

    await expect(sync!.getSyncProgress('messages')).resolves.toMatchObject({ totalDocuments: 2 });
    await sync!.syncIndex('conversations');
    await sync!.cleanupExcluded('messages');
    await sync!.getSyncProgress('conversations');
    expect(calls).toEqual([
      'messages.getSyncProgress',
      'conversations.syncWithMeili',
      'messages.cleanupExcludedMeiliIndex',
      'conversations.getSyncProgress',
    ]);

    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(sync!.resetSyncFlags('messages')).resolves.toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it('resets the flags on the model collection in batches', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ids = [{ _id: 'a' }, { _id: 'b' }];
    const find = jest.fn(() => ({
      limit: (size: number) => ({ toArray: async () => ids.splice(0, size) }),
    }));
    const updateMany = jest.fn(async (filter: { _id: { $in: string[] } }) => ({
      modifiedCount: filter._id.$in.length,
    }));
    const previous = {
      size: process.env.MEILI_SYNC_BATCH_SIZE,
      delay: process.env.MEILI_SYNC_DELAY_MS,
    };
    process.env.MEILI_SYNC_BATCH_SIZE = '1';
    process.env.MEILI_SYNC_DELAY_MS = '0';
    try {
      const collection = { collectionName: 'messages', find, updateMany };
      await expect(
        batchResetMeiliFlags(collection as unknown as Parameters<typeof batchResetMeiliFlags>[0]),
      ).resolves.toBe(2);
      expect(updateMany).toHaveBeenNthCalledWith(
        1,
        { _id: { $in: ['a'] } },
        { $set: { _meiliIndex: false } },
      );
      expect(updateMany).toHaveBeenNthCalledWith(
        2,
        { _id: { $in: ['b'] } },
        { $set: { _meiliIndex: false } },
      );
      expect(find).toHaveBeenCalledTimes(3);
      expect(find).toHaveBeenCalledWith(expect.objectContaining({ _meiliIndex: { $ne: false } }), {
        projection: { _id: 1 },
      });
      expect(write).toHaveBeenLastCalledWith('\r  Updating messages: 2 documents...');
    } finally {
      write.mockRestore();
      for (const [name, value] of [
        ['MEILI_SYNC_BATCH_SIZE', previous.size],
        ['MEILI_SYNC_DELAY_MS', previous.delay],
      ] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

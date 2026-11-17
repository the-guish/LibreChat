import type { Mongoose, mongo } from 'mongoose';
import type { SearchIndexName, SearchIndexSync } from '~/ports/searchIndexSync';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import { resetMeiliSyncFlags } from '~/search/meiliIndexer';

/** The part of a MongoDB collection (driver or mongoose) {@link batchResetMeiliFlags} uses. */
export type MeiliFlagCollection = Pick<mongo.Collection, 'collectionName' | 'find' | 'updateMany'>;

/**
 * Batch update documents in chunks to avoid timeouts on weak instances: sets `_meiliIndex` to
 * `false` on every visible document (see `buildRetentionVisibilityFilter`) that is not already
 * `false`, so the next sync reindexes it. Batch size and delay come from `MEILI_SYNC_BATCH_SIZE`
 * (default 1000) and `MEILI_SYNC_DELAY_MS` (default 100); progress is written to stdout. The loop
 * is `resetMeiliSyncFlags` (`~/search/meiliIndexer`) on the collection.
 *
 * MongoDB only: used by the MongoDB search index sync and by `config/reset-meili-sync.js`.
 * @param collection - MongoDB collection (the driver's, or a model's `collection`)
 * @returns Total modified count
 * @throws {Error} - Throws if database operations fail (e.g., network issues, connection loss, permission problems)
 */
export async function batchResetMeiliFlags(collection: MeiliFlagCollection): Promise<number> {
  return resetMeiliSyncFlags({
    collectionName: collection.collectionName,
    findIds: async (filter, limit) => {
      const docs = await collection
        .find(filter as mongo.Filter<mongo.Document>, { projection: { _id: 1 } })
        .limit(limit)
        .toArray();
      return docs.map((doc) => doc._id);
    },
    markUnindexed: async (ids) => {
      const result = await collection.updateMany(
        { _id: { $in: ids as mongo.Document['_id'][] } },
        { $set: { _meiliIndex: false } },
      );
      return result.modifiedCount;
    },
  });
}

/** The mongoose model that holds each searchable kind of data. */
const SEARCH_INDEX_MODELS: Record<SearchIndexName, string> = {
  messages: 'Message',
  conversations: 'Conversation',
};

/**
 * The MongoDB search index sync: the mongoMeili plugin's statics on the `Message` and
 * `Conversation` models (`getSyncProgress`, `syncWithMeili`, `cleanupExcludedMeiliIndex`) and
 * {@link batchResetMeiliFlags} on their collections. The models are looked up on `mongoose` once,
 * here; `null` when either is not registered.
 */
export function createMongoSearchIndexSync(mongoose: Mongoose): SearchIndexSync | null {
  const messages = mongoose.models[SEARCH_INDEX_MODELS.messages] as
    | SchemaWithMeiliMethods
    | undefined;
  const conversations = mongoose.models[SEARCH_INDEX_MODELS.conversations] as
    | SchemaWithMeiliMethods
    | undefined;
  if (!messages || !conversations) {
    return null;
  }
  const models: Record<SearchIndexName, SchemaWithMeiliMethods> = { messages, conversations };
  return {
    getSyncProgress: (index) => models[index].getSyncProgress(),
    syncIndex: (index) => models[index].syncWithMeili(),
    cleanupExcluded: (index) => models[index].cleanupExcludedMeiliIndex(),
    resetSyncFlags: (index) => batchResetMeiliFlags(models[index].collection),
  };
}

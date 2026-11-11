import type { Mongoose, mongo } from 'mongoose';
import type { SearchIndexName, SearchIndexSync } from '~/ports/searchIndexSync';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
import logger from '~/config/winston';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The part of a MongoDB collection (driver or mongoose) {@link batchResetMeiliFlags} uses. */
export type MeiliFlagCollection = Pick<mongo.Collection, 'collectionName' | 'find' | 'updateMany'>;

/**
 * Parse and validate an environment variable as a positive integer
 * @param varName - Environment variable name
 * @param defaultValue - Default value to use if invalid or missing
 * @returns Parsed value or default
 */
function parseEnvInt(varName: string, defaultValue: number): number {
  const value = process.env[varName];
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    logger.warn(
      `[batchResetMeiliFlags] Invalid value for ${varName}="${value}". Expected a positive integer. Using default: ${defaultValue}`,
    );
    return defaultValue;
  }

  return parsed;
}

/**
 * Batch update documents in chunks to avoid timeouts on weak instances: sets `_meiliIndex` to
 * `false` on every visible document (see `buildRetentionVisibilityFilter`) that is not already
 * `false`, so the next sync reindexes it. Batch size and delay come from `MEILI_SYNC_BATCH_SIZE`
 * (default 1000) and `MEILI_SYNC_DELAY_MS` (default 100); progress is written to stdout.
 *
 * MongoDB only: used by the MongoDB search index sync and by `config/reset-meili-sync.js`.
 * @param collection - MongoDB collection (the driver's, or a model's `collection`)
 * @returns Total modified count
 * @throws {Error} - Throws if database operations fail (e.g., network issues, connection loss, permission problems)
 */
export async function batchResetMeiliFlags(collection: MeiliFlagCollection): Promise<number> {
  const DEFAULT_BATCH_SIZE = 1000;

  let BATCH_SIZE = parseEnvInt('MEILI_SYNC_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  if (BATCH_SIZE === 0) {
    logger.warn(
      `[batchResetMeiliFlags] MEILI_SYNC_BATCH_SIZE cannot be 0. Using default: ${DEFAULT_BATCH_SIZE}`,
    );
    BATCH_SIZE = DEFAULT_BATCH_SIZE;
  }

  const BATCH_DELAY_MS = parseEnvInt('MEILI_SYNC_DELAY_MS', 100);
  let totalModified = 0;
  let hasMore = true;

  try {
    while (hasMore) {
      /** Rebuilt per batch (it compares with the current time); typed for the driver. */
      const visible = buildRetentionVisibilityFilter() as mongo.Filter<mongo.Document>;
      const docs = await collection
        .find({ ...visible, _meiliIndex: { $ne: false } }, { projection: { _id: 1 } })
        .limit(BATCH_SIZE)
        .toArray();

      if (docs.length === 0) {
        break;
      }

      const ids = docs.map((doc) => doc._id);
      const result = await collection.updateMany(
        { _id: { $in: ids } },
        { $set: { _meiliIndex: false } },
      );

      totalModified += result.modifiedCount;
      process.stdout.write(
        `\r  Updating ${collection.collectionName}: ${totalModified} documents...`,
      );

      if (docs.length < BATCH_SIZE) {
        hasMore = false;
      }

      if (hasMore && BATCH_DELAY_MS > 0) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    return totalModified;
  } catch (error) {
    throw new Error(
      `Failed to batch reset Meili flags for collection '${collection.collectionName}' after processing ${totalModified} documents: ${(error as Error).message}`,
    );
  }
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

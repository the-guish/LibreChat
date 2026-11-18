import _ from 'lodash';
import type {
  CallbackWithoutResultAndOptionalError,
  FilterQuery,
  Document,
  Schema,
  Query,
  Types,
  Model,
} from 'mongoose';
import type { SearchResponse, SearchParams, Index, MeiliSearch } from 'meilisearch';
import type { MeiliIndexable, MeiliSyncProgress } from '~/search/meiliIndexer';
import type { IConversation, IMessage } from '~/types';
import {
  MEILI_INDEXED_UPDATE,
  MEILI_CLEANED_UPDATE,
  MEILI_CLEANUP_VERSION,
  isIndexableRecord,
  createMeiliClient,
  ensureMeiliIndex,
  processInBatches,
  toSearchDocument,
  searchMeiliIndex,
  syncMeiliIndex,
  getMeiliSyncConfig,
  buildIndexableQuery,
  getMeiliSyncProgress,
  processMeiliSyncBatch,
  syncVersionedDocument,
  buildExcludedIndexedQuery,
  cleanupMeiliIndexEntries,
  createDetachedMeiliRunner,
  cleanupExcludedMeiliRecords,
} from '~/search/meiliIndexer';
import { buildRetentionVisibilityFilter, legacyPermanentExpirationFilter } from '~/utils/retention';
import logger from '~/config/meiliLogger';

export {
  MEILI_CLEANUP_VERSION,
  buildExcludedIndexedQuery,
  MEILI_INDEX_SCHEMA_VERSION,
} from '~/search/meiliIndexer';

/** Internal per-query bypass for writes to non-searchable bookkeeping fields. A WeakSet keeps
 * this marker out of driver options and stored data. Other model middleware still runs. */
const queriesWithoutMeiliIndexing = new WeakSet<object>();
export function withoutMeiliIndexing<T extends object>(query: T): T {
  queriesWithoutMeiliIndexing.add(query);
  return query;
}

interface MongoMeiliOptions {
  host: string;
  apiKey: string;
  indexName: string;
  primaryKey: string;
  mongoose: typeof import('mongoose');
  syncBatchSize?: number;
  syncDelayMs?: number;
  /** Documents carrying this path remain in MongoDB but are excluded from search. */
  excludeFromIndexPath?: string;
}

type SyncProgress = MeiliSyncProgress;

interface _DocumentWithMeiliIndex extends Document {
  _meiliIndex?: boolean;
  _meiliIndexAttempted?: boolean;
  _meiliIndexVersion?: string;
  _meiliIndexSchemaVersion?: number;
  _meiliCleanupVersion?: number;
  isTemporary?: boolean;
  expiredAt?: Date | null;
  preprocessObjectForIndex?: () => Record<string, unknown>;
  addObjectToMeili?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  updateObjectToMeili?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  deleteObjectFromMeili?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  postSaveHook?: (next: CallbackWithoutResultAndOptionalError) => Promise<void>;
  postUpdateHook?: (next: CallbackWithoutResultAndOptionalError) => Promise<void> | void;
  postRemoveHook?: (next: CallbackWithoutResultAndOptionalError) => Promise<void> | void;
}

export type DocumentWithMeiliIndex = _DocumentWithMeiliIndex & IConversation & Partial<IMessage>;

export interface SchemaWithMeiliMethods extends Model<DocumentWithMeiliIndex> {
  syncWithMeili(): Promise<void>;
  getSyncProgress(): Promise<SyncProgress>;
  processSyncBatch(
    index: Index<MeiliIndexable>,
    documents: Array<Record<string, unknown>>,
  ): Promise<void>;
  cleanupExcludedMeiliIndex(): Promise<void>;
  cleanupMeiliIndex(
    index: Index<MeiliIndexable>,
    primaryKey: string,
    batchSize: number,
    delayMs: number,
  ): Promise<void>;
  setMeiliIndexSettings(settings: Record<string, unknown>): Promise<unknown>;
  meiliSearch(
    q: string,
    params?: SearchParams,
    populate?: boolean,
  ): Promise<SearchResponse<MeiliIndexable, Record<string, unknown>>>;
}

// Environment flags
/**
 * Flag to indicate if search is enabled based on environment variables.
 */
const searchEnabled = process.env.SEARCH != null && process.env.SEARCH.toLowerCase() === 'true';

/**
 * Flag to indicate if MeiliSearch is enabled based on required environment variables.
 */
const meiliEnabled =
  process.env.MEILI_HOST != null && process.env.MEILI_MASTER_KEY != null && searchEnabled;

/**
 * Get sync configuration from environment variables
 */
const getSyncConfig = getMeiliSyncConfig;

const hasSchemaPath = (schema: Schema, path: string): boolean =>
  Object.prototype.hasOwnProperty.call(schema.obj, path);

const explicitTemporaryFlagKey = 'meiliExplicitTemporaryFlag';
const previouslyIndexedFlagKey = 'meiliPreviouslyIndexed';
const meiliCleanupVersion = MEILI_CLEANUP_VERSION;
const completeDetachedOperation: CallbackWithoutResultAndOptionalError = () => undefined;

const buildRetentionIndexableQuery = (schema: Schema): FilterQuery<unknown> => {
  if (hasSchemaPath(schema, 'isTemporary')) {
    return buildRetentionVisibilityFilter();
  }
  if (hasSchemaPath(schema, 'expiredAt')) {
    return legacyPermanentExpirationFilter();
  }
  return {};
};

/**
 * `isTemporary` defaults to `false` on the schema, so hydrated legacy documents
 * can appear non-temporary even when the field is absent from MongoDB. `$isDefault`
 * lets us distinguish that schema default from an explicit stored flag, and
 * `$locals` carries the pre-save answer into post hooks after Mongoose mutates
 * document state.
 */
const hasExplicitTemporaryFlag = (doc: DocumentWithMeiliIndex): boolean =>
  typeof doc.$locals?.[explicitTemporaryFlagKey] === 'boolean'
    ? (doc.$locals[explicitTemporaryFlagKey] as boolean)
    : doc.isTemporary != null && !doc.$isDefault('isTemporary');

const captureExplicitTemporaryFlag = (doc: DocumentWithMeiliIndex): void => {
  doc.$locals[explicitTemporaryFlagKey] = doc.isTemporary != null && !doc.$isDefault('isTemporary');
};

/**
 * Index only retained non-temporary records whose flag was explicitly stored,
 * plus legacy permanent records that have no retention deadline. Legacy records
 * with an expiration are treated as temporary and stay out of search.
 */
const isIndexableDocument = (doc: DocumentWithMeiliIndex, excludeFromIndexPath?: string): boolean =>
  isIndexableRecord(
    doc as unknown as Record<string, unknown>,
    hasExplicitTemporaryFlag(doc),
    excludeFromIndexPath,
  );

/**
 * Validates the required options for configuring the mongoMeili plugin.
 */
const validateOptions = (options: Partial<MongoMeiliOptions>): void => {
  const requiredKeys: (keyof MongoMeiliOptions)[] = ['host', 'apiKey', 'indexName', 'primaryKey'];
  requiredKeys.forEach((key) => {
    if (!options[key]) {
      throw new Error(`Missing mongoMeili Option: ${key}`);
    }
  });
};

/**
 * Factory function to create a MeiliMongooseModel class which extends a Mongoose model.
 * This class contains static and instance methods to synchronize and manage the MeiliSearch index
 * corresponding to the MongoDB collection. The index side of each method is written once in
 * `~/search/meiliIndexer`; the methods here supply its MongoDB steps.
 *
 * @param config - Configuration object.
 * @param config.index - The MeiliSearch index object.
 * @param config.attributesToIndex - List of attributes to index.
 * @param config.primaryKey - The primary key field for MeiliSearch document operations.
 * @param config.syncOptions - Sync configuration options.
 * @returns A class definition that will be loaded into the Mongoose schema.
 */
const createMeiliMongooseModel = ({
  client,
  index,
  getIndexableQuery,
  getExcludedIndexedQuery,
  excludeFromIndexPath,
  attributesToIndex,
  primaryKey,
  syncOptions,
}: {
  client: MeiliSearch;
  index: Index<MeiliIndexable>;
  getIndexableQuery: () => FilterQuery<unknown>;
  getExcludedIndexedQuery: () => FilterQuery<unknown> | null;
  excludeFromIndexPath?: string;
  attributesToIndex: string[];
  primaryKey: string;
  syncOptions: { batchSize: number; delayMs: number };
}) => {
  const syncConfig = { ...getSyncConfig(), ...syncOptions };

  const loadLatestDocument = async (
    doc: DocumentWithMeiliIndex,
  ): Promise<DocumentWithMeiliIndex | null> => {
    const model = doc.constructor as Model<DocumentWithMeiliIndex>;
    const selection = [
      ...attributesToIndex,
      '+_meiliIndex',
      '+_meiliIndexAttempted',
      '+_meiliIndexVersion',
      '+_meiliIndexSchemaVersion',
      'isTemporary',
      'expiredAt',
      'unfinished',
      ...(excludeFromIndexPath == null ? [] : [`+${excludeFromIndexPath}`]),
    ].join(' ');
    return await model.findById(doc._id).select(selection).exec();
  };

  /**
   * The MongoDB steps of the versioned write: the flag writes go straight to the collection
   * (versioned internal bookkeeping must not re-enter document middleware), filtered by `_id` and
   * the version the write produced.
   */
  const versionedWriteSteps = {
    client,
    index,
    primaryKey,
    shouldIndex: (doc: DocumentWithMeiliIndex) =>
      !(!isIndexableDocument(doc, excludeFromIndexPath) || doc.unfinished),
    toSearchDocument: (doc: DocumentWithMeiliIndex) => doc.preprocessObjectForIndex!(),
    acknowledgeCleanup: async (doc: DocumentWithMeiliIndex, version: string) => {
      // eslint-disable-next-line no-restricted-syntax -- versioned internal bookkeeping must not re-enter document middleware
      const cleanup = await doc.collection.updateOne(
        { _id: doc._id as Types.ObjectId, _meiliIndexVersion: version },
        {
          $set: { _meiliCleanupVersion: meiliCleanupVersion },
          $unset: { _meiliIndex: '', _meiliIndexAttempted: '' },
        },
      );
      return cleanup.matchedCount > 0;
    },
    acknowledgeIndexed: async (doc: DocumentWithMeiliIndex, version: string) => {
      // eslint-disable-next-line no-restricted-syntax -- versioned internal bookkeeping must not re-enter document middleware
      const acknowledgement = await doc.collection.updateOne(
        { _id: doc._id as Types.ObjectId, _meiliIndexVersion: version },
        { $set: { ...MEILI_INDEXED_UPDATE.$set } },
      );
      return acknowledgement.matchedCount > 0;
    },
    loadLatest: loadLatestDocument,
    markUnconverged: async (doc: DocumentWithMeiliIndex) => {
      // eslint-disable-next-line no-restricted-syntax -- versioned internal bookkeeping must not re-enter document middleware
      await doc.collection.updateOne(
        { _id: doc._id as Types.ObjectId, _meiliIndexVersion: doc._meiliIndexVersion },
        { $set: { _meiliIndex: false, _meiliIndexAttempted: true } },
      );
    },
  };

  /**
   * Submit a versioned snapshot and acknowledge only the MongoDB write that
   * produced it. If another replica wins the race, enqueue the latest snapshot
   * after the stale Meili task so task ordering converges on current Mongo data.
   */
  const syncDocument = (doc: DocumentWithMeiliIndex, mode: 'add' | 'update'): Promise<void> =>
    syncVersionedDocument(versionedWriteSteps, doc, mode);

  class MeiliMongooseModel {
    /**
     * Get the current sync progress
     */
    static async getSyncProgress(this: SchemaWithMeiliMethods): Promise<SyncProgress> {
      return getMeiliSyncProgress({
        count: (filter) => this.countDocuments(filter as FilterQuery<unknown>),
        indexableQuery: getIndexableQuery,
        excludedIndexedQuery: getExcludedIndexedQuery,
      });
    }

    /**
     * Synchronizes data between the MongoDB collection and the MeiliSearch index by
     * incrementally indexing only non-temporary documents that are unindexed or stale.
     * */
    static async syncWithMeili(this: SchemaWithMeiliMethods): Promise<void> {
      const { batchSize, delayMs } = syncConfig;
      await syncMeiliIndex({
        index,
        primaryKey,
        config: syncConfig,
        // eslint-disable-next-line no-restricted-syntax -- a collection-wide estimate is the quantity wanted here: it bounds a full-index sync and only feeds a progress log, so a tenant-scoped count would be wrong, not just unnecessary.
        estimatedCount: () => this.estimatedDocumentCount(),
        cleanupIndex: () => this.cleanupMeiliIndex(index, primaryKey, batchSize, delayMs),
        indexableQuery: getIndexableQuery,
        findPending: (query, limit) =>
          this.find(query as FilterQuery<unknown>)
            .select(attributesToIndex.join(' ') + ' _meiliIndex')
            .limit(limit)
            .lean(),
        processBatch: (documents) => this.processSyncBatch(index, documents),
      });
    }

    /**
     * Process a batch of documents for syncing
     */
    static async processSyncBatch(
      this: SchemaWithMeiliMethods,
      index: Index<MeiliIndexable>,
      documents: Array<Record<string, unknown>>,
    ): Promise<void> {
      await processMeiliSyncBatch(
        {
          markAttempted: (docsIds) =>
            this.updateMany(
              { _id: { $in: docsIds } },
              { $set: { _meiliIndexAttempted: true } },
              { timestamps: false },
            ),
          // Update MongoDB to mark documents as indexed.
          // { timestamps: false } prevents Mongoose from touching updatedAt, preserving
          // original conversation/message timestamps (fixes sidebar chronological sort).
          markIndexed: (docsIds) =>
            this.updateMany(
              { _id: { $in: docsIds } },
              { $set: { ...MEILI_INDEXED_UPDATE.$set } },
              { timestamps: false },
            ),
        },
        index,
        documents,
        attributesToIndex,
        primaryKey,
      );
    }

    /**
     * Remove documents that are intentionally excluded from search without
     * scanning the complete Meili index. The Mongo marker is cleared only
     * after Meili confirms deletion, so interrupted cleanup is retried.
     */
    static async cleanupExcludedMeiliIndex(this: SchemaWithMeiliMethods): Promise<void> {
      await cleanupExcludedMeiliRecords({
        client,
        index,
        primaryKey,
        config: syncConfig,
        excludedIndexedQuery: getExcludedIndexedQuery,
        findExcluded: (query, limit) =>
          this.find(query as FilterQuery<unknown>)
            .select(primaryKey)
            .limit(limit)
            .lean(),
        markCleaned: (query) =>
          this.updateMany(
            query as FilterQuery<unknown>,
            {
              $set: { ...MEILI_CLEANED_UPDATE.$set },
              $unset: { ...MEILI_CLEANED_UPDATE.$unset },
            },
            { timestamps: false },
          ),
      });
    }

    /**
     * Clean up documents in MeiliSearch that no longer exist in MongoDB
     */
    static async cleanupMeiliIndex(
      this: SchemaWithMeiliMethods,
      index: Index<MeiliIndexable>,
      primaryKey: string,
      batchSize: number,
      delayMs: number,
    ): Promise<void> {
      await cleanupMeiliIndexEntries(
        {
          client,
          cleanupExcluded: () => this.cleanupExcludedMeiliIndex(),
          findExisting: (query) =>
            this.find({ ...query, ...getIndexableQuery() })
              .select(primaryKey)
              .lean(),
          markCleaned: (query) =>
            this.updateMany(
              query as FilterQuery<unknown>,
              {
                $set: { ...MEILI_CLEANED_UPDATE.$set },
                $unset: { ...MEILI_CLEANED_UPDATE.$unset },
              },
              { timestamps: false },
            ),
        },
        index,
        primaryKey,
        batchSize,
        delayMs,
      );
    }

    /**
     * Updates settings for the MeiliSearch index
     */
    static async setMeiliIndexSettings(settings: Record<string, unknown>): Promise<unknown> {
      return await index.updateSettings(settings);
    }

    /**
     * Searches the MeiliSearch index and optionally populates results
     */
    static async meiliSearch(
      this: SchemaWithMeiliMethods,
      q: string,
      params: SearchParams,
      populate: boolean,
    ): Promise<SearchResponse<MeiliIndexable, Record<string, unknown>>> {
      return searchMeiliIndex<Record<string, unknown>>(
        index,
        q,
        params,
        populate
          ? {
              read: async (hits) => {
                const query: Record<string, unknown> = {};
                query[primaryKey] = _.map(hits, (hit) => hit[primaryKey]);

                const projection = Object.keys(this.schema.obj).reduce<Record<string, number>>(
                  (results, key) => {
                    if (!key.startsWith('$') && this.schema.path(key)?.options?.select !== false) {
                      results[key] = 1;
                    }
                    return results;
                  },
                  { _id: 1, __v: 1 },
                );

                return (await this.find(query, projection).lean()) as Array<
                  Record<string, unknown>
                >;
              },
              matches: (item, hit) => item[primaryKey] === hit[primaryKey],
            }
          : undefined,
      );
    }

    /**
     * Preprocesses the current document for indexing
     */
    preprocessObjectForIndex(this: DocumentWithMeiliIndex): Record<string, unknown> {
      return toSearchDocument(this.toJSON(), attributesToIndex);
    }

    /** Adds the current document to the MeiliSearch index. */
    async addObjectToMeili(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      if (!this._meiliIndexVersion) {
        return next();
      }
      try {
        await syncDocument(this, 'add');
      } catch (error) {
        logger.error('[addObjectToMeili] Error adding document to Meili:', error);
        return next();
      }
      next();
    }

    /**
     * Updates the current document in the MeiliSearch index
     */
    async updateObjectToMeili(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      if (!this._meiliIndexVersion) {
        return next();
      }
      try {
        await syncDocument(this, 'update');
        next();
      } catch (error) {
        logger.error('[updateObjectToMeili] Error updating document in Meili:', error);
        return next();
      }
    }

    /**
     * Deletes the current document from the MeiliSearch index.
     *
     * @returns {Promise<void>}
     */
    async deleteObjectFromMeili(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      try {
        await index.deleteDocument(String(this[primaryKey as keyof DocumentWithMeiliIndex]));
        next();
      } catch (error) {
        logger.error('[deleteObjectFromMeili] Error deleting document from Meili:', error);
        return next();
      }
    }

    /**
     * Post-save hook to synchronize the document with MeiliSearch.
     *
     * If the document is already indexed (i.e. `_meiliIndex` is true), it updates it;
     * otherwise, it adds the document to the index.
     */
    postSaveHook(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): Promise<void> {
      if (this.$locals?.[previouslyIndexedFlagKey] === true || this._meiliIndex) {
        return this.updateObjectToMeili!(next);
      }
      return this.addObjectToMeili!(next);
    }

    /**
     * Post-update hook to update the document in MeiliSearch.
     *
     * This hook is triggered after a document update, ensuring that changes are
     * propagated to the MeiliSearch index if the document is indexed.
     */
    postUpdateHook(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): void {
      if (this._meiliIndex) {
        this.updateObjectToMeili!(next);
      } else {
        next();
      }
    }

    /**
     * Post-remove hook to delete the document from MeiliSearch.
     *
     * This hook is triggered after a document is removed, ensuring that the document
     * is also removed from the MeiliSearch index if it was previously indexed.
     */
    postRemoveHook(
      this: DocumentWithMeiliIndex,
      next: CallbackWithoutResultAndOptionalError,
    ): void {
      if (this._meiliIndex) {
        this.deleteObjectFromMeili!(next);
      } else {
        next();
      }
    }
  }

  return MeiliMongooseModel;
};

/**
 * Mongoose plugin to synchronize MongoDB collections with a MeiliSearch index.
 *
 * This plugin:
 *   - Validates the provided options.
 *   - Adds a `_meiliIndex` field to the schema to track indexing status.
 *   - Sets up a MeiliSearch client and creates an index if it doesn't already exist.
 *   - Loads class methods for syncing, searching, and managing documents in MeiliSearch.
 *   - Registers Mongoose hooks (post-save, post-update, post-remove, etc.) to maintain index consistency.
 *
 * @param schema - The Mongoose schema to which the plugin is applied.
 * @param options - Configuration options.
 * @param options.host - The MeiliSearch host.
 * @param options.apiKey - The MeiliSearch API key.
 * @param options.indexName - The name of the MeiliSearch index.
 * @param options.primaryKey - The primary key field for indexing.
 * @param options.syncBatchSize - Batch size for sync operations.
 * @param options.syncDelayMs - Delay between batches in milliseconds.
 * @param options.excludeFromIndexPath - Presence of this path makes a document non-searchable.
 */
export default function mongoMeili(schema: Schema, options: MongoMeiliOptions): void {
  const mongoose = options.mongoose;
  validateOptions(options);

  // Add _meiliIndex field to the schema to track if a document has been indexed in MeiliSearch.
  schema.add({
    _meiliIndex: {
      type: Boolean,
      required: false,
      select: false,
      default: false,
    },
    _meiliIndexAttempted: {
      type: Boolean,
      required: false,
      select: false,
    },
    _meiliIndexVersion: {
      type: String,
      required: false,
      select: false,
    },
    _meiliIndexSchemaVersion: {
      type: Number,
      required: false,
      select: false,
    },
    _meiliCleanupVersion: {
      type: Number,
      required: false,
      select: false,
      default: meiliCleanupVersion,
    },
  });

  if (options.excludeFromIndexPath != null) {
    schema.index(
      { _meiliIndex: 1, [options.primaryKey]: 1 },
      {
        name: 'meili_excluded_indexed_cleanup_v3',
        partialFilterExpression: {
          [options.excludeFromIndexPath]: { $exists: true },
          _meiliIndex: { $eq: true },
        },
      },
    );
    schema.index(
      { _meiliIndexAttempted: 1, [options.primaryKey]: 1 },
      {
        name: 'meili_excluded_attempted_cleanup_v3',
        partialFilterExpression: {
          [options.excludeFromIndexPath]: { $exists: true },
          _meiliIndexAttempted: { $eq: true },
        },
      },
    );
    /* Serves the legacy branch of `buildExcludedIndexedQuery`. MongoDB rewrites
     * `$exists: false` into `$not`, which no `partialFilterExpression` accepts, so the
     * unstamped state is expressed as a null equality: it admits an absent or null
     * `_meiliCleanupVersion` and keeps every already-stamped document out, which is what
     * bounds this index to the shrinking legacy population rather than to every
     * excluded document ever written. Cleanup stamps the version, and the document
     * leaves the index. */
    schema.index(
      { _meiliIndex: 1, _meiliCleanupVersion: 1, [options.primaryKey]: 1 },
      {
        name: 'meili_excluded_legacy_cleanup_v4',
        partialFilterExpression: {
          [options.excludeFromIndexPath]: { $exists: true },
          _meiliIndex: { $eq: false },
          _meiliCleanupVersion: { $eq: null },
        },
      },
    );
  }

  const { host, apiKey, indexName, primaryKey } = options;
  const privateExcludedPath =
    options.excludeFromIndexPath != null &&
    schema.path(options.excludeFromIndexPath)?.options?.select === false
      ? options.excludeFromIndexPath
      : undefined;
  const queriesWithInjectedPrivatePath = new WeakSet<object>();
  const findOneAndUpdateVersions = new WeakMap<object, string>();
  const syncOptions = {
    batchSize: options.syncBatchSize || getSyncConfig().batchSize,
    delayMs: options.syncDelayMs || getSyncConfig().delayMs,
  };

  const client = createMeiliClient(host, apiKey);
  const runDetachedMeiliOperation = createDetachedMeiliRunner();
  const getOperationKey = (doc: DocumentWithMeiliIndex): string =>
    `${indexName}:${String(doc[primaryKey as keyof DocumentWithMeiliIndex] ?? doc._id)}`;

  /** Create index only if it doesn't exist */
  const index = client.index<MeiliIndexable>(indexName);

  void ensureMeiliIndex(client, index, indexName, primaryKey);

  // Collect attributes from the schema that should be indexed
  const attributesToIndex: string[] = [
    ...Object.entries(schema.obj).reduce<string[]>((results, [key, value]) => {
      const schemaValue = value as { meiliIndex?: boolean };
      return schemaValue.meiliIndex ? [...results, key] : results;
    }, []),
  ];

  // CRITICAL: Always include 'user' field for proper filtering
  // This ensures existing deployments can filter by user after migration
  if (schema.obj.user && !attributesToIndex.includes('user')) {
    attributesToIndex.push('user');
    logger.debug(`[mongoMeili] Added 'user' field to ${indexName} index attributes`);
  }

  schema.loadClass(
    createMeiliMongooseModel({
      client,
      index,
      getIndexableQuery: () =>
        buildIndexableQuery(
          buildRetentionIndexableQuery(schema) as Record<string, unknown>,
          options.excludeFromIndexPath,
        ) as FilterQuery<unknown>,
      getExcludedIndexedQuery: () =>
        buildExcludedIndexedQuery(options.excludeFromIndexPath) as FilterQuery<unknown> | null,
      excludeFromIndexPath: options.excludeFromIndexPath,
      attributesToIndex,
      primaryKey,
      syncOptions,
    }),
  );

  // Register Mongoose hooks
  schema.pre('save', function (this: DocumentWithMeiliIndex, next) {
    if (hasSchemaPath(schema, 'isTemporary')) {
      captureExplicitTemporaryFlag(this);
    }
    this.$locals[previouslyIndexedFlagKey] = this._meiliIndex === true;
    if (
      isIndexableDocument(this, options.excludeFromIndexPath) ||
      this._meiliIndex === true ||
      this._meiliIndexAttempted === true
    ) {
      this._meiliIndexVersion = new mongoose.Types.ObjectId().toString();
      this._meiliIndex = false;
      this._meiliIndexAttempted = true;
      this.markModified('_meiliIndexVersion');
      this.markModified('_meiliIndex');
      this.markModified('_meiliIndexAttempted');
    }
    next();
  });

  schema.post('save', function (doc: DocumentWithMeiliIndex, next) {
    next();
    if (typeof doc.postSaveHook === 'function') {
      runDetachedMeiliOperation(
        getOperationKey(doc),
        () => doc.postSaveHook!(completeDetachedOperation),
        '[mongoMeili] Detached post-save indexing failed:',
      );
    }
  });

  schema.pre('findOneAndUpdate', function (next) {
    if (queriesWithoutMeiliIndexing.has(this)) {
      next();
      return;
    }
    const query = this as Query<unknown, unknown>;
    if (meiliEnabled) {
      const version = new mongoose.Types.ObjectId().toString();
      query.set({
        _meiliIndex: false,
        _meiliIndexAttempted: true,
        _meiliIndexVersion: version,
      });
      findOneAndUpdateVersions.set(query, version);
    }
    if (privateExcludedPath != null) {
      const projection = query.projection() as Record<string, number> | null;
      const callerRequestedPrivatePath = Object.entries(projection ?? {}).some(
        ([path, included]) =>
          included === 1 &&
          (path === privateExcludedPath ||
            path === `+${privateExcludedPath}` ||
            path.startsWith(`${privateExcludedPath}.`)),
      );
      if (!callerRequestedPrivatePath) {
        query.select(`+${privateExcludedPath}`);
        queriesWithInjectedPrivatePath.add(query);
      }
    }
    next();
  });

  schema.post('updateOne', function (doc: DocumentWithMeiliIndex, next) {
    next();
    if (typeof doc.postUpdateHook === 'function') {
      runDetachedMeiliOperation(
        getOperationKey(doc),
        () => doc.postUpdateHook!(completeDetachedOperation),
        '[mongoMeili] Detached post-update indexing failed:',
      );
    }
  });

  schema.post('deleteOne', function (doc: DocumentWithMeiliIndex, next) {
    next();
    if (typeof doc.postRemoveHook === 'function') {
      runDetachedMeiliOperation(
        getOperationKey(doc),
        () => doc.postRemoveHook!(completeDetachedOperation),
        '[mongoMeili] Detached post-remove indexing failed:',
      );
    }
  });

  // Pre-deleteMany hook: remove corresponding documents from MeiliSearch when multiple documents are deleted.
  schema.pre('deleteMany', async function (next) {
    if (!meiliEnabled) {
      return next();
    }

    try {
      const conditions = (this as Query<unknown, unknown>).getQuery();
      const { batchSize, delayMs } = syncOptions;

      if (Object.prototype.hasOwnProperty.call(schema.obj, 'messages')) {
        const convoIndex = client.index('convos');
        const deletedConvos = await mongoose
          .model('Conversation')
          .find(conditions as FilterQuery<unknown>)
          .select('conversationId')
          .lean();

        // Process deletions in batches
        await processInBatches(deletedConvos, batchSize, delayMs, async (batch) => {
          const promises = batch.map((convo: Record<string, unknown>) =>
            convoIndex.deleteDocument(convo.conversationId as string),
          );
          await Promise.all(promises);
        });
      }

      if (Object.prototype.hasOwnProperty.call(schema.obj, 'messageId')) {
        const messageIndex = client.index('messages');
        const deletedMessages = await mongoose
          .model('Message')
          .find(conditions as FilterQuery<unknown>)
          .select('messageId')
          .lean();

        // Process deletions in batches
        await processInBatches(deletedMessages, batchSize, delayMs, async (batch) => {
          const promises = batch.map((message: Record<string, unknown>) =>
            messageIndex.deleteDocument(message.messageId as string),
          );
          await Promise.all(promises);
        });
      }
      return next();
    } catch (error) {
      if (meiliEnabled) {
        logger.error(
          '[MeiliMongooseModel.deleteMany] There was an issue deleting conversation indexes upon deletion. Next startup may trigger syncing.',
          error,
        );
      }
      return next();
    }
  });

  // Post-findOneAndUpdate hook
  schema.post(
    'findOneAndUpdate',
    function (
      res: DocumentWithMeiliIndex | { value: DocumentWithMeiliIndex | null } | null,
      next: CallbackWithoutResultAndOptionalError,
    ) {
      // `saveConvo` issues `findOneAndUpdate` with `includeResultMetadata: true`, so
      // the hook receives the raw `{ value, ok, lastErrorObject }` result instead of
      // the document. Unwrap `value` so indexing runs for that path too.
      let doc: DocumentWithMeiliIndex | null;
      if (res instanceof mongoose.Document) {
        doc = res;
      } else if (res != null && 'value' in res) {
        doc = res.value;
      } else {
        doc = res;
      }
      if (doc != null && privateExcludedPath != null && queriesWithInjectedPrivatePath.has(this)) {
        if (doc instanceof mongoose.Document) {
          doc.set(privateExcludedPath, undefined);
        } else {
          _.unset(doc, privateExcludedPath);
        }
      }

      const version = findOneAndUpdateVersions.get(this);
      if (!meiliEnabled || !doc || !version) {
        next();
        return;
      }

      const savedDoc = doc;
      const model = (this as Query<unknown, DocumentWithMeiliIndex>).model;
      next();
      runDetachedMeiliOperation(
        getOperationKey(savedDoc),
        async () => {
          const latestDoc = await model
            .findById(savedDoc._id)
            .select(
              [
                '+_meiliIndex',
                '+_meiliIndexAttempted',
                '+_meiliIndexVersion',
                ...(privateExcludedPath == null ? [] : [`+${privateExcludedPath}`]),
              ].join(' '),
            )
            .exec();
          await latestDoc?.addObjectToMeili?.(completeDetachedOperation);
        },
        '[mongoMeili] Detached findOneAndUpdate indexing failed:',
      );
    },
  );
}

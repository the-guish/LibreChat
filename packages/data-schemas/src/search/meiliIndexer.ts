/**
 * The MeiliSearch side of keeping a search index in step with the database (D4 keeps
 * MeiliSearch; docs/postgres-port/PHASE4.md §8 I3), written once on storage steps so the MongoDB
 * plugin (`~/models/plugins/mongoMeili`) and the PostgreSQL write hooks and index sync
 * (`~/adapters/postgres/search`) share it. Nothing here may import `mongoose` or the MongoDB
 * driver: what the database does (count, find a batch, acknowledge a version, clear the flags) is
 * a step the caller supplies, and the filters below use only the shared query language.
 *
 * What it holds:
 * - the index bookkeeping constants (`_meiliIndexSchemaVersion`, `_meiliCleanupVersion`), the
 *   client and index bootstrap, the sync batch configuration;
 * - which records belong in the index (retention, the excluded path, the legacy temporary rule)
 *   and the filters that select them;
 * - the versioned write of one record (submit, then acknowledge only the database write that
 *   produced it; on a lost race, resubmit the latest snapshot), with the detached runner that
 *   serializes those writes per record and the retry of a failed write;
 * - the batch sync, the cleanup of excluded records and of index entries the database no longer
 *   holds, the sync progress, and the merge of stored fields into search hits.
 */
import _ from 'lodash';
import { parseTextParts } from 'librechat-data-provider';
import { MeiliSearch, MeiliSearchTimeOutError } from 'meilisearch';
import type { MeiliSearchErrorInfo, SearchResponse, SearchParams, Index } from 'meilisearch';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
import logger from '~/config/meiliLogger';
import flagLogger from '~/config/winston';

/** A filter in the shared query language (`ports/query.ts`), as both backends read it. */
export type MeiliStoreFilter = Record<string, unknown>;

/** A record as the index sync sees it: its fields and the `_meili*` bookkeeping flags. */
export interface MeiliIndexable {
  [key: string]: unknown;
  _meiliIndex?: boolean;
  _meiliIndexAttempted?: boolean;
  _meiliIndexVersion?: string;
  _meiliIndexSchemaVersion?: number;
  _meiliCleanupVersion?: number;
}

/** How far the index is behind the database (the search index sync port's progress). */
export interface MeiliSyncProgress {
  lastSyncedId?: string;
  totalProcessed: number;
  totalDocuments: number;
  pendingIndexing: number;
  pendingCleanup: number;
  isComplete: boolean;
}

/** Batch size and delay between batches of the sync and the cleanups. */
export interface MeiliSyncConfig {
  batchSize: number;
  delayMs: number;
}

/** Bump when the indexed document shape or projection changes. */
export const MEILI_INDEX_SCHEMA_VERSION = 1;

/** The `_meiliCleanupVersion` stamped on documents (the path's default and the cleanup's mark). */
export const MEILI_CLEANUP_VERSION = 1;

/** The client's request timeout, and how long a write waits for its task. */
export const MEILI_REQUEST_TIMEOUT_MS = 10_000;

const meiliWriteMaxAttempts = 3;
const meiliRetryBaseDelayMs = 250;
const meiliVersionReconcileMaxAttempts = 3;

/** The sync batch configuration from `MEILI_SYNC_BATCH_SIZE` / `MEILI_SYNC_DELAY_MS`. */
export const getMeiliSyncConfig = (): MeiliSyncConfig => ({
  batchSize: parseInt(process.env.MEILI_SYNC_BATCH_SIZE || '100', 10),
  delayMs: parseInt(process.env.MEILI_SYNC_DELAY_MS || '100', 10),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a detached index write, retrying it with exponential backoff; rethrows the last error. */
export const retryDetachedMeiliWrite = async (
  operation: () => Promise<unknown>,
  context: string,
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < meiliWriteMaxAttempts; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < meiliWriteMaxAttempts) {
        logger.warn(`${context} Retrying detached Meili write`, error);
        await new Promise((resolve) =>
          setTimeout(resolve, meiliRetryBaseDelayMs * Math.pow(2, attempt)),
        );
      }
    }
  }
  throw lastError;
};

/** Runs `operation` after the previous one queued under the same key; logs a failure. */
export type DetachedMeiliRunner = (
  key: string,
  operation: () => Promise<void> | void,
  context: string,
) => void;

/**
 * A runner for index writes detached from the database write that caused them: operations under
 * one key (one record) run one after the other, in the order they were queued; a failure is
 * logged and does not stop the next one.
 */
export const createDetachedMeiliRunner = (): DetachedMeiliRunner => {
  const pendingOperations = new Map<string, Promise<void>>();

  return (key, operation, context) => {
    const previousOperation = pendingOperations.get(key) ?? Promise.resolve();
    const operationPromise = previousOperation.then(operation).catch((error) => {
      logger.error(context, error);
    });
    const trackedOperation = operationPromise.finally(() => {
      if (pendingOperations.get(key) === trackedOperation) {
        pendingOperations.delete(key);
      }
    });

    pendingOperations.set(key, trackedOperation);
  };
};

/**
 * Helper function to process documents in batches with rate limiting
 */
export const processInBatches = async <T>(
  items: T[],
  batchSize: number,
  delayMs: number,
  processor: (batch: T[]) => Promise<void>,
): Promise<void> => {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await processor(batch);

    // Add delay between batches to prevent overwhelming resources
    if (i + batchSize < items.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

/** The MeiliSearch client, with the request timeout the index writes rely on. */
export const createMeiliClient = (host: string, apiKey: string): MeiliSearch =>
  new MeiliSearch({ host, apiKey, timeout: MEILI_REQUEST_TIMEOUT_MS });

/**
 * Creates the index `indexName` when it does not exist (another instance may win the race), then
 * makes `user` filterable. Never rejects: every failure is logged.
 */
export async function ensureMeiliIndex(
  client: MeiliSearch,
  index: Index<MeiliIndexable>,
  indexName: string,
  primaryKey: string,
): Promise<void> {
  try {
    await index.getRawInfo();
    logger.debug(`[mongoMeili] Index ${indexName} already exists`);
  } catch (error) {
    const errorCode = (error as { code?: string })?.code;
    if (errorCode === 'index_not_found') {
      try {
        logger.info(`[mongoMeili] Creating new index: ${indexName}`);
        const enqueued = await client.createIndex(indexName, { primaryKey });
        const task = await client.waitForTask(enqueued.taskUid, {
          timeOutMs: 10000,
          intervalMs: 100,
        });
        logger.debug(`[mongoMeili] Index ${indexName} creation task:`, task);
        if (task.status !== 'succeeded') {
          const taskError = task.error as MeiliSearchErrorInfo | null;
          if (taskError?.code === 'index_already_exists') {
            logger.debug(`[mongoMeili] Index ${indexName} was created by another instance`);
          } else {
            logger.warn(`[mongoMeili] Index ${indexName} creation failed:`, taskError);
          }
        } else {
          logger.info(`[mongoMeili] Successfully created index: ${indexName}`);
        }
      } catch (createError) {
        if (createError instanceof MeiliSearchTimeOutError) {
          logger.warn(`[mongoMeili] Timed out waiting for index ${indexName} creation`);
        } else {
          logger.warn(`[mongoMeili] Error creating index ${indexName}:`, createError);
        }
      }
    } else {
      logger.error(`[mongoMeili] Error checking index ${indexName}:`, error);
    }
  }

  try {
    await index.updateSettings({
      filterableAttributes: ['user'],
    });
    logger.debug(`[mongoMeili] Updated index ${indexName} settings to make 'user' filterable`);
  } catch (settingsError) {
    logger.error(`[mongoMeili] Error updating index settings for ${indexName}:`, settingsError);
  }
}

/* ------------------------------------------------------------------ which records are indexed */

/** The filter of the records that belong in the index, given the retention filter. */
export const buildIndexableQuery = (
  retentionFilter: MeiliStoreFilter,
  excludeFromIndexPath?: string,
): MeiliStoreFilter => {
  if (excludeFromIndexPath == null) {
    return retentionFilter;
  }

  return {
    $and: [retentionFilter, { [excludeFromIndexPath]: { $exists: false } }],
  };
};

/**
 * Excluded documents that may still hold a Meili entry. The legacy branch matches a
 * `_meiliCleanupVersion` that is absent or null, written as a null equality rather than
 * `$exists: false` so `meili_excluded_legacy_cleanup_v4` can serve it: a partial index
 * accepts null equality and rejects `$exists: false`, and the planner only reaches a
 * partial index through a predicate that implies its filter.
 */
export const buildExcludedIndexedQuery = (
  excludeFromIndexPath?: string,
): MeiliStoreFilter | null => {
  if (excludeFromIndexPath == null) {
    return null;
  }

  return {
    [excludeFromIndexPath]: { $exists: true },
    $or: [
      { _meiliIndex: true },
      { _meiliIndexAttempted: true },
      { _meiliIndex: false, _meiliCleanupVersion: null },
    ],
  };
};

/** Indexable records whose indexing failed, or whose indexed shape is outdated. */
export const buildNeedsIndexingQuery = (indexableQuery: MeiliStoreFilter): MeiliStoreFilter => ({
  $and: [
    indexableQuery,
    {
      $or: [
        { _meiliIndex: { $ne: true }, _meiliIndexAttempted: true },
        {
          _meiliIndex: true,
          _meiliIndexSchemaVersion: { $ne: MEILI_INDEX_SCHEMA_VERSION },
        },
      ],
    },
  ],
});

/** Indexable records that are indexed and current. */
export const buildIndexedQuery = (indexableQuery: MeiliStoreFilter): MeiliStoreFilter => ({
  $and: [
    indexableQuery,
    {
      _meiliIndex: true,
      _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
    },
  ],
});

/** Indexable records the sync (re)indexes: not indexed, or indexed with an older shape. */
export const buildPendingSyncQuery = (indexableQuery: MeiliStoreFilter): MeiliStoreFilter => ({
  $and: [
    indexableQuery,
    {
      $or: [
        { _meiliIndex: { $ne: true } },
        {
          _meiliIndex: true,
          _meiliIndexSchemaVersion: { $ne: MEILI_INDEX_SCHEMA_VERSION },
        },
      ],
    },
  ],
});

/** The update that marks records as indexed (sync and versioned acknowledgement). */
export const MEILI_INDEXED_UPDATE: {
  readonly $set: {
    readonly _meiliIndex: true;
    readonly _meiliCleanupVersion: number;
    readonly _meiliIndexSchemaVersion: number;
  };
} = {
  $set: {
    _meiliIndex: true,
    _meiliCleanupVersion: MEILI_CLEANUP_VERSION,
    _meiliIndexSchemaVersion: MEILI_INDEX_SCHEMA_VERSION,
  },
};

/** The update that marks records as removed from the index (cleanups). */
export const MEILI_CLEANED_UPDATE: {
  readonly $set: { readonly _meiliCleanupVersion: number };
  readonly $unset: { readonly _meiliIndex: ''; readonly _meiliIndexAttempted: '' };
} = {
  $set: { _meiliCleanupVersion: MEILI_CLEANUP_VERSION },
  $unset: { _meiliIndex: '', _meiliIndexAttempted: '' },
};

/** Whether the record carries the path that keeps it out of search. */
export const isExcludedFromIndex = (
  record: Readonly<Record<string, unknown>>,
  excludeFromIndexPath?: string,
): boolean => excludeFromIndexPath != null && !_.isNil(_.get(record, excludeFromIndexPath));

/** Whether a retention deadline is absent or still ahead. */
export const hasActiveExpiration = (expiredAt?: Date | null): boolean =>
  _.isNil(expiredAt) || new Date(expiredAt).getTime() > Date.now();

/**
 * Index only retained non-temporary records whose flag was explicitly stored,
 * plus legacy permanent records that have no retention deadline. Legacy records
 * with an expiration are treated as temporary and stay out of search.
 * `explicitTemporaryFlag` tells a stored `isTemporary` from the schema default.
 */
export const isIndexableRecord = (
  record: Readonly<Record<string, unknown>> & { isTemporary?: boolean; expiredAt?: Date | null },
  explicitTemporaryFlag: boolean,
  excludeFromIndexPath?: string,
): boolean =>
  !isExcludedFromIndex(record, excludeFromIndexPath) &&
  ((record.isTemporary === false &&
    explicitTemporaryFlag &&
    hasActiveExpiration(record.expiredAt)) ||
    (!explicitTemporaryFlag && _.isNil(record.expiredAt)));

/* -------------------------------------------------------------------- the indexed document */

/** The indexed attributes of `record` (keys starting with `$` dropped), as the sync sends them. */
export const pickIndexedAttributes = (
  record: Readonly<Record<string, unknown>>,
  attributesToIndex: readonly string[],
): Record<string, unknown> =>
  _.omitBy(_.pick(record, attributesToIndex), (_v, k) => k.startsWith('$'));

/**
 * The document a record write submits: its indexed attributes, a `conversationId` containing
 * `|` with `--` in its place, and a `content` array as its `text` (steered words included).
 */
export const toSearchDocument = (
  record: Readonly<Record<string, unknown>>,
  attributesToIndex: readonly string[],
): Record<string, unknown> => {
  const object = _.omitBy(_.pick(record, attributesToIndex), (v, k) => k.startsWith('$'));

  if (
    object.conversationId &&
    typeof object.conversationId === 'string' &&
    object.conversationId.includes('|')
  ) {
    object.conversationId = object.conversationId.replace(/\|/g, '--');
  }

  if (object.content && Array.isArray(object.content)) {
    /** Search indexes the full conversational record, steered words included. */
    object.text = parseTextParts(object.content, false, { includeSteer: true });
    delete object.content;
  }

  return object;
};

/* ----------------------------------------------------------------- the versioned record write */

/** A record the versioned write handles: it carries the version of the write that produced it. */
export interface VersionedRecord {
  _meiliIndexVersion?: string;
}

/** What the versioned write of one record needs from the database. */
export interface VersionedWriteSteps<D extends VersionedRecord> {
  client: MeiliSearch;
  index: Index<MeiliIndexable>;
  primaryKey: string;
  /** Whether `doc` belongs in the index now (indexable and not unfinished). */
  shouldIndex(doc: D): boolean;
  /** The document to submit for `doc`. */
  toSearchDocument(doc: D): Record<string, unknown>;
  /** Marks `doc` removed from the index if it still carries `version`; whether it did. */
  acknowledgeCleanup(doc: D, version: string): Promise<boolean>;
  /** Marks `doc` indexed if it still carries `version`; whether it did. */
  acknowledgeIndexed(doc: D, version: string): Promise<boolean>;
  /** The record as stored now, with its flags; `null` when it was deleted. */
  loadLatest(doc: D): Promise<D | null>;
  /** Leaves `doc` (its current version) marked for the next sync. */
  markUnconverged(doc: D): Promise<void>;
}

const deleteDocumentAndWait = async <D extends VersionedRecord>(
  steps: VersionedWriteSteps<D>,
  doc: D,
): Promise<void> => {
  const deletion = await steps.index.deleteDocument(
    String((doc as unknown as Record<string, unknown>)[steps.primaryKey]),
  );
  const deletionTask = await steps.client.waitForTask(deletion.taskUid, {
    timeOutMs: MEILI_REQUEST_TIMEOUT_MS,
    intervalMs: 100,
  });
  if (deletionTask.status !== 'succeeded') {
    throw new Error(`Meili cleanup task ${deletion.taskUid} ended with ${deletionTask.status}`);
  }
};

/**
 * Submit a versioned snapshot and acknowledge only the database write that
 * produced it. If another replica wins the race, enqueue the latest snapshot
 * after the stale Meili task so task ordering converges on current data.
 */
export async function syncVersionedDocument<D extends VersionedRecord>(
  steps: VersionedWriteSteps<D>,
  initialDoc: D,
  initialMode: 'add' | 'update',
): Promise<void> {
  let doc = initialDoc;
  let mode = initialMode;

  for (let attempt = 0; attempt < meiliVersionReconcileMaxAttempts; attempt++) {
    const version = doc._meiliIndexVersion;
    if (!version) {
      throw new Error('Missing _meiliIndexVersion for detached Meili write');
    }

    if (!steps.shouldIndex(doc)) {
      await retryDetachedMeiliWrite(
        () => deleteDocumentAndWait(steps, doc),
        '[mongoMeili] Failed to remove a non-indexable document.',
      );
      if (await steps.acknowledgeCleanup(doc, version)) {
        return;
      }
    } else {
      const object = steps.toSearchDocument(doc);
      const { client, index, primaryKey } = steps;
      await retryDetachedMeiliWrite(async () => {
        const enqueued =
          mode === 'update'
            ? index.updateDocuments([object], { primaryKey })
            : index.addDocuments([object], { primaryKey });
        const task = await enqueued;
        const completedTask = await client.waitForTask(task.taskUid, {
          timeOutMs: MEILI_REQUEST_TIMEOUT_MS,
          intervalMs: 100,
        });
        if (completedTask.status !== 'succeeded') {
          throw new Error(`Meili write task ${task.taskUid} ended with ${completedTask.status}`);
        }
      }, '[mongoMeili] Failed to submit a document to Meili.');
      if (await steps.acknowledgeIndexed(doc, version)) {
        return;
      }
    }

    const latestDoc = await steps.loadLatest(doc);
    if (!latestDoc) {
      await retryDetachedMeiliWrite(
        () => deleteDocumentAndWait(steps, doc),
        '[mongoMeili] Failed to remove a concurrently deleted document.',
      );
      return;
    }
    doc = latestDoc;
    mode = 'add';
  }

  await steps.markUnconverged(doc);
  throw new Error('Meili indexing did not converge after concurrent MongoDB writes');
}

/* ------------------------------------------------------------------------ sync and cleanup */

/** What the sync progress needs from the database. */
export interface SyncProgressSteps {
  count(filter: MeiliStoreFilter): Promise<number>;
  /** The records that belong in the index (built per call: it compares with the current time). */
  indexableQuery(): MeiliStoreFilter;
  /** The excluded records that may still be indexed; `null` without an excluded path. */
  excludedIndexedQuery(): MeiliStoreFilter | null;
}

/** How far the index is behind the database: four counts, run together. */
export async function getMeiliSyncProgress(steps: SyncProgressSteps): Promise<MeiliSyncProgress> {
  const indexableQuery = steps.indexableQuery();
  const excludedIndexedQuery = steps.excludedIndexedQuery();
  const needsIndexingQuery = buildNeedsIndexingQuery(indexableQuery);
  const [totalDocuments, totalProcessed, pendingIndexing, pendingCleanup] = await Promise.all([
    steps.count(indexableQuery),
    steps.count(buildIndexedQuery(indexableQuery)),
    steps.count(needsIndexingQuery),
    excludedIndexedQuery == null ? Promise.resolve(0) : steps.count(excludedIndexedQuery),
  ]);

  return {
    totalProcessed,
    totalDocuments,
    pendingIndexing,
    pendingCleanup,
    isComplete: totalProcessed === totalDocuments && pendingCleanup === 0,
  };
}

/** What the batch sync needs from the database. */
export interface SyncSteps<R extends Record<string, unknown>> {
  index: Index<MeiliIndexable>;
  primaryKey: string;
  config: MeiliSyncConfig;
  /** An estimate of every record of the collection, for the progress log. */
  estimatedCount(): Promise<number>;
  /** Removes index entries the database no longer holds or excludes. */
  cleanupIndex(): Promise<void>;
  /** The records that belong in the index (built per batch: it compares with the current time). */
  indexableQuery(): MeiliStoreFilter;
  /** Up to `limit` records matching `filter`, with their indexed attributes and `_meiliIndex`. */
  findPending(filter: MeiliStoreFilter, limit: number): Promise<R[]>;
  /** Indexes one batch (see {@link processMeiliSyncBatch}). */
  processBatch(documents: R[]): Promise<void>;
}

/**
 * Synchronizes the database with the MeiliSearch index by incrementally indexing only
 * non-temporary records that are unindexed or stale, after the index cleanup.
 */
export async function syncMeiliIndex<R extends Record<string, unknown>>(
  steps: SyncSteps<R>,
): Promise<void> {
  const startTime = Date.now();
  const { batchSize, delayMs } = steps.config;
  const { index } = steps;

  const collectionName = steps.primaryKey === 'messageId' ? 'messages' : 'conversations';
  logger.info(`[syncWithMeili] Starting sync for ${collectionName} with batch size ${batchSize}`);

  // Get approximate total count for raw estimation, the sync should not overcome this number
  const approxTotalCount = await steps.estimatedCount();
  logger.info(
    `[syncWithMeili] Approximate total number of all ${collectionName}: ${approxTotalCount}`,
  );

  try {
    // First, handle documents that need to be removed from Meili
    logger.info(`[syncWithMeili] Starting cleanup of Meili index ${index.uid} before sync`);
    await steps.cleanupIndex();
    logger.info(`[syncWithMeili] Completed cleanup of Meili index: ${index.uid}`);
  } catch (error) {
    logger.error('[syncWithMeili] Error during cleanup Meili before sync:', error);
    throw error;
  }

  let processedCount = 0;
  let hasMore = true;

  while (hasMore) {
    const query = buildPendingSyncQuery(steps.indexableQuery());

    try {
      const documents = await steps.findPending(query, batchSize);

      // Check if there are more documents to process
      if (documents.length === 0) {
        logger.info('[syncWithMeili] No more documents to process');
        break;
      }

      // Process the batch
      await steps.processBatch(documents);
      processedCount += documents.length;
      logger.info(`[syncWithMeili] Processed: ${processedCount}`);

      if (documents.length < batchSize) {
        hasMore = false;
      }

      // Add delay to prevent overwhelming resources
      if (hasMore && delayMs > 0) {
        await sleep(delayMs);
      }
    } catch (error) {
      logger.error('[syncWithMeili] Error processing documents batch:', error);
      throw error;
    }
  }

  const duration = Date.now() - startTime;
  logger.info(
    `[syncWithMeili] Completed sync for ${collectionName}. Processed ${processedCount} documents in ${duration}ms`,
  );
}

/** What indexing one sync batch needs from the database. */
export interface SyncBatchSteps {
  /** Marks the records attempted (before the index write). */
  markAttempted(ids: unknown[]): Promise<unknown>;
  /** Marks the records indexed (after the index write). */
  markIndexed(ids: unknown[]): Promise<unknown>;
}

/**
 * Indexes one batch: marks it attempted, adds its indexed attributes to the index, marks it
 * indexed. The flag writes must leave `updatedAt` alone (the sidebar sorts on it).
 */
export async function processMeiliSyncBatch(
  steps: SyncBatchSteps,
  index: Index<MeiliIndexable>,
  documents: Array<Record<string, unknown>>,
  attributesToIndex: readonly string[],
  primaryKey: string,
): Promise<void> {
  if (documents.length === 0) {
    return;
  }

  // Format documents for MeiliSearch
  const formattedDocs = documents.map((doc) => pickIndexedAttributes(doc, attributesToIndex));

  try {
    const docsIds = documents.map((doc) => doc._id);
    await steps.markAttempted(docsIds);

    // Add documents to MeiliSearch
    await index.addDocumentsInBatches(formattedDocs, undefined, { primaryKey });

    await steps.markIndexed(docsIds);
  } catch (error) {
    logger.error('[processSyncBatch] Error processing batch:', error);
    throw error;
  }
}

/** What the excluded-record cleanup needs from the database. */
export interface ExcludedCleanupSteps {
  client: MeiliSearch;
  index: Index<MeiliIndexable>;
  primaryKey: string;
  config: MeiliSyncConfig;
  /** The excluded records that may still be indexed; `null` without an excluded path. */
  excludedIndexedQuery(): MeiliStoreFilter | null;
  /** Up to `limit` records matching `filter`, with their primary key. */
  findExcluded(filter: MeiliStoreFilter, limit: number): Promise<Array<Record<string, unknown>>>;
  /** Marks the records matching `filter` cleaned (see {@link MEILI_CLEANED_UPDATE}). */
  markCleaned(filter: MeiliStoreFilter): Promise<unknown>;
}

/**
 * Remove documents that are intentionally excluded from search without
 * scanning the complete Meili index. The database marker is cleared only
 * after Meili confirms deletion, so interrupted cleanup is retried.
 */
export async function cleanupExcludedMeiliRecords(steps: ExcludedCleanupSteps): Promise<void> {
  const excludedIndexedQuery = steps.excludedIndexedQuery();
  if (excludedIndexedQuery == null) {
    return;
  }

  const { batchSize, delayMs } = steps.config;
  const { primaryKey } = steps;
  while (true) {
    const pendingExcludedDocuments = await steps.findExcluded(excludedIndexedQuery, batchSize);
    if (pendingExcludedDocuments.length === 0) {
      break;
    }

    const pendingIds = pendingExcludedDocuments.map((doc) => doc[primaryKey]);
    const deletion = await steps.index.deleteDocuments(pendingIds.map(String));
    const deletionTask = await steps.client.waitForTask(deletion.taskUid, {
      timeOutMs: 10000,
      intervalMs: 100,
    });
    if (deletionTask.status !== 'succeeded') {
      throw new Error(`Meili cleanup task ${deletion.taskUid} ended with ${deletionTask.status}`);
    }
    await steps.markCleaned({ ...excludedIndexedQuery, [primaryKey]: { $in: pendingIds } });

    if (pendingExcludedDocuments.length < batchSize) {
      break;
    }
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

/** What the index cleanup needs from the database. */
export interface IndexCleanupSteps {
  client: MeiliSearch;
  /** The excluded-record cleanup, run first. */
  cleanupExcluded(): Promise<void>;
  /** The indexable records among those whose primary key is in `filter`, with their primary key. */
  findExisting(filter: MeiliStoreFilter): Promise<Array<Record<string, unknown>>>;
  /** Marks the records matching `filter` cleaned (see {@link MEILI_CLEANED_UPDATE}). */
  markCleaned(filter: MeiliStoreFilter): Promise<unknown>;
}

/**
 * Clean up documents in MeiliSearch that the database no longer holds (or no longer indexes),
 * after the excluded-record cleanup; pages through the index with an offset that skips what it
 * deleted. Logs a failure instead of throwing.
 */
export async function cleanupMeiliIndexEntries(
  steps: IndexCleanupSteps,
  index: Index<MeiliIndexable>,
  primaryKey: string,
  batchSize: number,
  delayMs: number,
): Promise<void> {
  try {
    await steps.cleanupExcluded();

    let offset = 0;
    let moreDocuments = true;

    while (moreDocuments) {
      const batch = await index.getDocuments({ limit: batchSize, offset });
      if (batch.results.length === 0) {
        moreDocuments = false;
        break;
      }

      const meiliIds = batch.results.map((doc) => doc[primaryKey]);
      const query: Record<string, unknown> = {};
      query[primaryKey] = { $in: meiliIds };

      const existingDocs = await steps.findExisting(query);

      const existingIds = new Set(existingDocs.map((doc) => doc[primaryKey]));

      // Delete documents that don't exist in the database
      const toDelete = meiliIds.filter((id) => !existingIds.has(id));
      if (toDelete.length > 0) {
        const deletion = await index.deleteDocuments(toDelete.map(String));
        const deletionTask = await steps.client.waitForTask(deletion.taskUid, {
          timeOutMs: 10000,
          intervalMs: 100,
        });
        if (deletionTask.status !== 'succeeded') {
          throw new Error(
            `Meili cleanup task ${deletion.taskUid} ended with ${deletionTask.status}`,
          );
        }
        await steps.markCleaned({ [primaryKey]: { $in: toDelete } });
        logger.debug(`[cleanupMeiliIndex] Deleted ${toDelete.length} orphaned documents`);
      }
      // if fetch documents request returns less documents than limit, all documents are processed
      if (batch.results.length < batchSize) {
        break;
      }

      offset += batchSize - toDelete.length;

      // Add delay between batches
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  } catch (error) {
    logger.error('[cleanupMeiliIndex] Error during cleanup:', error);
  }
}

/* ------------------------------------------------------------------------------- flag reset */

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
    flagLogger.warn(
      `[batchResetMeiliFlags] Invalid value for ${varName}="${value}". Expected a positive integer. Using default: ${defaultValue}`,
    );
    return defaultValue;
  }

  return parsed;
}

/** What the flag reset needs from the database. */
export interface FlagResetSteps {
  /** The collection's name, for the progress line and the error. */
  collectionName: string;
  /** The `_id`s of up to `limit` records matching `filter`. */
  findIds(filter: MeiliStoreFilter, limit: number): Promise<unknown[]>;
  /** Sets `_meiliIndex: false` on the records `ids`; the number it changed. */
  markUnindexed(ids: unknown[]): Promise<number>;
}

/**
 * Batch update documents in chunks to avoid timeouts on weak instances: sets `_meiliIndex` to
 * `false` on every visible document (see `buildRetentionVisibilityFilter`) that is not already
 * `false`, so the next sync reindexes it. Batch size and delay come from `MEILI_SYNC_BATCH_SIZE`
 * (default 1000) and `MEILI_SYNC_DELAY_MS` (default 100); progress is written to stdout.
 * @returns Total modified count
 * @throws {Error} - Throws if database operations fail (e.g., network issues, connection loss, permission problems)
 */
export async function resetMeiliSyncFlags(steps: FlagResetSteps): Promise<number> {
  const DEFAULT_BATCH_SIZE = 1000;

  let BATCH_SIZE = parseEnvInt('MEILI_SYNC_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  if (BATCH_SIZE === 0) {
    flagLogger.warn(
      `[batchResetMeiliFlags] MEILI_SYNC_BATCH_SIZE cannot be 0. Using default: ${DEFAULT_BATCH_SIZE}`,
    );
    BATCH_SIZE = DEFAULT_BATCH_SIZE;
  }

  const BATCH_DELAY_MS = parseEnvInt('MEILI_SYNC_DELAY_MS', 100);
  let totalModified = 0;
  let hasMore = true;

  try {
    while (hasMore) {
      /** Rebuilt per batch (it compares with the current time). */
      const visible = buildRetentionVisibilityFilter() as MeiliStoreFilter;
      const ids = await steps.findIds({ ...visible, _meiliIndex: { $ne: false } }, BATCH_SIZE);

      if (ids.length === 0) {
        break;
      }

      totalModified += await steps.markUnindexed(ids);
      process.stdout.write(`\r  Updating ${steps.collectionName}: ${totalModified} documents...`);

      if (ids.length < BATCH_SIZE) {
        hasMore = false;
      }

      if (hasMore && BATCH_DELAY_MS > 0) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    return totalModified;
  } catch (error) {
    throw new Error(
      `Failed to batch reset Meili flags for collection '${steps.collectionName}' after processing ${totalModified} documents: ${(error as Error).message}`,
    );
  }
}

/* ------------------------------------------------------------------------------------ search */

/**
 * Searches `index`; with `hydrate`, puts each hit's stored record (the one `hydrate` reads and
 * `matches` pairs with it) under its indexed fields, which win.
 */
export async function searchMeiliIndex<R extends Record<string, unknown>>(
  index: Index<MeiliIndexable>,
  q: string,
  params: SearchParams | undefined,
  hydrate?: {
    read(hits: MeiliIndexable[]): Promise<R[]>;
    matches(record: R, hit: MeiliIndexable): boolean;
  },
): Promise<SearchResponse<MeiliIndexable, Record<string, unknown>>> {
  const data = await index.search(q, params);

  if (hydrate) {
    const stored = await hydrate.read(data.hits);

    const populatedHits = data.hits.map((hit) => {
      const originalHit = _.find(stored, (item) => hydrate.matches(item, hit));

      return {
        ...(originalHit && typeof originalHit === 'object' ? originalHit : {}),
        ...hit,
      };
    });
    data.hits = populatedHits;
  }

  return data;
}

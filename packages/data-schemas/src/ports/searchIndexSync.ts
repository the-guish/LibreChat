/**
 * Search index sync port: keeping the search index (MeiliSearch today) in step with the
 * messages and conversations the database holds. Nothing here may import `mongoose` or the
 * MongoDB driver, at runtime or as a type.
 *
 * How a backend tracks what is indexed is its own business (with MongoDB: the mongoMeili
 * plugin's `_meiliIndex*` fields on each document and its model statics), so the boot sync
 * (`api/db/indexSync.js`) asks the backend for these operations instead of reaching the models.
 * The sync decisions (thresholds, the order of the steps, logging) and the search engine's own
 * maintenance (health, index settings, removing documents without a user) stay with the caller:
 * they talk to the search engine only and are the same whichever database feeds it.
 *
 * Not a member of `DataStore`: it is index maintenance for the whole deployment, run as the
 * system at boot, and is reached through the backend (`DataStoreBackend.getSearchIndexSync`).
 */
import { listPortMethods } from './common';

/** The searchable data: messages and conversations. */
export type SearchIndexName = 'messages' | 'conversations';

/** How far the search index is behind the database for one {@link SearchIndexName}. */
export interface SearchIndexSyncProgress {
  /** Documents that are indexed and current. */
  totalProcessed: number;
  /** Documents that should be in the index. */
  totalDocuments: number;
  /** Documents whose indexing failed or whose indexed shape is outdated. */
  pendingIndexing: number;
  /** Documents excluded from search (such as temporary ones) that are still indexed. */
  pendingCleanup: number;
  /** Whether every document is indexed and nothing awaits cleanup. */
  isComplete: boolean;
}

/** The database side of the search index sync, for messages and conversations. */
export interface SearchIndexSync {
  /** How far the index is behind the database. */
  getSyncProgress(index: SearchIndexName): Promise<SearchIndexSyncProgress>;
  /**
   * Indexes every document that is not indexed or is stale, after removing from the index the
   * documents the database no longer holds or excludes; logs its own progress.
   */
  syncIndex(index: SearchIndexName): Promise<void>;
  /** Removes documents excluded from search from the index, without a full sync. */
  cleanupExcluded(index: SearchIndexName): Promise<void>;
  /**
   * Marks every visible document as not indexed, in batches, so the next sync reindexes it all;
   * resolves to the number of documents marked. Batch size and delay come from
   * `MEILI_SYNC_BATCH_SIZE` / `MEILI_SYNC_DELAY_MS`; progress is written to stdout.
   */
  resetSyncFlags(index: SearchIndexName): Promise<number>;
}

/** Every method of {@link SearchIndexSync}, for adapters and conformance checks. */
export const SEARCH_INDEX_SYNC_METHODS: ReadonlyArray<keyof SearchIndexSync> =
  listPortMethods<SearchIndexSync>({
    getSyncProgress: true,
    syncIndex: true,
    cleanupExcluded: true,
    resetSyncFlags: true,
  });

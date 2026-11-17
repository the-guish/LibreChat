/**
 * MeiliSearch on the PostgreSQL backend (D4; docs/postgres-port/PHASE4.md §4 "Search engine",
 * §8 I3): the write hooks that keep the `messages` and `convos` indexes in step with the two
 * tables, the search index sync (`SearchIndexSync`) on their `_meili*` flag columns, and the
 * index reads the stores make. The search-engine side is `~/search/meiliIndexer`, shared with the
 * MongoDB plugin; this module supplies its PostgreSQL steps. Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * - **Configuration**: MeiliSearch is on when `MEILI_HOST` and `MEILI_MASTER_KEY` are set (read
 *   when the backend builds its collections, on first use), as the MongoDB plugin is applied;
 *   `SEARCH=true` also turns on what the plugin ties to it (the update and delete hooks). The
 *   client and each index are built on first use; the index is created when missing and `user`
 *   made filterable, as the plugin does at boot.
 * - **Write hooks** (collection hooks, document mode only, as mongoose middleware), on the
 *   writes the plugin's middleware sees: `insertOne` (mongoose's `save`) stamps a new
 *   `_meiliIndexVersion` (with `_meiliIndex: false`, `_meiliIndexAttempted: true`) on an
 *   indexable record and, once the write is durable, submits it; `findOneAndUpdate` (and a write
 *   that opts in with `writeHooks: true`) stamps the update when `SEARCH=true` and submits the
 *   record as stored then. The submission is the plugin's versioned write: detached from the
 *   store write, serialized per record, acknowledged only on the version it submitted (a raw
 *   update by `_id` and version, which runs no hooks and leaves `updatedAt`). A non-indexable
 *   record (temporary, expired, excluded, unfinished) is removed from the index and marked
 *   cleaned instead. Every delete removes the deleted records from the index once it is durable
 *   (with `SEARCH=true`, as the plugin's `deleteMany` hook). `updateMany`, `insertMany` and
 *   `bulk` index nothing, as mongoose runs no document middleware for them; the boot sync catches
 *   up.
 * - **Index sync** (`SearchIndexSync`): the plugin's statics on the raw collections (no tenant
 *   scoping, no timestamps, no hooks: the sync runs as the system at boot). Pending records are
 *   read in batches of `MEILI_SYNC_BATCH_SIZE` that drop out of the pending set as they are
 *   marked, so no offset or cursor is kept; the index cleanup pages through MeiliSearch.
 * - **Reads**: the stores search through {@link PostgresSearch.search}. A hydrated message search
 *   reads the stored messages by user and `messageId` (MongoDB's reads them by `messageId`
 *   alone, PHASE4.md §4), in document mode (tenant-scoped, default projection).
 */
import { sql } from 'kysely';
import type { SearchParams, SearchResponse, MeiliSearch, Index } from 'meilisearch';
import type { MeiliIndexable, MeiliSyncConfig, VersionedWriteSteps } from '~/search/meiliIndexer';
import type { SearchIndexName, SearchIndexSync } from '~/ports/searchIndexSync';
import type { StoreTransactions } from '~/ports/storeTransactions';
import type { CollectionHooks } from './collection/hooks';
import type { PgRecord } from './collection/types';
import type { PgCollections } from './collection';
import type { PostgresKysely } from './types';
import {
  MEILI_CLEANED_UPDATE,
  MEILI_INDEXED_UPDATE,
  syncMeiliIndex,
  ensureMeiliIndex,
  processInBatches,
  toSearchDocument,
  searchMeiliIndex,
  isIndexableRecord,
  createMeiliClient,
  getMeiliSyncConfig,
  buildIndexableQuery,
  resetMeiliSyncFlags,
  getMeiliSyncProgress,
  processMeiliSyncBatch,
  syncVersionedDocument,
  buildExcludedIndexedQuery,
  cleanupMeiliIndexEntries,
  createDetachedMeiliRunner,
  cleanupExcludedMeiliRecords,
} from '~/search/meiliIndexer';
import { buildRetentionVisibilityFilter } from '~/utils/retention';
import { generatePostgresStoreId } from './storeIds';
import logger from '~/config/meiliLogger';

/** The MeiliSearch configuration of the PostgreSQL backend. */
export interface PostgresSearchOptions {
  host: string;
  apiKey: string;
  /** `SEARCH=true`: the update and delete hooks run (the MongoDB plugin's `meiliEnabled`). */
  searchEnabled: boolean;
}

/** The configuration `env` gives: `null` unless `MEILI_HOST` and `MEILI_MASTER_KEY` are set. */
export function readPostgresSearchOptions(
  env: Readonly<Record<string, string | undefined>>,
): PostgresSearchOptions | null {
  if (!env.MEILI_HOST || !env.MEILI_MASTER_KEY) {
    return null;
  }
  return {
    host: env.MEILI_HOST,
    apiKey: env.MEILI_MASTER_KEY,
    searchEnabled: env.SEARCH != null && env.SEARCH.toLowerCase() === 'true',
  };
}

/** One searchable kind of data: its table, its index and what it indexes. */
export interface PostgresSearchKind {
  name: SearchIndexName;
  collection: 'messages' | 'conversations';
  indexName: string;
  primaryKey: string;
  /** Records carrying this path stay in the table but out of search. */
  excludeFromIndexPath: string;
  /** The schema paths marked `meiliIndex` (and `user`), in schema order. */
  attributesToIndex: readonly string[];
}

/**
 * The two searchable kinds, as the models apply the plugin (`models/message.ts`,
 * `models/convo.ts`); `search.spec.ts` checks the attributes against the schemas.
 */
export const POSTGRES_SEARCH_KINDS: Readonly<Record<SearchIndexName, PostgresSearchKind>> = {
  messages: {
    name: 'messages',
    collection: 'messages',
    indexName: 'messages',
    primaryKey: 'messageId',
    excludeFromIndexPath: 'subagentTask',
    attributesToIndex: ['messageId', 'conversationId', 'user', 'sender', 'text', 'content'],
  },
  conversations: {
    name: 'conversations',
    collection: 'conversations',
    indexName: 'convos',
    primaryKey: 'conversationId',
    excludeFromIndexPath: 'subagentThread',
    attributesToIndex: ['conversationId', 'title', 'user', 'tags'],
  },
};

/** Thrown when the search is used without MeiliSearch configured. */
export class SearchNotConfiguredError extends Error {
  constructor() {
    super('MeiliSearch is not configured (MEILI_HOST and MEILI_MASTER_KEY)');
    this.name = 'SearchNotConfiguredError';
  }
}

/** What the PostgreSQL search is built with. */
export interface PostgresSearchDeps {
  /** The configuration, read once on first use (`null`: MeiliSearch is off). */
  options(): PostgresSearchOptions | null;
  /** The backend's collections (the raw ones serve the index bookkeeping). */
  collections(): PgCollections;
  /** The backend's Kysely instance (the sync's size estimate). */
  db(): PostgresKysely;
  /** Defers index work until a caller's transaction commits. */
  transactions: Pick<StoreTransactions, 'runAfterCommit'>;
}

/** MeiliSearch on the PostgreSQL backend. */
export interface PostgresSearch {
  /** Whether MeiliSearch is configured. */
  configured(): boolean;
  /** The collection hooks of `messages` and `conversations` (none while unconfigured). */
  hooks(): Record<string, CollectionHooks>;
  /** The search index sync on the flag columns. */
  readonly searchIndexSync: SearchIndexSync;
  /**
   * Searches the index of `kind`; with `hydrate`, merges each hit's stored record (the ones
   * `hydrate` reads, paired by the primary key). Throws {@link SearchNotConfiguredError} while
   * MeiliSearch is off.
   */
  search(
    kind: SearchIndexName,
    q: string,
    params: SearchParams | undefined,
    hydrate?: (hits: MeiliIndexable[]) => Promise<PgRecord[]>,
  ): Promise<SearchResponse<MeiliIndexable, Record<string, unknown>>>;
}

/** An index of one kind, with its client. */
interface KindIndex {
  client: MeiliSearch;
  index: Index<MeiliIndexable>;
}

/** The PostgreSQL search. */
export function createPostgresSearch(deps: PostgresSearchDeps): PostgresSearch {
  let options: PostgresSearchOptions | null | undefined;
  const config = () => (options === undefined ? (options = deps.options()) : options);
  let client: MeiliSearch | undefined;
  const indexes = new Map<SearchIndexName, KindIndex>();
  const syncConfig = (): MeiliSyncConfig => getMeiliSyncConfig();
  const runDetached = createDetachedMeiliRunner();
  /** Inserted records whose `isTemporary` the caller gave (the schema default is not explicit). */
  const explicitTemporary = new WeakMap<object, boolean>();

  const required = (): PostgresSearchOptions => {
    const current = config();
    if (!current) {
      throw new SearchNotConfiguredError();
    }
    return current;
  };

  const indexOf = (name: SearchIndexName): KindIndex => {
    let entry = indexes.get(name);
    if (!entry) {
      const { host, apiKey } = required();
      client ??= createMeiliClient(host, apiKey);
      const kind = POSTGRES_SEARCH_KINDS[name];
      const index = client.index<MeiliIndexable>(kind.indexName);
      void ensureMeiliIndex(client, index, kind.indexName, kind.primaryKey);
      entry = { client, index };
      indexes.set(name, entry);
    }
    return entry;
  };

  const raw = (kind: PostgresSearchKind) => deps.collections().raw(kind.collection);

  const indexableQuery = (kind: PostgresSearchKind) =>
    buildIndexableQuery(
      buildRetentionVisibilityFilter() as Record<string, unknown>,
      kind.excludeFromIndexPath,
    );
  const excludedIndexedQuery = (kind: PostgresSearchKind) =>
    buildExcludedIndexedQuery(kind.excludeFromIndexPath);

  /* ------------------------------------------------------------- the versioned write */

  const versionedSteps = (kind: PostgresSearchKind): VersionedWriteSteps<PgRecord> => {
    const { client, index } = indexOf(kind.name);
    return {
      client,
      index,
      primaryKey: kind.primaryKey,
      shouldIndex: (doc) =>
        isIndexableRecord(
          doc,
          explicitTemporary.get(doc) ?? doc.isTemporary != null,
          kind.excludeFromIndexPath,
        ) && !doc.unfinished,
      toSearchDocument: (doc) => toSearchDocument(doc, kind.attributesToIndex),
      acknowledgeCleanup: async (doc, version) =>
        (
          await raw(kind).updateOne(
            { _id: doc._id, _meiliIndexVersion: version },
            MEILI_CLEANED_UPDATE,
          )
        ).matchedCount > 0,
      acknowledgeIndexed: async (doc, version) =>
        (
          await raw(kind).updateOne(
            { _id: doc._id, _meiliIndexVersion: version },
            MEILI_INDEXED_UPDATE,
          )
        ).matchedCount > 0,
      loadLatest: (doc) => raw(kind).findOne({ _id: doc._id }),
      markUnconverged: async (doc) => {
        await raw(kind).updateOne(
          { _id: doc._id, _meiliIndexVersion: doc._meiliIndexVersion },
          { $set: { _meiliIndex: false, _meiliIndexAttempted: true } },
        );
      },
    };
  };

  /** Submits the record (or, given only its key, the record as stored then), detached. */
  const scheduleWrite = (kind: PostgresSearchKind, key: string, record?: PgRecord) => {
    runDetached(
      `${kind.indexName}:${key}`,
      async () => {
        const doc = record ?? (await raw(kind).findOne({ _id: key }));
        if (!doc?._meiliIndexVersion) {
          return;
        }
        try {
          await syncVersionedDocument(versionedSteps(kind), doc, 'add');
        } catch (error) {
          logger.error('[addObjectToMeili] Error adding document to Meili:', error);
        }
      },
      '[postgresSearch] Detached indexing failed:',
    );
  };

  /** Removes `ids` from the index of `kind`, in batches; logs a failure. */
  const removeFromIndex = async (kind: PostgresSearchKind, ids: string[]): Promise<void> => {
    try {
      const { index } = indexOf(kind.name);
      const { batchSize, delayMs } = syncConfig();
      await processInBatches(ids, batchSize, delayMs, async (batch) => {
        await index.deleteDocuments(batch);
      });
    } catch (error) {
      logger.error(
        '[postgresSearch] There was an issue deleting indexes upon deletion. Next startup may trigger syncing.',
        error,
      );
    }
  };

  const kindHooks = (
    kind: PostgresSearchKind,
    current: PostgresSearchOptions,
  ): CollectionHooks => ({
    beforeInsert(record, context) {
      if (!context?.tracked) {
        return;
      }
      const explicit = context.input.isTemporary != null;
      if (
        isIndexableRecord(record, explicit, kind.excludeFromIndexPath) ||
        record._meiliIndex === true ||
        record._meiliIndexAttempted === true
      ) {
        record._meiliIndexVersion = generatePostgresStoreId();
        record._meiliIndex = false;
        record._meiliIndexAttempted = true;
      }
    },
    beforeUpdate(update, context) {
      if (!context.tracked || !current.searchEnabled) {
        return update;
      }
      return {
        ...update,
        $set: {
          ...((update.$set as PgRecord | undefined) ?? {}),
          _meiliIndex: false,
          _meiliIndexAttempted: true,
          _meiliIndexVersion: generatePostgresStoreId(),
        },
      };
    },
    afterWrite(written, context) {
      if (written.record) {
        const record = written.record;
        if (!record._meiliIndexVersion) {
          return;
        }
        explicitTemporary.set(record, written.input?.isTemporary != null);
        return deps.transactions.runAfterCommit(context.tx, async () =>
          scheduleWrite(kind, written.key, record),
        );
      }
      if (!current.searchEnabled) {
        return;
      }
      return deps.transactions.runAfterCommit(context.tx, async () =>
        scheduleWrite(kind, written.key),
      );
    },
    afterDelete: {
      columns: [kind.primaryKey],
      run(rows, context) {
        if (!current.searchEnabled || rows.length === 0) {
          return;
        }
        const ids = rows
          .map((row) => row[kind.primaryKey])
          .filter((id): id is string => typeof id === 'string');
        return deps.transactions.runAfterCommit(context.tx, () => removeFromIndex(kind, ids));
      },
    },
  });

  /* ------------------------------------------------------------------ the index sync */

  const kindOf = (name: SearchIndexName) => {
    const kind = POSTGRES_SEARCH_KINDS[name];
    if (!kind) {
      throw new Error(`Unknown search index: ${String(name)}`);
    }
    return kind;
  };

  const cleanupExcluded = (kind: PostgresSearchKind) => {
    const { client, index } = indexOf(kind.name);
    return cleanupExcludedMeiliRecords({
      client,
      index,
      primaryKey: kind.primaryKey,
      config: syncConfig(),
      excludedIndexedQuery: () => excludedIndexedQuery(kind),
      findExcluded: (filter, limit) =>
        raw(kind).find(filter, { projection: kind.primaryKey, limit }),
      markCleaned: (filter) => raw(kind).updateMany(filter, MEILI_CLEANED_UPDATE),
    });
  };

  const searchIndexSync: SearchIndexSync = {
    getSyncProgress(name) {
      const kind = kindOf(name);
      return getMeiliSyncProgress({
        count: (filter) => raw(kind).count(filter),
        indexableQuery: () => indexableQuery(kind),
        excludedIndexedQuery: () => excludedIndexedQuery(kind),
      });
    },

    async syncIndex(name) {
      const kind = kindOf(name);
      const { client, index } = indexOf(kind.name);
      const configNow = syncConfig();
      await syncMeiliIndex<PgRecord>({
        index,
        primaryKey: kind.primaryKey,
        config: configNow,
        estimatedCount: async () => {
          /** The planner's estimate, as MongoDB's `estimatedDocumentCount` (a progress log only). */
          const { rows } = await sql<{
            estimate: string | number | null;
          }>`SELECT GREATEST(reltuples, 0)::bigint AS estimate FROM pg_class WHERE oid = to_regclass(${kind.collection})`.execute(
            deps.db(),
          );
          return Number(rows[0]?.estimate ?? 0);
        },
        cleanupIndex: () =>
          cleanupMeiliIndexEntries(
            {
              client,
              cleanupExcluded: () => cleanupExcluded(kind),
              findExisting: (filter) =>
                raw(kind).find(
                  { $and: [filter, indexableQuery(kind)] },
                  { projection: kind.primaryKey },
                ),
              markCleaned: (filter) => raw(kind).updateMany(filter, MEILI_CLEANED_UPDATE),
            },
            index,
            kind.primaryKey,
            configNow.batchSize,
            configNow.delayMs,
          ),
        indexableQuery: () => indexableQuery(kind),
        findPending: (filter, limit) =>
          raw(kind).find(filter, {
            projection: `${kind.attributesToIndex.join(' ')} _meiliIndex`,
            limit,
          }),
        processBatch: (documents) =>
          processMeiliSyncBatch(
            {
              markAttempted: (ids) =>
                raw(kind).updateMany(
                  { _id: { $in: ids } },
                  { $set: { _meiliIndexAttempted: true } },
                ),
              markIndexed: (ids) =>
                raw(kind).updateMany({ _id: { $in: ids } }, MEILI_INDEXED_UPDATE),
            },
            index,
            documents,
            kind.attributesToIndex,
            kind.primaryKey,
          ),
      });
    },

    cleanupExcluded: async (name) => cleanupExcluded(kindOf(name)),

    resetSyncFlags(name) {
      const kind = kindOf(name);
      return resetMeiliSyncFlags({
        collectionName: kind.collection,
        findIds: async (filter, limit) =>
          (await raw(kind).find(filter, { projection: '_id', limit })).map((record) => record._id),
        markUnindexed: async (ids) =>
          (await raw(kind).updateMany({ _id: { $in: ids } }, { $set: { _meiliIndex: false } }))
            .modifiedCount,
      });
    },
  };

  return {
    configured: () => config() != null,

    hooks() {
      const current = config();
      if (!current) {
        return {};
      }
      return Object.fromEntries(
        Object.values(POSTGRES_SEARCH_KINDS).map((kind) => [
          kind.collection,
          kindHooks(kind, current),
        ]),
      );
    },

    searchIndexSync,

    async search(name, q, params, hydrate) {
      const kind = kindOf(name);
      const { index } = indexOf(name);
      return searchMeiliIndex<PgRecord>(
        index,
        q,
        params,
        hydrate
          ? {
              read: hydrate,
              matches: (record, hit) => record[kind.primaryKey] === hit[kind.primaryKey],
            }
          : undefined,
      );
    },
  };
}

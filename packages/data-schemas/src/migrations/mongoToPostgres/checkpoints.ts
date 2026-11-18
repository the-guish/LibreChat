/**
 * The copy of the LangGraph checkpoints (docs/postgres-port/PHASE4.md D5, §8 X1 "Checkpoints"):
 * per storage (a pair of MongoDB collections) and per stored `(thread_id, checkpoint_ns)`,
 *
 * 1. the checkpoints are read with `MongoDBSaver.list()` (serde-decoded tuples, newest first,
 *    with their pending writes; the stored, owner-prefixed ids as they are);
 * 2. they are written oldest first through LibreChat's PostgreSQL saver (`OwnedPostgresSaver`,
 *    I2): `put(config, checkpoint, metadata, newVersions = checkpoint.channel_versions)`, then
 *    `putWrites(config, writes, taskId)` per task (no `taskPath`, so the writes sort by task id,
 *    the 1.2 contract for rows without a path). A checkpoint MongoDB stored for an owner
 *    (`lc_owner`, owner-prefixed thread and namespace) is written through the owned path with the
 *    owner's key, so PostgreSQL stores the same prefixed ids and `lc_owner` and records the
 *    owner's storage descriptor; a row whose ids do not carry its owner's prefix is written as
 *    stored and its `lc_owner` set afterwards. `upserted_at` (the TTL clock) is the copy time.
 * 3. They are read back with the saver's unowned `list()` on the stored ids and compared with
 *    the source: checkpoint, metadata, parent, pending writes (as a set) and `lc_owner`. The
 *    checkpoint is compared without the channel values its `channel_versions` do not name
 *    ({@link versionedCheckpoint}): `PostgresSaver` stores values per channel version, so those
 *    (LangGraph's empty task topic) read back as the empty channels they are.
 *
 * `put` upserts and `putWrites` skips or replaces what is there, so a repeated run converges.
 * The storages are the default one (`agent_checkpoints`, `agent_checkpoint_writes`), those the
 * storage descriptors and deletion intents name, and those the caller adds.
 */
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import type {
  PendingWrite,
  CheckpointTuple,
  CheckpointMetadata,
  CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { Db, MongoClient } from 'mongodb';
import type { Pool } from 'pg';
import type { CheckpointRunnableConfig } from '~/methods/checkpointRules';
import type { CheckpointStorageNames } from '~/ports/checkpointStore';
import type { PgCollections } from '~/adapters/postgres/collection';
import type { CheckpointCopyReport } from './report';
import {
  OwnedPostgresSaver,
  postgresCheckpointTables,
  postgresCheckpointSchemaName,
  setupPostgresCheckpointStorage,
  POSTGRES_CHECKPOINT_STORAGE_TABLE,
} from '~/adapters/postgres/checkpointSaver';
import { LIBRECHAT_CHECKPOINT_OWNER_KEY } from '~/ports/checkpointStore';
import { firstDifference, toCanonical } from './canonical';
import { describeFailure } from './collections';
import { addProblem } from './report';

/** The storage LibreChat uses when `librechat.yaml` names none. */
export const DEFAULT_CHECKPOINT_STORAGE: CheckpointStorageNames = {
  checkpointCollectionName: 'agent_checkpoints',
  checkpointWritesCollectionName: 'agent_checkpoint_writes',
};

/** The MongoDB collection of the pending checkpoint deletions. */
const DELETION_COLLECTION = 'agent_checkpoint_deletions';

/** What a checkpoint copy works with. */
export interface CheckpointCopyContext {
  client: MongoClient;
  source: Db;
  pool: Pool;
  /** The backend's PostgreSQL schema (`POSTGRES_SCHEMA`). */
  schema: string;
  collections: PgCollections;
  dryRun: boolean;
  log(message: string): void;
}

function storageKey(storage: CheckpointStorageNames): string {
  return JSON.stringify([storage.checkpointCollectionName, storage.checkpointWritesCollectionName]);
}

function asStorage(value: unknown): CheckpointStorageNames | undefined {
  const storage = value as Partial<CheckpointStorageNames> | null | undefined;
  return typeof storage?.checkpointCollectionName === 'string' &&
    typeof storage.checkpointWritesCollectionName === 'string'
    ? {
        checkpointCollectionName: storage.checkpointCollectionName,
        checkpointWritesCollectionName: storage.checkpointWritesCollectionName,
      }
    : undefined;
}

/**
 * The storages to copy (see the module header), those whose checkpoint or writes collection the
 * source holds (`present`).
 */
export async function findCheckpointStorages(
  source: Db,
  present: ReadonlySet<string>,
  extra: readonly CheckpointStorageNames[] = [],
): Promise<CheckpointStorageNames[]> {
  const storages = new Map<string, CheckpointStorageNames>();
  const add = (storage: CheckpointStorageNames | undefined) => {
    if (storage) storages.set(storageKey(storage), storage);
  };
  add(DEFAULT_CHECKPOINT_STORAGE);
  for (const collection of [POSTGRES_CHECKPOINT_STORAGE_TABLE, DELETION_COLLECTION]) {
    if (!present.has(collection)) continue;
    const records = await source
      .collection(collection)
      .find({}, { projection: { storage: 1 } })
      .toArray();
    for (const record of records) add(asStorage(record.storage));
  }
  extra.forEach(add);
  return [...storages.values()].filter(
    (storage) =>
      present.has(storage.checkpointCollectionName) ||
      present.has(storage.checkpointWritesCollectionName),
  );
}

/** The pending writes of a tuple grouped by task, in their order. */
function writesByTask(writes: readonly CheckpointPendingWrite[] = []): Map<string, PendingWrite[]> {
  const tasks = new Map<string, PendingWrite[]>();
  for (const [taskId, channel, value] of writes) {
    const list = tasks.get(taskId) ?? [];
    list.push([channel, value]);
    tasks.set(taskId, list);
  }
  return tasks;
}

/**
 * A checkpoint without the channel values its `channel_versions` do not name: `PostgresSaver`
 * stores a value per channel version, so an unversioned value (LangGraph's empty
 * `__pregel_tasks` topic, which a checkpoint document keeps) is not stored, and reads back as
 * the empty channel it is.
 */
export function versionedCheckpoint(checkpoint: CheckpointTuple['checkpoint']): unknown {
  const versions = checkpoint.channel_versions ?? {};
  return {
    ...checkpoint,
    channel_values: Object.fromEntries(
      Object.entries(checkpoint.channel_values ?? {}).filter(([channel]) => channel in versions),
    ),
  };
}

/**
 * A tuple's comparable parts in canonical form: the versioned checkpoint, the metadata, the
 * parent, and the pending writes as a sorted set.
 */
function comparable(tuple: CheckpointTuple): unknown {
  const writes = (tuple.pendingWrites ?? [])
    .map((write) => JSON.stringify(toCanonical(JSON.parse(JSON.stringify(write)) as unknown)))
    .sort();
  return toCanonical({
    checkpoint: JSON.parse(JSON.stringify(versionedCheckpoint(tuple.checkpoint))) as unknown,
    metadata: JSON.parse(JSON.stringify(tuple.metadata ?? {})) as unknown,
    parent: tuple.parentConfig?.configurable?.checkpoint_id ?? null,
    writes,
  });
}

/** The saver config of a stored checkpoint, with its owner's key when its ids carry its prefix. */
function storedConfig(
  threadId: string,
  namespace: string,
  owner: string | undefined,
  checkpointId: string | undefined,
): { config: CheckpointRunnableConfig; owned: boolean } {
  const owned = owner != null && threadId.startsWith(owner) && namespace.startsWith(owner);
  const configurable: Record<string, unknown> = owned
    ? {
        thread_id: threadId.slice(owner.length),
        checkpoint_ns: namespace.slice(owner.length),
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
      }
    : { thread_id: threadId, checkpoint_ns: namespace };
  if (checkpointId !== undefined) {
    configurable.checkpoint_id = checkpointId;
  }
  return { config: { configurable }, owned };
}

/** Copies one storage (see the module header). */
export async function copyCheckpointStorage(
  context: CheckpointCopyContext,
  storage: CheckpointStorageNames,
): Promise<CheckpointCopyReport> {
  const schema = postgresCheckpointSchemaName(context.schema, storage);
  const report: CheckpointCopyReport = {
    checkpointCollection: storage.checkpointCollectionName,
    writesCollection: storage.checkpointWritesCollectionName,
    schema,
    threads: 0,
    checkpoints: 0,
    writes: 0,
    verified: 0,
    failed: 0,
    failures: [],
    mismatched: 0,
    mismatches: [],
    orphanWrites: 0,
  };
  const checkpoints = context.source.collection(storage.checkpointCollectionName);
  const mongoSaver = new MongoDBSaver({
    client: context.client as unknown as ConstructorParameters<typeof MongoDBSaver>[0]['client'],
    dbName: context.source.databaseName,
    checkpointCollectionName: storage.checkpointCollectionName,
    checkpointWritesCollectionName: storage.checkpointWritesCollectionName,
  });
  let saver: OwnedPostgresSaver | undefined;
  if (!context.dryRun) {
    await setupPostgresCheckpointStorage(context.pool, schema, storage);
    saver = new OwnedPostgresSaver({
      pool: context.pool,
      schema,
      storage: { type: 'mongo', ...storage },
      recordDescriptor: async (record) => {
        await context.collections
          .raw(POSTGRES_CHECKPOINT_STORAGE_TABLE)
          .updateOne(
            { _id: record._id },
            { $setOnInsert: { owner: record.owner, storage: record.storage } },
            { upsert: true },
          );
      },
    });
  }
  const tables = postgresCheckpointTables(schema);
  const threads = checkpoints.aggregate<{ _id: { thread: unknown; namespace: unknown } }>(
    [
      { $group: { _id: { thread: '$thread_id', namespace: '$checkpoint_ns' } } },
      { $sort: { '_id.thread': 1, '_id.namespace': 1 } },
    ],
    { allowDiskUse: true },
  );
  for await (const { _id: key } of threads) {
    const threadId = typeof key.thread === 'string' ? key.thread : undefined;
    const namespace = typeof key.namespace === 'string' ? key.namespace : '';
    if (threadId === undefined) {
      report.failed += 1;
      addProblem(report.failures, { id: String(key.thread), message: 'thread_id is not a string' });
      continue;
    }
    report.threads += 1;
    const label = `${threadId}|${namespace}`;
    const owners = new Map<string, string | undefined>();
    for (const row of await checkpoints
      .find(
        { thread_id: threadId, checkpoint_ns: namespace },
        { projection: { _id: 0, checkpoint_id: 1, lc_owner: 1 } },
      )
      .toArray()) {
      owners.set(
        String(row.checkpoint_id),
        typeof row.lc_owner === 'string' ? row.lc_owner : undefined,
      );
    }
    const tuples: CheckpointTuple[] = [];
    for await (const tuple of mongoSaver.list({
      configurable: { thread_id: threadId, checkpoint_ns: namespace },
    })) {
      tuples.unshift(tuple);
    }
    report.checkpoints += tuples.length;
    report.writes += tuples.reduce((sum, tuple) => sum + (tuple.pendingWrites?.length ?? 0), 0);
    if (!saver) continue;
    const written = new Set<string>();
    for (const tuple of tuples) {
      const checkpointId = tuple.checkpoint.id;
      const owner = owners.get(checkpointId);
      try {
        const parent = tuple.parentConfig?.configurable?.checkpoint_id as string | undefined;
        const { config, owned } = storedConfig(threadId, namespace, owner, parent);
        await saver.put(
          config,
          tuple.checkpoint,
          tuple.metadata as CheckpointMetadata,
          tuple.checkpoint.channel_versions,
        );
        const writeConfig = storedConfig(threadId, namespace, owner, checkpointId).config;
        for (const [taskId, writes] of writesByTask(tuple.pendingWrites)) {
          await saver.putWrites(writeConfig, writes, taskId);
        }
        if (owner != null && !owned) {
          for (const table of [tables.checkpoints, tables.writes]) {
            await context.pool.query(
              `UPDATE ${table} SET lc_owner = $4
                WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3`,
              [threadId, namespace, checkpointId, owner],
            );
          }
        }
        written.add(checkpointId);
      } catch (error) {
        report.failed += 1;
        addProblem(report.failures, {
          id: `${label}|${checkpointId}`,
          message: describeFailure(error),
        });
      }
    }
    const stored = new Map<string, CheckpointTuple>();
    for await (const tuple of saver.list({
      configurable: { thread_id: threadId, checkpoint_ns: namespace },
    })) {
      stored.set(tuple.checkpoint.id, tuple);
    }
    const { rows } = await context.pool.query<{ checkpoint_id: string; lc_owner: string | null }>(
      `SELECT checkpoint_id, lc_owner FROM ${tables.checkpoints} WHERE thread_id = $1 AND checkpoint_ns = $2`,
      [threadId, namespace],
    );
    const storedOwners = new Map(rows.map((row) => [row.checkpoint_id, row.lc_owner ?? undefined]));
    for (const tuple of tuples) {
      const checkpointId = tuple.checkpoint.id;
      if (!written.has(checkpointId)) continue;
      const copy = stored.get(checkpointId);
      let message: string | undefined;
      if (!copy) {
        message = 'missing in PostgreSQL';
      } else if (storedOwners.get(checkpointId) !== owners.get(checkpointId)) {
        message = 'lc_owner differs';
      } else {
        const difference = firstDifference(comparable(tuple) as never, comparable(copy) as never);
        if (difference) {
          message = `${difference.path}: expected ${difference.expected}, found ${difference.actual}`;
        }
      }
      if (message) {
        report.mismatched += 1;
        addProblem(report.mismatches, { id: `${label}|${checkpointId}`, message });
      } else {
        report.verified += 1;
      }
    }
  }
  const totalWrites = await context.source
    .collection(storage.checkpointWritesCollectionName)
    .countDocuments();
  report.orphanWrites = Math.max(0, totalWrites - report.writes);
  return report;
}

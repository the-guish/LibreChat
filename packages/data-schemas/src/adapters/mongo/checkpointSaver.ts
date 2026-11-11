/**
 * The MongoDB LangGraph checkpoint saver (`CheckpointStore.createSaver` in
 * `~/ports/checkpointStore`), moved from `@librechat/api` (`agents/checkpointer.ts` and
 * `agents/checkpoints/saver.ts`): `MongoDBSaver` from `@langchain/langgraph-checkpoint-mongodb`
 * on the server's `MongoClient`, bound to the database mongoose selected, with
 * - {@link OwnedMongoSaver}: owner-isolated rows (`lc_owner`, owner-prefixed thread and
 *   namespace) and the storage descriptors in {@link CHECKPOINT_STORAGE_COLLECTION};
 * - {@link LazyMongoSaver}: the generation namespace mapping, the lazy persistence of anchored
 *   checkpoints only, and the single-document size guard (MongoDB's 16 MB BSON ceiling);
 * - {@link setupCheckpointIndexes} and {@link createMongoCheckpointSaver}: the saver's indexes
 *   (retried on single-index-build engines such as Amazon DocumentDB) plus the `checkpoint_ns`
 *   and `lc_owner` cleanup indexes.
 */
import { mongo } from 'mongoose';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { INTERRUPT, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  CheckpointListOptions,
  CheckpointPendingWrite,
  BaseCheckpointSaver,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { Mongoose } from 'mongoose';
import type { CheckpointSaverOptions, CheckpointStorageDescriptor } from '~/ports/checkpointStore';
import type { IndexBuildOptions } from '~/utils/retry';
import {
  checkpointStorageKey,
  CheckpointTooLargeError,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from '~/ports/checkpointStore';
import { buildIndexWithRetry, isIndexBuildInProgress } from '~/utils/retry';
import logger from '~/config/winston';

/** The LangGraph runnable config every saver method takes. */
type RunnableConfig = Parameters<BaseCheckpointSaver['getTuple']>[0];

/** The collection that holds the storage descriptors (`CheckpointStore.listStorageDescriptors`). */
export const CHECKPOINT_STORAGE_COLLECTION = 'agent_checkpoint_stores';

/** A storage descriptor: where an owner wrote checkpoints. */
export interface CheckpointStorageRecord {
  _id: string;
  owner: string;
  storage: CheckpointStorageDescriptor;
}

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  lc_owner?: string;
  type: string;
  checkpoint: mongo.Binary;
  metadata: mongo.Binary;
  metadata_search: CheckpointMetadata;
}

interface WriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: mongo.Binary;
  lc_owner?: string;
}

function ownerOf(config: RunnableConfig): string | undefined {
  const owner = config.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY];
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

function identity(config: RunnableConfig): {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id?: string;
} {
  const thread_id = config.configurable?.thread_id;
  const checkpoint_ns = config.configurable?.checkpoint_ns ?? '';
  const checkpoint_id = config.configurable?.checkpoint_id;
  if (
    typeof thread_id !== 'string' ||
    typeof checkpoint_ns !== 'string' ||
    (checkpoint_id != null && typeof checkpoint_id !== 'string')
  ) {
    throw new Error('Invalid owned checkpoint identity');
  }
  return { thread_id, checkpoint_ns, ...(checkpoint_id == null ? {} : { checkpoint_id }) };
}

/** Isolate physical storage by owner while preserving logical SDK references. */
export class OwnedMongoSaver extends MongoDBSaver {
  private async recordStorage(config: RunnableConfig): Promise<void> {
    const namespace = config.configurable?.checkpoint_ns;
    const candidate =
      ownerOf(config) ??
      (typeof namespace === 'string' ? namespace.match(/^lcg:v2:[0-9a-f]{64}:/)?.[0] : undefined) ??
      config.configurable?.[LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY];
    if (typeof candidate !== 'string' || !/^lcg:v2:[0-9a-f]{64}:$/.test(candidate)) return;
    const storage = {
      type: 'mongo' as const,
      checkpointCollectionName: this.checkpointCollectionName,
      checkpointWritesCollectionName: this.checkpointWritesCollectionName,
    };
    await this.db
      .collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION)
      .updateOne(
        { _id: `${candidate}${checkpointStorageKey(storage)}` },
        { $setOnInsert: { owner: candidate, storage } },
        { upsert: true },
      );
  }

  private async tuple(doc: CheckpointRow, owner: string, legacy = false): Promise<CheckpointTuple> {
    const namespace = doc.checkpoint_ns.startsWith(owner)
      ? doc.checkpoint_ns.slice(owner.length)
      : doc.checkpoint_ns;
    const key = {
      thread_id: doc.thread_id.startsWith(owner)
        ? doc.thread_id.slice(owner.length)
        : doc.thread_id,
      checkpoint_ns: namespace,
      checkpoint_id: doc.checkpoint_id,
    };
    const rows = await this.db
      .collection<WriteRow>(this.checkpointWritesCollectionName)
      .find({
        checkpoint_id: key.checkpoint_id,
        $or: [
          {
            thread_id: `${owner}${key.thread_id}`,
            checkpoint_ns: `${owner}${namespace}`,
            lc_owner: owner,
          },
          ...(legacy
            ? [{ thread_id: key.thread_id, checkpoint_ns: namespace, lc_owner: { $exists: false } }]
            : []),
        ],
      })
      .toArray();
    const slots = new Map<string, WriteRow>();
    for (const row of rows) {
      const slot = JSON.stringify([row.task_id, row.idx]);
      if (!slots.has(slot) || row.checkpoint_ns === `${owner}${namespace}`) slots.set(slot, row);
    }
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      [...slots.values()].map(
        async (row) =>
          [
            row.task_id,
            row.channel,
            await this.serde.loadsTyped(row.type, row.value.value()),
          ] as CheckpointPendingWrite,
      ),
    );
    return {
      config: {
        configurable: {
          ...key,
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
          ...(legacy ? { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.checkpoint_id } : {}),
        },
      },
      checkpoint: (await this.serde.loadsTyped(doc.type, doc.checkpoint.value())) as Checkpoint,
      metadata: (await this.serde.loadsTyped(doc.type, doc.metadata.value())) as CheckpointMetadata,
      pendingWrites,
      ...(doc.parent_checkpoint_id == null
        ? {}
        : {
            parentConfig: {
              configurable: {
                ...key,
                checkpoint_id: doc.parent_checkpoint_id,
                [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
                [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: doc.parent_checkpoint_id,
              },
            },
          }),
    };
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const owner = ownerOf(config);
    if (owner == null) return super.getTuple(config);
    const key = identity(config);
    const checkpoints = this.db.collection<CheckpointRow>(this.checkpointCollectionName);
    let doc = await checkpoints
      .find({
        ...key,
        thread_id: `${owner}${key.thread_id}`,
        checkpoint_ns: `${owner}${key.checkpoint_ns}`,
        lc_owner: owner,
      })
      .sort({ checkpoint_id: -1 })
      .limit(1)
      .next();
    if (
      doc == null &&
      key.checkpoint_id != null &&
      key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY]
    ) {
      doc = await checkpoints.findOne({ ...key, lc_owner: { $exists: false } });
    }
    return doc == null
      ? undefined
      : this.tuple(
          doc,
          owner,
          key.checkpoint_id != null &&
            key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY],
        );
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const owner = ownerOf(config);
    if (owner == null) {
      yield* super.list(config, options);
      return;
    }
    const key = identity(config);
    const query: mongo.Filter<CheckpointRow> = {
      thread_id: `${owner}${key.thread_id}`,
      checkpoint_ns: `${owner}${key.checkpoint_ns}`,
      lc_owner: owner,
    };
    for (const [name, value] of Object.entries(options?.filter ?? {})) {
      if (value !== null && typeof value === 'object')
        throw new Error('Checkpoint metadata filters must be primitive');
      query[`metadata_search.${name}`] = value;
    }
    const before = options?.before?.configurable?.checkpoint_id;
    if (before != null) {
      if (typeof before !== 'string') throw new Error('Invalid checkpoint list boundary');
      query.checkpoint_id = { $lt: before };
    }
    let cursor = this.db
      .collection<CheckpointRow>(this.checkpointCollectionName)
      .find(query)
      .sort({ checkpoint_id: -1 });
    if (options?.limit != null) cursor = cursor.limit(options.limit);
    for await (const doc of cursor) yield await this.tuple(doc, owner);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    await this.recordStorage(config);
    const owner = ownerOf(config);
    if (owner == null) return super.put(config, checkpoint, metadata);
    const key = identity(config);
    const [[type, serializedCheckpoint], [metadataType, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type !== metadataType) throw new Error('Mismatched checkpoint and metadata types');
    const stored = {
      thread_id: key.thread_id,
      checkpoint_ns: key.checkpoint_ns,
      checkpoint_id: checkpoint.id,
    };
    await this.db.collection(this.checkpointCollectionName).updateOne(
      {
        ...stored,
        thread_id: `${owner}${key.thread_id}`,
        checkpoint_ns: `${owner}${key.checkpoint_ns}`,
        lc_owner: owner,
      },
      {
        $set: {
          parent_checkpoint_id: key.checkpoint_id,
          type,
          checkpoint: serializedCheckpoint,
          metadata: serializedMetadata,
          metadata_search: metadata,
        },
        ...(this.enableTimestamps ? { $currentDate: { upserted_at: true as const } } : {}),
      },
      { upsert: true },
    );
    return { configurable: { ...stored, [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner } };
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    await this.recordStorage(config);
    const owner = ownerOf(config);
    if (owner == null) return super.putWrites(config, writes, taskId);
    const key = identity(config);
    if (key.checkpoint_id == null) throw new Error('Owned writes require a checkpoint id');
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const legacy = key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
    const existing =
      !allSpecial && legacy
        ? await this.db
            .collection<WriteRow>(this.checkpointWritesCollectionName)
            .find(
              { ...key, task_id: taskId, lc_owner: { $exists: false } },
              { projection: { idx: 1 } },
            )
            .toArray()
        : [];
    const legacySlots = new Set(existing.map((row) => row.idx));
    const operations = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        if (legacySlots.has(WRITES_IDX_MAP[channel] ?? idx)) return null;
        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        const fields = { channel, type, value: serializedValue, lc_owner: owner };
        return {
          updateOne: {
            filter: {
              ...key,
              thread_id: `${owner}${key.thread_id}`,
              checkpoint_ns: `${owner}${key.checkpoint_ns}`,
              task_id: taskId,
              idx: WRITES_IDX_MAP[channel] ?? idx,
              lc_owner: owner,
            },
            update: allSpecial
              ? {
                  $set: fields,
                  ...(this.enableTimestamps
                    ? { $currentDate: { upserted_at: true as const } }
                    : {}),
                }
              : {
                  $setOnInsert: {
                    ...fields,
                    ...(this.enableTimestamps ? { upserted_at: new Date() } : {}),
                  },
                },
            upsert: true,
          },
        };
      }),
    );
    const pending = operations.filter((operation) => operation != null);
    if (pending.length > 0)
      // eslint-disable-next-line no-restricted-syntax -- checkpoint writes are not a tenant model; every upsert is keyed by its owner-qualified identity.
      await this.db.collection(this.checkpointWritesCollectionName).bulkWrite(pending);
  }
}

/** Joins a stored root (generation) namespace and a nested graph namespace. */
export const CHECKPOINT_NAMESPACE_SEPARATOR = '|';

function generationCheckpointNamespace(config: RunnableConfig): string | undefined {
  const value = config.configurable?.[LIBRECHAT_CHECKPOINT_NAMESPACE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isEventActorInvocation(config: RunnableConfig): boolean {
  const value = config.configurable?.[LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY];
  return typeof value === 'string' && value.length > 0;
}

/** Prefix every root/subgraph storage namespace with the immutable generation. */
function toStorageCheckpointConfig(config: RunnableConfig): RunnableConfig {
  const generationNamespace = generationCheckpointNamespace(config);
  if (!generationNamespace) {
    return config;
  }
  const graphNamespace =
    typeof config.configurable?.checkpoint_ns === 'string' ? config.configurable.checkpoint_ns : '';
  return {
    ...config,
    configurable: {
      ...config.configurable,
      checkpoint_ns:
        graphNamespace === ''
          ? generationNamespace
          : `${generationNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${graphNamespace}`,
    },
  };
}

/** Restore the namespace LangGraph supplied while retaining the private scope. */
function fromStorageCheckpointConfig(
  storedConfig: RunnableConfig,
  requestedConfig: RunnableConfig,
): RunnableConfig {
  const generationNamespace = generationCheckpointNamespace(requestedConfig);
  if (!generationNamespace) {
    return storedConfig;
  }
  const graphNamespace =
    typeof requestedConfig.configurable?.checkpoint_ns === 'string'
      ? requestedConfig.configurable.checkpoint_ns
      : '';
  return {
    ...storedConfig,
    configurable: {
      ...storedConfig.configurable,
      ...(requestedConfig.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY] && {
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]:
          requestedConfig.configurable[LIBRECHAT_CHECKPOINT_OWNER_KEY],
      }),
      ...(requestedConfig.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY] && {
        [LIBRECHAT_LEGACY_CHECKPOINT_KEY]:
          storedConfig.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY] ??
          requestedConfig.configurable[LIBRECHAT_LEGACY_CHECKPOINT_KEY],
      }),
      thread_id: requestedConfig.configurable?.thread_id ?? storedConfig.configurable?.thread_id,
      checkpoint_ns: graphNamespace,
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: generationNamespace,
    },
  };
}

function fromStorageCheckpointTuple(
  tuple: CheckpointTuple,
  requestedConfig: RunnableConfig,
): CheckpointTuple {
  return {
    ...tuple,
    config: fromStorageCheckpointConfig(tuple.config, requestedConfig),
    ...(tuple.parentConfig && {
      parentConfig: fromStorageCheckpointConfig(tuple.parentConfig, requestedConfig),
    }),
  };
}

/**
 * Soft size threshold that triggers a sweep of STALE write-anchor ids. The map normally
 * holds a handful (each id is consumed by the `put` that immediately follows its
 * `putWrites`); this only bounds a slow leak from a process that dies in that window.
 */
const WRITE_ANCHOR_SWEEP_THRESHOLD = 1024;

/**
 * A write-anchor id is considered stale once this much wall-clock has passed without its
 * matching `put` — a `put` always follows its `putWrites` within the same exit sequence
 * (milliseconds), so anything this old is from a crashed run, never a valid in-flight id.
 * Generous on purpose: we would rather keep a tracked id slightly too long than evict a
 * valid one and mis-classify its (possibly slow-I/O) interrupt `put` as a clean exit.
 */
const WRITE_ANCHOR_STALE_MS = 5 * 60 * 1000;

/**
 * Does a pending-write batch make its checkpoint worth persisting (ANCHOR it)? True if it
 * carries an interrupt (the HITL pause that resume targets) or any real state/delta channel
 * write (a value a later checkpoint's resume depends on). False for pure bookkeeping batches —
 * `__error__` (a failed, non-paused turn), `__no_writes__` (a task that completed without state
 * updates), a lone `__resume__`, `__scheduled__` — which never justify keeping a checkpoint on
 * their own. A false verdict does NOT mean the batch is discarded: bookkeeping rows are still
 * required when the checkpoint is retained (see the buffering in `LazyMongoSaver.putWrites`);
 * this predicate only decides anchoring.
 *
 * `INTERRUPT` is the one `__`-prefixed channel that IS anchor-worthy; every other `__…__`
 * channel is langgraph bookkeeping. Constants verified against `@langchain/langgraph`.
 */
function hasResumableWrite(writes: PendingWrite[]): boolean {
  return (writes ?? []).some(([channel]) => {
    const name = String(channel);
    return name === INTERRUPT || !name.startsWith('__');
  });
}

/**
 * A `MongoDBSaver` that persists ONLY checkpoints carrying a {@link hasResumableWrite resumable}
 * pending write — an interrupt (a HITL pause) or a real-channel/delta anchor — and discards both
 * the no-write checkpoint LangGraph writes on a CLEAN exit and the bookkeeping-only checkpoint of
 * a failed (non-paused) turn.
 *
 * **Why.** With `durability: 'exit'` (set by the SDK whenever a checkpointer is active) the
 * graph persists exactly one checkpoint at the exit boundary on EVERY run — paused or not.
 * A non-paused turn therefore writes a dead checkpoint whose only fate is to be pruned by
 * `deleteAgentCheckpoint` (`@librechat/api`). HITL only ever resumes a checkpoint that has pending writes,
 * so the clean (write-less) exit checkpoint is pure write+delete churn on the common path.
 * This saver skips it.
 *
 * **How it tells them apart** (verified empirically with throwaway runnable probes against
 * `@langchain/langgraph@1.4`, not source-reading): under `durability: 'exit'` LangGraph
 * calls `putWrites` for a checkpoint BEFORE the `put` that creates it, with `config.checkpoint_id`
 * equal to that `put`'s `checkpoint.id`. An interrupt records an `INTERRUPT` ("__interrupt__")
 * write; a delta-channel graph records its delta writes on a real (non-`__`-prefixed) channel.
 * A CLEAN exit produces a checkpoint with NO pending writes. So we record the checkpoint id of
 * each `putWrites` that carries a {@link hasResumableWrite resumable} write and persist a `put`
 * only when its `checkpoint.id` was so marked — which keeps interrupt checkpoints AND any
 * real-channel/delta anchors (resume can walk the chain), while dropping the write-less clean
 * exit. Keying on the globally-unique checkpoint id (NOT thread_id) stays correct even when two
 * runs race on the same conversation (`thread_id`).
 *
 * **Bookkeeping batches follow their checkpoint's fate.** Only a {@link hasResumableWrite
 * resumable} batch ANCHORS a checkpoint (justifies persisting it); a bookkeeping-only batch
 * (`__error__`, `__no_writes__`, a lone `__resume__`, …) never does — but whether its ROWS matter
 * depends on whether the checkpoint survives, which `put` decides later. Probe-confirmed both
 * ways: a failed non-paused turn emits `putWrites([__error__])` + `put` — persisting either half
 * would leak (an orphan row or a dead checkpoint) — while a paused Send fan-out records completed
 * siblings as `__no_writes__` markers on the RETAINED interrupt checkpoint, and dropping those
 * re-executes the siblings on resume (duplicated side effects). So bookkeeping batches are
 * BUFFERED in memory until the fate is known: forwarded once the checkpoint is anchored (or was
 * just persisted), dropped when its `put` discards it. Net effect: an errored turn still leaves
 * NOTHING durable (0 checkpoints, 0 write rows), and a retained checkpoint keeps EVERY pending
 * write LangGraph recorded for it — byte-for-byte what a plain `MongoDBSaver` would store.
 *
 * For LibreChat's agent graph (standard `Annotation`/`MessagesAnnotation` channels, no
 * `DeltaChannel` — grep-confirmed in `@librechat/agents`) a clean run makes no `putWrites` at all,
 * so this is effectively interrupt-only and the common path writes nothing; the broader
 * real-channel rule just keeps it honest for delta graphs.
 *
 * **Invariant.** Correctness depends on `durability: 'exit'` (which the SDK sets whenever a
 * checkpointer is active): exactly one parentless boundary checkpoint per run, with its
 * `putWrites` ordered before its `put`. Under per-step durability LangGraph instead emits
 * `put`-before-`putWrites` for chained checkpoints — the anchor would arrive too late and a
 * checkpoint could be wrongly discarded. The SDK never runs HITL that way; if that ever changes,
 * this saver must be revisited (a parent-based guard is NOT viable — a resumed turn's clean
 * completion is itself a parented, write-less checkpoint that we correctly discard).
 *
 * **Correctness.** Checkpoints with resumable writes (interrupt + real-channel/delta anchor) and
 * the writes themselves persist exactly as before, so resume is unchanged. The write-less clean
 * checkpoint (and the now-discarded error-only checkpoint) was only ever written-then-pruned, so
 * not writing it is observationally equivalent; the pre-run prune + Mongo TTL remain the
 * backstops. The saver overrides every config-bearing read/write path to apply
 * generation storage scoping; `deleteThread` and `setup` remain inherited.
 */
/** A bookkeeping-only pending-write batch held until its checkpoint's fate is decided. */
interface BufferedWriteBatch {
  at: number;
  batches: Array<{ config: RunnableConfig; writes: PendingWrite[]; taskId: string }>;
}

/**
 * MongoDB's hard per-document ceiling. A checkpoint whose serialized state pushes its
 * document past this cannot be stored — the driver throws `BSONObjectTooLarge` (code 10334).
 */
const MAX_BSON_DOCUMENT_BYTES = 16 * 1024 * 1024;

/**
 * Headroom reserved below {@link MAX_BSON_DOCUMENT_BYTES} for a checkpoint document's
 * non-state fields (ids, metadata, `metadata_search`, BSON framing). The serialized
 * `checkpoint` blob dominates the document; this margin covers everything else so the guard
 * rejects before Mongo does — with a legible error instead of a raw driver failure.
 */
const CHECKPOINT_SIZE_HEADROOM_BYTES = 1024 * 1024;

/**
 * Reject a checkpoint whose serialized state exceeds this. The pause is unrecoverable either
 * way (the document can't be written), so failing here as a typed {@link CheckpointTooLargeError}
 * turns an opaque `BSONObjectTooLarge` crash into an actionable one.
 */
export const CHECKPOINT_HARD_LIMIT_BYTES: number =
  MAX_BSON_DOCUMENT_BYTES - CHECKPOINT_SIZE_HEADROOM_BYTES;

/**
 * Warn once a persisted checkpoint crosses this soft threshold (~50% of the ceiling), so a
 * conversation's checkpoint growth is visible in logs well before it reaches the hard limit.
 */
export const CHECKPOINT_WARN_BYTES: number = 8 * 1024 * 1024;

/**
 * A durable checkpoint whose serialized state exceeds {@link CHECKPOINT_HARD_LIMIT_BYTES} — more
 * than MongoDB can hold in a single document. Thrown BEFORE the doomed write so the run fails
 * with a clear, typed message instead of a raw driver `BSONObjectTooLarge`. The checkpoint cannot
 * be persisted regardless of how it is handled upstream, so a durable resume is impossible.
 */

/**
 * Construction options for {@link LazyMongoSaver}: the base saver options plus optional
 * size-guard overrides. The overrides default to the module thresholds and exist so tests can
 * exercise the guard at small sizes; production always uses the defaults.
 */
export type LazyMongoSaverOptions = ConstructorParameters<typeof MongoDBSaver>[0] & {
  /** Soft warn threshold in bytes. Defaults to {@link CHECKPOINT_WARN_BYTES}. */
  warnBytes?: number;
  /** Hard reject limit in bytes. Defaults to {@link CHECKPOINT_HARD_LIMIT_BYTES}. */
  hardLimitBytes?: number;
};

export class LazyMongoSaver extends OwnedMongoSaver {
  /** checkpoint id → time the resumable `putWrites` anchoring it arrived; consumed by `put`. */
  private readonly writeAnchorIds = new Map<string, number>();
  /** checkpoint id → time its anchored `put` persisted it, so a bookkeeping batch that lands
   * after the `put` (concurrent dispatch) is forwarded instead of buffered forever. */
  private readonly persistedIds = new Map<string, number>();
  /** checkpoint id → bookkeeping batches parked until the checkpoint persists or is discarded. */
  private readonly bufferedBookkeeping = new Map<string, BufferedWriteBatch>();

  /** Soft threshold (bytes) past which a persisted checkpoint is warned about. */
  private readonly warnBytes: number;
  /** Hard limit (bytes) past which a checkpoint is refused with {@link CheckpointTooLargeError}. */
  private readonly hardLimitBytes: number;

  constructor(options: LazyMongoSaverOptions) {
    const { warnBytes, hardLimitBytes, ...mongoOptions } = options;
    super(mongoOptions);
    this.warnBytes = warnBytes ?? CHECKPOINT_WARN_BYTES;
    this.hardLimitBytes = hardLimitBytes ?? CHECKPOINT_HARD_LIMIT_BYTES;
  }

  /**
   * LangGraph normalizes every root invocation to `checkpoint_ns: ''` before
   * touching the saver. Map LibreChat's private generation key into Mongo's
   * namespace at this storage boundary, then restore the graph-visible config
   * on the way out. This keeps callbacks/tools on the real conversation
   * `thread_id` while making replacement generations physically disjoint.
   */
  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(toStorageCheckpointConfig(config));
    return tuple ? fromStorageCheckpointTuple(tuple, config) : undefined;
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const storageConfig = toStorageCheckpointConfig(config);
    const storageOptions = options?.before
      ? { ...options, before: toStorageCheckpointConfig(options.before) }
      : options;
    for await (const tuple of super.list(storageConfig, storageOptions)) {
      yield fromStorageCheckpointTuple(tuple, config);
    }
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const storageConfig = toStorageCheckpointConfig(config);
    if (isEventActorInvocation(config)) {
      return super.putWrites(storageConfig, writes, taskId);
    }
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!checkpointId) {
      // No checkpoint id to tie a fate to — forward untouched (the base saver's contract).
      return super.putWrites(storageConfig, writes, taskId);
    }
    if (!hasResumableWrite(writes)) {
      // A bookkeeping-only batch (`__error__` from a failed turn, a completed Send-sibling's
      // `__no_writes__` marker, a lone `__resume__`, …). It must NOT anchor the checkpoint,
      // but its rows follow the checkpoint's fate: required on a RETAINED checkpoint
      // (probe-confirmed — dropping a sibling's `__no_writes__` marker re-executes the
      // sibling on resume), an orphan on a discarded one. Forward when the fate is already
      // known to be "persist"; otherwise buffer until an anchoring batch or `put` decides.
      if (this.writeAnchorIds.has(checkpointId) || this.persistedIds.has(checkpointId)) {
        return super.putWrites(storageConfig, writes, taskId);
      }
      const buffered = this.bufferedBookkeeping.get(checkpointId);
      if (buffered) {
        buffered.batches.push({ config: storageConfig, writes, taskId });
      } else {
        sweepStale(this.bufferedBookkeeping, (b) => b.at);
        this.bufferedBookkeeping.set(checkpointId, {
          at: Date.now(),
          batches: [{ config: storageConfig, writes, taskId }],
        });
      }
      return;
    }
    // A resumable batch — an interrupt (a HITL pause) or a real state/delta channel a later
    // checkpoint depends on — anchors the checkpoint so its `put` persists it. Keyed on the
    // globally-unique checkpoint id so concurrent runs on the same `thread_id` can't
    // cross-consume anchors. The anchor is recorded BEFORE the awaited super call on purpose:
    // LangGraph dispatches the matching `put` concurrently with `putWrites` (probe-confirmed),
    // so recording after the await could let a slow-I/O interrupt `put` miss its anchor and be
    // wrongly discarded.
    this.recordWriteAnchor(checkpointId);
    try {
      // The checkpoint's fate is now "persist" — flush the bookkeeping batches that
      // arrived before this anchor so the stored pending writes are complete.
      await this.flushBufferedBookkeeping(checkpointId);
      return await super.putWrites(storageConfig, writes, taskId);
    } catch (err) {
      // The write batch never landed — best-effort un-anchor so the concurrent `put` doesn't
      // persist a checkpoint whose pending writes are missing (an unresumable phantom pause).
      // If `put` already consumed the anchor, the thrown error still fails the run and the
      // pre-run prune / Mongo TTL reclaim the orphan.
      this.writeAnchorIds.delete(checkpointId);
      throw err;
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    if (isEventActorInvocation(config)) {
      await this.assertCheckpointFitsDocument(config, checkpoint, metadata);
      const persisted = await super.put(toStorageCheckpointConfig(config), checkpoint, metadata);
      logger.debug(
        `[checkpointer] Persisted durable checkpoint for thread ${config.configurable?.thread_id ?? 'unknown'} (${checkpoint.id})`,
      );
      return fromStorageCheckpointConfig(persisted, config);
    }
    if (this.writeAnchorIds.delete(checkpoint.id)) {
      // Carries a resumable write (interrupt / real-channel delta anchor) — persist so resume
      // can read it, and remember the id briefly so any bookkeeping batch dispatched after
      // this `put` is forwarded rather than parked.
      await this.assertCheckpointFitsDocument(config, checkpoint, metadata);
      sweepStale(this.persistedIds, (t) => t);
      this.persistedIds.set(checkpoint.id, Date.now());
      const persisted = await super.put(toStorageCheckpointConfig(config), checkpoint, metadata);
      logger.debug(
        `[checkpointer] Persisted durable checkpoint for thread ${config.configurable?.thread_id ?? 'unknown'} (${checkpoint.id})`,
      );
      // `assertCheckpointFitsDocument` awaits a (potentially slow) serialization AFTER the
      // anchor was consumed above but BEFORE `persistedIds` was set — a bookkeeping-only
      // `putWrites` dispatched in that window sees neither marker and parks its batch. Flush
      // it now that the checkpoint is persisted; without this the marker is dropped and a
      // resume can re-execute already-completed work.
      await this.flushBufferedBookkeeping(checkpoint.id);
      return fromStorageCheckpointConfig(persisted, config);
    }
    // No resumable writes ⇒ a clean exit (a non-paused completion, a resumed turn's clean
    // finish, or an error-only turn): discard, and drop the parked bookkeeping batches with
    // it — this is what keeps a failed turn from leaving orphan rows in the writes
    // collection. Return the config LangGraph expects (pointing at the checkpoint it believes
    // was saved) so the run finishes normally; nothing durable is written.
    this.bufferedBookkeeping.delete(checkpoint.id);
    return {
      ...config,
      configurable: {
        ...config.configurable,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Track a checkpoint id whose `put` must persist it. Evicts ONLY genuinely-stale ids
   * (older than {@link WRITE_ANCHOR_STALE_MS}, i.e. from a crashed run whose `put` never
   * landed) — never a recent in-flight id — so a slow-I/O interrupt `put` is never
   * mis-classified as a clean exit. If nothing is stale the map is allowed to grow rather
   * than drop a valid id; the next sweep reclaims the crashed ones.
   */
  private recordWriteAnchor(checkpointId: string): void {
    sweepStale(this.writeAnchorIds, (t) => t);
    this.writeAnchorIds.set(checkpointId, Date.now());
  }

  /**
   * Forward the bookkeeping batches parked for `checkpointId` while its fate was undecided,
   * now that the checkpoint is being persisted. Snapshot-and-delete before awaiting so a batch
   * that arrives afterwards can't be double-forwarded — by then the anchor/persisted marker is
   * set, so it forwards directly instead of parking. Shared by the anchoring `putWrites` and by
   * `put` (for a batch parked during the size-check serialization window).
   */
  private async flushBufferedBookkeeping(checkpointId: string): Promise<void> {
    const buffered = this.bufferedBookkeeping.get(checkpointId);
    if (!buffered) {
      return;
    }
    this.bufferedBookkeeping.delete(checkpointId);
    await Promise.all(buffered.batches.map((b) => super.putWrites(b.config, b.writes, b.taskId)));
  }

  /**
   * Measure the checkpoint's serialized size on the persist path and act on it: `debug`-log it,
   * `warn` past {@link warnBytes}, and throw {@link CheckpointTooLargeError} past
   * {@link hardLimitBytes} — BEFORE the write, so an oversize pause fails legibly rather than as a
   * raw `BSONObjectTooLarge`. Serializes with the same `serde` the base `put` uses, so the measured
   * bytes match what would be stored. The extra serialization runs only when a checkpoint is
   * selected for durable retention: HITL pauses and event-actor invocation heads.
   */
  private async assertCheckpointFitsDocument(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<void> {
    // `MongoDBSaver.put` writes THREE size-bearing fields into the same
    // `agent_checkpoints` document: the serialized `checkpoint`, the serialized
    // `metadata`, AND `metadata_search` — the WHOLE raw `metadata` object stored a
    // second time as a queryable BSON subdocument (`metadata_search: metadata`).
    // So a large `metadata` (e.g. `metadata.writes` holding a big tool result) is
    // counted twice on the wire. Measuring only checkpoint + serialized metadata
    // let such a document pass the preflight while `metadata_search` pushed the
    // actual BSON past 16 MB — the raw `BSONObjectTooLarge` this guard exists to
    // prevent. Add the raw metadata's BSON size; the headroom now only has to
    // cover ids and BSON framing.
    const [, serializedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);
    const metadataSearchBytes = mongo.BSON.calculateObjectSize(
      metadata as unknown as Record<string, unknown>,
    );
    const bytes =
      serializedCheckpoint.byteLength + serializedMetadata.byteLength + metadataSearchBytes;
    const threadId = config.configurable?.thread_id as string | undefined;
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
    if (bytes > this.hardLimitBytes) {
      // The anchoring write row was already persisted by `putWrites`; the pre-run prune and Mongo
      // TTL reclaim it. Drop any parked bookkeeping so it doesn't linger in memory.
      this.bufferedBookkeeping.delete(checkpoint.id);
      logger.error(
        `[checkpointer] Durable checkpoint for thread ${threadId ?? 'unknown'} is ${mb(bytes)} MB, over the ${mb(this.hardLimitBytes)} MB limit; refusing the write (a document past 16 MB cannot be stored in MongoDB).`,
      );
      throw new CheckpointTooLargeError(bytes, this.hardLimitBytes, threadId);
    }
    if (bytes >= this.warnBytes) {
      logger.warn(
        `[checkpointer] Durable checkpoint for thread ${threadId ?? 'unknown'} is ${mb(bytes)} MB, past the ${mb(this.warnBytes)} MB soft threshold (hard limit ${mb(this.hardLimitBytes)} MB) — approaching MongoDB's single-document ceiling.`,
      );
      return;
    }
    logger.debug(
      `[checkpointer] Prepared durable checkpoint for thread ${threadId ?? 'unknown'}: ${bytes} bytes`,
    );
  }
}

/**
 * Evict genuinely-stale entries from a fate-tracking map once it is crowded
 * ({@link WRITE_ANCHOR_SWEEP_THRESHOLD}). Entries from a crashed run (older than
 * {@link WRITE_ANCHOR_STALE_MS}) are reclaimed; recent in-flight entries never are.
 */
function sweepStale<T>(map: Map<string, T>, timeOf: (value: T) => number): void {
  if (map.size < WRITE_ANCHOR_SWEEP_THRESHOLD) {
    return;
  }
  const now = Date.now();
  for (const [id, value] of map) {
    if (now - timeOf(value) > WRITE_ANCHOR_STALE_MS) {
      map.delete(id);
    }
  }
}

/** Longest wait for a peer's checkpoint index build before the saver proceeds without it. */
const CHECKPOINT_INDEX_BUILD_DEADLINE_MS = 120_000;

/**
 * `MongoDBSaver.setup()` starts the compound and TTL builds of each collection
 * concurrently and reports failures instead of throwing. Amazon DocumentDB
 * admits one index build per collection at a time, so there the second build of
 * each pair is rejected (code 40333) and the saver would otherwise run with its
 * TTL index missing — checkpoints then never expire. `setup()` is idempotent (an
 * index that already exists is a no-op), so re-running it lets one more build
 * through per pass until every index exists. Every other error is returned for
 * the caller to log, exactly as `setup()` reports it — including those reported
 * beside a conflict that outlasts the deadline. A rejection of `setup()` itself
 * propagates, so the caller keeps its in-process fallback.
 */
export async function setupCheckpointIndexes(
  saver: Pick<MongoDBSaver, 'setup'>,
  options: IndexBuildOptions = {},
): Promise<Error[]> {
  let companions: Error[] = [];
  try {
    return await buildIndexWithRetry(
      async () => {
        const errors = await saver.setup();
        const blocked = errors.find(isIndexBuildInProgress);
        if (blocked == null) {
          return errors;
        }
        companions = errors.filter((error) => !isIndexBuildInProgress(error));
        throw blocked;
      },
      'MongoDBSaver.setup()',
      { peerBuildDeadlineMs: CHECKPOINT_INDEX_BUILD_DEADLINE_MS, ...options },
    );
  } catch (error) {
    if (!isIndexBuildInProgress(error)) {
      throw error;
    }
    return [...companions, error instanceof Error ? error : new Error(String(error))];
  }
}

/**
 * Builds the durable saver on `mongoose`'s connection, moved from `buildMongoSaver` in
 * `@librechat/api`: creates the saver's indexes, then the `checkpoint_ns` and `lc_owner` cleanup
 * indexes on both collections (each logged and skipped when unavailable). Rejects when the saver
 * cannot be built or `setup()` itself rejects.
 */
export async function createMongoCheckpointSaver(
  mongoose: Mongoose,
  options: CheckpointSaverOptions,
): Promise<LazyMongoSaver> {
  const saver = new LazyMongoSaver({
    // mongoose vends the live MongoClient; reuse it instead of opening a second
    // connection. The driver type is structurally identical but resolves to a
    // different `mongodb` copy than checkpoint-mongodb's, hence the cast.
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof MongoDBSaver
    >[0]['client'],
    // MongoDBSaver calls MongoClient.db(dbName). Passing no name makes that
    // resolve from the driver's URI default, which is not guaranteed to be the
    // database Mongoose selected (for example when Mongoose connected with a
    // dbName override). Every capture/delete path uses connection.db, so
    // bind the saver to that exact database as well or a pause can be written to
    // one database while LibreChat looks for it in another.
    dbName: mongoose.connection.db?.databaseName,
    checkpointCollectionName: options.checkpointCollectionName,
    checkpointWritesCollectionName: options.checkpointWritesCollectionName,
    // TTL index on `upserted_at`: an unresolved paused run is reclaimed after the
    // approval window, so a forgotten approval can never leak checkpoints forever.
    ttl: options.ttlSeconds,
  });
  const errors = await setupCheckpointIndexes(saver);
  if (errors.length > 0) {
    logger.warn(
      '[checkpointer] MongoDBSaver.setup() reported errors (checkpoint indexes may be incomplete):',
      errors,
    );
  }
  await Promise.all(
    [options.checkpointCollectionName, options.checkpointWritesCollectionName].map(async (name) => {
      try {
        await buildIndexWithRetry(
          () => mongoose.connection.db!.collection(name).createIndex({ checkpoint_ns: 1 }),
          `${name}.checkpoint_ns`,
        );
      } catch (error) {
        logger.warn('[checkpointer] Owner cleanup index unavailable:', error);
      }
    }),
  );
  await Promise.all(
    [options.checkpointCollectionName, options.checkpointWritesCollectionName].map(async (name) => {
      try {
        await buildIndexWithRetry(
          () => mongoose.connection.db!.collection(name).createIndex({ lc_owner: 1, thread_id: 1 }),
          `${name}.lc_owner`,
        );
      } catch (error) {
        logger.warn('[checkpointer] Payload ownership index unavailable:', error);
      }
    }),
  );
  logger.info('[checkpointer] Durable Mongo checkpointer ready for agent continuation');
  return saver;
}

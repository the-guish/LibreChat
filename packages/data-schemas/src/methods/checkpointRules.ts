/**
 * The storage rules every backend's LangGraph checkpoint saver applies (`~/ports/checkpointStore`),
 * moved verbatim from the MongoDB saver (`adapters/mongo/checkpointSaver.ts`) so the PostgreSQL
 * saver (`adapters/postgres/checkpointSaver.ts`) applies the same ones: the owner and identity a
 * config names, the owner a write's storage descriptor is recorded for, the generation namespace
 * mapping, the anchor rule of lazy persistence and its stale-entry sweep, and the record size
 * limits. Database-neutral: nothing here may import `mongoose` or the MongoDB driver.
 */
import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import type {
  CheckpointTuple,
  PendingWrite,
  BaseCheckpointSaver,
} from '@langchain/langgraph-checkpoint';
import {
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from '~/ports/checkpointStore';

/** The LangGraph runnable config every saver method takes. */
export type CheckpointRunnableConfig = Parameters<BaseCheckpointSaver['getTuple']>[0];

/** Joins a stored root (generation) namespace and a nested graph namespace. */
export const CHECKPOINT_NAMESPACE_SEPARATOR = '|';

/** The authenticated owner whose rows a saver call reads and writes, if the config names one. */
export function checkpointOwnerOf(config: CheckpointRunnableConfig): string | undefined {
  const owner = config.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY];
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

/** The thread, namespace and (optional) checkpoint id an owned saver call addresses. */
export function ownedCheckpointIdentity(config: CheckpointRunnableConfig): {
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

/**
 * The authenticated owner prefix a write's storage descriptor is recorded for: the owner key, else
 * the owner prefix of the stored namespace, else the storage owner key; `undefined` when none of
 * them is an owner prefix (nothing is recorded then).
 */
export function checkpointStorageOwnerOf(config: CheckpointRunnableConfig): string | undefined {
  const namespace = config.configurable?.checkpoint_ns;
  const candidate =
    checkpointOwnerOf(config) ??
    (typeof namespace === 'string' ? namespace.match(/^lcg:v2:[0-9a-f]{64}:/)?.[0] : undefined) ??
    config.configurable?.[LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY];
  if (typeof candidate !== 'string' || !/^lcg:v2:[0-9a-f]{64}:$/.test(candidate)) return undefined;
  return candidate;
}

function generationCheckpointNamespace(config: CheckpointRunnableConfig): string | undefined {
  const value = config.configurable?.[LIBRECHAT_CHECKPOINT_NAMESPACE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Whether the config marks an isolated event actor attempt, whose checkpoints are always kept. */
export function isEventActorInvocation(config: CheckpointRunnableConfig): boolean {
  const value = config.configurable?.[LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY];
  return typeof value === 'string' && value.length > 0;
}

/** Prefix every root/subgraph storage namespace with the immutable generation. */
export function toStorageCheckpointConfig(
  config: CheckpointRunnableConfig,
): CheckpointRunnableConfig {
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
export function fromStorageCheckpointConfig(
  storedConfig: CheckpointRunnableConfig,
  requestedConfig: CheckpointRunnableConfig,
): CheckpointRunnableConfig {
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

/** {@link fromStorageCheckpointConfig} on a tuple's config and parent config. */
export function fromStorageCheckpointTuple(
  tuple: CheckpointTuple,
  requestedConfig: CheckpointRunnableConfig,
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
export function hasResumableWrite(writes: PendingWrite[]): boolean {
  return (writes ?? []).some(([channel]) => {
    const name = String(channel);
    return name === INTERRUPT || !name.startsWith('__');
  });
}

/**
 * Evict genuinely-stale entries from a fate-tracking map once it is crowded
 * ({@link WRITE_ANCHOR_SWEEP_THRESHOLD}). Entries from a crashed run (older than
 * {@link WRITE_ANCHOR_STALE_MS}) are reclaimed; recent in-flight entries never are.
 */
export function sweepStale<T>(map: Map<string, T>, timeOf: (value: T) => number): void {
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

/**
 * MongoDB's hard per-document ceiling, the durable checkpoint size limit of every backend
 * (PostgreSQL keeps it for parity). A checkpoint whose serialized state pushes its document past
 * this cannot be stored in MongoDB — the driver throws `BSONObjectTooLarge` (code 10334).
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
 * way (the document can't be written), so failing here as a typed `CheckpointTooLargeError`
 * turns an opaque `BSONObjectTooLarge` crash into an actionable one.
 */
export const CHECKPOINT_HARD_LIMIT_BYTES: number =
  MAX_BSON_DOCUMENT_BYTES - CHECKPOINT_SIZE_HEADROOM_BYTES;

/**
 * Warn once a persisted checkpoint crosses this soft threshold (~50% of the ceiling), so a
 * conversation's checkpoint growth is visible in logs well before it reaches the hard limit.
 */
export const CHECKPOINT_WARN_BYTES: number = 8 * 1024 * 1024;

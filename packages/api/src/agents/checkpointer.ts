import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import { getDataStoreBackend, logger } from '@librechat/data-schemas';
import {
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
} from '@librechat/data-schemas';
import type { CheckpointSaver, CheckpointStore } from '@librechat/data-schemas';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { ResolvedCheckpointerConfig } from './checkpoints/config';
import { checkpointOwnerNamespacePrefix } from '../stream/checkpoints';
import { resolveCheckpointerConfig } from './checkpoints/config';

/**
 * The saver's private configurable keys (`LIBRECHAT_CHECKPOINT_NAMESPACE_KEY` carries the
 * immutable generation scope, which LangGraph would reset on `checkpoint_ns`), the MongoDB
 * saver and its size limits now live with the checkpoint store in `@librechat/data-schemas`;
 * they stay exported here unchanged.
 */
export {
  LazyMongoSaver,
  CheckpointTooLargeError,
  setupCheckpointIndexes,
  CHECKPOINT_WARN_BYTES,
  CHECKPOINT_HARD_LIMIT_BYTES,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
} from '@librechat/data-schemas';
export type { LazyMongoSaverOptions } from '@librechat/data-schemas';
export { checkpointOwnerNamespacePrefix } from '../stream/checkpoints';

export { resolveCheckpointerConfig } from './checkpoints/config';
export {
  checkpointStorageConfigs,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from './checkpoints/storage';
export type { ResolvedCheckpointerConfig } from './checkpoints/config';
export { DEFAULT_CHECKPOINT_TTL_SECONDS } from '../stream/checkpoints';

/** The process's checkpoint store, or `null` while the database is not available. */
function checkpointStore(): CheckpointStore | null {
  return getDataStoreBackend().getCheckpointStore();
}

/**
 * Durable checkpointing for human-in-the-loop (HITL) resume.
 *
 * This is the seam between LibreChat and LangGraph's checkpoint machinery. A run
 * that pauses for tool approval suspends its graph state to a checkpoint; resuming
 * rebuilds that state on a *fresh* `Run` (see `agents/run.ts`), which only works if
 * the checkpoint outlives the original request — across a restart, or on another
 * replica. So HITL needs a durable saver, not the SDK's process-local `MemorySaver`.
 *
 * Two adapters sit behind the one interface ({@link getAgentCheckpointer}):
 *   - the data store backend's durable saver (`CheckpointStore.createSaver`; with MongoDB,
 *     `MongoDBSaver` over the app's existing connection), the default, and
 *   - `undefined`, which lets the SDK install its own in-process `MemorySaver`
 *     (single-process / dev, or whenever the database isn't ready yet).
 *
 * Every other read or write of checkpoint data goes through the same `CheckpointStore`.
 *
 * Storage is bounded two ways: a database TTL reclaims runs that are never
 * resolved ({@link DEFAULT_CHECKPOINT_TTL_SECONDS}), and {@link deleteAgentCheckpoint}
 * prunes a thread's checkpoints after ordinary terminal transitions. Approval
 * expiry relies on the TTL because a thread-wide eager delete can race a replacement run.
 */

/**
 * Exact checkpoint ids present before a legacy, unscoped generation is claimed.
 *
 * New jobs delete their immutable saver scope wholesale at terminal ownership.
 * Legacy jobs share storage, so cleanup deletes only this captured set; a later
 * replacement's fresh checkpoint ids cannot be removed by the delayed cleanup.
 */
export interface AgentCheckpointGeneration {
  threadId: string;
  /** Nonempty saver-level generation scope. Missing means a legacy
   * thread-wide capture; an empty string is invalid because it would omit the
   * legacy generation's nested LangGraph namespaces during deletion. */
  checkpointNamespace?: string;
  checkpointIds: string[];
}

/** Approval-window milliseconds from the resolved config; drives pending-action expiry. */
export function getApprovalTtlMs(cfg: TCheckpointerConfig | undefined): number {
  return resolveCheckpointerConfig(cfg).ttlSeconds * 1000;
}

/**
 * Prove that the durable saver contains a complete interrupt checkpoint for one generation.
 *
 * A pending Redis action is useful only when LangGraph can reload the state it
 * interrupted. Read the exact checkpoint selected by the current interrupt and
 * require its matching interrupt id, so an older retained pause cannot satisfy
 * verification for a missing or misrouted re-pause.
 * This runs once per interrupt, never on the ordinary generation path.
 */
export async function hasDurableAgentInterruptCheckpoint(
  threadId: string,
  cfg?: TCheckpointerConfig,
  options?: {
    checkpointNamespace?: string;
    checkpointId: string;
    checkpointNs?: string;
    interruptId: string;
  },
): Promise<boolean> {
  if (!threadId || !options?.checkpointId || !options.interruptId) {
    return false;
  }
  const saver = await getAgentCheckpointer(cfg);
  if (!saver) {
    return false;
  }

  const checkpointNamespace = options?.checkpointNamespace ?? '';
  const tuple = await saver.getTuple({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: options.checkpointNs ?? '',
      checkpoint_id: options.checkpointId,
      ...(checkpointNamespace !== '' && {
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: checkpointNamespace,
      }),
    },
  });
  if (tuple?.checkpoint.id !== options.checkpointId) {
    return false;
  }
  return (tuple.pendingWrites ?? []).some((write) => {
    if (write[1] !== INTERRUPT) {
      return false;
    }
    const values = Array.isArray(write[2]) ? write[2] : [write[2]];
    return values.some(
      (value) =>
        value != null &&
        typeof value === 'object' &&
        'id' in value &&
        value.id === options.interruptId,
    );
  });
}

/**
 * One saver per process, built lazily on first use so `setup()` (index creation)
 * runs exactly once. Keyed by the resolved settings so a config change rebuilds.
 */
let saverPromise: Promise<CheckpointSaver | undefined> | undefined;
let cachedKey: string | undefined;

function settingsKey(resolved: ResolvedCheckpointerConfig): string {
  return `${resolved.checkpointCollectionName}|${resolved.checkpointWritesCollectionName}|${resolved.ttlSeconds}`;
}

/**
 * The durable saver to hand to `graphConfig.compileOptions.checkpointer`, or
 * `undefined` to let the SDK fall back to its in-process `MemorySaver`.
 *
 * Returns `undefined` (without caching) when the config selects `memory` or when
 * Mongo isn't connected yet, so a later run retries once the connection is up.
 * The SDK types the checkpointer as `unknown`, so the store's saver passes directly.
 */
export async function getAgentCheckpointer(
  cfg: TCheckpointerConfig | undefined,
): Promise<CheckpointSaver | undefined> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory') {
    return undefined;
  }
  const store = checkpointStore();
  if (!store || !store.isConnected()) {
    logger.warn(
      '[checkpointer] Mongoose not connected; durable agent continuations will use an in-process checkpointer this turn and will not survive a restart or resolve on another replica.',
    );
    return undefined;
  }

  const key = settingsKey(resolved);
  if (!saverPromise || cachedKey !== key) {
    cachedKey = key;
    saverPromise = buildSaver(store, resolved);
  }
  return saverPromise;
}

export interface AgentEventCheckpointReference {
  threadId: string;
  checkpointId: string;
  checkpointNs: string;
}

export interface AgentEventCheckpointMessageOverlay {
  source: string;
  messages: readonly BaseMessage[];
}

function applyAgentEventCheckpointMessageOverlay(
  checkpoint: Checkpoint,
  overlay: AgentEventCheckpointMessageOverlay | undefined,
): Checkpoint {
  if (overlay == null) {
    return checkpoint;
  }
  const channelValues = checkpoint.channel_values;
  const messages = Array.isArray(channelValues.messages) ? channelValues.messages : [];
  const retainedMessages = messages.filter((message) => {
    if (message == null || typeof message !== 'object') {
      return true;
    }
    const kwargs = (message as { additional_kwargs?: { source?: unknown } }).additional_kwargs;
    return kwargs?.source !== overlay.source;
  });
  const agentMessages = channelValues.agentMessages;
  const retainedAgentMessages = Array.isArray(agentMessages)
    ? agentMessages.filter((message) => {
        if (message == null || typeof message !== 'object') {
          return true;
        }
        const kwargs = (message as { additional_kwargs?: { source?: unknown } }).additional_kwargs;
        return kwargs?.source !== overlay.source;
      })
    : agentMessages;
  return {
    ...checkpoint,
    channel_values: {
      ...channelValues,
      messages: [...retainedMessages, ...overlay.messages],
      ...(retainedAgentMessages === undefined ? {} : { agentMessages: retainedAgentMessages }),
    },
  };
}

function eventActorRunnableConfig(
  reference: Pick<AgentEventCheckpointReference, 'threadId' | 'checkpointNs'>,
  invocationId: string,
  checkpointId?: string,
  owner?: string,
): RunnableConfig {
  return {
    configurable: {
      thread_id: reference.threadId,
      checkpoint_ns: '',
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: reference.checkpointNs,
      [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: invocationId,
      ...(owner == null
        ? {}
        : {
            [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
            ...(checkpointId == null ? {} : { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: checkpointId }),
          }),
      ...(checkpointId == null ? {} : { checkpoint_id: checkpointId }),
    },
  };
}

/** Copies one committed actor head into an invocation-owned namespace. */
export async function forkAgentEventCheckpoint(
  source: AgentEventCheckpointReference,
  checkpointNs: string,
  invocationId: string,
  cfg?: TCheckpointerConfig,
  messageOverlay?: AgentEventCheckpointMessageOverlay,
  owner?: string,
): Promise<AgentEventCheckpointReference | null> {
  const saver = await getAgentCheckpointer(cfg);
  if (!saver || checkpointNs.length === 0 || invocationId.length === 0) {
    return null;
  }
  const tuple = await saver.getTuple(
    eventActorRunnableConfig(source, invocationId, source.checkpointId, owner),
  );
  if (!tuple || tuple.metadata == null || (tuple.pendingWrites?.length ?? 0) > 0) {
    return null;
  }
  const target = { threadId: source.threadId, checkpointNs };
  const persisted = await saver.put(
    eventActorRunnableConfig(target, invocationId, undefined, owner),
    applyAgentEventCheckpointMessageOverlay(tuple.checkpoint, messageOverlay),
    tuple.metadata,
  );
  const checkpointId = persisted.configurable?.checkpoint_id;
  if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
    throw new Error('Event actor checkpoint fork did not return a checkpoint id');
  }
  return { ...target, checkpointId };
}

/** Historical evidence authorizes only this exact ID, never the whole legacy namespace. */
export async function deleteAgentEventCheckpointReference(
  reference: AgentEventCheckpointReference,
  cfg?: TCheckpointerConfig,
  owner?: string,
): Promise<boolean> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory') {
    return false;
  }
  const store = checkpointStore();
  if (!store || !store.isConnected()) {
    throw new Error('Mongo checkpoint storage is unavailable');
  }
  await store.deleteCheckpointReference(resolved, reference, owner);
  return true;
}

/** Consume exact historical proofs in bounded batches, retaining intent on any failure. */
export async function deleteAgentEventCheckpointReferences(
  references: readonly AgentEventCheckpointReference[],
  owner: string,
  cfg?: TCheckpointerConfig,
): Promise<void> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory' || references.length === 0) return;
  const store = checkpointStore();
  if (!store || !store.isConnected()) throw new Error('Checkpoint database is unavailable');
  await store.deleteCheckpointReferences(resolved, references, owner);
}

/** Reads the terminal checkpoint produced inside one invocation namespace. */
export async function captureAgentEventCheckpoint(
  threadId: string,
  checkpointNs: string,
  invocationId: string,
  cfg?: TCheckpointerConfig,
  owner?: string,
  legacyCheckpointId?: string,
): Promise<AgentEventCheckpointReference | null> {
  const saver = await getAgentCheckpointer(cfg);
  if (!saver) {
    return null;
  }
  let tuple = await saver.getTuple(
    eventActorRunnableConfig({ threadId, checkpointNs }, invocationId, undefined, owner),
  );
  if (legacyCheckpointId != null && (tuple == null || tuple.checkpoint.id < legacyCheckpointId)) {
    tuple = await saver.getTuple(
      eventActorRunnableConfig({ threadId, checkpointNs }, invocationId, legacyCheckpointId, owner),
    );
  }
  const checkpointId = tuple?.checkpoint.id;
  return typeof checkpointId === 'string' && checkpointId.length > 0
    ? { threadId, checkpointId, checkpointNs }
    : null;
}

/**
 * Builds the store's durable saver. On failure the memoized build is reset so a later run can
 * retry, and the run falls back to the in-process checkpointer.
 */
async function buildSaver(
  store: CheckpointStore,
  resolved: ResolvedCheckpointerConfig,
): Promise<CheckpointSaver | undefined> {
  try {
    return await store.createSaver({
      checkpointCollectionName: resolved.checkpointCollectionName,
      checkpointWritesCollectionName: resolved.checkpointWritesCollectionName,
      ttlSeconds: resolved.ttlSeconds,
    });
  } catch (err) {
    // Reset so a later run can retry rather than being stuck on a failed build.
    saverPromise = undefined;
    cachedKey = undefined;
    logger.error(
      '[checkpointer] Failed to initialize Mongo checkpointer; falling back to in-process checkpointer:',
      err,
    );
    return undefined;
  }
}

/**
 * Snapshot the durable checkpoint ids that belong to the generation about to
 * resume. Capture this before atomically claiming the paused job; a replacement
 * that wins before the claim makes that claim fail, while one that starts after
 * the claim writes ids outside this snapshot.
 */
export async function captureAgentCheckpointGeneration(
  threadId: string,
  cfg?: TCheckpointerConfig,
  options?: { throwOnError?: boolean; checkpointNamespace?: string },
): Promise<AgentCheckpointGeneration> {
  const requestedNamespace = options?.checkpointNamespace ?? '';
  /** Empty is the shared legacy namespace, whose nested subgraphs live under
   * independent nonempty LangGraph namespaces. Treat it as a thread-wide id
   * capture and omit the namespace marker so deletion cannot silently filter
   * those child rows out. Only nonempty generation scopes are prefix-safe. */
  const namespaceScoped =
    options != null &&
    Object.prototype.hasOwnProperty.call(options, 'checkpointNamespace') &&
    requestedNamespace !== '';
  const generation: AgentCheckpointGeneration = {
    threadId,
    ...(namespaceScoped && { checkpointNamespace: requestedNamespace }),
    checkpointIds: [],
  };
  if (!threadId) {
    return generation;
  }
  try {
    const saver = await getAgentCheckpointer(cfg);
    const store = checkpointStore();
    if (!saver || !store) {
      return generation;
    }
    const resolved = resolveCheckpointerConfig(cfg);
    generation.checkpointIds = await store.listGenerationCheckpointIds(resolved, {
      threadId,
      ...(namespaceScoped && { namespace: requestedNamespace }),
    });
  } catch (err) {
    logger.warn(
      `[checkpointer] Failed to capture checkpoint generation for thread ${threadId}:`,
      err,
    );
    if (options?.throwOnError) {
      throw err;
    }
  }
  return generation;
}

/**
 * Prune a thread's checkpoints on a terminal transition — natural completion,
 * abort, or expiry — so the durable store stays bounded. The TTL index is the
 * safety net; this is the eager cleanup. No-op in memory mode or before any run
 * has built the saver (nothing to delete).
 *
 * @param threadId - the LangGraph `thread_id` (LibreChat's conversationId).
 * @param generation - when present, delete only the checkpoint ids captured for
 * this resumed generation; omitted by legacy callers that intentionally prune
 * the untagged legacy rows on the thread.
 */
export async function deleteAgentCheckpoint(
  threadId: string | undefined,
  cfg?: TCheckpointerConfig,
  generation?: AgentCheckpointGeneration,
  options?: { throwOnError?: boolean; checkpointNamespace?: string },
): Promise<void> {
  if (!threadId) {
    return;
  }
  const saver = await getAgentCheckpointer(cfg);
  if (!saver) {
    return;
  }
  try {
    if (generation) {
      if (generation.threadId !== threadId || generation.checkpointIds.length === 0) {
        return;
      }
      if (
        Object.prototype.hasOwnProperty.call(generation, 'checkpointNamespace') &&
        (generation.checkpointNamespace ?? '') === ''
      ) {
        throw new Error(
          'Legacy checkpoint cleanup requires a thread-wide captured generation without an empty namespace marker',
        );
      }
      const store = checkpointStore();
      if (!store) {
        return;
      }
      const resolved = resolveCheckpointerConfig(cfg);
      await store.deleteGenerationCheckpoints(
        resolved,
        {
          threadId,
          ...(Object.prototype.hasOwnProperty.call(generation, 'checkpointNamespace') && {
            namespace: generation.checkpointNamespace ?? '',
          }),
        },
        generation.checkpointIds,
      );
      return;
    }
    if (Object.prototype.hasOwnProperty.call(options ?? {}, 'checkpointNamespace')) {
      const checkpointNamespace = options?.checkpointNamespace ?? '';
      /** An explicit empty namespace denotes a legacy/pre-isolation job, not
       * an immutable storage scope. Thread-wide deletion could erase a newer
       * v2 replacement, while filtering `checkpoint_ns: ''` would strand the
       * legacy job's nested subgraphs. Such callers must capture a thread-wide
       * immutable id set, verify their job epoch after that capture, and pass
       * the resulting `generation` above. */
      if (checkpointNamespace === '') {
        throw new Error(
          'Legacy checkpoint cleanup requires a captured checkpoint generation, not an empty namespace',
        );
      }
      const store = checkpointStore();
      if (!store) {
        return;
      }
      const resolved = resolveCheckpointerConfig(cfg);
      await store.deleteGenerationCheckpoints(resolved, {
        threadId,
        namespace: checkpointNamespace,
      });
      return;
    }
    const store = checkpointStore();
    if (!store) return;
    const resolved = resolveCheckpointerConfig(cfg);
    await store.deleteGenerationCheckpoints(resolved, { threadId });
  } catch (err) {
    logger.warn(`[checkpointer] Failed to delete checkpoints for thread ${threadId}:`, err);
    if (options?.throwOnError) {
      throw err;
    }
  }
}

/** Erase only payload rows carrying this authenticated actor owner. */
export async function deleteOwnedActorCheckpointScope(
  threadId: string,
  checkpointNs: string,
  owner: string,
  cfg?: TCheckpointerConfig,
): Promise<void> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory') return;
  const store = checkpointStore();
  if (!store || !store.isConnected()) throw new Error('Checkpoint database is unavailable');
  await store.deleteOwnedNamespace(resolved, owner, threadId, checkpointNs);
}

/** Delete durable rows by authenticated ownership, independently of job/receipt lifetimes. */
export async function deleteOwnedAgentCheckpoints(
  userId: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
  cfg?: TCheckpointerConfig,
): Promise<void> {
  if (!userId) {
    throw new Error('Checkpoint cleanup requires an owner');
  }
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory' || conversationIds?.length === 0) {
    return;
  }
  const store = checkpointStore();
  if (!store || !store.isConnected()) {
    throw new Error('Checkpoint database is unavailable');
  }
  const owner = checkpointOwnerNamespacePrefix(userId, tenantId);
  await store.deleteOwnerCheckpoints(resolved, owner, conversationIds);
}

/** Test-only: drop the memoized saver so a fresh build is forced. */
export function __resetCheckpointerForTests(): void {
  saverPromise = undefined;
  cachedKey = undefined;
}

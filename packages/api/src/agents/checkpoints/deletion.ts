import { createHash, randomUUID } from 'crypto';
import { getDataStoreBackend, logger } from '@librechat/data-schemas';
import type { CheckpointDeletionIntent, CheckpointStore } from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import {
  checkpointStorageKey,
  checkpointStorageConfigs,
  ownedCheckpointReferences,
} from './storage';
import { deleteOwnedAgentCheckpoints, deleteAgentEventCheckpointReferences } from '../checkpointer';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { historicalActorReferences } from './pruning';

type DeletionTarget = CheckpointDeletionIntent;

/** The checkpoint store, connected; otherwise the database is unavailable. */
function connectedCheckpointStore(): CheckpointStore {
  const store = getDataStoreBackend().getCheckpointStore();
  if (!store || !store.isConnected()) {
    throw new Error('Checkpoint database is unavailable');
  }
  return store;
}

export interface CheckpointDeletion {
  conversationIds(): string[];
  remember(conversationIds: readonly string[]): Promise<void>;
  cleanup(): Promise<void>;
  acknowledge(): Promise<void>;
}

const hash = (value: string | null) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable deletion intent preserves cascade identity after topology is removed.
 * These records contain no checkpoint payload and exist only during deletion,
 * not once per generation. They must survive until both drain and cleanup succeed. */
export async function openCheckpointDeletion(
  userId: string,
  tenantId: string | undefined,
  rootConversationId: string | undefined,
  cfg?: TCheckpointerConfig,
): Promise<CheckpointDeletion> {
  if (!userId) {
    throw new Error('Checkpoint deletion requires an owner');
  }
  const store = connectedCheckpointStore();
  const storageKey = checkpointStorageKey;
  const ownerPrefix = checkpointOwnerNamespacePrefix(userId, tenantId);
  const tenants = tenantId ? [tenantId, undefined] : [undefined];
  const prefixes = tenants.map((tenant) => {
    const prefix = checkpointOwnerNamespacePrefix(userId, tenant);
    return rootConversationId == null
      ? prefix
      : `${prefix}[0-9a-f]{64}:${hash(rootConversationId)}:`;
  });
  const retained = await store.findDeletionIntents(prefixes);
  const targets = new Map(retained.map((target) => [target.id, target]));
  const stores = new Map(retained.map((target) => [storageKey(target.storage), target.storage]));
  async function refreshStores() {
    for (const storage of await checkpointStorageConfigs(userId, tenantId, cfg)) {
      stores.set(storageKey(storage), storage);
    }
  }
  await refreshStores();
  const version = randomUUID();
  const batchSize = 256;

  async function persist(batch: DeletionTarget[]) {
    await store.saveDeletionIntents(version, userId, tenantId, batch);
    for (const target of batch) targets.set(target.id, target);
  }

  const conversationIds = () => [
    ...new Set([...targets.values()].map((target) => target.threadId)),
  ];
  async function captureOwned(ids: readonly string[] | undefined) {
    let batch: DeletionTarget[] = [];
    for (const [key, storage] of stores) {
      const rootPrefix = `${ownerPrefix}${key}:${hash(rootConversationId ?? null)}:`;
      for await (const { checkpoint, conversationId } of ownedCheckpointReferences(
        userId,
        tenantId,
        ids,
        storage,
      )) {
        batch.push({
          id: `${rootPrefix}${hash(conversationId)}:${hash(JSON.stringify([checkpoint.threadId, checkpoint.checkpointNs, checkpoint.checkpointId]))}`,
          version,
          threadId: conversationId,
          userId,
          tenantId,
          storage,
          checkpoint,
        });
        if (batch.length === batchSize) {
          await persist(batch);
          batch = [];
        }
      }
    }
    if (batch.length > 0) await persist(batch);
  }
  return {
    conversationIds,
    async remember(ids: readonly string[]) {
      await refreshStores();
      for (let offset = 0; offset < ids.length; offset += batchSize) {
        const threads = ids.slice(offset, offset + batchSize);
        for (const [key, storage] of stores) {
          const rootPrefix = `${ownerPrefix}${key}:${hash(rootConversationId ?? null)}:`;
          await persist(
            threads.map((threadId) => ({
              id: `${rootPrefix}${hash(threadId)}`,
              version,
              threadId,
              userId,
              tenantId,
              storage,
            })),
          );
        }
        await captureOwned(threads);
        let batch: DeletionTarget[] = [];
        for await (const checkpoint of historicalActorReferences(userId, tenantId, threads)) {
          for (const [key, storage] of stores) {
            const rootPrefix = `${ownerPrefix}${key}:${hash(rootConversationId ?? null)}:`;
            batch.push({
              id: `${rootPrefix}${hash(checkpoint.threadId)}:${hash(JSON.stringify([checkpoint.checkpointNs, checkpoint.checkpointId]))}`,
              version,
              threadId: checkpoint.threadId,
              userId,
              tenantId,
              storage,
              checkpoint,
            });
            if (batch.length === batchSize) {
              await persist(batch);
              batch = [];
            }
          }
        }
        if (batch.length > 0) await persist(batch);
      }
    },
    async cleanup() {
      await refreshStores();
      await captureOwned(rootConversationId == null ? undefined : conversationIds());
      const groups = new Map([...stores.keys()].map((key) => [key, [] as DeletionTarget[]]));
      for (const target of targets.values()) groups.get(storageKey(target.storage))!.push(target);
      for (const [key, storage] of stores) {
        const group = groups.get(key)!;
        const storedConfig = { ...storage, ttl: storage.ttlSeconds };
        const ids =
          rootConversationId == null
            ? undefined
            : [...new Set(group.map((target) => target.threadId))];
        for (const tenant of tenants) {
          await deleteOwnedAgentCheckpoints(userId, tenant, ids, storedConfig);
        }
        await deleteAgentEventCheckpointReferences(
          group.flatMap((target) => target.checkpoint ?? []),
          ownerPrefix,
          storedConfig,
        );
      }
    },
    async acknowledge() {
      const receipts = [...targets.values()];
      for (let offset = 0; offset < receipts.length; offset += batchSize) {
        await store.deleteDeletionIntents(
          receipts.slice(offset, offset + batchSize).map(({ id, version: captured }) => ({
            id,
            version: captured,
          })),
        );
      }
      if (rootConversationId != null) return;
      const pending = await store.hasDeletionIntent(prefixes);
      if (pending) throw new Error('Checkpoint deletion intent is still pending');
      // Owner-wide callers retain their deletion fence through acknowledgement.
      const descriptors = [...stores.keys()].flatMap((key) =>
        tenants.map((tenant) => `${checkpointOwnerNamespacePrefix(userId, tenant)}${key}`),
      );
      for (let offset = 0; offset < descriptors.length; offset += batchSize) {
        await store.deleteStorageDescriptors(descriptors.slice(offset, offset + batchSize));
      }
    },
  };
}

/** Replay captured identities after topology deletion; never sweep new generations. */
export function createCheckpointDeletionReclaimer(
  getOwnerJobs: (userId: string, tenantId?: string) => Promise<string[]>,
): (limit: number, activity?: { found: boolean }) => Promise<number> {
  let after: string | undefined;
  return async (limit, activity) => {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid reclamation limit');
    const store = connectedCheckpointStore();
    const targets = await store.listDeletionIntents(after, limit);
    if (activity != null && targets.length > 0) activity.found = true;
    after = targets.length === limit ? targets[targets.length - 1].id : undefined;
    const jobsByOwner = new Map<string, Promise<string[]>>();

    const hasPersistence = async (target: DeletionTarget): Promise<boolean> => {
      const { userId, tenantId, threadId, checkpoint, storage } = target;
      const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
        checkpointOwnerNamespacePrefix(userId, tenant),
      );
      const evidence = await Promise.all([
        store.hasConversationRecords(userId, threadId),
        ...(storage.type === 'memory'
          ? []
          : [store.hasCheckpointPayload(storage, owners, threadId, checkpoint)]),
      ]);
      return evidence.some(Boolean);
    };

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        const owner = checkpointOwnerNamespacePrefix(target.userId, target.tenantId);
        let jobs = jobsByOwner.get(owner);
        if (jobs == null) {
          jobs = getOwnerJobs(target.userId, target.tenantId);
          jobsByOwner.set(owner, jobs);
        }
        if ((await jobs).length > 0) return 0;
        if (target.checkpoint != null) {
          const conversation = await store.hasConversation(target.userId, target.threadId);
          if (!conversation) {
            for (const tenant of target.tenantId ? [target.tenantId, undefined] : [undefined]) {
              await deleteAgentEventCheckpointReferences(
                [target.checkpoint],
                checkpointOwnerNamespacePrefix(target.userId, tenant),
                { ...target.storage, ttl: target.storage.ttlSeconds },
              );
            }
          }
        }
        if (await hasPersistence(target)) return 0;
        return store.deleteDeletionIntent(target.id, target.version);
      }),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      for (const failure of failures)
        logger.error('[checkpoints] Deletion evidence reclamation failed:', failure.reason);
      throw new Error('Checkpoint evidence reclamation failed');
    }
    return results.reduce(
      (count, result) => count + (result.status === 'fulfilled' ? result.value : 0),
      0,
    );
  };
}

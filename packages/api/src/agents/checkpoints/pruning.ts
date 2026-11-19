import { getDataStoreBackend } from '@librechat/data-schemas';
import type { CheckpointStore } from '@librechat/data-schemas';
import type { AgentEventCheckpointReference } from '../checkpointer';

/** The checkpoint store, while its database is connected. */
function actorCheckpointStore(): CheckpointStore {
  const store = getDataStoreBackend().getCheckpointStore();
  if (!store || !store.isConnected()) {
    throw new Error('Actor checkpoint cleanup requires Mongo storage');
  }
  return store;
}

export async function acknowledgeActorPruning(
  user: string,
  tenantId: string | undefined,
  conversationId: string,
  reference: AgentEventCheckpointReference,
): Promise<void> {
  await actorCheckpointStore().pullActorCleanup(user, tenantId, conversationId, reference);
}

export async function drainActorPruning(
  user: string,
  tenantId: string | undefined,
  conversationId: string,
  remove: (reference: AgentEventCheckpointReference) => Promise<void>,
): Promise<void> {
  const cleanup = await actorCheckpointStore().getActorCleanup(user, tenantId, conversationId);
  for (const reference of cleanup) {
    await remove(reference);
    await acknowledgeActorPruning(user, tenantId, conversationId, reference);
  }
}

/** Read hidden historical evidence while the owner-filtered conversation still exists. */
export async function* historicalActorReferences(
  user: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
): AsyncGenerator<AgentEventCheckpointReference> {
  const ids = conversationIds == null ? undefined : [...new Set(conversationIds)];
  for (let offset = 0; offset < (ids?.length ?? 1); offset += 256) {
    const cursor = actorCheckpointStore().findActorHistory(
      user,
      tenantId,
      ids && ids.slice(offset, offset + 256),
    );
    for await (const conversation of cursor) {
      const suspension = conversation.agentEventActorSuspension?.suspension;
      const candidates = [
        conversation.agentEventActor?.checkpoint,
        conversation.agentEventActor?.previousCheckpoint,
        suspension?.checkpoint,
        suspension?.invocation?.fork,
        suspension?.invocation?.base?.checkpoint,
        ...(conversation.agentEventActorReconciliations ?? []).map((entry) => entry.checkpoint),
        ...(conversation.agentEventActorCleanup ?? []),
      ];
      const seen = new Set<string>();
      for (const reference of candidates) {
        if (
          typeof reference?.checkpointId !== 'string' ||
          reference.checkpointId.length === 0 ||
          typeof reference.checkpointNs !== 'string' ||
          !reference.checkpointNs.startsWith('event-actor/') ||
          reference.threadId !== conversation.conversationId
        ) {
          continue;
        }
        const key = JSON.stringify([
          reference.threadId,
          reference.checkpointNs,
          reference.checkpointId,
        ]);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        yield {
          threadId: reference.threadId,
          checkpointNs: reference.checkpointNs,
          checkpointId: reference.checkpointId,
        };
      }
    }
  }
}

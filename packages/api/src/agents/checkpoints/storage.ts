import { checkpointStorageKey, getDataStoreBackend } from '@librechat/data-schemas';
import type {
  CheckpointStore,
  OwnedCheckpointReference,
  CheckpointStorageDescriptor,
} from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { ResolvedCheckpointerConfig } from './config';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { resolveCheckpointerConfig } from './config';

export {
  checkpointStorageKey,
  CHECKPOINT_STORAGE_COLLECTION,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from '@librechat/data-schemas';
export type CheckpointStorage = CheckpointStorageDescriptor;

/** The process's checkpoint store, connected; otherwise the database is unavailable. */
function connectedCheckpointStore(): CheckpointStore {
  const store = getDataStoreBackend().getCheckpointStore();
  if (!store || !store.isConnected()) throw new Error('Checkpoint database is unavailable');
  return store;
}

/** Descriptors locate stores; caller ownership and captured identities authorize deletion. */
export async function checkpointStorageConfigs(
  userId: string,
  tenantId: string | undefined,
  cfg?: TCheckpointerConfig,
): Promise<ResolvedCheckpointerConfig[]> {
  const store = connectedCheckpointStore();
  const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
    checkpointOwnerNamespacePrefix(userId, tenant),
  );
  const storages = await store.listStorageDescriptors(owners);
  const configs = storages.map((storage) => resolveCheckpointerConfig(storage));
  configs.push(resolveCheckpointerConfig(cfg));
  return [...new Map(configs.map((storage) => [checkpointStorageKey(storage), storage])).values()];
}

/** Capture exact owner-qualified identities, including orphan payload during owner-wide deletion. */
export async function* ownedCheckpointReferences(
  userId: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
  storage: CheckpointStorage,
): AsyncGenerator<OwnedCheckpointReference> {
  if (storage.type === 'memory') return;
  const store = connectedCheckpointStore();
  const owners = (tenantId ? [tenantId, undefined] : [undefined]).map((tenant) =>
    checkpointOwnerNamespacePrefix(userId, tenant),
  );
  yield* store.listOwnedCheckpointReferences(storage, owners, conversationIds);
}

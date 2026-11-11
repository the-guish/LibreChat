/**
 * Agent checkpoint store port: the durable LangGraph checkpointer of the agents runtime (human in
 * the loop resume, event actor heads) and every other read or write of checkpoint data, which
 * lives in the main database. Nothing here may import `mongoose` or the MongoDB driver, at
 * runtime or as a type.
 *
 * The LangGraph saver is the backend's own: a `BaseCheckpointSaver` from
 * `@langchain/langgraph-checkpoint` (with MongoDB: `MongoDBSaver` from
 * `@langchain/langgraph-checkpoint-mongodb` on the server's connection; a PostgreSQL backend
 * would build on `@langchain/langgraph-checkpoint-postgres`). Every backend's saver applies the
 * same storage rules, which the other operations rely on:
 * - a root namespace carried on {@link LIBRECHAT_CHECKPOINT_NAMESPACE_KEY} is the stored
 *   namespace of the root graph, and nested graph namespaces are stored below it, joined with
 *   `|`; the graph sees its own namespaces unchanged;
 * - checkpoints are kept only when a pending write with a resumable value (an interrupt, or a
 *   write to a state channel) anchors them, or when the config carries
 *   {@link LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY}; other checkpoints and their bookkeeping writes
 *   are discarded;
 * - a checkpoint over the backend's record size limit is refused with
 *   {@link CheckpointTooLargeError} before anything is written;
 * - a config carrying {@link LIBRECHAT_CHECKPOINT_OWNER_KEY} reads and writes rows owned by that
 *   owner (whose stored thread and namespace start with the owner), and also reads the one legacy
 *   unowned checkpoint named by {@link LIBRECHAT_LEGACY_CHECKPOINT_KEY};
 * - a write whose owner is an authenticated owner prefix (from the owner key, the namespace or
 *   {@link LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY}) records a storage descriptor for that owner,
 *   so deletion finds every store an owner wrote to.
 *
 * Owners are the prefixes `checkpointOwnerNamespacePrefix` in `@librechat/api` builds. Where an
 * operation matches ids or namespaces by pattern, the pattern is an unescaped regular expression
 * anchored at the start (the syntax MongoDB and PostgreSQL share for these patterns).
 *
 * Not a member of `DataStore`: the process's checkpoint store is reached through the backend
 * (`DataStoreBackend.getCheckpointStore`), and each operation is told which storage (with
 * MongoDB: which pair of collections) it acts on, since the configured storage can change and
 * deletion visits every storage an owner used.
 */
import { createHash } from 'crypto';
import type {
  Checkpoint,
  ChannelVersions,
  CheckpointMetadata,
  BaseCheckpointSaver,
} from '@langchain/langgraph-checkpoint';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { IAgentEventActorCheckpoint, IConversation } from '~/types';
import { listPortMethods } from './common';

/**
 * LangGraph forces `checkpoint_ns` to `''` for every root invocation, so the immutable
 * generation scope travels on this private configurable key; the saver stores it as the root
 * namespace without changing the graph-visible `thread_id`.
 */
export const LIBRECHAT_CHECKPOINT_NAMESPACE_KEY = '__librechat_checkpoint_ns';
/**
 * Marks a checkpoint write as belonging to an isolated event actor attempt. Unlike ordinary
 * clean chat exits, these exits are durable candidate heads.
 */
export const LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY = '__librechat_event_actor_invocation_id';
/** The authenticated owner whose rows a saver call reads and writes. */
export const LIBRECHAT_CHECKPOINT_OWNER_KEY = '__librechat_checkpoint_owner';
/** The one legacy (unowned) checkpoint id an owned saver call may also read. */
export const LIBRECHAT_LEGACY_CHECKPOINT_KEY = '__librechat_legacy_checkpoint_id';
/** The owner a write's storage descriptor is recorded for, when no owner key is given. */
export const LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY = '__librechat_checkpoint_storage_owner';

/** Where a checkpoint store keeps checkpoints and their pending writes (with MongoDB: two collections). */
export interface CheckpointStorageNames {
  checkpointCollectionName: string;
  checkpointWritesCollectionName: string;
}

/** A checkpointer's settings with every default applied (`resolveCheckpointerConfig`). */
export interface CheckpointStorageSettings extends CheckpointStorageNames {
  type: NonNullable<NonNullable<TCheckpointerConfig>['type']>;
  /** Approval window / TTL in seconds. */
  ttlSeconds: number;
}

/** What a storage descriptor records: a storage without its TTL. */
export type CheckpointStorageDescriptor = Omit<CheckpointStorageSettings, 'ttlSeconds'>;

/** The LangGraph runnable config the saver methods take. */
type SaverRunnableConfig = Parameters<BaseCheckpointSaver['put']>[0];

/**
 * The durable LangGraph saver a {@link CheckpointStore} builds. LangGraph always passes
 * `newVersions` to `put`; the agents runtime's own direct writes (event actor forks) copy a whole
 * checkpoint and pass none, so a backend whose saver needs them takes them from the checkpoint's
 * `channel_versions` (the MongoDB saver never reads them).
 */
export interface CheckpointSaver extends BaseCheckpointSaver {
  put(
    config: SaverRunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<SaverRunnableConfig>;
}

/** What {@link CheckpointStore.createSaver} builds. */
export interface CheckpointSaverOptions extends CheckpointStorageNames {
  /** Checkpoints and writes not updated for this long are removed by the database. */
  ttlSeconds: number;
}

/** One stored checkpoint, by its stored thread, namespace and id. */
export type CheckpointReference = IAgentEventActorCheckpoint;

/** A stored checkpoint row an owner wrote, and the conversation it belongs to. */
export interface OwnedCheckpointReference {
  conversationId: string;
  checkpoint: CheckpointReference;
}

/**
 * Which generation of a thread an operation covers: the rows under a nonempty stored root
 * `namespace` (and its nested graph namespaces), or, without `namespace`, the legacy rows of the
 * thread (stored before generations were isolated: no owner, and a namespace that is not an
 * owned one).
 */
export interface CheckpointGenerationScope {
  threadId: string;
  namespace?: string;
}

/**
 * Durable deletion intent: what a deletion must still remove for an owner, kept until both the
 * drain and the cleanup succeed. Holds no checkpoint payload.
 */
export interface CheckpointDeletionIntent {
  id: string;
  /** The deletion that wrote it last; a later deletion's acknowledgement keeps it. */
  version: string;
  threadId: string;
  checkpoint?: CheckpointReference;
  userId: string;
  tenantId?: string;
  storage: CheckpointStorageSettings;
}

/** A {@link CheckpointDeletionIntent} to record, for {@link CheckpointStore.saveDeletionIntents}. */
export type CheckpointDeletionIntentInput = Pick<
  CheckpointDeletionIntent,
  'id' | 'threadId' | 'storage' | 'checkpoint'
>;

/** The event actor checkpoint evidence a conversation still holds. */
export type ActorCheckpointHistory = Pick<
  IConversation,
  | 'conversationId'
  | 'agentEventActor'
  | 'agentEventActorSuspension'
  | 'agentEventActorReconciliations'
  | 'agentEventActorCleanup'
>;

/**
 * A durable checkpoint whose serialized state exceeds the backend's record size limit. Thrown by
 * the saver BEFORE the doomed write so the run fails with a clear, typed message instead of a
 * raw driver error. The checkpoint cannot be persisted regardless of how it is handled upstream,
 * so a durable resume is impossible.
 */
export class CheckpointTooLargeError extends Error {
  readonly code = 'CHECKPOINT_TOO_LARGE';
  constructor(
    readonly bytes: number,
    readonly limit: number,
    readonly threadId?: string,
  ) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
    super(
      `Checkpoint state is ${mb(bytes)} MB, over the ${mb(limit)} MB durable limit. ` +
        'This conversation carries too much state to resume — large tool outputs or inlined ' +
        'media are the usual cause. Start a new conversation or reduce context.',
    );
    this.name = 'CheckpointTooLargeError';
  }
}

/** The stable key of a storage: descriptors and deletion intents are grouped and named by it. */
export function checkpointStorageKey(storage: CheckpointStorageDescriptor): string {
  const value = JSON.stringify([
    storage.type,
    storage.checkpointCollectionName,
    storage.checkpointWritesCollectionName,
  ]);
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The process's checkpoint store. Obtained while the database is reachable
 * (`DataStoreBackend.getCheckpointStore`); every operation may reject.
 */
export interface CheckpointStore {
  /** Whether the database connection is open now (callers fail closed or fall back when not). */
  isConnected(): boolean;
  /**
   * Builds the durable LangGraph saver on `options`, creates its indexes (logging those it could
   * not create) and resolves once it is ready; rejects when it cannot be built.
   */
  createSaver(options: CheckpointSaverOptions): Promise<CheckpointSaver>;

  /** The checkpoint ids of a thread's generation (`scope`), in no particular order. */
  listGenerationCheckpointIds(
    storage: CheckpointStorageNames,
    scope: CheckpointGenerationScope,
  ): Promise<string[]>;
  /**
   * Removes a thread's generation (`scope`): its checkpoints and writes, or only those with one of
   * `checkpointIds`.
   */
  deleteGenerationCheckpoints(
    storage: CheckpointStorageNames,
    scope: CheckpointGenerationScope,
    checkpointIds?: readonly string[],
  ): Promise<void>;
  /**
   * Removes the rows `owner` wrote for the logical `threadId` under the root `namespace` and its
   * nested graph namespaces.
   */
  deleteOwnedNamespace(
    storage: CheckpointStorageNames,
    owner: string,
    threadId: string,
    namespace: string,
  ): Promise<void>;
  /**
   * Removes every row `owner` wrote or whose namespace it owns: on the given conversations
   * (logical or owned thread ids), or on every thread when `conversationIds` is omitted.
   * Checkpoints and writes are removed batch by batch, writes after checkpoints.
   */
  deleteOwnerCheckpoints(
    storage: CheckpointStorageNames,
    owner: string,
    conversationIds?: readonly string[],
  ): Promise<void>;
  /**
   * Removes one checkpoint and its writes, when they are unowned or (with `owner`) owned by
   * `owner`. Writes are removed first.
   */
  deleteCheckpointReference(
    storage: CheckpointStorageNames,
    reference: CheckpointReference,
    owner?: string,
  ): Promise<void>;
  /**
   * Removes the given checkpoints and their writes, when they are unowned or owned by `owner`,
   * batch by batch (writes first in each batch).
   */
  deleteCheckpointReferences(
    storage: CheckpointStorageNames,
    references: readonly CheckpointReference[],
    owner: string,
  ): Promise<void>;
  /**
   * Every stored checkpoint and write row owned by one of `owners` (by namespace or recorded
   * owner), on the given conversations or on every thread. A row may be yielded more than once
   * (once per collection that holds it).
   */
  listOwnedCheckpointReferences(
    storage: CheckpointStorageNames,
    owners: readonly string[],
    conversationIds?: readonly string[],
  ): AsyncIterable<OwnedCheckpointReference>;
  /**
   * Whether `storage` still holds a row of `threadId` owned by one of `owners`, or the
   * `reference`d checkpoint when it is unowned or owned by one of them.
   */
  hasCheckpointPayload(
    storage: CheckpointStorageNames,
    owners: readonly string[],
    threadId: string,
    reference?: CheckpointReference,
  ): Promise<boolean>;

  /** The storages recorded for owners whose descriptor ids start with one of `owners`. */
  listStorageDescriptors(owners: readonly string[]): Promise<CheckpointStorageDescriptor[]>;
  /** Removes the storage descriptors with the given ids. */
  deleteStorageDescriptors(ids: readonly string[]): Promise<void>;

  /** The deletion intents whose id matches one of `idPatterns`. */
  findDeletionIntents(idPatterns: readonly string[]): Promise<CheckpointDeletionIntent[]>;
  /** Whether a deletion intent's id matches one of `idPatterns`. */
  hasDeletionIntent(idPatterns: readonly string[]): Promise<boolean>;
  /**
   * Records `intents` for `userId` and `tenantId` under `version`, replacing the recorded fields
   * of an intent with the same id (an intent's absent `checkpoint` keeps a recorded one).
   */
  saveDeletionIntents(
    version: string,
    userId: string,
    tenantId: string | undefined,
    intents: readonly CheckpointDeletionIntentInput[],
  ): Promise<void>;
  /** Removes each intent still at the given version. */
  deleteDeletionIntents(
    intents: readonly Pick<CheckpointDeletionIntent, 'id' | 'version'>[],
  ): Promise<void>;
  /** Up to `limit` deletion intents in id order, after the id `after` when given. */
  listDeletionIntents(
    after: string | undefined,
    limit: number,
  ): Promise<CheckpointDeletionIntent[]>;
  /** Removes one intent if it is still at `version`; resolves how many were removed. */
  deleteDeletionIntent(id: string, version: string): Promise<number>;

  /**
   * Whether `userId` still has the conversation `conversationId`, or messages, tool calls or
   * shared links of it.
   */
  hasConversationRecords(userId: string, conversationId: string): Promise<boolean>;
  /** Whether `userId` still has the conversation `conversationId`. */
  hasConversation(userId: string, conversationId: string): Promise<boolean>;
  /** The actor checkpoints a conversation must still prune (empty when there is none). */
  getActorCleanup(
    user: string,
    tenantId: string | undefined,
    conversationId: string,
  ): Promise<CheckpointReference[]>;
  /** Removes `reference` from a conversation's actor checkpoints to prune. */
  pullActorCleanup(
    user: string,
    tenantId: string | undefined,
    conversationId: string,
    reference: CheckpointReference,
  ): Promise<void>;
  /**
   * The event actor checkpoint evidence of the user's subagent thread conversations (the tenant's
   * and the tenantless ones with a `tenantId`, else the tenantless ones): of `conversationIds`, or
   * of all of them.
   */
  findActorHistory(
    user: string,
    tenantId: string | undefined,
    conversationIds?: readonly string[],
  ): AsyncIterable<ActorCheckpointHistory>;
}

/** Every method of {@link CheckpointStore}, for adapters and conformance checks. */
export const CHECKPOINT_STORE_METHODS: ReadonlyArray<keyof CheckpointStore> =
  listPortMethods<CheckpointStore>({
    isConnected: true,
    createSaver: true,
    listGenerationCheckpointIds: true,
    deleteGenerationCheckpoints: true,
    deleteOwnedNamespace: true,
    deleteOwnerCheckpoints: true,
    deleteCheckpointReference: true,
    deleteCheckpointReferences: true,
    listOwnedCheckpointReferences: true,
    hasCheckpointPayload: true,
    listStorageDescriptors: true,
    deleteStorageDescriptors: true,
    findDeletionIntents: true,
    hasDeletionIntent: true,
    saveDeletionIntents: true,
    deleteDeletionIntents: true,
    listDeletionIntents: true,
    deleteDeletionIntent: true,
    hasConversationRecords: true,
    hasConversation: true,
    getActorCleanup: true,
    pullActorCleanup: true,
    findActorHistory: true,
  });

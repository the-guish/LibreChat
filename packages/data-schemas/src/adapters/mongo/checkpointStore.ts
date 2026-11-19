/**
 * The MongoDB checkpoint store (`~/ports/checkpointStore`), moved from `@librechat/api`
 * (`agents/checkpointer.ts` and `agents/checkpoints/{deletion,pruning,storage}.ts`): raw
 * collection reads and writes on the database of mongoose's default connection.
 * - Checkpoints and writes live in the two collections each operation names (by default
 *   `agent_checkpoints` and `agent_checkpoint_writes`); owned rows carry `lc_owner` and an
 *   owner-prefixed `thread_id` and `checkpoint_ns`.
 * - Storage descriptors live in {@link CHECKPOINT_STORAGE_COLLECTION}, deletion intents in
 *   {@link CHECKPOINT_DELETION_COLLECTION} (`_id` is the intent id).
 * - Conversation evidence is read from the `Conversation`, `Message`, `ToolCall` and
 *   `SharedLink` models' collections (by their registered names, or the default names).
 *
 * The saver itself is built by `createMongoCheckpointSaver` (`./checkpointSaver`).
 */
import type { Mongoose, mongo } from 'mongoose';
import type {
  CheckpointStore,
  CheckpointReference,
  CheckpointStorageNames,
  CheckpointDeletionIntent,
  CheckpointGenerationScope,
  OwnedCheckpointReference,
  ActorCheckpointHistory,
} from '~/ports/checkpointStore';
import type { CheckpointStorageRecord } from './checkpointSaver';
import type { IConversation } from '~/types';
import {
  createMongoCheckpointSaver,
  CHECKPOINT_STORAGE_COLLECTION,
  CHECKPOINT_NAMESPACE_SEPARATOR,
} from './checkpointSaver';

/** The collection that holds the deletion intents (`CheckpointStore.findDeletionIntents`). */
export const CHECKPOINT_DELETION_COLLECTION = 'agent_checkpoint_deletions';

/** A deletion intent as stored: the intent with its id as `_id`. */
type DeletionDocument = Omit<CheckpointDeletionIntent, 'id'> & { _id: string };

/** A checkpoint or write row, as far as the ownership queries read it. */
interface CheckpointIdentityRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  lc_owner?: string;
}

type ConversationDocument = Omit<IConversation, 'tenantId'> & { tenantId?: string | null };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mongo filter matching a generation's root and every nested graph namespace. */
function generationNamespaceFilter(checkpointNamespace: string): string | { $regex: string } {
  if (checkpointNamespace === '') {
    return '';
  }
  return {
    $regex: `^${escapeRegExp(checkpointNamespace)}(?:\\${CHECKPOINT_NAMESPACE_SEPARATOR}|$)`,
  };
}

function legacyCheckpointStorageFilter() {
  return { checkpoint_ns: { $not: /^lcg:v2:/ }, lc_owner: { $exists: false } };
}

function generationFilter(scope: CheckpointGenerationScope) {
  return {
    thread_id: scope.threadId,
    ...(scope.namespace !== undefined
      ? { checkpoint_ns: generationNamespaceFilter(scope.namespace) }
      : legacyCheckpointStorageFilter()),
  };
}

/** The collection a registered model uses, or `fallback` while the model is not registered. */
function modelCollectionName(mongoose: Mongoose, model: string, fallback: string): string {
  // eslint-disable-next-line no-restricted-syntax -- Collection name metadata only, no raw driver operations.
  return mongoose.models[model]?.collection.name ?? fallback;
}

function toDeletionIntent({ _id, ...intent }: DeletionDocument): CheckpointDeletionIntent {
  return { id: _id, ...intent };
}

/**
 * The checkpoint store on `mongoose`'s default connection, or `null` while that connection has
 * no database. Its operations use that database; `isConnected` and `createSaver` read the
 * connection when called.
 */
export function createMongoCheckpointStore(mongoose: Mongoose): CheckpointStore | null {
  const db = mongoose.connection.db as mongo.Db | undefined;
  if (!db) {
    return null;
  }

  const deletions = () => db.collection<DeletionDocument>(CHECKPOINT_DELETION_COLLECTION);
  const descriptors = () => db.collection<CheckpointStorageRecord>(CHECKPOINT_STORAGE_COLLECTION);
  const conversationCollectionName = () =>
    modelCollectionName(mongoose, 'Conversation', 'conversations');
  const conversations = () => db.collection<ConversationDocument>(conversationCollectionName());

  return {
    isConnected: () => mongoose.connection.readyState === 1,
    createSaver: (options) => createMongoCheckpointSaver(mongoose, options),

    async listGenerationCheckpointIds(storage, scope) {
      const checkpoints = await db
        .collection<{ checkpoint_id?: string }>(storage.checkpointCollectionName)
        .find(generationFilter(scope), { projection: { _id: 0, checkpoint_id: 1 } })
        .toArray();
      return checkpoints.reduce<string[]>((ids, checkpoint) => {
        if (typeof checkpoint.checkpoint_id === 'string') {
          ids.push(checkpoint.checkpoint_id);
        }
        return ids;
      }, []);
    },

    async deleteGenerationCheckpoints(storage, scope, checkpointIds) {
      const filter = {
        ...generationFilter(scope),
        ...(checkpointIds && { checkpoint_id: { $in: checkpointIds as string[] } }),
      };
      await Promise.all([
        db.collection(storage.checkpointCollectionName).deleteMany(filter),
        db.collection(storage.checkpointWritesCollectionName).deleteMany(filter),
      ]);
    },

    async deleteOwnedNamespace(storage, owner, threadId, namespace) {
      const filter = {
        thread_id: `${owner}${threadId}`,
        checkpoint_ns: generationNamespaceFilter(`${owner}${namespace}`),
        lc_owner: owner,
      };
      await Promise.all([
        db.collection(storage.checkpointCollectionName).deleteMany(filter),
        db.collection(storage.checkpointWritesCollectionName).deleteMany(filter),
      ]);
    },

    async deleteOwnerCheckpoints(storage, owner, conversationIds) {
      const ownership = { $or: [{ checkpoint_ns: { $regex: `^${owner}` } }, { lc_owner: owner }] };
      const ids = conversationIds == null ? undefined : [...new Set(conversationIds)];
      const batchSize = 128;
      for (let offset = 0; offset < (ids?.length ?? 1); offset += batchSize) {
        const filter = {
          ...ownership,
          ...(ids && {
            thread_id: {
              $in: ids.slice(offset, offset + batchSize).flatMap((id) => [id, `${owner}${id}`]),
            },
          }),
        };
        await db.collection(storage.checkpointCollectionName).deleteMany(filter);
        await db.collection(storage.checkpointWritesCollectionName).deleteMany(filter);
      }
    },

    async deleteCheckpointReference(storage, reference, owner) {
      const exact = {
        thread_id: reference.threadId,
        checkpoint_ns: reference.checkpointNs,
        checkpoint_id: reference.checkpointId,
        ...(owner == null
          ? { lc_owner: { $exists: false } }
          : { $or: [{ lc_owner: owner }, { lc_owner: { $exists: false } }] }),
      };
      await db.collection(storage.checkpointWritesCollectionName).deleteMany(exact);
      await db.collection(storage.checkpointCollectionName).deleteOne(exact);
    },

    async deleteCheckpointReferences(storage, references, owner) {
      for (let offset = 0; offset < references.length; offset += 256) {
        const exact = {
          $and: [
            { $or: [{ lc_owner: owner }, { lc_owner: { $exists: false } }] },
            {
              $or: references.slice(offset, offset + 256).map((reference) => ({
                thread_id: reference.threadId,
                checkpoint_ns: reference.checkpointNs,
                checkpoint_id: reference.checkpointId,
              })),
            },
          ],
        };
        await db.collection(storage.checkpointWritesCollectionName).deleteMany(exact);
        await db.collection(storage.checkpointCollectionName).deleteMany(exact);
      }
    },

    async *listOwnedCheckpointReferences(
      storage: CheckpointStorageNames,
      owners: readonly string[],
      conversationIds?: readonly string[],
    ): AsyncGenerator<OwnedCheckpointReference> {
      for (let offset = 0; offset < (conversationIds?.length ?? 1); offset += 64) {
        const logicalIds = new Map<string, string>();
        for (const id of conversationIds?.slice(offset, offset + 64) ?? []) {
          logicalIds.set(id, id);
          for (const owner of owners) logicalIds.set(`${owner}${id}`, id);
        }
        for (const name of [
          storage.checkpointCollectionName,
          storage.checkpointWritesCollectionName,
        ]) {
          const cursor = db.collection<CheckpointIdentityRow>(name).find(
            {
              ...(conversationIds == null ? {} : { thread_id: { $in: [...logicalIds.keys()] } }),
              $or: [
                ...owners.map((owner) => ({ checkpoint_ns: { $regex: `^${owner}` } })),
                { lc_owner: { $in: owners as string[] } },
              ],
            },
            { projection: { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, lc_owner: 1 } },
          );
          for await (const row of cursor) {
            if (typeof row.checkpoint_id !== 'string' || typeof row.checkpoint_ns !== 'string')
              continue;
            const logicalThread =
              row.lc_owner != null &&
              owners.includes(row.lc_owner) &&
              row.thread_id.startsWith(row.lc_owner)
                ? row.thread_id.slice(row.lc_owner.length)
                : row.thread_id;
            yield {
              conversationId: logicalIds.get(row.thread_id) ?? logicalThread,
              checkpoint: {
                threadId: row.thread_id,
                checkpointNs: row.checkpoint_ns,
                checkpointId: row.checkpoint_id,
              },
            };
          }
        }
      }
    },

    async hasCheckpointPayload(storage, owners, threadId, reference) {
      const rows = await Promise.all(
        [storage.checkpointCollectionName, storage.checkpointWritesCollectionName].map((name) =>
          db.collection(name).findOne(
            {
              $or: [
                ...owners.map((owner) => ({
                  thread_id: { $in: [threadId, `${owner}${threadId}`] },
                  $or: [{ checkpoint_ns: { $regex: `^${owner}` } }, { lc_owner: owner }],
                })),
                ...(reference == null
                  ? []
                  : [
                      {
                        thread_id: reference.threadId,
                        checkpoint_ns: reference.checkpointNs,
                        checkpoint_id: reference.checkpointId,
                        $or: [
                          { lc_owner: { $in: owners as string[] } },
                          { lc_owner: { $exists: false } },
                        ],
                      },
                    ]),
              ],
            },
            { projection: { _id: 1 } },
          ),
        ),
      );
      return rows.some((row) => row != null);
    },

    async listStorageDescriptors(owners) {
      const records = await descriptors()
        .find({ $or: owners.map((owner) => ({ _id: { $regex: `^${owner}` } })) })
        .toArray();
      return records.map(({ storage }) => storage);
    },

    async deleteStorageDescriptors(ids) {
      await descriptors().deleteMany({ _id: { $in: ids as string[] } });
    },

    async findDeletionIntents(idPatterns) {
      const intents = await deletions()
        .find({ $or: idPatterns.map((prefix) => ({ _id: { $regex: `^${prefix}` } })) })
        .toArray();
      return intents.map(toDeletionIntent);
    },

    async hasDeletionIntent(idPatterns) {
      const pending = await deletions().findOne(
        { $or: idPatterns.map((prefix) => ({ _id: { $regex: `^${prefix}` } })) },
        { projection: { _id: 1 } },
      );
      return pending != null;
    },

    async saveDeletionIntents(version, userId, tenantId, intents) {
      // eslint-disable-next-line no-restricted-syntax -- infrastructure collection outside the tenant models; every upsert is keyed by its owner-prefixed `_id`.
      await deletions().bulkWrite(
        intents.map((target) => ({
          updateOne: {
            filter: { _id: target.id },
            update: {
              $set: {
                version,
                threadId: target.threadId,
                userId,
                tenantId,
                storage: target.storage,
                ...(target.checkpoint && { checkpoint: target.checkpoint }),
              },
            },
            upsert: true,
          },
        })),
      );
    },

    async deleteDeletionIntents(intents) {
      await deletions().deleteMany({
        $or: intents.map(({ id, version }) => ({ _id: id, version })),
      });
    },

    async listDeletionIntents(after, limit) {
      const intents = await deletions()
        .find(after == null ? {} : { _id: { $gt: after } })
        .sort({ _id: 1 })
        .limit(limit)
        .toArray();
      return intents.map(toDeletionIntent);
    },

    async deleteDeletionIntent(id, version) {
      return (await deletions().deleteOne({ _id: id, version })).deletedCount;
    },

    async hasConversationRecords(userId, conversationId) {
      const user = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : userId;
      const siblingCollections = [
        [conversationCollectionName(), userId],
        [modelCollectionName(mongoose, 'Message', 'messages'), userId],
        [modelCollectionName(mongoose, 'ToolCall', 'toolcalls'), user],
        [modelCollectionName(mongoose, 'SharedLink', 'sharedlinks'), userId],
      ] as const;
      const rows = await Promise.all(
        siblingCollections.map(([name, owner]) =>
          db.collection(name).findOne({ user: owner, conversationId }, { projection: { _id: 1 } }),
        ),
      );
      return rows.some((row) => row != null);
    },

    async hasConversation(userId, conversationId) {
      const conversation = await db
        .collection(conversationCollectionName())
        .findOne({ user: userId, conversationId }, { projection: { _id: 1 } });
      return conversation != null;
    },

    async getActorCleanup(user, tenantId, conversationId) {
      const conversation = await conversations().findOne(
        { user, tenantId: tenantId ?? null, conversationId },
        { projection: { agentEventActorCleanup: 1 } },
      );
      return conversation?.agentEventActorCleanup ?? [];
    },

    async pullActorCleanup(user, tenantId, conversationId, reference: CheckpointReference) {
      await conversations().updateOne(
        { user, tenantId: tenantId ?? null, conversationId },
        { $pull: { agentEventActorCleanup: reference } },
      );
    },

    async *findActorHistory(
      user: string,
      tenantId: string | undefined,
      conversationIds?: readonly string[],
    ): AsyncGenerator<ActorCheckpointHistory> {
      const cursor = conversations().find(
        {
          user,
          tenantId: tenantId ? { $in: [tenantId, null] } : null,
          subagentThread: { $exists: true },
          ...(conversationIds && { conversationId: { $in: conversationIds as string[] } }),
        },
        {
          projection: {
            conversationId: 1,
            'agentEventActor.checkpoint': 1,
            'agentEventActor.previousCheckpoint': 1,
            'agentEventActorSuspension.suspension.checkpoint': 1,
            'agentEventActorSuspension.suspension.invocation.fork': 1,
            'agentEventActorSuspension.suspension.invocation.base.checkpoint': 1,
            'agentEventActorReconciliations.checkpoint': 1,
            agentEventActorCleanup: 1,
          },
        },
      );
      for await (const conversation of cursor) {
        yield conversation;
      }
    },
  };
}

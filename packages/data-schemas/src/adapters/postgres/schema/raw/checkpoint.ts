/**
 * The LangGraph checkpointer's bookkeeping collections (`adapters/mongo/checkpointSaver.ts`,
 * `adapters/mongo/checkpointStore.ts`), declared for the PostgreSQL mapping only
 * (docs/postgres-port/PHASE4.md §1.4, §1.6, D5): never registered as models. The checkpoints and
 * their writes live in the `PostgresSaver` tables of each storage's schema, not here.
 */
import { Schema } from 'mongoose';

/** A storage (`CheckpointStorageDescriptor`): the checkpointer type and its two collections. */
const storageFields = {
  type: { type: String },
  checkpointCollectionName: String,
  checkpointWritesCollectionName: String,
};

/** `agent_checkpoint_stores`: where an owner wrote checkpoints (`CheckpointStorageRecord`). */
export const checkpointStorageSchema: Schema = new Schema(
  {
    _id: { type: String },
    owner: String,
    storage: new Schema(storageFields, { _id: false }),
  },
  { versionKey: false },
);

/** `agent_checkpoint_deletions`: the pending checkpoint deletions (`CheckpointDeletionIntent`). */
export const checkpointDeletionSchema: Schema = new Schema(
  {
    _id: { type: String },
    version: String,
    threadId: String,
    checkpoint: new Schema(
      { threadId: String, checkpointId: String, checkpointNs: String },
      { _id: false },
    ),
    userId: String,
    tenantId: String,
    storage: new Schema({ ...storageFields, ttlSeconds: Number }, { _id: false }),
  },
  { versionKey: false },
);

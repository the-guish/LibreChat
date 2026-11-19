/**
 * The MongoDB `CheckpointContractHarness` (`~/contracts/checkpoint`): the MongoDB backend's
 * checkpoint store (`createMongoDataStoreBackend(mongoose).getCheckpointStore()`) on a private
 * mongoose instance connected to the server `engine` provides (mongodb-memory-server in the
 * specs), with every model registered. `seedRaw`, `readRaw` and `reset` are the MongoDB
 * `ContractHarness`'s on the same instance; checkpoint and write rows are driver inserts and reads
 * of the storage's two collections (identity fields only, as the checkpoint store reads them).
 * The disconnected store comes from a backend on another mongoose instance that never connects.
 */
import { Mongoose } from 'mongoose';
import type { CheckpointContractHarness, CheckpointIdentityRow } from '~/contracts/checkpoint';
import type { CheckpointStorageNames } from '~/ports/checkpointStore';
import type { MongoContractEngine } from './contractHarness';
import { createMongoContractHarness } from './contractHarness';
import { createMongoDataStoreBackend } from './backend';
import { mongoStoreIds } from './storeIds';

/** The MongoDB checkpoint contract harness on the server `engine` provides. */
export function createMongoCheckpointContractHarness(
  engine: MongoContractEngine,
): CheckpointContractHarness {
  const mongoose = new Mongoose();
  const base = createMongoContractHarness(engine, mongoose);
  const backend = createMongoDataStoreBackend(mongoose);
  const db = () => {
    const database = mongoose.connection.db;
    if (!database) {
      throw new Error('The MongoDB checkpoint contract harness is not set up');
    }
    return database;
  };
  const collectionName = (storage: CheckpointStorageNames, kind: 'checkpoints' | 'writes') =>
    kind === 'checkpoints'
      ? storage.checkpointCollectionName
      : storage.checkpointWritesCollectionName;

  return {
    name: 'mongo',
    setup: () => base.setup(),
    teardown: () => base.teardown(),
    reset: () => base.reset(),

    store() {
      const store = backend.getCheckpointStore();
      if (!store) {
        throw new Error('The connected MongoDB backend served no checkpoint store');
      }
      return store;
    },

    disconnectedStore: () => createMongoDataStoreBackend(new Mongoose()).getCheckpointStore(),

    async seedCheckpointRows(storage, kind, rows) {
      if (rows.length === 0) {
        return;
      }
      await db()
        .collection(collectionName(storage, kind))
        .insertMany(rows.map((row) => ({ ...row })));
    },

    async readCheckpointRows(storage, kind) {
      const rows = await db()
        .collection<CheckpointIdentityRow>(collectionName(storage, kind))
        .find(
          {},
          { projection: { _id: 0, thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, lc_owner: 1 } },
        )
        .toArray();
      return rows.map(({ thread_id, checkpoint_ns, checkpoint_id, lc_owner }) => ({
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        ...(lc_owner == null ? {} : { lc_owner }),
      }));
    },

    seedRaw: (collection, records) => base.seedRaw(collection, records),
    readRaw: (collection) => base.readRaw(collection),
    generateId: () => mongoStoreIds.generate(),
  };
}

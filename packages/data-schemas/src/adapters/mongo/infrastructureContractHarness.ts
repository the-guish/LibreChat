/**
 * The MongoDB `InfrastructureContractHarness` (`~/contracts/infrastructure`): the MongoDB backend
 * (`createMongoDataStoreBackend`) on a private mongoose instance connected to the server `engine`
 * provides (mongodb-memory-server in the specs), with every model registered (`createModels`), so
 * the credential marker finds its `User` model. `reset` empties every collection (the Keyv
 * collections and GridFS buckets, the marker's and `users`); `seedUser` is a driver insert into
 * `users`. The disconnected backend runs on another mongoose instance that never connects.
 */
import { Mongoose } from 'mongoose';
import type { InfrastructureContractHarness } from '~/contracts/infrastructure';
import type { MongoContractEngine } from './contractHarness';
import { createMongoDataStoreBackend } from './backend';
import { createModels } from '~/models';

/** The MongoDB infrastructure contract harness on the server `engine` provides. */
export function createMongoInfrastructureContractHarness(
  engine: MongoContractEngine,
): InfrastructureContractHarness {
  const mongoose = new Mongoose();
  const backend = createMongoDataStoreBackend(mongoose);
  let users = 0;
  const db = () => {
    const database = mongoose.connection.db;
    if (!database) {
      throw new Error('The MongoDB infrastructure contract harness is not set up');
    }
    return database;
  };

  return {
    name: 'mongo',

    async setup() {
      await mongoose.connect(await engine.connect());
      createModels(mongoose);
    },

    async teardown() {
      await mongoose.disconnect();
      await engine.release();
    },

    async reset() {
      const collections = await db().collections();
      await Promise.all(collections.map((collection) => collection.deleteMany({})));
    },

    backend: () => backend,

    disconnectedBackend: () => createMongoDataStoreBackend(new Mongoose()),

    async seedUser() {
      const email = `user-${(users += 1)}@example.com`;
      await db().collection('users').insertOne({ email });
    },
  };
}

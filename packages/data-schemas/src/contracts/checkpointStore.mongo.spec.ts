import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoCheckpointContractHarness } from '~/adapters/mongo/checkpointContractHarness';
import { describeCheckpointStoreContract } from './checkpointStore.contract';

/** The checkpoint store contract on MongoDB. */
let server: MongoMemoryServer;

describeCheckpointStoreContract(
  createMongoCheckpointContractHarness({
    async connect() {
      server = await MongoMemoryServer.create();
      return server.getUri();
    },
    async release() {
      await server.stop();
    },
  }),
);

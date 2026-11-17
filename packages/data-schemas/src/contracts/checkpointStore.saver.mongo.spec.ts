import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoCheckpointContractHarness } from '~/adapters/mongo/checkpointContractHarness';
import { describeCheckpointSaverContract } from './checkpointStore.saver.contract';

/** The checkpoint store's saver contract on MongoDB. */
let server: MongoMemoryServer;

describeCheckpointSaverContract(
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

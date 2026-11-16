import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoInfrastructureContractHarness } from '~/adapters/mongo/infrastructureContractHarness';
import { describeKeyValueStoreContract } from './keyValueStore.contract';

/** The key-value store contract on MongoDB. */
let server: MongoMemoryServer;

describeKeyValueStoreContract(
  createMongoInfrastructureContractHarness({
    async connect() {
      server = await MongoMemoryServer.create();
      return server.getUri();
    },
    async release() {
      await server.stop();
    },
  }),
);

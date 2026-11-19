import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoInfrastructureContractHarness } from '~/adapters/mongo/infrastructureContractHarness';
import { describeCredentialMarkerContract } from './credentialMarker.contract';

/** The credential marker store contract on MongoDB. */
let server: MongoMemoryServer;

describeCredentialMarkerContract(
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

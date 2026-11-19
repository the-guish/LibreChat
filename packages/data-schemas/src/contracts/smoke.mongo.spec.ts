import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { describeContractHarnessSmoke } from './smoke.contract';

/** The contract harness smoke suite on MongoDB; the PostgreSQL run comes with C1. */
let server: MongoMemoryServer;

describeContractHarnessSmoke(
  createMongoContractHarness({
    async connect() {
      server = await MongoMemoryServer.create();
      return server.getUri();
    },
    async release() {
      await server.stop();
    },
  }),
);

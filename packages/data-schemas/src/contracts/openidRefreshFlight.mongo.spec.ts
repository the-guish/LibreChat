import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { describeOpenIDRefreshFlightContract } from './openidRefreshFlight.contract';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';

/** The OpenID refresh flight store contract on MongoDB; the PostgreSQL run comes with its S unit. */
let server: MongoMemoryServer;
const engine: MongoContractEngine = {
  async connect() {
    server = await MongoMemoryServer.create();
    return server.getUri();
  },
  async release() {
    await server.stop();
  },
};

describeOpenIDRefreshFlightContract(createMongoContractHarness(engine));

import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { describeCodeEnvironmentContract } from './codeEnvironment.contract';

/**
 * The `CodeEnvironmentStore` contract (registry, lifecycle and browser setup reservations) on
 * MongoDB; the PostgreSQL run comes with its S unit.
 */
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

describeCodeEnvironmentContract(createMongoContractHarness(engine));

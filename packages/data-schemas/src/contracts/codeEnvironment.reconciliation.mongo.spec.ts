import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { describeCodeEnvironmentReconciliationContract } from './codeEnvironment.reconciliation.contract';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';

/** The `CodeEnvironmentStore` (reconciliation) contract on MongoDB; the PostgreSQL run comes with its S unit. */
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

describeCodeEnvironmentReconciliationContract(createMongoContractHarness(engine));

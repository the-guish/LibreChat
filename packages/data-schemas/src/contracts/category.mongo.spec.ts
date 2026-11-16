import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { describeCategoriesContract, describeAgentCategoryContract } from './category.contract';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';

/** The categories and agent category store contract on MongoDB; the PostgreSQL run comes with its S unit. */
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

describeCategoriesContract(createMongoContractHarness(engine));
describeAgentCategoryContract(createMongoContractHarness(engine));

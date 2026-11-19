import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { describeMCPAuthorizationFenceRetryContract } from './mcpAuthorizationFenceRetry.contract';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';

/** The `MCPAuthorizationFenceRetryStore` contract on MongoDB; the PostgreSQL run comes with its S unit. */
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

describeMCPAuthorizationFenceRetryContract(createMongoContractHarness(engine));

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { describeMCPAuthorityContract } from './mcpAuthority.contract';

/**
 * The `MCPAuthorityStore` contract on MongoDB, on a one-member replica set so the store runs its snapshot
 * transactions; the PostgreSQL run comes with its S unit.
 */
let server: MongoMemoryReplSet;
const engine: MongoContractEngine = {
  async connect() {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    return server.getUri();
  },
  async release() {
    await server.stop();
  },
};

describeMCPAuthorityContract(createMongoContractHarness(engine));

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { describeAclEntryContract } from './aclEntry.contract';

/**
 * The ACL entry store contract on MongoDB, on a one-member replica set so the store runs
 * transactions (the contract's transaction cases need them); the PostgreSQL run comes with its
 * S unit.
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

describeAclEntryContract(createMongoContractHarness(engine));

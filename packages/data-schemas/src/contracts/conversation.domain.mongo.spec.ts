import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { describeConversationDomainContract } from './conversation.domain.contract';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';

/**
 * The conversation store's domain steps and the composed conversation functions on MongoDB; the
 * PostgreSQL run comes with its S unit.
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

describeConversationDomainContract(createMongoContractHarness(engine));

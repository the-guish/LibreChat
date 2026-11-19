import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { describeConversationAgentEventActorContract } from './conversation.agentEventActor.contract';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';

/**
 * The conversation store contract for subagent threads and event actors on MongoDB; the
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

describeConversationAgentEventActorContract(createMongoContractHarness(engine));

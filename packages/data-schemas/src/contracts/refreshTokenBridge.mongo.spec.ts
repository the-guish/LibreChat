import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { describeRefreshTokenBridgeContract } from './refreshTokenBridge.contract';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';

/** The refresh token bridge store contract on MongoDB; the PostgreSQL run comes with its S unit. */
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

describeRefreshTokenBridgeContract(createMongoContractHarness(engine));

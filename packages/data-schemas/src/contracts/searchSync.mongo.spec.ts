/** Search on, with a MeiliSearch host and key, before the plugin and models load (side-effect import: keep it first). */
import './searchSyncEnv';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { createMongoSearchIndexSync } from '~/adapters/mongo/searchIndexSync';
import { describeSearchSyncContract } from './searchSync.contract';

/** The plugin's MeiliSearch client is the in-memory fake the contract reads. */
jest.mock('meilisearch', () => jest.requireActual('./meiliFake').meilisearchModule);

/** The search sync contract on MongoDB: the mongoMeili plugin and its statics. */
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

describeSearchSyncContract(createMongoContractHarness(engine, mongoose), () => {
  const searchIndexSync = createMongoSearchIndexSync(mongoose);
  if (!searchIndexSync) {
    throw new Error('The Message and Conversation models are not registered');
  }
  return searchIndexSync;
});

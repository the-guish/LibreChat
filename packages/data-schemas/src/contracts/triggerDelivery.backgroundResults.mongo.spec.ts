import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoContractEngine } from '~/adapters/mongo/contractHarness';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { describeTriggerDeliveryBackgroundResultsContract } from './triggerDelivery.backgroundResults.contract';

/**
 * The trigger delivery store contract (background results) on MongoDB; the PostgreSQL run comes with
 * its S unit.
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

describeTriggerDeliveryBackgroundResultsContract(createMongoContractHarness(engine));

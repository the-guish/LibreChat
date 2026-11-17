/**
 * The test data store on MongoDB (`./index`): an in-memory MongoDB server, connected on the
 * shared `mongoose` instance the process's backend uses, through the MongoDB contract harness
 * (`seedRaw`, `readRaw`, `reset`). Loaded only when `DATABASE_BACKEND` selects MongoDB.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestDataStore, TestDataStoreOptions } from './types';
import type { DataMethods } from '~/compose/types';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { getDataStoreBackend } from '~/adapters/backend';
import { openTestDataStore } from './harness';

/** A test data store on a new in-memory MongoDB server. */
export async function createMongoTestDataStore(
  options: TestDataStoreOptions,
): Promise<TestDataStore> {
  const backend = getDataStoreBackend();
  if (backend.name !== 'mongo') {
    throw new Error(
      `createTestDataStore: DATABASE_BACKEND selects MongoDB, but the process's backend is "${backend.name}" (DATABASE_BACKEND is read once, on the first getDataStoreBackend() call)`,
    );
  }
  let server: MongoMemoryServer | undefined;
  const harness = createMongoContractHarness(
    {
      async connect() {
        server = await MongoMemoryServer.create();
        return server.getUri();
      },
      async release() {
        await server?.stop();
        server = undefined;
      },
    },
    mongoose,
  );
  return openTestDataStore(
    'mongo',
    harness,
    (deps) => backend.createMethods(deps) as unknown as DataMethods,
    options.deps,
  );
}

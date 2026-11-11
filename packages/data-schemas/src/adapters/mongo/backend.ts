import type { Mongoose } from 'mongoose';
import type { DataStoreBackend, DataStoreConnectionOptions } from '~/ports/connection';
import type { MongoConnectionCache, MongoDataStoreConnection } from './connection';
import type { AllMethods, CreateMethodsDeps } from '~/methods';
import { createMongoSearchIndexSync } from './searchIndexSync';
import { createMongoDataStoreConnection } from './connection';
import { createMongoStartupChecks } from './startupChecks';
import { createMethods } from '~/methods';
import { createModels } from '~/models';

/** The MongoDB backend: the `DataStoreBackend` port with the MongoDB methods, models and handle. */
export interface MongoDataStoreBackend
  extends DataStoreBackend<AllMethods, CreateMethodsDeps, Mongoose> {
  readonly name: 'mongo';
  /** `createModels(mongoose)`: registers every model and returns them. */
  registerModels(): ReturnType<typeof createModels>;
  createConnection(
    options: DataStoreConnectionOptions & { cache?: MongoConnectionCache },
  ): MongoDataStoreConnection;
}

/**
 * The MongoDB backend on `mongoose` (the server's: the one instance every model is registered
 * on). Model registration, the methods, the connection, the search index sync and the startup
 * checks all use that instance.
 */
export function createMongoDataStoreBackend(mongoose: Mongoose): MongoDataStoreBackend {
  return {
    name: 'mongo',
    registerModels: () => createModels(mongoose),
    createMethods: (deps?: CreateMethodsDeps) => createMethods(mongoose, deps),
    createConnection: (options) => createMongoDataStoreConnection(mongoose, options),
    getSearchIndexSync: () => createMongoSearchIndexSync(mongoose),
    createStartupChecks: (methods) => createMongoStartupChecks(mongoose, methods),
  };
}

import type { Mongoose } from 'mongoose';
import type { DataStoreBackend, DataStoreConnectionOptions } from '~/ports/connection';
import type { MongoConnectionCache, MongoDataStoreConnection } from './connection';
import type { MongoKeyValueStoreOptions } from './keyValueStore';
import type { AllMethods, CreateMethodsDeps } from '~/methods';
import type { KeyValueStore } from '~/ports/keyValueStore';
import { createMongoCredentialMarkerStore } from './credentialMarker';
import { createMongoCheckpointStore } from './checkpointStore';
import { createMongoSearchIndexSync } from './searchIndexSync';
import { createMongoDataStoreConnection } from './connection';
import { createMongoKeyValueStore } from './keyValueStore';
import { createMongoStartupChecks } from './startupChecks';
import { mongoStoreIds } from './storeIds';
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
  /** Also takes the GridFS bucket's read preference for a store with `largeValues`. */
  createKeyValueStore(options: MongoKeyValueStoreOptions): KeyValueStore;
}

/**
 * The MongoDB backend on `mongoose` (the server's: the one instance every model is registered
 * on). Model registration, the methods, the connection, the search index sync, the startup
 * checks, the credential marker, the key-value stores and the checkpoint store all use that
 * instance; the ids are ObjectIds (`mongoStoreIds`).
 */
export function createMongoDataStoreBackend(mongoose: Mongoose): MongoDataStoreBackend {
  return {
    name: 'mongo',
    registerModels: () => createModels(mongoose),
    createMethods: (deps?: CreateMethodsDeps) => createMethods(mongoose, deps),
    createConnection: (options) => createMongoDataStoreConnection(mongoose, options),
    getSearchIndexSync: () => createMongoSearchIndexSync(mongoose),
    createStartupChecks: (methods) => createMongoStartupChecks(mongoose, methods),
    getCredentialMarkerStore: () => createMongoCredentialMarkerStore(mongoose),
    createKeyValueStore: (options) => createMongoKeyValueStore(mongoose, options),
    getCheckpointStore: () => createMongoCheckpointStore(mongoose),
    ids: mongoStoreIds,
  };
}

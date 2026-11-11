/** Adapters that satisfy the ports in `~/ports`. */
export { getDataStoreBackend } from './backend';
export { createMongoConversationStore } from './mongo/conversationStore';
export { createMongoDataStore } from './mongo/dataStore';
export type { MongoDataStoreMethods } from './mongo/dataStore';
export { createMongoDataStoreBackend } from './mongo/backend';
export type { MongoDataStoreBackend } from './mongo/backend';
export {
  instrumentMongooseQueries,
  readMongoConnectionSettings,
  toMongooseConnectOptions,
  createMongoDataStoreConnection,
} from './mongo/connection';
export type {
  MongooseQueryHost,
  MongoConnectionCache,
  MongoConnectionSettings,
  MongoDataStoreConnection,
} from './mongo/connection';
export { pickStore } from './mongo/pickStore';
export { batchResetMeiliFlags, createMongoSearchIndexSync } from './mongo/searchIndexSync';
export type { MeiliFlagCollection } from './mongo/searchIndexSync';
export { ensureCollectionExists, ensureRequiredCollectionsExist } from './mongo/collections';
export {
  createMongoStartupChecks,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} from './mongo/startupChecks';
export type {
  AgentPermissionsMigrationCheckParams,
  PromptPermissionsMigrationCheckParams,
} from './mongo/startupChecks';
export { createMongoKeyValueStore } from './mongo/keyValueStore';
export type { MongoKeyValueStoreOptions } from './mongo/keyValueStore';
export {
  CREDENTIAL_MARKER_ID,
  CREDENTIAL_MARKER_COLLECTION,
  createMongoCredentialMarkerStore,
} from './mongo/credentialMarker';
export {
  LazyMongoSaver,
  OwnedMongoSaver,
  setupCheckpointIndexes,
  createMongoCheckpointSaver,
  CHECKPOINT_WARN_BYTES,
  CHECKPOINT_HARD_LIMIT_BYTES,
  CHECKPOINT_STORAGE_COLLECTION,
} from './mongo/checkpointSaver';
export type { LazyMongoSaverOptions, CheckpointStorageRecord } from './mongo/checkpointSaver';
export {
  createMongoCheckpointStore,
  CHECKPOINT_DELETION_COLLECTION,
} from './mongo/checkpointStore';

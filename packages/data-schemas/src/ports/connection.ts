/**
 * Data store lifecycle port: registering the data model, connecting, closing and checking the
 * database, on whichever database the backend is. Nothing here may import `mongoose` or the
 * MongoDB driver, at runtime or as a type.
 *
 * The backend is chosen once for the whole database (`getDataStoreBackend` in `~/adapters`), so
 * the boot code (`api/db`), the composition root (`api/models`) and the command line scripts
 * reach the database only through a {@link DataStoreBackend} and the
 * {@link DataStoreConnection} it creates. Each backend reads its own settings (with MongoDB: the
 * `MONGO_*` variables) from the environment it is given.
 *
 * Not a member of `DataStore`: it is the process's connection, not a store of data methods, and
 * `DataStore` is built from it (`createMethods`). The backend also serves the deployment-wide
 * maintenance that runs at boot outside any store (the search index sync, the startup migration
 * checks and the credential marker) and the infrastructure key-value stores the cache layer
 * keeps in the main database.
 */
import type { DataStoreStartupChecks, StartupCheckMethods } from './startupChecks';
import type { KeyValueStore, KeyValueStoreOptions } from './keyValueStore';
import type { CredentialMarkerStore } from './credentialMarker';
import type { SearchIndexSync } from './searchIndexSync';
import { listPortMethods } from './common';

/** Where a connection is in its lifecycle. */
export type DataStoreConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting';

/** What {@link DataStoreConnection.health} reports. */
export interface DataStoreHealth {
  /** Whether the database answered a round trip just now. */
  ok: boolean;
  /** The connection's state when the check ran. */
  state: DataStoreConnectionState;
  /** How long the round trip took, when one was made. */
  latencyMs?: number;
  /** Why the check failed, when the round trip was made and failed. */
  error?: string;
}

/**
 * One finished database query, for metrics. `model` and `operation` are the backend's own
 * names (with MongoDB: the model name and the mongoose operation, such as `findOne`), passed
 * as they are or `undefined` when unknown; the observer normalizes them.
 */
export interface DataStoreQueryObservation {
  model: string | undefined;
  operation: string | undefined;
  status: 'success' | 'error';
  durationSeconds: number;
}

/** Called once per finished query; must not throw. */
export type DataStoreQueryObserver = (observation: DataStoreQueryObservation) => void;

/** What a backend needs to create the process's connection. */
export interface DataStoreConnectionOptions {
  /**
   * The environment the backend reads its settings from (the server passes `process.env`). A
   * backend whose required settings are missing throws from `createConnection`.
   */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * When given, every query made through the backend is reported to it. Instrumentation is
   * installed once per process (later observers are ignored), before the settings are read.
   */
  observeQueries?: DataStoreQueryObserver;
}

/**
 * The process's connection to the database. `THandle` is what `connect` resolves to: the
 * backend's own client, for the boot code and scripts that still hand it on.
 */
export interface DataStoreConnection<THandle = unknown> {
  /**
   * Connects (or reuses the connection already made or being made in this process, including
   * across hot reloads) and resolves once the database is reachable; rejects when it is not.
   */
  connect(): Promise<THandle>;
  /** Closes the process's connection; a later `connect` opens a new one. */
  close(): Promise<void>;
  /** The connection's current state. */
  getState(): DataStoreConnectionState;
  /** Whether the connection is open (`getState() === 'connected'`). */
  isConnected(): boolean;
  /** Checks that the database answers; never rejects. */
  health(): Promise<DataStoreHealth>;
}

/**
 * A database backend: the one place where the database is chosen. `TMethods` is what
 * `createMethods` builds (it carries the backend's `stores: DataStore`), `TDeps` the
 * dependencies the methods take from the api layer, `THandle` the connection's handle.
 */
export interface DataStoreBackend<TMethods = unknown, TDeps = never, THandle = unknown> {
  /** The backend's name, such as `mongo`. */
  readonly name: string;
  /**
   * Registers the data model (with MongoDB: every mongoose model, on the default connection).
   * Idempotent. Must run before code that looks a model up at load time (`indexSync`).
   */
  registerModels(): void;
  /** Builds the data methods and their stores, once per call; the composition root calls it once. */
  createMethods(deps?: TDeps): TMethods;
  /** Creates the process's connection from the environment; see {@link DataStoreConnectionOptions}. */
  createConnection(options: DataStoreConnectionOptions): DataStoreConnection<THandle>;
  /**
   * The database side of the search index sync (`~/ports/searchIndexSync`), or `null` while the
   * data model is not registered (`registerModels` has not run). Looked up on each call.
   */
  getSearchIndexSync(): SearchIndexSync | null;
  /**
   * The boot-time migration checks (`~/ports/startupChecks`), using `methods` from the
   * composition root's stores. Each check reads the database when it is called, not before.
   */
  createStartupChecks(methods: StartupCheckMethods): DataStoreStartupChecks;
  /**
   * The credential marker (`~/ports/credentialMarker`), or `null` while the database is not
   * connected or the user model is not registered. Looked up on each call.
   */
  getCredentialMarkerStore(): CredentialMarkerStore | null;
  /**
   * Opens a key-value store by name (`~/ports/keyValueStore`). Nothing is read until its first
   * operation; stores of the same name and `largeValues` share their entries and their opening.
   */
  createKeyValueStore(options: KeyValueStoreOptions): KeyValueStore;
}

/** Every method of {@link DataStoreConnection}, for adapters and conformance checks. */
export const DATA_STORE_CONNECTION_METHODS: ReadonlyArray<keyof DataStoreConnection> =
  listPortMethods<DataStoreConnection>({
    connect: true,
    close: true,
    getState: true,
    isConnected: true,
    health: true,
  });

/** Every member of {@link DataStoreBackend}, for adapters and conformance checks. */
export const DATA_STORE_BACKEND_MEMBERS: ReadonlyArray<keyof DataStoreBackend> =
  listPortMethods<DataStoreBackend>({
    name: true,
    registerModels: true,
    createMethods: true,
    createConnection: true,
    getSearchIndexSync: true,
    createStartupChecks: true,
    getCredentialMarkerStore: true,
    createKeyValueStore: true,
  });

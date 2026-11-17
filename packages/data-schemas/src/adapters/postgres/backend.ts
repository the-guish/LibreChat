/**
 * The PostgreSQL backend (`DataStoreBackend`; docs/postgres-port/PHASE4.md), selected with
 * `DATABASE_BACKEND=postgres` (`~/adapters/backend`). Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * What it serves today:
 * - `createMethods` composes through `composeDataMethods` (`~/compose`) like every backend; the
 *   `transactions` store, the pure helpers and the stores of `POSTGRES_IMPLEMENTED_STORES` are
 *   real (the S units' adapters, `./stores`, on one collection primitive per backend built on
 *   first use over the production tables and the schema engine), every other store is a
 *   stand-in whose methods throw `StoreNotImplementedError` (`./factories`, `./notImplemented`);
 * - `createConnection`: the PostgreSQL connection (`./connection`: pool, boot checks,
 *   migrations). Its `connect` refuses while stores are missing (listing them), unless
 *   `POSTGRES_ALLOW_INCOMPLETE_STORES=true` in the environment it was given, which only logs a
 *   warning (for development and the specs; B1 removes the escape hatch from production paths);
 * - `ids` (`./storeIds`), `documents` (`./storeDocuments`), `errors` (`./storeErrors`);
 * - `registerModels`: nothing to register (the tables come from the migrations), a no-op;
 * - `createKeyValueStore` (`./keyValueStore`, I1): stores on `key_value_entries`, querying
 *   through the connection's handle on each operation (each operation rejects while it is not
 *   connected);
 * - `getCredentialMarkerStore` (`./credentialMarker`, I1): the marker on the connection's handle,
 *   or `null` while it is not connected (as MongoDB answers `null` without a connection);
 * - `getCheckpointStore` (`./checkpointStore`, I2): the checkpoint store on the connection's
 *   handle (its savers on the handle's pool), or `null` while it is not connected (as MongoDB
 *   answers `null` without a database).
 *
 * Not yet (each throws `StoreNotImplementedError` when used, never answers `null`): the search
 * index sync (I3), the startup checks (B1).
 */
import type { PostgresConnectionOptions, PostgresDataStoreConnection } from './connection';
import type { CreateMethodsDeps, DataMethods } from '~/compose/types';
import type { UniqueConstraintFields } from './storeErrors';
import type { DataStoreBackend } from '~/ports/connection';
import type { PgCollections } from './collection';
import type { PostgresHandle } from './types';
import { StoreNotImplementedError, createNotImplementedStartupChecks } from './notImplemented';
import { POSTGRES_UNIMPLEMENTED_STORES, createPostgresDataModuleFactories } from './factories';
import { createPostgresStoreErrors, POSTGRES_UNIQUE_CONSTRAINTS } from './storeErrors';
import { createPostgresCredentialMarkerStore } from './credentialMarker';
import { createPostgresStoreTransactions } from './storeTransactions';
import { SCHEMA_DESCRIPTOR } from './schema/descriptor.generated';
import { createPostgresCheckpointStore } from './checkpointStore';
import { createPostgresDataStoreConnection } from './connection';
import { createPostgresKeyValueStore } from './keyValueStore';
import { createPgCollections } from './collection/collection';
import { postgresStoreDocuments } from './storeDocuments';
import { getSchemaEngine } from './schema/engine';
import { readTtlIntervalMs } from './ttlSweeper';
import { composeDataMethods } from '~/compose';
import { postgresStoreIds } from './storeIds';
import logger from '~/config/winston';

/** The backend members other than stores that the PostgreSQL backend does not implement yet. */
export const POSTGRES_UNIMPLEMENTED_MEMBERS: ReadonlyArray<string> = [
  'searchIndexSync',
  'startupChecks',
];

/** The PostgreSQL backend: the `DataStoreBackend` port with the composed data methods. */
export interface PostgresDataStoreBackend
  extends DataStoreBackend<DataMethods, CreateMethodsDeps, PostgresHandle> {
  readonly name: 'postgres';
  createConnection(options: PostgresConnectionOptions): PostgresDataStoreConnection;
  /**
   * What is not implemented yet: the stores (`DataStore` keys) and the other members; `connect`
   * refuses while it is not empty, unless `POSTGRES_ALLOW_INCOMPLETE_STORES=true`.
   */
  readonly unimplemented: ReadonlyArray<string>;
}

/** Options of {@link createPostgresDataStoreBackend}. */
export interface PostgresDataStoreBackendOptions {
  /** Unique index and constraint names → the fields they cover (default: the descriptor's). */
  uniqueConstraints?: UniqueConstraintFields;
  /**
   * Check every tier-1 update of the stores against the evaluator (default:
   * `POSTGRES_UPDATE_SHADOW_CHECK=true`, read at each update; `createPgCollections`).
   */
  shadowCheck?: boolean;
}

/** Thrown by `connect` while the backend is incomplete and the escape hatch is not set. */
export class IncompletePostgresBackendError extends Error {
  readonly unimplemented: ReadonlyArray<string>;
  constructor(unimplemented: ReadonlyArray<string>) {
    super(
      `The PostgreSQL backend is incomplete: ${unimplemented.length} stores and members are not implemented yet (${unimplemented.join(', ')}). Use DATABASE_BACKEND=mongo, or set POSTGRES_ALLOW_INCOMPLETE_STORES=true to connect anyway (development and tests only: the missing stores throw StoreNotImplementedError).`,
    );
    this.name = 'IncompletePostgresBackendError';
    this.unimplemented = unimplemented;
  }
}

function allowsIncompleteStores(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.POSTGRES_ALLOW_INCOMPLETE_STORES?.trim().toLowerCase() === 'true';
}

/**
 * The PostgreSQL backend. One backend instance owns its latest connection: the `transactions`
 * store queries through the handle that connection's `connect` opened (and throws while it is
 * not connected).
 */
export function createPostgresDataStoreBackend(
  options: PostgresDataStoreBackendOptions = {},
): PostgresDataStoreBackend {
  const unimplemented: ReadonlyArray<string> = [
    ...POSTGRES_UNIMPLEMENTED_STORES,
    ...POSTGRES_UNIMPLEMENTED_MEMBERS,
  ];
  let connection: PostgresDataStoreConnection | undefined;
  /** The period of the checkpoint expiry sweep, from the latest connection's environment. */
  let ttlIntervalMs: number | undefined;

  const getDb = () => {
    const handle = connection?.getHandle();
    if (!handle) {
      throw new Error('PostgreSQL is not connected: connect the data store connection first');
    }
    return handle.db;
  };

  /**
   * The collection primitive over the production tables, shared by every store this backend
   * builds: built on first use (the schema engine compiles the mongoose models offline then), and
   * querying through the connected handle on each operation (`getDb`).
   */
  let collections: PgCollections | undefined;
  const getCollections = (): PgCollections =>
    (collections ??= createPgCollections({
      db: getDb,
      descriptor: SCHEMA_DESCRIPTOR,
      engine: getSchemaEngine(),
      ...(options.shadowCheck !== undefined ? { shadowCheck: options.shadowCheck } : {}),
    }));

  function createConnection(connectionOptions: PostgresConnectionOptions) {
    const inner = createPostgresDataStoreConnection(connectionOptions);
    connection = inner;
    ttlIntervalMs = readTtlIntervalMs(connectionOptions.env);
    const connect = async (): Promise<PostgresHandle> => {
      if (unimplemented.length > 0) {
        if (!allowsIncompleteStores(connectionOptions.env)) {
          throw new IncompletePostgresBackendError(unimplemented);
        }
        logger.warn(
          `[connectDb] POSTGRES_ALLOW_INCOMPLETE_STORES=true: connecting although ${unimplemented.length} PostgreSQL stores and members are not implemented yet; using them throws StoreNotImplementedError.`,
        );
      }
      return inner.connect();
    };
    return { ...inner, connect };
  }

  return {
    name: 'postgres',
    unimplemented,
    registerModels: () => undefined,
    createMethods: (deps?: CreateMethodsDeps): DataMethods =>
      composeDataMethods(
        createPostgresDataModuleFactories({
          createTransactions: () => createPostgresStoreTransactions(getDb),
          createStoreContext: (transactions) => ({
            collections: getCollections,
            db: getDb,
            transactions,
            isTenantScoped: (collection) => getSchemaEngine().isTenantScoped(collection),
          }),
        }),
        deps,
      ),
    createConnection,
    getSearchIndexSync: () => {
      throw new StoreNotImplementedError('searchIndexSync', 'getSearchIndexSync');
    },
    createStartupChecks: () => createNotImplementedStartupChecks(),
    getCredentialMarkerStore: () => {
      const handle = connection?.getHandle();
      return handle ? createPostgresCredentialMarkerStore(handle.db) : null;
    },
    createKeyValueStore: (storeOptions) => createPostgresKeyValueStore(getDb, storeOptions),
    getCheckpointStore: () => {
      const current = connection;
      const handle = current?.getHandle();
      return handle
        ? createPostgresCheckpointStore({
            handle,
            collections: getCollections,
            isConnected: () => current?.getHandle() === handle,
            ttlIntervalMs,
          })
        : null;
    },
    ids: postgresStoreIds,
    documents: postgresStoreDocuments,
    errors: createPostgresStoreErrors(options.uniqueConstraints ?? POSTGRES_UNIQUE_CONSTRAINTS),
  };
}

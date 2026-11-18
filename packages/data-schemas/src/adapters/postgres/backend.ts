/**
 * The PostgreSQL backend (`DataStoreBackend`; docs/postgres-port/PHASE4.md), selected with
 * `DATABASE_BACKEND=postgres` (`~/adapters/backend`). Must not import `mongoose`, `mongodb` or
 * `bson`. It implements every member (B1):
 *
 * - `createMethods` composes through `composeDataMethods` (`~/compose`) like every backend: the
 *   `transactions` store, the pure helpers and every store of `DataStore` (the S units' adapters,
 *   `./stores`, on one collection primitive per backend built on first use over the production
 *   tables and the schema engine; `./factories`);
 * - `createConnection`: the PostgreSQL connection (`./connection`: pool, boot checks,
 *   migrations);
 * - `ids` (`./storeIds`), `documents` (`./storeDocuments`), `errors` (`./storeErrors`);
 * - `registerModels`: nothing to register (the tables come from the migrations), a no-op;
 * - `createKeyValueStore` (`./keyValueStore`, I1): stores on `key_value_entries`, querying
 *   through the connection's handle on each operation (each operation rejects while it is not
 *   connected);
 * - `getCredentialMarkerStore` (`./credentialMarker`, I1): the marker on the connection's handle,
 *   or `null` while it is not connected (as MongoDB answers `null` without a connection);
 * - `getCheckpointStore` (`./checkpointStore`, I2): the checkpoint store on the connection's
 *   handle (its savers on the handle's pool), or `null` while it is not connected (as MongoDB
 *   answers `null` without a database);
 * - `getSearchIndexSync` (`./search`, I3): the MeiliSearch index sync on the `_meili*` flag
 *   columns, querying through the connection's handle on each operation; the same search serves
 *   the collections' write hooks and the stores' index reads (MeiliSearch is configured by
 *   `MEILI_HOST`/`MEILI_MASTER_KEY`/`SEARCH`, or the `search` option);
 * - `createStartupChecks` (`./startupChecks`, B1): the search token probe and the permission
 *   migration dry runs on the collections' raw mode.
 *
 * Nothing is a stand-in any more, so the connection no longer refuses an incomplete backend and
 * F1's escape hatch for one is gone; `./completeness.spec.ts` keeps it that way.
 */
import type { PostgresConnectionOptions, PostgresDataStoreConnection } from './connection';
import type { CreateMethodsDeps, DataMethods } from '~/compose/types';
import type { UniqueConstraintFields } from './storeErrors';
import type { DataStoreBackend } from '~/ports/connection';
import type { PostgresSearchOptions } from './search';
import type { PgCollections } from './collection';
import type { PostgresHandle } from './types';
import { createPostgresStoreErrors, POSTGRES_UNIQUE_CONSTRAINTS } from './storeErrors';
import { createPostgresSearch, readPostgresSearchOptions } from './search';
import { createPostgresCredentialMarkerStore } from './credentialMarker';
import { createPostgresStoreTransactions } from './storeTransactions';
import { SCHEMA_DESCRIPTOR } from './schema/descriptor.generated';
import { createPostgresCheckpointStore } from './checkpointStore';
import { createPostgresDataStoreConnection } from './connection';
import { createPostgresDataModuleFactories } from './factories';
import { createPostgresKeyValueStore } from './keyValueStore';
import { createPostgresStartupChecks } from './startupChecks';
import { createPgCollections } from './collection/collection';
import { DEFAULT_COLLECTION_HOOKS } from './collection/hooks';
import { postgresStoreDocuments } from './storeDocuments';
import { getSchemaEngine } from './schema/engine';
import { readTtlIntervalMs } from './ttlSweeper';
import { composeDataMethods } from '~/compose';
import { postgresStoreIds } from './storeIds';

/** The PostgreSQL backend: the `DataStoreBackend` port with the composed data methods. */
export interface PostgresDataStoreBackend
  extends DataStoreBackend<DataMethods, CreateMethodsDeps, PostgresHandle> {
  readonly name: 'postgres';
  createConnection(options: PostgresConnectionOptions): PostgresDataStoreConnection;
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
  /**
   * The MeiliSearch configuration (`null`: off). Default: `MEILI_HOST`, `MEILI_MASTER_KEY` and
   * `SEARCH` of the process environment, read when the collections are first built.
   */
  search?: PostgresSearchOptions | null;
}

/**
 * The PostgreSQL backend. One backend instance owns its latest connection: the `transactions`
 * store queries through the handle that connection's `connect` opened (and throws while it is
 * not connected).
 */
export function createPostgresDataStoreBackend(
  options: PostgresDataStoreBackendOptions = {},
): PostgresDataStoreBackend {
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
  /** MeiliSearch: the write hooks of messages and conversations, the index sync, the reads. */
  const search = createPostgresSearch({
    options: () =>
      options.search !== undefined ? options.search : readPostgresSearchOptions(process.env),
    collections: () => getCollections(),
    db: getDb,
    transactions: createPostgresStoreTransactions(getDb),
  });
  const getCollections = (): PgCollections =>
    (collections ??= createPgCollections({
      db: getDb,
      descriptor: SCHEMA_DESCRIPTOR,
      engine: getSchemaEngine(),
      hooks: { ...DEFAULT_COLLECTION_HOOKS, ...search.hooks() },
      ...(options.shadowCheck !== undefined ? { shadowCheck: options.shadowCheck } : {}),
    }));

  function createConnection(connectionOptions: PostgresConnectionOptions) {
    const created = createPostgresDataStoreConnection(connectionOptions);
    connection = created;
    ttlIntervalMs = readTtlIntervalMs(connectionOptions.env);
    return created;
  }

  return {
    name: 'postgres',
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
            search,
          }),
        }),
        deps,
      ),
    createConnection,
    getSearchIndexSync: () => search.searchIndexSync,
    createStartupChecks: (methods) =>
      createPostgresStartupChecks({ collections: getCollections, methods }),
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

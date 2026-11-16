/**
 * The PostgreSQL `ContractHarness` (`~/contracts/harness`; docs/postgres-port/PHASE4.md §7): the
 * contract suites' view of the PostgreSQL backend, on the database `engine` gives (a suite database
 * copied from the migrated template in the specs). Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * - The stores are the backend's `createMethods(deps).stores`, connected to that database with
 *   `POSTGRES_ALLOW_INCOMPLETE_STORES=true`: stores not implemented yet are the backend's
 *   stand-ins (their methods throw `StoreNotImplementedError`) until their S unit lands.
 * - `seedRaw` and `readRaw` use the collection primitive's raw mode (§3.2): values of declared
 *   paths cast by the descriptor, no defaults, validators, hooks, tenant scoping or timestamps;
 *   undeclared or uncastable values kept in `_extra` and read back where they were (D7).
 *   `readRaw` returns hidden paths too, oldest `_id` first, ids as hex strings.
 * - `createConversationDomain` picks the four composed conversation functions from the same
 *   `createMethods(deps)` (stand-ins until S6a).
 * - `reset` truncates every collection and raw table (child rows by cascade).
 */
import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { PostgresDataStoreConnection } from './connection';
import type { CreateMethodsDeps } from '~/compose/types';
import type { PgCollections } from './collection';
import { SCHEMA_DESCRIPTOR } from './schema/descriptor.generated';
import { createPgCollections } from './collection/collection';
import { createPostgresDataStoreBackend } from './backend';
import { createSqlRunner } from './collection/runner';
import { quoteIdentifier } from './schema/naming';
import { postgresStoreIds } from './storeIds';

/** The database a harness runs on. */
export interface PostgresContractEngine {
  /** Starts or locates the server and returns the URI of a migrated (or empty) database. */
  connect(): Promise<string>;
  /** Releases the server once the harness has disconnected from it. */
  release(): Promise<void>;
}

/** The PostgreSQL contract harness. */
export function createPostgresContractHarness(engine: PostgresContractEngine): ContractHarness {
  const backend = createPostgresDataStoreBackend();
  let connection: PostgresDataStoreConnection | undefined;
  let collections: PgCollections | undefined;

  const ready = () => {
    const handle = connection?.getHandle();
    if (!handle || !collections) {
      throw new Error('The PostgreSQL contract harness is not set up');
    }
    return { handle, collections };
  };
  const roots = SCHEMA_DESCRIPTOR.tables
    .filter((table) => table.kind === 'collection' || table.kind === 'raw')
    .map((table) => quoteIdentifier(table.name));

  return {
    name: 'postgres',
    ids: postgresStoreIds,
    errors: backend.errors,

    async setup() {
      const uri = await engine.connect();
      connection = backend.createConnection({
        env: { POSTGRES_URI: uri, POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' },
        cache: { handle: null, promise: null },
      });
      const handle = await connection.connect();
      collections = createPgCollections({
        db: handle.db,
        descriptor: SCHEMA_DESCRIPTOR,
        engine: null,
      });
    },

    async teardown() {
      await connection?.close();
      connection = undefined;
      collections = undefined;
      await engine.release();
    },

    createStores: (deps?: CreateMethodsDeps) => backend.createMethods(deps).stores,

    /** The four composed conversation functions, from the same composition as the stores. */
    createConversationDomain(deps?: CreateMethodsDeps) {
      const { saveConvo, bulkSaveConvos, deleteConvos, searchConversation } =
        backend.createMethods(deps);
      return { saveConvo, bulkSaveConvos, deleteConvos, searchConversation };
    },

    async reset() {
      await createSqlRunner(ready().handle.db).query(`TRUNCATE ${roots.join(', ')} CASCADE`);
    },

    async seedRaw(collection, records) {
      if (records.length === 0) {
        return;
      }
      await ready()
        .collections.raw(collection)
        .insertMany(records.map((record) => ({ ...record })));
    },

    async readRaw(collection) {
      /** Without a sort, raw reads come back by `_id`, oldest first. */
      return (await ready().collections.raw(collection).find({})) as RawRecord[];
    },
  };
}

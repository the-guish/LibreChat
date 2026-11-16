/**
 * The PostgreSQL `InfrastructureContractHarness` (`~/contracts/infrastructure`; PHASE4.md §8 I1):
 * the PostgreSQL backend (`createPostgresDataStoreBackend`) connected, through its own
 * connection and connection state, to a suite database of the test harness copied from the
 * migrated template (`usePostgresTestDatabase({ template: 'migrated' })`), so every table exists.
 * Interim: the full PostgreSQL `ContractHarness` comes with the collection primitive (C1); this
 * one needs no collection access. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * `reset` truncates the tables the members use (`key_value_entries`,
 * `librechatCredentialMetadata`, `users` and its child tables); `seedUser` inserts a `users` row
 * with a new id and email. The disconnected backend is another backend instance whose connection
 * never connects.
 */
import { sql } from 'kysely';
import type { InfrastructureContractHarness } from '~/contracts/infrastructure';
import type { PostgresDataStoreConnection } from './connection';
import type { PostgresTestDatabase } from '~/test/postgres';
import { POSTGRES_CREDENTIAL_MARKER_TABLE } from './credentialMarker';
import { createPostgresDataStoreBackend } from './backend';
import { generatePostgresStoreId } from './storeIds';
import { KEY_VALUE_TABLE } from './keyValueStore';

/** The PostgreSQL infrastructure contract harness on the suite database `database`. */
export function createPostgresInfrastructureContractHarness(
  database: PostgresTestDatabase,
): InfrastructureContractHarness {
  const backend = createPostgresDataStoreBackend();
  let connection: PostgresDataStoreConnection | undefined;
  const db = () => {
    const handle = connection?.getHandle();
    if (!handle) {
      throw new Error('The PostgreSQL infrastructure contract harness is not set up');
    }
    return handle.db;
  };

  return {
    name: 'postgres',

    async setup() {
      connection = backend.createConnection({
        env: database.env({ POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' }),
        cache: { handle: null, promise: null },
      });
      await connection.connect();
    },

    async teardown() {
      await connection?.close();
      connection = undefined;
    },

    async reset() {
      await sql`TRUNCATE ${sql.table(KEY_VALUE_TABLE)}, ${sql.table(
        POSTGRES_CREDENTIAL_MARKER_TABLE,
      )}, ${sql.table('users')} CASCADE`.execute(db());
    },

    backend: () => backend,

    disconnectedBackend: () => createPostgresDataStoreBackend(),

    async seedUser() {
      const _id = generatePostgresStoreId();
      await sql`INSERT INTO ${sql.table('users')} ("_id", "email")
        VALUES (${_id}, ${`user-${_id}@example.com`})`.execute(db());
    },
  };
}

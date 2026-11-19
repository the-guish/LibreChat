/**
 * The PostgreSQL `CheckpointContractHarness` (`~/contracts/checkpoint`; PHASE4.md §8 I2): the
 * checkpoint store of a PostgreSQL backend (`getCheckpointStore()`) connected to a suite database
 * of the test harness copied from the migrated template. `seedRaw`, `readRaw` and `reset` are the
 * PostgreSQL `ContractHarness`'s on the same backend and connection; `reset` also empties the
 * tables of every checkpoint storage schema. Checkpoint and write rows are inserted into and read
 * from a storage's schema with SQL, after the store has set the schema up (`createSaver`), with
 * placeholder payloads. Must not import `mongoose`, `mongodb` or `bson`.
 */
import { Pool } from 'pg';
import type { CheckpointContractHarness, CheckpointIdentityRow } from '~/contracts/checkpoint';
import type { CheckpointStorageNames } from '~/ports/checkpointStore';
import type { PostgresTestDatabase } from '~/test/postgres';
import { postgresCheckpointSchemaName, postgresCheckpointTables } from './checkpointSaver';
import { createPostgresContractHarness } from './contractHarness';
import { createPostgresDataStoreBackend } from './backend';
import { postgresStoreIds } from './storeIds';

/** The schema the suite databases keep their tables in (`POSTGRES_SCHEMA` unset). */
const MAIN_SCHEMA = 'public';

/** The PostgreSQL checkpoint contract harness on the suite database `database`. */
export function createPostgresCheckpointContractHarness(
  database: PostgresTestDatabase,
): CheckpointContractHarness {
  const backend = createPostgresDataStoreBackend({ shadowCheck: true });
  const base = createPostgresContractHarness(
    { connect: async () => database.uri, release: async () => undefined },
    { backend },
  );
  let pool: Pool | undefined;
  let slot = 0;
  const sql = () => {
    if (!pool) {
      throw new Error('The PostgreSQL checkpoint contract harness is not set up');
    }
    return pool;
  };
  const store = () => {
    const served = backend.getCheckpointStore();
    if (!served) {
      throw new Error('The connected PostgreSQL backend served no checkpoint store');
    }
    return served;
  };
  const tablesOf = (storage: CheckpointStorageNames) =>
    postgresCheckpointTables(postgresCheckpointSchemaName(MAIN_SCHEMA, storage));

  return {
    name: 'postgres',

    async setup() {
      await base.setup();
      pool = new Pool({ connectionString: database.uri, max: 2 });
    },

    async teardown() {
      await pool?.end();
      pool = undefined;
      await base.teardown();
    },

    async reset() {
      await base.reset();
      const { rows } = await sql().query<{ schema: string }>(
        `SELECT nspname AS schema FROM pg_namespace WHERE nspname LIKE 'lc\\_checkpoints\\_%'`,
      );
      for (const { schema } of rows) {
        const tables = postgresCheckpointTables(schema);
        await sql().query(`TRUNCATE ${tables.checkpoints}, ${tables.blobs}, ${tables.writes}`);
      }
    },

    store,

    disconnectedStore: () => createPostgresDataStoreBackend().getCheckpointStore(),

    async seedCheckpointRows(storage, kind, rows) {
      if (rows.length === 0) {
        return;
      }
      await store().createSaver({ ...storage, ttlSeconds: 86_400 });
      const tables = tablesOf(storage);
      for (const row of rows) {
        if (kind === 'checkpoints') {
          await sql().query(
            `INSERT INTO ${tables.checkpoints} (thread_id, checkpoint_ns, checkpoint_id, checkpoint, lc_owner)
              VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
            [row.thread_id, row.checkpoint_ns, row.checkpoint_id, row.lc_owner ?? null],
          );
        } else {
          await sql().query(
            `INSERT INTO ${tables.writes}
                (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob, lc_owner)
              VALUES ($1, $2, $3, 'seed', $4, 'seed', 'json', '\\x'::bytea, $5)`,
            [
              row.thread_id,
              row.checkpoint_ns,
              row.checkpoint_id,
              (slot += 1),
              row.lc_owner ?? null,
            ],
          );
        }
      }
    },

    async readCheckpointRows(storage, kind) {
      const tables = tablesOf(storage);
      const table = kind === 'checkpoints' ? tables.checkpoints : tables.writes;
      const exists = await sql().query<{ exists: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        [table],
      );
      if (!exists.rows[0]?.exists) {
        return [];
      }
      const { rows } = await sql().query<CheckpointIdentityRow & { lc_owner: string | null }>(
        `SELECT thread_id, checkpoint_ns, checkpoint_id, lc_owner FROM ${table}`,
      );
      return rows.map(({ thread_id, checkpoint_ns, checkpoint_id, lc_owner }) => ({
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        ...(lc_owner == null ? {} : { lc_owner }),
      }));
    },

    seedRaw: (collection, records) => base.seedRaw(collection, records),
    readRaw: (collection) => base.readRaw(collection),
    generateId: () => postgresStoreIds.generate(),
  };
}

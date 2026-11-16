/* eslint-disable jest/valid-title, jest/valid-describe-callback, jest/no-disabled-tests -- `describePostgres` forwards a suite's own title and body to `describe` (or `describe.skip`
   when no server is available), which the rules cannot see through. */
/**
 * Jest helpers for the PostgreSQL specs (docs/postgres-port/PHASE4.md §6, "Test server"):
 *
 * ```ts
 * describePostgres('my store on PostgreSQL', () => {
 *   const database = usePostgresTestDatabase();
 *   it('...', async () => {
 *     await sql`...`.execute(database.kysely());
 *   });
 * });
 * ```
 *
 * - `describePostgres` is `describe` when a server is available (`POSTGRES_TEST_URI`, or the
 *   server binaries for a temporary cluster), and `describe.skip` with a warning otherwise. With
 *   `REQUIRE_POSTGRES_TESTS=true` (CI) an unavailable server fails the suite instead.
 * - `usePostgresTestDatabase` gives the suite its own database, copied from one of the run's two
 *   templates before the suite's tests and dropped after them, with pools and Kysely instances
 *   that are closed after them too: `{ template: 'migrated' }` copies the template the package's
 *   migrations were applied to (the whole PostgreSQL schema, ready for the stores), the default
 *   (`'empty'`) an empty database (for specs that create their own tables or replay the
 *   migrations, as the foundation's and the generator's specs do). `truncateAll()` empties every
 *   table between tests.
 *
 * Under the package's Jest config the server is shared by the whole run: the global setup
 * (`jest.postgres.mjs`) creates a run directory, the first suite needing PostgreSQL starts the
 * server there (so runs with no PostgreSQL spec start nothing and cost nothing), and the global
 * teardown stops it. Without that global setup (another Jest config), each suite starts and
 * stops a server of its own.
 */
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { PostgresKysely, PostgresTables } from '~/adapters/postgres/types';
import type { OpenPostgresTestDatabase, PostgresTestDatabaseOptions } from './database';
import type { PostgresTestServer } from './server';
import { createPostgresPool } from '~/adapters/postgres/connection';
import { openPostgresTestDatabase } from './database';
import { withClient, quoteIdentifier, getPostgresTestAvailability } from './server';

export { getPostgresTestAvailability, findPostgresBinDir } from './server';
export type { PostgresTestServer, PostgresTestAvailability } from './server';
export { openPostgresTestDatabase } from './database';
export type {
  PostgresTestTemplate,
  OpenPostgresTestDatabase,
  PostgresTestDatabaseOptions,
} from './database';

/** Whether an unavailable server fails the PostgreSQL suites instead of skipping them. */
export const POSTGRES_TESTS_REQUIRED: boolean = process.env.REQUIRE_POSTGRES_TESTS === 'true';

let warned = false;

/**
 * `describe` for a suite that needs PostgreSQL: skipped with a warning when no server is
 * available, unless `REQUIRE_POSTGRES_TESTS=true`, which fails it with the reason.
 */
export function describePostgres(name: string, fn: () => void): void {
  const availability = getPostgresTestAvailability();
  if (availability.available) {
    describe(name, fn);
    return;
  }
  if (POSTGRES_TESTS_REQUIRED) {
    describe(name, () => {
      beforeAll(() => {
        throw new Error(`REQUIRE_POSTGRES_TESTS=true, but ${availability.reason}`);
      });
      fn();
    });
    return;
  }
  if (!warned) {
    warned = true;
    console.warn(`[postgres tests] Skipping the PostgreSQL specs: ${availability.reason}`);
  }
  describe.skip(name, fn);
}

/** A suite's database, available from its `beforeAll` on. */
export interface PostgresTestDatabase {
  /** The database's name. */
  readonly name: string;
  /** The connection URI of the database. */
  readonly uri: string;
  /** The server it lives on. */
  readonly server: PostgresTestServer;
  /**
   * The environment the PostgreSQL connection reads (`POSTGRES_URI` on this database), merged
   * with `extra`.
   */
  env(extra?: Record<string, string>): Record<string, string>;
  /** A new `pg` pool on the database (closed after the suite). */
  pool(options?: { max?: number }): Pool;
  /** A new Kysely instance on the database (destroyed after the suite). */
  kysely(options?: { max?: number }): PostgresKysely;
  /**
   * Truncates every table of the database (every schema but the system ones) except the
   * migration tables (`kysely_migration`, `kysely_migration_lock`), so the migration level stays.
   */
  truncateAll(): Promise<void>;
}

/**
 * Gives the current `describe` block its own database (created in `beforeAll`, dropped in
 * `afterAll`). Read its members inside hooks and tests, not while the suite is collected.
 */
export function usePostgresTestDatabase(
  options: PostgresTestDatabaseOptions = {},
): PostgresTestDatabase {
  let database: OpenPostgresTestDatabase | undefined;
  const closers: Array<() => Promise<void>> = [];

  const ready = (): OpenPostgresTestDatabase => {
    if (!database) {
      throw new Error('The PostgreSQL test database is only available inside hooks and tests');
    }
    return database;
  };
  const uri = () => ready().uri;

  beforeAll(async () => {
    database = await openPostgresTestDatabase(options);
  }, 180_000);

  afterAll(async () => {
    for (const close of closers.splice(0).reverse()) {
      await close().catch(() => undefined);
    }
    await database?.drop();
    database = undefined;
  }, 60_000);

  const openPool = (max?: number): Pool =>
    createPostgresPool({ uri: uri(), schema: 'public', poolMax: max, autoMigrate: true });

  return {
    get name() {
      return ready().name;
    },
    get uri() {
      return uri();
    },
    get server() {
      return ready().server;
    },
    env: (extra = {}) => ({ POSTGRES_URI: uri(), ...extra }),
    pool: (options = {}) => {
      const pool = openPool(options.max);
      closers.push(() => pool.end());
      return pool;
    },
    kysely: (options = {}) => {
      const db = new Kysely<PostgresTables>({
        dialect: new PostgresDialect({ pool: openPool(options.max) }),
      });
      closers.push(() => db.destroy());
      return db;
    },
    truncateAll: async () => {
      await withClient(uri(), async (client) => {
        const { rows } = await client.query<{ schemaname: string; tablename: string }>(
          `SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
             AND schemaname NOT LIKE 'pg\\_%'
             AND tablename NOT IN ('kysely_migration', 'kysely_migration_lock')`,
        );
        if (rows.length > 0) {
          const tables = rows.map(
            (row) => `${quoteIdentifier(row.schemaname)}.${quoteIdentifier(row.tablename)}`,
          );
          await client.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
        }
      });
    },
  };
}

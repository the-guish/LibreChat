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
 * - `usePostgresTestDatabase` gives the suite its own database, copied from the run's migrated
 *   template before the suite's tests and dropped after them, with pools and Kysely instances
 *   that are closed after them too. `truncateAll()` resets it between tests.
 *
 * Under the package's Jest config the server is shared by the whole run: the global setup
 * (`jest.postgres.mjs`) creates a run directory, the first suite needing PostgreSQL starts the
 * server there (so runs with no PostgreSQL spec start nothing and cost nothing), and the global
 * teardown stops it. Without that global setup (another Jest config), each suite starts and
 * stops a server of its own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { PostgresKysely, PostgresTables } from '~/adapters/postgres/types';
import type { PostgresTestServer } from './server';
import { createPostgresPool } from '~/adapters/postgres/connection';
import {
  withClient,
  withDatabase,
  quoteIdentifier,
  stopPostgresTestServer,
  startPostgresTestServer,
  POSTGRES_TEST_RUN_DIR_ENV,
  getPostgresTestAvailability,
  acquireSharedPostgresTestServer,
} from './server';

export { getPostgresTestAvailability, findPostgresBinDir } from './server';
export type { PostgresTestServer, PostgresTestAvailability } from './server';

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
  /** Truncates every table of the `public` schema but the migration tables. */
  truncateAll(): Promise<void>;
}

let databaseCounter = 0;

/** A run directory of this process, for suites run without the global setup. */
function createPrivateRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-pg-run-'));
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }));
  return dir;
}

/**
 * Gives the current `describe` block its own database (created in `beforeAll`, dropped in
 * `afterAll`). Read its members inside hooks and tests, not while the suite is collected.
 */
export function usePostgresTestDatabase(): PostgresTestDatabase {
  let server: PostgresTestServer | undefined;
  let name: string | undefined;
  let privateRunDir: string | undefined;
  const closers: Array<() => Promise<void>> = [];

  const ready = (): { server: PostgresTestServer; name: string } => {
    if (!server || !name) {
      throw new Error('The PostgreSQL test database is only available inside hooks and tests');
    }
    return { server, name };
  };
  const uri = () => {
    const current = ready();
    return withDatabase(current.server.adminUri, current.name);
  };

  beforeAll(async () => {
    const sharedRunDir = process.env[POSTGRES_TEST_RUN_DIR_ENV];
    if (sharedRunDir) {
      server = await acquireSharedPostgresTestServer(sharedRunDir);
    } else {
      privateRunDir = createPrivateRunDir();
      server = await startPostgresTestServer(privateRunDir);
    }
    const worker = process.env.JEST_WORKER_ID ?? '0';
    databaseCounter += 1;
    const database = `${server.databasePrefix}${worker}_${databaseCounter}`;
    await withClient(server.adminUri, (client) =>
      client.query(
        `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE ${quoteIdentifier(server!.templateDatabase)}`,
      ),
    );
    name = database;
  }, 180_000);

  afterAll(async () => {
    for (const close of closers.splice(0).reverse()) {
      await close().catch(() => undefined);
    }
    if (server && name) {
      const database = name;
      await withClient(server.adminUri, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`),
      ).catch(() => undefined);
    }
    if (privateRunDir) {
      await stopPostgresTestServer(privateRunDir);
    }
    server = undefined;
    name = undefined;
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
        const { rows } = await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
             AND tablename NOT IN ('kysely_migration', 'kysely_migration_lock')`,
        );
        if (rows.length > 0) {
          await client.query(
            `TRUNCATE ${rows.map((row) => quoteIdentifier(row.tablename)).join(', ')} CASCADE`,
          );
        }
      });
    },
  };
}

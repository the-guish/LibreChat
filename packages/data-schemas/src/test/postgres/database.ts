/**
 * A test database on the PostgreSQL test server, opened and dropped by the caller (the
 * imperative half of `usePostgresTestDatabase`, which wraps it in `beforeAll`/`afterAll`; and of
 * `createTestDataStore()`, docs/postgres-port/PHASE4.md §7 item 5). Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * The server is the run's shared one when the Jest global setup created a run directory
 * (`LIBRECHAT_POSTGRES_TEST_RUN_DIR`: data-schemas' `jest.postgres.mjs`, or the PostgreSQL Jest
 * configs of the other packages), otherwise a server of the database's own (`POSTGRES_TEST_URI`,
 * or a temporary cluster), stopped again by `drop`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PostgresTestServer } from './server';
import {
  withClient,
  withDatabase,
  quoteIdentifier,
  stopPostgresTestServer,
  startPostgresTestServer,
  POSTGRES_TEST_RUN_DIR_ENV,
  acquireSharedPostgresTestServer,
} from './server';

/** Which template a test database is copied from. */
export type PostgresTestTemplate = 'empty' | 'migrated';

/** Options of {@link openPostgresTestDatabase}. */
export interface PostgresTestDatabaseOptions {
  /**
   * `migrated`: a copy of the template the package's migrations were applied to (every table of
   * the PostgreSQL schema). `empty` (the default): an empty database.
   */
  template?: PostgresTestTemplate;
}

/** An open test database. */
export interface OpenPostgresTestDatabase {
  /** The database's name. */
  readonly name: string;
  /** The connection URI of the database. */
  readonly uri: string;
  /** The server it lives on. */
  readonly server: PostgresTestServer;
  /**
   * Drops the database (closing every connection to it) and, when the database started a server
   * of its own, stops that server. Safe to call more than once.
   */
  drop(): Promise<void>;
}

let databaseCounter = 0;

/** A run directory of this process, for databases opened without the global setup. */
function createPrivateRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-pg-run-'));
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }));
  return dir;
}

/**
 * Creates `<prefix><worker>_<n>` from one of the run's templates (starting or locating the server
 * first) and resolves once it can be connected to.
 */
export async function openPostgresTestDatabase(
  options: PostgresTestDatabaseOptions = {},
): Promise<OpenPostgresTestDatabase> {
  const template = options.template ?? 'empty';
  const sharedRunDir = process.env[POSTGRES_TEST_RUN_DIR_ENV];
  let privateRunDir: string | undefined;
  let server: PostgresTestServer;
  if (sharedRunDir) {
    server = await acquireSharedPostgresTestServer(sharedRunDir);
  } else {
    privateRunDir = createPrivateRunDir();
    try {
      server = await startPostgresTestServer(privateRunDir);
    } catch (error) {
      await stopPostgresTestServer(privateRunDir);
      throw error;
    }
  }

  const worker = process.env.JEST_WORKER_ID ?? '0';
  databaseCounter += 1;
  const name = `${server.databasePrefix}${worker}_${databaseCounter}`;
  const stopPrivateServer = async () => {
    if (privateRunDir) {
      const dir = privateRunDir;
      privateRunDir = undefined;
      await stopPostgresTestServer(dir);
    }
  };
  try {
    await withClient(server.adminUri, (client) =>
      client.query(
        `CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE ${quoteIdentifier(
          template === 'migrated' ? server.templateDatabase : server.emptyTemplateDatabase,
        )}`,
      ),
    );
  } catch (error) {
    await stopPrivateServer();
    throw error;
  }

  let dropped = false;
  return {
    name,
    uri: withDatabase(server.adminUri, name),
    server,
    async drop() {
      if (dropped) {
        return;
      }
      dropped = true;
      await withClient(server.adminUri, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`),
      ).catch(() => undefined);
      await stopPrivateServer();
    },
  };
}

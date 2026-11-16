/**
 * The PostgreSQL test server (docs/postgres-port/PHASE4.md §6, "Test server"): the server the
 * PostgreSQL specs run against, and the template database every suite database is copied from.
 *
 * - With `POSTGRES_TEST_URI` (CI: the `postgres:15`/`postgres:16` service containers) that server
 *   is used; the URI names the maintenance database the harness creates databases from.
 * - Otherwise a temporary cluster: `initdb` into a new directory under the OS temp directory
 *   (`--auth=trust --encoding=UTF8 --locale=C`, run as the `postgres` user through
 *   `runuser -u postgres --` when the process is root, since `initdb` refuses root), then
 *   `postgres` on a free port of 127.0.0.1 with durability off (`fsync`, `synchronous_commit`,
 *   `full_page_writes`). The binaries come from `POSTGRES_TEST_BIN_DIR`, else the newest
 *   `/usr/lib/postgresql/<version>/bin`, else `PATH`.
 * - Once started, the package's migrations are applied to a template database
 *   (`<prefix>template`), and each suite gets `CREATE DATABASE <prefix><worker>_<n> TEMPLATE
 *   <prefix>template` (about 100 ms). Every database of a run shares the run's prefix
 *   (`lc_t_<run id>_`), so runs sharing one server never collide.
 *
 * A run's state lives in a run directory: `cleanup.json` says how to undo what was started (the
 * `pg_ctl stop` command, the directories to remove, the database prefix to drop on an external
 * server), `server.json` describes the ready server, `error.json` a failed start. The Jest
 * global setup and teardown (`jest.postgres.mjs` at the package root) create that directory and
 * apply `cleanup.json` at the end of the run; the formats are shared with it.
 */
import fs from 'node:fs';
import net from 'node:net';
import { Client } from 'pg';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Kysely, PostgresDialect } from 'kysely';
import type { PostgresTables } from '~/adapters/postgres/types';
import { migratePostgresToLatest } from '~/adapters/postgres/migrator';
import { createPostgresPool } from '~/adapters/postgres/connection';

/** The environment variable naming the run directory (set by the Jest global setup). */
export const POSTGRES_TEST_RUN_DIR_ENV = 'LIBRECHAT_POSTGRES_TEST_RUN_DIR';

/** What `cleanup.json` holds: how to undo what a run started. Read by `jest.postgres.mjs`. */
export interface PostgresTestCleanup {
  /** The command stopping the run's temporary cluster (argv), when it started one. */
  stop?: string[];
  /** Directories to remove once the cluster is stopped. */
  removeDirs?: string[];
  /** On an external server: drop every database whose name starts with `prefix`. */
  dropDatabases?: { adminUri: string; prefix: string };
}

/** A started (or located) test server: what `server.json` holds. */
export interface PostgresTestServer {
  kind: 'external' | 'temporary';
  /** A URI of the maintenance database, for creating and dropping databases. */
  adminUri: string;
  /** The prefix of every database the run creates. */
  databasePrefix: string;
  /** The migrated template database the suite databases are copied from. */
  templateDatabase: string;
  /** The server's major version. */
  majorVersion: number;
}

/** Whether the specs can reach a PostgreSQL server, and why not. */
export type PostgresTestAvailability = { available: true } | { available: false; reason: string };

const isRoot = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The directory holding `initdb`, `pg_ctl` and `postgres`, or `undefined`. */
export function findPostgresBinDir(): string | undefined {
  const hasBinaries = (dir: string) =>
    ['initdb', 'pg_ctl', 'postgres'].every((name) => isExecutable(path.join(dir, name)));
  const configured = process.env.POSTGRES_TEST_BIN_DIR;
  if (configured) {
    return hasBinaries(configured) ? configured : undefined;
  }
  const debianRoot = '/usr/lib/postgresql';
  try {
    const versions = fs
      .readdirSync(debianRoot)
      .filter((entry) => /^\d+$/.test(entry))
      .sort((a, b) => Number(b) - Number(a));
    for (const version of versions) {
      const dir = path.join(debianRoot, version, 'bin');
      if (hasBinaries(dir)) {
        return dir;
      }
    }
  } catch {
    /* not a Debian layout */
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && hasBinaries(dir)) {
      return dir;
    }
  }
  return undefined;
}

let availability: PostgresTestAvailability | undefined;

/**
 * Whether a server is available, decided without starting one (so suites can choose `describe`
 * or `describe.skip` while Jest collects them): `POSTGRES_TEST_URI` is set, or the binaries are
 * installed and, as root, `runuser` and a `postgres` user exist.
 */
export function getPostgresTestAvailability(): PostgresTestAvailability {
  if (availability) {
    return availability;
  }
  if (process.env.POSTGRES_TEST_URI) {
    availability = { available: true };
  } else if (!findPostgresBinDir()) {
    availability = {
      available: false,
      reason:
        'no PostgreSQL server: set POSTGRES_TEST_URI, or install the server binaries (initdb, pg_ctl, postgres; POSTGRES_TEST_BIN_DIR names their directory)',
    };
  } else if (isRoot() && spawnSync('id', ['-u', 'postgres'], { stdio: 'ignore' }).status !== 0) {
    availability = {
      available: false,
      reason: 'running as root, which initdb refuses, and there is no "postgres" user to run it as',
    };
  } else if (isRoot() && spawnSync('runuser', ['--help'], { stdio: 'ignore' }).error) {
    availability = {
      available: false,
      reason: 'running as root, which initdb refuses, and runuser is not installed',
    };
  } else {
    availability = { available: true };
  }
  return availability;
}

/** `argv` run as the `postgres` user when the process is root. */
function asPostgresUser(argv: string[]): string[] {
  return isRoot() ? ['runuser', '-u', 'postgres', '--', ...argv] : argv;
}

function run(argv: string[], cwd: string): void {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(
      `PostgreSQL test server: \`${argv.join(' ')}\` failed (${result.error?.message ?? `exit ${result.status}`})${output ? `:\n${output}` : ''}`,
    );
  }
}

/** A free TCP port on 127.0.0.1 (released before it is used, so a start can still race). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** `uri` with its database replaced by `database`. */
export function withDatabase(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/** Double-quotes an identifier for SQL. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Runs `fn` with a client on `uri`, closed afterwards. */
export async function withClient<T>(uri: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: uri });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Starts a temporary cluster under `runDir`; records how to stop it in `cleanup.json`. */
async function startTemporaryCluster(runDir: string): Promise<string> {
  const binDir = findPostgresBinDir();
  if (!binDir) {
    throw new Error('PostgreSQL test server: the server binaries are not installed');
  }
  const root = fs.mkdtempSync(path.join(runDir, 'cluster-'));
  const dataDir = path.join(root, 'data');
  if (isRoot()) {
    const ids = spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' });
    const groups = spawnSync('id', ['-g', 'postgres'], { encoding: 'utf8' });
    fs.chownSync(root, Number(ids.stdout.trim()), Number(groups.stdout.trim()));
  }
  const cleanup: PostgresTestCleanup = {
    stop: asPostgresUser([
      path.join(binDir, 'pg_ctl'),
      '-D',
      dataDir,
      '-m',
      'immediate',
      '-w',
      'stop',
    ]),
    removeDirs: [root],
  };
  run(
    asPostgresUser([
      path.join(binDir, 'initdb'),
      '-D',
      dataDir,
      '--auth=trust',
      '--encoding=UTF8',
      '--locale=C',
      '--username=postgres',
      '--no-sync',
    ]),
    root,
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    try {
      writeJson(path.join(runDir, 'cleanup.json'), cleanup);
      run(
        asPostgresUser([
          path.join(binDir, 'pg_ctl'),
          '-D',
          dataDir,
          '-l',
          path.join(root, 'server.log'),
          '-w',
          '-t',
          '60',
          '-o',
          [
            `-p ${port}`,
            `-k ${root}`,
            '-c listen_addresses=127.0.0.1',
            '-c fsync=off',
            '-c synchronous_commit=off',
            '-c full_page_writes=off',
            '-c max_connections=300',
          ].join(' '),
          'start',
        ]),
        root,
      );
      return `postgresql://postgres@127.0.0.1:${port}/postgres`;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Starts (or locates) the server for a run whose state lives in `runDir`, and migrates the
 * template database. Writes `cleanup.json` before anything can be left behind.
 */
export async function startPostgresTestServer(runDir: string): Promise<PostgresTestServer> {
  const runId = randomBytes(4).toString('hex');
  const databasePrefix = `lc_t_${runId}_`;
  const templateDatabase = `${databasePrefix}template`;
  const externalUri = process.env.POSTGRES_TEST_URI;

  let adminUri: string;
  if (externalUri) {
    adminUri = externalUri;
    writeJson(path.join(runDir, 'cleanup.json'), {
      dropDatabases: { adminUri, prefix: databasePrefix },
    } satisfies PostgresTestCleanup);
  } else {
    adminUri = await startTemporaryCluster(runDir);
  }

  const majorVersion = await withClient(adminUri, async (client) => {
    await client.query(`CREATE DATABASE ${quoteIdentifier(templateDatabase)}`);
    const { rows } = await client.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    return Math.floor(Number(rows[0].version) / 10000);
  });

  const pool = createPostgresPool({
    uri: withDatabase(adminUri, templateDatabase),
    schema: 'public',
    poolMax: 1,
    autoMigrate: true,
  });
  const db = new Kysely<PostgresTables>({ dialect: new PostgresDialect({ pool }) });
  try {
    await migratePostgresToLatest(db);
  } finally {
    await db.destroy();
  }

  return {
    kind: externalUri ? 'external' : 'temporary',
    adminUri,
    databasePrefix,
    templateDatabase,
    majorVersion,
  };
}

/**
 * Undoes what `runDir`'s `cleanup.json` lists: stops the cluster, drops the run's databases on
 * an external server, removes the directories. The same steps as `jest.postgres.mjs`.
 */
export async function stopPostgresTestServer(runDir: string): Promise<void> {
  const cleanup = readJson<PostgresTestCleanup>(path.join(runDir, 'cleanup.json'));
  if (cleanup?.stop) {
    spawnSync(cleanup.stop[0], cleanup.stop.slice(1), { stdio: 'ignore', cwd: '/' });
  }
  if (cleanup?.dropDatabases) {
    const { adminUri, prefix } = cleanup.dropDatabases;
    await withClient(adminUri, async (client) => {
      const { rows } = await client.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE starts_with(datname, $1)',
        [prefix],
      );
      for (const { datname } of rows) {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(datname)} WITH (FORCE)`);
      }
    }).catch(() => undefined);
  }
  for (const dir of cleanup?.removeDirs ?? []) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(runDir, { recursive: true, force: true });
}

const POLL_MS = 100;
const WAIT_MS = 180_000;

/**
 * The server shared by every suite of the run whose directory is `runDir`: the first suite to
 * ask starts it (holding the `starting` lock directory), the others wait for its `server.json`
 * (or its `error.json`, and then fail the same way).
 */
export async function acquireSharedPostgresTestServer(runDir: string): Promise<PostgresTestServer> {
  const serverFile = path.join(runDir, 'server.json');
  const errorFile = path.join(runDir, 'error.json');
  const lockDir = path.join(runDir, 'starting');
  const deadline = Date.now() + WAIT_MS;

  for (;;) {
    const server = readJson<PostgresTestServer>(serverFile);
    if (server) {
      return server;
    }
    const failure = readJson<{ message: string }>(errorFile);
    if (failure) {
      throw new Error(failure.message);
    }
    let holdsLock = false;
    try {
      fs.mkdirSync(lockDir);
      holdsLock = true;
    } catch {
      /* another suite is starting it */
    }
    if (holdsLock) {
      try {
        const started = await startPostgresTestServer(runDir);
        writeJson(serverFile, started);
        return started;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJson(errorFile, { message });
        throw error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`PostgreSQL test server: timed out waiting for ${serverFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

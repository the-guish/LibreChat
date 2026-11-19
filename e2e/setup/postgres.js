/**
 * PostgreSQL for the e2e test server (docs/postgres-port/PHASE4.md §7, E1), used by
 * `start-server.js` and `start-server-cluster.js` when `E2E_DATABASE_BACKEND=postgres`
 * (the default, `mongo`, never loads this module's PostgreSQL half).
 *
 * - With `POSTGRES_URI` set, the server uses that database as it is.
 * - Otherwise a new, empty database on the PostgreSQL test server of
 *   `@librechat/data-schemas/testing` (the server of `POSTGRES_TEST_URI` when set, else a
 *   temporary cluster), which the LibreChat server migrates on boot as a fresh deployment does.
 *   Playwright stops its web servers with SIGKILL, which never reaches a cleanup handler, and
 *   `pg_ctl` detaches the cluster from the process group, so a detached reaper
 *   (`postgres-reaper.js`) stops the cluster (or drops the database) once this process is gone.
 *
 * The runtime env file then carries `DATABASE_BACKEND=postgres` and `POSTGRES_URI` (plus
 * `POSTGRES_SCHEMA` when set) for the spec helpers (`specs/mock/db.ts`) and the global teardown
 * (`cleanupUser.ts`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REAPER_PATH = path.resolve(__dirname, 'postgres-reaper.js');
const PASSED_THROUGH = ['POSTGRES_SCHEMA'];

/** `E2E_DATABASE_BACKEND`: `mongo` (default) or `postgres` (as `setup/database.ts`). */
function getE2EDatabaseBackend() {
  const value = (process.env.E2E_DATABASE_BACKEND ?? '').trim().toLowerCase();
  if (value === '' || value === 'mongo') {
    return 'mongo';
  }
  if (value === 'postgres') {
    return 'postgres';
  }
  throw new Error(
    `E2E_DATABASE_BACKEND must be mongo or postgres, received ${process.env.E2E_DATABASE_BACKEND}`,
  );
}

/** What the runtime env file holds on PostgreSQL. */
function getPostgresRuntimeEnv() {
  const env = {
    E2E_DATABASE_BACKEND: 'postgres',
    DATABASE_BACKEND: 'postgres',
    POSTGRES_URI: process.env.POSTGRES_URI,
  };
  for (const key of PASSED_THROUGH) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/** Starts the detached process that cleans `runDir` up once this process has exited. */
function startReaper(runDir) {
  const reaper = spawn(process.execPath, [REAPER_PATH, String(process.pid), runDir], {
    cwd: path.resolve(__dirname, '../..'),
    detached: true,
    stdio: 'ignore',
  });
  reaper.unref();
  return reaper;
}

/**
 * Selects PostgreSQL for this process (`DATABASE_BACKEND=postgres`) and makes `POSTGRES_URI`
 * name its database (see the module header). Resolves to `stop()`, which removes what was
 * started (nothing for a given `POSTGRES_URI`).
 */
async function startE2EPostgres() {
  process.env.DATABASE_BACKEND = 'postgres';
  if (process.env.POSTGRES_URI) {
    return { uri: process.env.POSTGRES_URI, started: false, stop: async () => undefined };
  }

  const testing = require('@librechat/data-schemas/testing');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-e2e-pg-'));
  /** The cluster's own directory, made inside, belongs to the `postgres` user (root runs). */
  fs.chmodSync(runDir, 0o755);
  startReaper(runDir);

  const runDirEnv = testing.POSTGRES_TEST_RUN_DIR_ENV;
  const previousRunDir = process.env[runDirEnv];
  process.env[runDirEnv] = runDir;
  let database;
  try {
    database = await testing.openPostgresTestDatabase({ template: 'empty' });
  } catch (error) {
    await testing.stopPostgresTestServer(runDir);
    throw error;
  } finally {
    if (previousRunDir === undefined) {
      delete process.env[runDirEnv];
    } else {
      process.env[runDirEnv] = previousRunDir;
    }
  }

  process.env.POSTGRES_URI = database.uri;
  let stopped = false;
  return {
    uri: database.uri,
    started: true,
    stop: async () => {
      if (!stopped) {
        stopped = true;
        await testing.stopPostgresTestServer(runDir);
      }
    },
  };
}

module.exports = {
  startE2EPostgres,
  getE2EDatabaseBackend,
  getPostgresRuntimeEnv,
};

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The run-level part of the PostgreSQL test harness (`src/test/postgres`), for the Jest global
 * setup and teardown. Nothing is started here: the first suite that needs PostgreSQL starts the
 * server in the run directory created below (so a run without PostgreSQL specs starts nothing),
 * and records in `cleanup.json` how to undo it; the teardown applies that record. The
 * `cleanup.json` format is `PostgresTestCleanup` in `src/test/postgres/server.ts`.
 */

/** The environment variable naming the run directory; workers inherit it. */
export const POSTGRES_TEST_RUN_DIR_ENV = 'LIBRECHAT_POSTGRES_TEST_RUN_DIR';
const RUN_DIR_PREFIX = 'librechat-pg-run-';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Stops what a run started (cluster, databases on an external server) and removes its directory. */
async function cleanupRun(runDir) {
  const cleanup = readJson(path.join(runDir, 'cleanup.json'));
  if (cleanup?.stop) {
    spawnSync(cleanup.stop[0], cleanup.stop.slice(1), { stdio: 'ignore', cwd: '/' });
  }
  if (cleanup?.dropDatabases) {
    const { adminUri, prefix } = cleanup.dropDatabases;
    try {
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: adminUri });
      await client.connect();
      try {
        const { rows } = await client.query(
          'SELECT datname FROM pg_database WHERE starts_with(datname, $1)',
          [prefix],
        );
        for (const { datname } of rows) {
          await client.query(
            `DROP DATABASE IF EXISTS "${datname.replace(/"/g, '""')}" WITH (FORCE)`,
          );
        }
      } finally {
        await client.end();
      }
    } catch (error) {
      console.warn('[postgres tests] Could not drop the test databases:', error?.message ?? error);
    }
  }
  for (const dir of cleanup?.removeDirs ?? []) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(runDir, { recursive: true, force: true });
}

/** Cleans up the runs of processes that died before their teardown (killed runs). */
async function cleanupStaleRuns() {
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(RUN_DIR_PREFIX));
  } catch {
    return;
  }
  for (const entry of entries) {
    const runDir = path.join(os.tmpdir(), entry);
    const owner = readJson(path.join(runDir, 'owner.json'));
    if (owner && typeof owner.pid === 'number' && !isAlive(owner.pid)) {
      await cleanupRun(runDir);
    }
  }
}

/** Global setup: a fresh run directory (and stale runs of dead processes cleaned up). */
export async function preparePostgresTestRun() {
  await cleanupStaleRuns();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_DIR_PREFIX));
  fs.chmodSync(runDir, 0o755);
  fs.writeFileSync(path.join(runDir, 'owner.json'), JSON.stringify({ pid: process.pid }));
  process.env[POSTGRES_TEST_RUN_DIR_ENV] = runDir;
}

/** Global teardown: stops what the run's suites started and removes the run directory. */
export async function finishPostgresTestRun() {
  const runDir = process.env[POSTGRES_TEST_RUN_DIR_ENV];
  if (runDir) {
    delete process.env[POSTGRES_TEST_RUN_DIR_ENV];
    await cleanupRun(runDir);
  }
}

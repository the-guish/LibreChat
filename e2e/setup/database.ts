/**
 * The database the mock e2e suite runs on (docs/postgres-port/PHASE4.md §7, E1):
 * `E2E_DATABASE_BACKEND=mongo` (the default) or `postgres`. `start-server*.js` read the same
 * variable (`./postgres.js`) and start the server on that backend; the spec helpers
 * (`specs/mock/db.ts`) and the PostgreSQL skip list (`specs/mock/postgres-skips.ts`) follow it.
 */
export type E2EDatabaseBackend = 'mongo' | 'postgres';

export function getE2EDatabaseBackend(): E2EDatabaseBackend {
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

/**
 * The PostgreSQL connection the runtime env file hands the spec helpers (`applyRuntimeEnv` copies
 * it into the worker's environment, where it stays for every later spec of that worker).
 */
const SERVER_DATABASE_ENV = ['DATABASE_BACKEND', 'POSTGRES_URI', 'POSTGRES_SCHEMA'];

/**
 * `env` without the e2e server's PostgreSQL connection, for the jest suites a spec spawns: they
 * pick their own database (MongoDB memory servers under their default config) and must neither
 * switch backends nor reach the server's database. On MongoDB nothing is removed.
 */
export function withoutServerDatabaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of SERVER_DATABASE_ENV) {
    delete result[key];
  }
  return result;
}

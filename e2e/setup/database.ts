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

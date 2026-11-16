import globalSetup from './jest.globalSetup.mjs';

/**
 * Global setup of `jest.postgres.config.mjs` (`npm run test:postgres`; docs/postgres-port/
 * PHASE4.md §8 H1): selects PostgreSQL for the run (`DATABASE_BACKEND=postgres`, and
 * `REQUIRE_POSTGRES_TESTS=true`, so a suite needing the server fails rather than skips), then the
 * package's own global setup: the run directory of the PostgreSQL test server (the first suite
 * that needs it starts it there, from this package's sources, and the teardown stops it; see
 * `jest.postgres.mjs`) and the in-memory MongoDB binary (the differential specs compare with
 * MongoDB). The workers inherit the environment set here.
 */
export default async function postgresGlobalSetup() {
  process.env.DATABASE_BACKEND = 'postgres';
  process.env.REQUIRE_POSTGRES_TESTS = 'true';
  await globalSetup();
}

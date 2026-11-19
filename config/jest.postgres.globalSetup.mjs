import {
  finishPostgresTestRun,
  preparePostgresTestRun,
  POSTGRES_TEST_RUN_DIR_ENV,
} from '../packages/data-schemas/jest.postgres.mjs';

/**
 * Global setup of the PostgreSQL Jest configs of packages/api and api (`config/jest.postgres.cjs`,
 * docs/postgres-port/PHASE4.md §8 H1), which test the built `@librechat/data-schemas`:
 *
 * - selects PostgreSQL for the run: `DATABASE_BACKEND=postgres` and `REQUIRE_POSTGRES_TESTS=true`
 *   (a suite needing the server fails rather than skips), and checks every tier-1 update against
 *   the evaluator (`POSTGRES_UPDATE_SHADOW_CHECK=true`, PHASE4.md §3.3) unless the variable is
 *   already set;
 * - points `POSTGRES_URI` at a database that does not exist, as `api/test/jestSetup.js` does with
 *   `MONGO_URI`: modules that create the server's connection at load (`api/db/connect.js`) need
 *   one, and no suite may reach a real database through it; suites reach theirs through
 *   `createTestDataStore()`;
 * - starts the run's PostgreSQL test server now (data-schemas' harness: `POSTGRES_TEST_URI`, or a
 *   temporary cluster), in a run directory shared with the workers (`jest.postgres.mjs`), and
 *   sets `POSTGRES_TEST_URI` to it when it was not set, so suites with a server logic of their
 *   own (`keyvMongo.postgres.spec.ts`) use the same server.
 *
 * The workers inherit the environment set here.
 */
export default async function globalSetup() {
  process.env.DATABASE_BACKEND = 'postgres';
  process.env.REQUIRE_POSTGRES_TESTS = 'true';
  process.env.POSTGRES_UPDATE_SHADOW_CHECK ??= 'true';
  process.env.POSTGRES_URI = 'postgresql://127.0.0.1:5432/dummy-uri';

  await preparePostgresTestRun();
  try {
    const { getPostgresTestAvailability, acquireSharedPostgresTestServer } = await import(
      '@librechat/data-schemas/testing'
    );
    const availability = getPostgresTestAvailability();
    if (!availability.available) {
      throw new Error(`test:postgres needs a PostgreSQL server: ${availability.reason}`);
    }
    const server = await acquireSharedPostgresTestServer(process.env[POSTGRES_TEST_RUN_DIR_ENV]);
    if (!process.env.POSTGRES_TEST_URI) {
      process.env.POSTGRES_TEST_URI = server.adminUri;
      process.env.LIBRECHAT_POSTGRES_TEST_URI_SET_BY_RUN = 'true';
    }
  } catch (error) {
    await finishPostgresTestRun();
    throw error;
  }
}

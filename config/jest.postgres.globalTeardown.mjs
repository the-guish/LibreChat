import { finishPostgresTestRun } from '../packages/data-schemas/jest.postgres.mjs';

/**
 * Global teardown of the PostgreSQL Jest configs of packages/api and api: stops the run's
 * PostgreSQL test server (or drops the run's databases on `POSTGRES_TEST_URI`) and removes the
 * run directory (`config/jest.postgres.globalSetup.mjs`).
 */
export default async function globalTeardown() {
  await finishPostgresTestRun();
  if (process.env.LIBRECHAT_POSTGRES_TEST_URI_SET_BY_RUN) {
    delete process.env.POSTGRES_TEST_URI;
    delete process.env.LIBRECHAT_POSTGRES_TEST_URI_SET_BY_RUN;
  }
}

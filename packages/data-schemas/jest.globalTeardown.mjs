import { finishPostgresTestRun } from './jest.postgres.mjs';

/** Stops the PostgreSQL test server the run's suites started, if any (`jest.postgres.mjs`). */
export default async function globalTeardown() {
  await finishPostgresTestRun();
}

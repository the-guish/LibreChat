import base from './jest.config.mjs';
import { createPostgresJestConfig } from '../../config/jest.postgres.cjs';

/**
 * `npm run test:postgres`: this package's suites on PostgreSQL (docs/postgres-port/PHASE4.md §8
 * H1; the rule and the checks are in `config/jest.postgres.cjs`): every no-DB suite of the CI set
 * (`test:ci`'s exclusions: integration, helper and manual specs), with `DATABASE_BACKEND=postgres`
 * against the built `@librechat/data-schemas`, plus the suites listed below. The global setup
 * starts the run's PostgreSQL test server (`POSTGRES_TEST_URI` when set, otherwise a temporary
 * cluster) before the workers start.
 */
export default createPostgresJestConfig(base, {
  rootDir: import.meta.dirname,
  globalSetup: '<rootDir>/../../config/jest.postgres.globalSetup.mjs',
  globalTeardown: '<rootDir>/../../config/jest.postgres.globalTeardown.mjs',
  testPathIgnorePatterns: [
    '\\.*integration\\.',
    '\\.*helper\\.',
    '__tests__/helpers/',
    '\\.*manual\\.spec\\.',
  ],
  /**
   * The PostgreSQL-enabled DB suites: the specs written for PostgreSQL, which must all be listed,
   * and the DB-backed suites converted to `createTestDataStore()` (H2b, H2c) once the stores they
   * touch exist on PostgreSQL.
   */
  enabled: [
    'src/acl/accessControlService.spec.ts',
    'src/cache/keyvMongo.postgres.spec.ts',
    'src/conversations/save.spec.ts',
    'src/shared-links/access.test.ts',
  ],
});

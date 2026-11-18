const base = require('./jest.config');
const { createPostgresJestConfig } = require('../config/jest.postgres.cjs');

/**
 * `npm run test:postgres`: this package's suites on PostgreSQL (docs/postgres-port/PHASE4.md §8
 * H1; the rule and the checks are in `config/jest.postgres.cjs`): every no-DB suite, with
 * `DATABASE_BACKEND=postgres` against the built `@librechat/data-schemas`, plus the suites listed
 * below. The global setup starts the run's PostgreSQL test server (`POSTGRES_TEST_URI` when set,
 * otherwise a temporary cluster) before the workers start.
 */
module.exports = createPostgresJestConfig(base, {
  rootDir: __dirname,
  globalSetup: '<rootDir>/../config/jest.postgres.globalSetup.mjs',
  globalTeardown: '<rootDir>/../config/jest.postgres.globalTeardown.mjs',
  /**
   * The PostgreSQL-enabled DB suites: the DB-backed route suites converted to
   * `createTestDataStore()` (H2a to H2d), each once the stores it touches exist on PostgreSQL.
   */
  enabled: [
    'db/indexSync.store.spec.js',
    'server/routes/__tests__/admin-config-reload.spec.js',
    'server/routes/__tests__/auth.tenant.spec.js',
    'server/routes/__tests__/grants.spec.js',
    'server/routes/__tests__/messages-delete.spec.js',
    'server/routes/__tests__/messages-tool-previews.spec.js',
    'server/routes/accessPermissions.test.js',
    'server/routes/agents/__tests__/openapi.contract.spec.js',
    'server/routes/agents/__tests__/responses.spec.js',
    'server/routes/assistants/avatar.spec.js',
    'server/routes/files/images.agents.test.js',
    'server/routes/prompts.test.js',
    'server/routes/skills.tenant.test.js',
  ],
});

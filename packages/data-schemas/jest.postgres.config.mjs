import base from './jest.config.mjs';
import { createPostgresJestConfig } from '../../config/jest.postgres.cjs';

/**
 * `npm run test:postgres`: this package's suites on PostgreSQL (docs/postgres-port/PHASE4.md §8
 * H1; the rule and the checks are in `config/jest.postgres.cjs`): every no-DB suite, with
 * `DATABASE_BACKEND=postgres` and `REQUIRE_POSTGRES_TESTS=true`, plus the suites listed below.
 * The run's PostgreSQL test server is started by the first suite that needs it
 * (`jest.postgres.mjs`): `POSTGRES_TEST_URI` when set (CI), otherwise a temporary cluster.
 */
export default createPostgresJestConfig(base, {
  rootDir: import.meta.dirname,
  globalSetup: '<rootDir>/jest.postgres.globalSetup.mjs',
  globalTeardown: '<rootDir>/jest.globalTeardown.mjs',
  /** No-DB suites that assert MongoDB is the default backend (`DATABASE_BACKEND` unset). */
  mongoDefault: {
    'src/adapters/mongo/storeDocuments.spec.ts':
      'expects getDataStoreBackend().documents to be mongoStoreDocuments',
    'src/adapters/mongo/storeIds.spec.ts': 'expects getDataStoreBackend().ids to be mongoStoreIds',
  },
  /**
   * The PostgreSQL-enabled DB suites: the specs written for PostgreSQL (the adapter's specs, the
   * contract, corpus and tenant suites with PostgreSQL runners), which must all be listed, and the
   * DB-backed suites converted to `createTestDataStore()` once their stores exist on PostgreSQL.
   */
  enabled: [
    'src/adapters/postgres/backend.spec.ts',
    'src/adapters/postgres/collection/collection.corpus.postgres.spec.ts',
    'src/adapters/postgres/collection/collection.extended.postgres.spec.ts',
    'src/adapters/postgres/collection/collection.postgres.spec.ts',
    'src/adapters/postgres/collection/collection.typed.postgres.spec.ts',
    'src/adapters/postgres/collection/concurrency.postgres.spec.ts',
    'src/adapters/postgres/collection/raw.postgres.spec.ts',
    'src/adapters/postgres/connection.spec.ts',
    'src/adapters/postgres/contractHarness.postgres.spec.ts',
    'src/adapters/postgres/deferredIndexes.spec.ts',
    'src/adapters/postgres/keyValueStore.spec.ts',
    'src/adapters/postgres/migrator.spec.ts',
    'src/adapters/postgres/query/corpusD.postgres.spec.ts',
    'src/adapters/postgres/query/explain.postgres.spec.ts',
    'src/adapters/postgres/query/jsonpath.postgres.spec.ts',
    'src/adapters/postgres/query/query.postgres.differential.spec.ts',
    'src/adapters/postgres/query/query.typed.postgres.spec.ts',
    'src/adapters/postgres/query/regex.postgres.spec.ts',
    'src/adapters/postgres/records/records.postgres.spec.ts',
    'src/adapters/postgres/schema/drift.postgres.spec.ts',
    'src/adapters/postgres/schema/functions.postgres.spec.ts',
    'src/adapters/postgres/schema/schema.postgres.spec.ts',
    'src/adapters/postgres/storeErrors.spec.ts',
    'src/adapters/postgres/storeTransactions.spec.ts',
    'src/adapters/postgres/stores/balance.contention.postgres.spec.ts',
    'src/adapters/postgres/stores/sharing.contention.postgres.spec.ts',
    'src/adapters/postgres/ttlSweeper.spec.ts',
    'src/contracts/accessRole.postgres.spec.ts',
    'src/contracts/aclEntry.postgres.spec.ts',
    'src/contracts/action.postgres.spec.ts',
    'src/contracts/agentApiKey.postgres.spec.ts',
    'src/contracts/assistant.postgres.spec.ts',
    'src/contracts/auditLog.postgres.spec.ts',
    'src/contracts/banner.postgres.spec.ts',
    'src/contracts/category.postgres.spec.ts',
    'src/contracts/chatProject.postgres.spec.ts',
    'src/contracts/configOverride.postgres.spec.ts',
    'src/contracts/conversation.agentEventActor.postgres.spec.ts',
    'src/contracts/conversation.postgres.spec.ts',
    'src/contracts/conversationImport.postgres.spec.ts',
    'src/contracts/conversationTag.postgres.spec.ts',
    'src/contracts/credentialMarker.postgres.spec.ts',
    'src/contracts/fileStorage.postgres.spec.ts',
    'src/contracts/insights.postgres.spec.ts',
    'src/contracts/keyValueStore.postgres.spec.ts',
    'src/contracts/memory.postgres.spec.ts',
    'src/contracts/message.postgres.spec.ts',
    'src/contracts/openidRefreshFlight.postgres.spec.ts',
    'src/contracts/passkey.postgres.spec.ts',
    'src/contracts/pluginAuth.postgres.spec.ts',
    'src/contracts/preset.postgres.spec.ts',
    'src/contracts/principal.postgres.spec.ts',
    'src/contracts/refreshTokenBridge.postgres.spec.ts',
    'src/contracts/resourceLock.postgres.spec.ts',
    'src/contracts/role.postgres.spec.ts',
    'src/contracts/session.postgres.spec.ts',
    'src/contracts/sharedLink.postgres.spec.ts',
    'src/contracts/smoke.postgres.spec.ts',
    'src/contracts/spendTokens.postgres.spec.ts',
    'src/contracts/subagentContent.postgres.spec.ts',
    'src/contracts/systemGrant.postgres.spec.ts',
    'src/contracts/token.postgres.spec.ts',
    'src/contracts/tokenList.postgres.spec.ts',
    'src/contracts/tokenTransaction.postgres.spec.ts',
    'src/contracts/toolApprovalGrant.postgres.spec.ts',
    'src/contracts/toolCall.postgres.spec.ts',
    'src/contracts/toolFavorite.postgres.spec.ts',
    'src/contracts/user.postgres.spec.ts',
    'src/contracts/userGroup.postgres.spec.ts',
    'src/contracts/userKey.postgres.spec.ts',
    'src/tenant/conformance.postgres.spec.ts',
    'src/test/dataStore/dataStore.postgres.spec.ts',
  ],
});

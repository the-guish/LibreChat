import { describeMCPAuthorizationFenceRetryContract } from './mcpAuthorizationFenceRetry.contract';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `MCPAuthorizationFenceRetryStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('MCPAuthorizationFenceRetryStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeMCPAuthorizationFenceRetryContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

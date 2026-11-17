import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeMCPAuthorityContract } from './mcpAuthority.contract';

/** The `MCPAuthorityStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('MCPAuthorityStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeMCPAuthorityContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

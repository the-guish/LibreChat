import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeMCPServerContract } from './mcpServer.contract';

/** The `MCPServerStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('MCPServerStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeMCPServerContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

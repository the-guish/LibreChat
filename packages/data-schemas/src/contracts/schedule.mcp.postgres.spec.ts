import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeScheduleMCPContract } from './schedule.mcp.contract';

/**
 * The `ScheduleStore` contract (MCP receipts) on PostgreSQL, on a suite database copied from the
 * migrated template.
 */
describePostgres('ScheduleStore (MCP receipts) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeScheduleMCPContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

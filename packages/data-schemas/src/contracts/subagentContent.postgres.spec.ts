import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeSubagentContentContract } from './subagentContent.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `SubagentContentStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('SubagentContentStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeSubagentContentContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

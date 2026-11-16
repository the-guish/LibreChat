import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeToolCallContract } from './toolCall.contract';

/** The `ToolCallStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ToolCallStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeToolCallContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

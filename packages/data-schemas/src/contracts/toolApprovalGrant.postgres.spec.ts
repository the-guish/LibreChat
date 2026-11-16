import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeToolApprovalGrantContract } from './toolApprovalGrant.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `ToolApprovalGrantStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ToolApprovalGrantStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeToolApprovalGrantContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

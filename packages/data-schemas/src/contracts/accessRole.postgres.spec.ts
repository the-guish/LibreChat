import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAccessRoleContract } from './accessRole.contract';

/** The `AccessRoleStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AccessRoleStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAccessRoleContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

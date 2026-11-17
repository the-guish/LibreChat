import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeUserGroupContract } from './userGroup.contract';

/** The `UserGroupStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('UserGroupStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeUserGroupContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

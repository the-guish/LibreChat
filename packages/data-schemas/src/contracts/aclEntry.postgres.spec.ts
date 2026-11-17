import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAclEntryContract } from './aclEntry.contract';

/** The `AclEntryStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AclEntryStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAclEntryContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

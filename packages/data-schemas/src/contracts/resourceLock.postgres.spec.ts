import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeResourceLockContract } from './resourceLock.contract';

/** The `ResourceLockStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ResourceLockStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeResourceLockContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeSystemGrantContract } from './systemGrant.contract';

/** The `SystemGrantStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('SystemGrantStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeSystemGrantContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

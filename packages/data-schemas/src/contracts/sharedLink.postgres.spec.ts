import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeSharedLinkContract } from './sharedLink.contract';

/** The `SharedLinkStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('SharedLinkStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeSharedLinkContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

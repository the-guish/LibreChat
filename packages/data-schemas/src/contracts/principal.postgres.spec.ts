import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describePrincipalContract } from './principal.contract';

/** The `PrincipalStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('PrincipalStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describePrincipalContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

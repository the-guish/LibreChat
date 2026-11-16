import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeConfigOverrideContract } from './configOverride.contract';

/** The `ConfigOverrideStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ConfigOverrideStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeConfigOverrideContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

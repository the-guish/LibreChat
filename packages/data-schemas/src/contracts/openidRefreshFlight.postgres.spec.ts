import { describeOpenIDRefreshFlightContract } from './openidRefreshFlight.contract';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `OpenIDRefreshFlightStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('OpenIDRefreshFlightStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeOpenIDRefreshFlightContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeBrowserSetupContract } from './browserSetup.contract';

/** The `BrowserSetupBackendStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('BrowserSetupBackendStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeBrowserSetupContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

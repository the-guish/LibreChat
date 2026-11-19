import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describePluginAuthContract } from './pluginAuth.contract';

/** The `PluginAuthStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('PluginAuthStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describePluginAuthContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeCodeEnvironmentContract } from './codeEnvironment.contract';

/** The `CodeEnvironmentStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('CodeEnvironmentStore (registry and setup) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeCodeEnvironmentContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

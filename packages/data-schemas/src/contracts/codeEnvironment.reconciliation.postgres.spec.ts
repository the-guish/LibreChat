import { describeCodeEnvironmentReconciliationContract } from './codeEnvironment.reconciliation.contract';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `CodeEnvironmentStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('CodeEnvironmentStore (reconciliation) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeCodeEnvironmentReconciliationContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

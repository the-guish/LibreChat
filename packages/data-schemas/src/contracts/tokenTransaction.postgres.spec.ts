import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeTokenTransactionContract } from './tokenTransaction.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `TokenTransactionStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('TokenTransactionStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeTokenTransactionContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

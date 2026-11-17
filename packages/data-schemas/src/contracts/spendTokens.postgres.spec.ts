import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeSpendTokensContract } from './spendTokens.contract';

/** The `SpendTokensStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('SpendTokensStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeSpendTokensContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

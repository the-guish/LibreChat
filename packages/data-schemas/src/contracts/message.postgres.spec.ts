import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeMessageContract } from './message.contract';

/** The `MessageStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('MessageStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeMessageContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

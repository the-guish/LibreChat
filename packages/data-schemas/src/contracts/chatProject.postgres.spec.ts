import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeChatProjectContract } from './chatProject.contract';

/** The `ChatProjectStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ChatProjectStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeChatProjectContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

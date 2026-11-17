import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describePromptContract } from './prompt.contract';

/** The `PromptLibraryStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('PromptLibraryStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describePromptContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

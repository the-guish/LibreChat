import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAssistantContract } from './assistant.contract';

/** The `AssistantStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AssistantStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAssistantContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

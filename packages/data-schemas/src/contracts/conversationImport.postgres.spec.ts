import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeConversationImportContract } from './conversationImport.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `ConversationImportStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ConversationImportStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeConversationImportContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeConversationTagContract } from './conversationTag.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `ConversationTagStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ConversationTagStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeConversationTagContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

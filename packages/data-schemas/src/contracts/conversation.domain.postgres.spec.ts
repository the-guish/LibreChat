import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeConversationDomainContract } from './conversation.domain.contract';

/**
 * The `ConversationStore` contract (the conversation store's domain steps and the composed
 * conversation functions (`deleteConvos` with its queued-turn and trigger delivery retirement)) on
 * PostgreSQL, on a suite database copied from the migrated template.
 */
describePostgres('ConversationStore domain steps on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeConversationDomainContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

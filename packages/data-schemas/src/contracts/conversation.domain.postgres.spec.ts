import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeConversationDomainContract } from './conversation.domain.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/**
 * The conversation store's domain steps and the composed conversation functions on PostgreSQL,
 * on a suite database copied from the migrated template.
 */
describePostgres('ConversationStore domain steps and functions on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeConversationDomainContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

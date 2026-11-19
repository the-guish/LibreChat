import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeConversationContract } from './conversation.contract';

/**
 * The `ConversationStore` contract (reads, the sidebar listing, single-field writes, the code
 * environment and lane git state) on PostgreSQL, on a suite database copied from the migrated
 * template.
 */
describePostgres('ConversationStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeConversationContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

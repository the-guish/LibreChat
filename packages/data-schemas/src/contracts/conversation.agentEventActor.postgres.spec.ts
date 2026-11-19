import { describeConversationAgentEventActorContract } from './conversation.agentEventActor.contract';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/**
 * The conversation store contract for subagent threads and event actors on PostgreSQL, on a
 * suite database copied from the migrated template.
 */
describePostgres('ConversationStore subagent threads and event actors on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeConversationAgentEventActorContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

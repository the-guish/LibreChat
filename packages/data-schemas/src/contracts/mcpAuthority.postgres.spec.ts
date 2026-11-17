import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeMCPAuthorityContract } from './mcpAuthority.contract';
import { describeWithBlockedCases } from './blockedCases';

/**
 * The `MCPAuthorityStore` contract on PostgreSQL, on a suite database copied from the migrated
 * template (the store runs its own snapshot transaction). The agent-access case removes the link
 * through the agent store, still a stand-in on PostgreSQL until S7; it is skipped until then.
 */
describePostgres('MCPAuthorityStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeWithBlockedCases(
    {
      'grants access through an agent the user may view, and loses it with the link':
        'agents.updateAgent (S7)',
    },
    () =>
      describeMCPAuthorityContract(
        createPostgresContractHarness({
          connect: async () => database.uri,
          release: async () => undefined,
        }),
      ),
  );
});

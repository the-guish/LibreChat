import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeCodeEnvironmentContract } from './codeEnvironment.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeWithBlockedCases } from './blockedCases';

/**
 * The `CodeEnvironmentStore` contract (registry and setup) on PostgreSQL, on a suite database
 * copied from the migrated template. The agent reference cases write through the agent store,
 * still a stand-in on PostgreSQL until S7; they are skipped until then.
 */
const BLOCKED_BY_AGENTS = 'agents.createAgent (S7)';

describePostgres('CodeEnvironmentStore (registry and setup) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeWithBlockedCases(
    {
      'holds a reservation on a live environment only while the agent write lasts':
        BLOCKED_BY_AGENTS,
      'lets an agent name an environment the registry does not hold (deployment config)':
        BLOCKED_BY_AGENTS,
      'refuses an agent write naming an environment being removed, pending or retired':
        BLOCKED_BY_AGENTS,
    },
    () =>
      describeCodeEnvironmentContract(
        createPostgresContractHarness({
          connect: async () => database.uri,
          release: async () => undefined,
        }),
      ),
  );
});

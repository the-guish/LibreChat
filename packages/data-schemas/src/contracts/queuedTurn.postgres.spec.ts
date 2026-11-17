import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAgentQueuedTurnContract } from './queuedTurn.contract';

/** The `AgentQueuedTurnStore` contract (queue, delivery and deletion) on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AgentQueuedTurnStore (queue, delivery and deletion) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAgentQueuedTurnContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

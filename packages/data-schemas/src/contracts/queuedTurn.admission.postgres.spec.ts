import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAgentQueuedTurnAdmissionContract } from './queuedTurn.admission.contract';

/** The `AgentQueuedTurnStore` contract (claim and admission) on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AgentQueuedTurnStore (claim and admission) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAgentQueuedTurnAdmissionContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

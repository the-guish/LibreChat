import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAgentVersionsContract } from './agent.versions.contract';

/** The `AgentStore` contract (writes and versions) on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AgentStore writes and versions on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAgentVersionsContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

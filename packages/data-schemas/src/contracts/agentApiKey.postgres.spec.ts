import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAgentApiKeyContract } from './agentApiKey.contract';

/** The `AgentApiKeyStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AgentApiKeyStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAgentApiKeyContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeRefreshTokenBridgeContract } from './refreshTokenBridge.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The `RefreshTokenBridgeStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('RefreshTokenBridgeStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeRefreshTokenBridgeContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

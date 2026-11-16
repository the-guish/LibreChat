import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeToolFavoriteContract } from './toolFavorite.contract';

/** The `ToolFavoriteStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('ToolFavoriteStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeToolFavoriteContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

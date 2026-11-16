import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeFileStorageContract } from './fileStorage.contract';

/** The `FileStorageStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('FileStorageStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeFileStorageContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

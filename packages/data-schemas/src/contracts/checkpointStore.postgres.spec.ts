import { createPostgresCheckpointContractHarness } from '~/adapters/postgres/checkpointContractHarness';
import { describeCheckpointStoreContract } from './checkpointStore.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The checkpoint store contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('CheckpointStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeCheckpointStoreContract(createPostgresCheckpointContractHarness(database));
});

import { createPostgresCheckpointContractHarness } from '~/adapters/postgres/checkpointContractHarness';
import { describeCheckpointSaverContract } from './checkpointStore.saver.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/** The checkpoint store contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('CheckpointStore saver on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeCheckpointSaverContract(createPostgresCheckpointContractHarness(database));
});

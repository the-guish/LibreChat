import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describePresetContract } from './preset.contract';

/** The `PresetStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('PresetStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describePresetContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

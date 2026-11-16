import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeContractHarnessSmoke } from './smoke.contract';

/**
 * The contract harness smoke suite on PostgreSQL (its store cases go through the banner store,
 * implemented since S3), on a suite database copied from the migrated template.
 */
describePostgres('contract harness smoke on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeContractHarnessSmoke(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

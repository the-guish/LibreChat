import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describeScheduleConsentContract } from './scheduleConsent.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/**
 * The `ScheduleConsentStore` contract on PostgreSQL, on a suite database copied from the migrated
 * template.
 */
describePostgres('ScheduleConsentStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeScheduleConsentContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeScheduleContract } from './schedule.contract';

/**
 * The `ScheduleStore` contract (schedules) on PostgreSQL, on a suite database copied from the
 * migrated template.
 */
describePostgres('ScheduleStore (schedules) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeScheduleContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

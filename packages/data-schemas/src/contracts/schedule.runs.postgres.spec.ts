import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeScheduleRunsContract } from './schedule.runs.contract';

/**
 * The `ScheduleStore` contract (runs and bookkeeping) on PostgreSQL, on a suite database copied
 * from the migrated template.
 */
describePostgres('ScheduleStore (runs and bookkeeping) on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeScheduleRunsContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

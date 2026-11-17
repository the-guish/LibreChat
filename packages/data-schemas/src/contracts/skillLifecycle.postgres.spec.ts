import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeSkillLifecycleContract } from './skillLifecycle.contract';

/** The `SkillLifecycleStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('SkillLifecycleStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeSkillLifecycleContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

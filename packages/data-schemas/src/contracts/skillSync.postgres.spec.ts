/** Test credentials, before `~/crypto` loads (side-effect import: keep it first). */
import './credentialsEnv';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeSkillSyncContract } from './skillSync.contract';

/** The `SkillSyncStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('SkillSyncStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeSkillSyncContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

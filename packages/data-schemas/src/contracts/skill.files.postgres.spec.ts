import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeSkillFilesContract } from './skill.files.contract';

/** The `SkillStore` contract for files, deletion and allowlists on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('SkillStore files on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeSkillFilesContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

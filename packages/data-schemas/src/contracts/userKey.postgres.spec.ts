/** Test credentials, before `~/crypto` loads (side-effect import: keep it first). */
import './credentialsEnv';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeUserKeyContract } from './userKey.contract';

/** The `UserKeyStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('UserKeyStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeUserKeyContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

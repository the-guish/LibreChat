/** Search on, with a MeiliSearch host and key, before the backend reads them (side-effect import: keep it first). */
import './searchSyncEnv';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { createPostgresDataStoreBackend } from '~/adapters/postgres/backend';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeSearchSyncContract } from './searchSync.contract';

/** The backend's MeiliSearch client is the in-memory fake the contract reads. */
jest.mock('meilisearch', () => jest.requireActual('./meiliFake').meilisearchModule);

/**
 * The search sync contract on PostgreSQL: the search hooks, index sync and reads of
 * `adapters/postgres/search.ts`, on a suite database copied from the migrated template.
 */
describePostgres('search sync on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const backend = createPostgresDataStoreBackend({ shadowCheck: true });
  describeSearchSyncContract(
    createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend },
    ),
    () => {
      const searchIndexSync = backend.getSearchIndexSync();
      if (!searchIndexSync) {
        throw new Error('The PostgreSQL backend serves no search index sync');
      }
      return searchIndexSync;
    },
  );
});

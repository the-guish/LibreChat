/**
 * The test data store on PostgreSQL (`./index`): a database copied from the migrated template of
 * the PostgreSQL test server (`~/test/postgres`), connected on the process's backend and the
 * process-wide connection state through the PostgreSQL contract harness (`seedRaw`, `readRaw`,
 * `reset`). Loaded only when `DATABASE_BACKEND=postgres`. Must not import `mongoose`, `mongodb` or
 * `bson` (the process's backend is reached through `~/adapters/backend`, which also holds the
 * MongoDB backend: that module loads `mongoose` without connecting it).
 */
import type { PostgresDataStoreBackend } from '~/adapters/postgres/backend';
import type { OpenPostgresTestDatabase } from '~/test/postgres/database';
import type { TestDataStore, TestDataStoreOptions } from './types';
import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { getPostgresTestAvailability } from '~/test/postgres/server';
import { openPostgresTestDatabase } from '~/test/postgres/database';
import { getDataStoreBackend } from '~/adapters/backend';
import { openTestDataStore } from './harness';

/** A test data store on a new database of the PostgreSQL test server. */
export async function createPostgresTestDataStore(
  options: TestDataStoreOptions,
): Promise<TestDataStore> {
  const backend = getDataStoreBackend() as unknown as PostgresDataStoreBackend;
  if (backend.name !== 'postgres') {
    throw new Error(
      `createTestDataStore: DATABASE_BACKEND=postgres, but the process's backend is "${backend.name}" (DATABASE_BACKEND is read once, on the first getDataStoreBackend() call)`,
    );
  }
  const availability = getPostgresTestAvailability();
  if (!availability.available) {
    throw new Error(`createTestDataStore: DATABASE_BACKEND=postgres, but ${availability.reason}`);
  }
  let database: OpenPostgresTestDatabase | undefined;
  const harness = createPostgresContractHarness(
    {
      async connect() {
        database = await openPostgresTestDatabase({ template: 'migrated' });
        return database.uri;
      },
      async release() {
        await database?.drop();
        database = undefined;
      },
    },
    { backend, processConnection: true },
  );
  return openTestDataStore(
    'postgres',
    harness,
    (deps) => backend.createMethods(deps),
    options.deps,
  );
}

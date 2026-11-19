import { describeTestDataStore } from './dataStore.cases';
import { describePostgres } from '~/test/postgres';

/** `createTestDataStore()` on PostgreSQL: a database copied from the migrated template. */
describePostgres('test data store on PostgreSQL', () => {
  describeTestDataStore('postgres');
});

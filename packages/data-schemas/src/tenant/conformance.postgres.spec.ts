import { createPostgresTenantHarness } from '~/adapters/postgres/collection/tenantHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeTenantIsolationConformance } from './conformance';

/**
 * The PostgreSQL binding's answer to the portable tenant-isolation contract
 * (docs/postgres-port/PHASE4.md §1.8): the collection primitive with the policy bound, on its own
 * schema of a suite database.
 */
describePostgres('tenant isolation on PostgreSQL', () => {
  const database = usePostgresTestDatabase();

  describeTenantIsolationConformance(
    createPostgresTenantHarness({
      name: 'postgres',
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

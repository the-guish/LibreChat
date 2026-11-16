import { createPostgresInfrastructureContractHarness } from '~/adapters/postgres/infrastructureContractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeKeyValueStoreContract } from './keyValueStore.contract';

/**
 * The key-value store contract on PostgreSQL, on a suite database copied from the migrated
 * template, through the interim infrastructure harness (the full PostgreSQL contract harness
 * comes with C1).
 */
describePostgres('key-value store on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeKeyValueStoreContract(createPostgresInfrastructureContractHarness(database));
});

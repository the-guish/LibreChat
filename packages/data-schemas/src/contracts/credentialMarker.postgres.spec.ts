import { createPostgresInfrastructureContractHarness } from '~/adapters/postgres/infrastructureContractHarness';
import { describeCredentialMarkerContract } from './credentialMarker.contract';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/**
 * The credential marker store contract on PostgreSQL, on a suite database copied from the migrated
 * template, through the interim infrastructure harness (the full PostgreSQL contract harness
 * comes with C1).
 */
describePostgres('credential marker store on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeCredentialMarkerContract(createPostgresInfrastructureContractHarness(database));
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeAuditLogContract } from './auditLog.contract';

/** The `AuditLogStore` contract on PostgreSQL, on a suite database copied from the migrated template. */
describePostgres('AuditLogStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeAuditLogContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeTriggerDeliveryPurgeContract } from './triggerDelivery.purge.contract';

/**
 * The `TriggerDeliveryStore` contract (user purge markers and recovery, deletion with queued turns,
 * conversation result erasure) on PostgreSQL, on a suite database copied from the migrated
 * template.
 */
describePostgres('TriggerDeliveryStore deletion on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeTriggerDeliveryPurgeContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

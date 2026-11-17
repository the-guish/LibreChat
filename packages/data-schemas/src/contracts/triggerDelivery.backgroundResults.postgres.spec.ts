import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeTriggerDeliveryBackgroundResultsContract } from './triggerDelivery.backgroundResults.contract';

/**
 * The `TriggerDeliveryStore` contract (pending listings, result receipts, single claims and receipt
 * batches, with the composed release of parent-message claim stamps) on PostgreSQL, on a suite
 * database copied from the migrated template.
 */
describePostgres('TriggerDeliveryStore background results on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeTriggerDeliveryBackgroundResultsContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

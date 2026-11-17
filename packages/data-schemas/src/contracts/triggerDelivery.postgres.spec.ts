import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeTriggerDeliveryContract } from './triggerDelivery.contract';

/**
 * The `TriggerDeliveryStore` contract (the queue: publication on ordering lanes, the claim and its
 * capability shield, lane order, the attempt fences and history, reads, dead letters, requeue and
 * active counts) on PostgreSQL, on a suite database copied from the migrated template.
 */
describePostgres('TriggerDeliveryStore on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeTriggerDeliveryContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeTriggerDeliveryLifecycleContract } from './triggerDelivery.lifecycle.contract';

/**
 * The `TriggerDeliveryStore` contract (retirement, producer leases, expediting and the held wake
 * marker, terminal handling, coalesced batches and the recovery sweeps) on PostgreSQL, on a suite
 * database copied from the migrated template.
 */
describePostgres('TriggerDeliveryStore lifecycle on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeTriggerDeliveryLifecycleContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

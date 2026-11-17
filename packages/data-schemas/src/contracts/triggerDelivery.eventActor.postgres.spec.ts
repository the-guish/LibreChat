import { createPostgresContractHarness } from '~/adapters/postgres/contractHarness';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { describeTriggerDeliveryEventActorContract } from './triggerDelivery.eventActor.contract';

/**
 * The `TriggerDeliveryStore` contract (admissions, detached actions and their capped history,
 * receipts, backfill and storage metrics) on PostgreSQL, on a suite database copied from the
 * migrated template.
 */
describePostgres('TriggerDeliveryStore Event Actor receipts on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  describeTriggerDeliveryEventActorContract(
    createPostgresContractHarness({
      connect: async () => database.uri,
      release: async () => undefined,
    }),
  );
});

import mongoose from 'mongoose';
import type {
  Assert,
  EveryMethodPlaced,
  ExclusionsHold,
  SameSignatures,
  Satisfies,
} from './conformance';
import type { AgentTriggerDeliveryMethods } from '~/methods/triggerDelivery';
import type { TriggerDeliveryStore } from './triggerDelivery';
import { createAgentTriggerDeliveryMethods } from '~/methods/triggerDelivery';
import { TRIGGER_DELIVERY_STORE_METHODS } from './triggerDelivery';

/**
 * Agent trigger delivery methods left out of the port: none. Every signature is copied
 * verbatim, but for owner and batch member ids typed `Types.ObjectId`, which the port states as
 * `IdLike`. The module's error classes (`AgentTriggerDeliveryConflictError`,
 * `AgentTriggerClaimContentionError`) and receipt-metric helpers are not part of the methods
 * object.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/** The port methods that take no owner or batch member ids, so the port copies them exactly. */
type ExactMethods =
  | 'ensureAgentTriggerDeliveryIndexes'
  | 'claimNextAgentTriggerDelivery'
  | 'findEarlierAgentTriggerDelivery'
  | 'releaseAgentTriggerDelivery'
  | 'beginAgentTriggerDeliveryAttempt'
  | 'deferAgentTriggerDeliveryAttempt'
  | 'completeAgentTriggerDelivery'
  | 'retryAgentTriggerDelivery'
  | 'deadLetterAgentTriggerDelivery'
  | 'retireAgentTriggerDelivery'
  | 'renewAgentTriggerDeliveryProducerLease'
  | 'getAgentTriggerDeliveryProducerLease'
  | 'settleAgentTriggerHandlingOutcome'
  | 'getAgentTriggerDelivery'
  | 'getAgentTriggerDeadLetters'
  | 'requeueAgentTriggerDelivery'
  | 'persistAgentBackgroundToolResult'
  | 'getAgentBackgroundToolResult'
  | 'getAgentBackgroundToolResultClaim'
  | 'claimAgentBackgroundToolResults'
  | 'releaseAgentBackgroundToolResultClaims'
  | 'claimAgentBackgroundToolResultBatch'
  | 'getAgentBackgroundToolResultBatch'
  | 'beginAgentBackgroundToolResultBatchDispatch'
  | 'confirmAgentBackgroundToolResultBatch'
  | 'getAgentEventActorReceiptStorageMetrics'
  | 'recoverAgentTriggerLanePublications'
  | 'recoverAgentTriggerBatchReceipts'
  | 'reclaimInactiveAgentTriggerLanes'
  | 'recoverAgentTriggerUserPurges';

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<TriggerDeliveryStore, AgentTriggerDeliveryMethods>>,
  Assert<SameSignatures<Pick<TriggerDeliveryStore, ExactMethods>, AgentTriggerDeliveryMethods>>,
  Assert<EveryMethodPlaced<TriggerDeliveryStore, AgentTriggerDeliveryMethods, Excluded>>,
  Assert<ExclusionsHold<TriggerDeliveryStore, Excluded>>,
];

describe('TriggerDeliveryStore port', () => {
  const methods = createAgentTriggerDeliveryMethods(mongoose);

  it('matches the MongoDB trigger-delivery methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(TRIGGER_DELIVERY_STORE_METHODS).size).toBe(
      TRIGGER_DELIVERY_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...TRIGGER_DELIVERY_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB trigger-delivery methods', () => {
    const store: TriggerDeliveryStore = methods;
    for (const name of TRIGGER_DELIVERY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

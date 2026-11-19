import mongoose from 'mongoose';
import type {
  Assert,
  EveryMethodPlaced,
  ExclusionsHold,
  SameSignatures,
  Satisfies,
} from './conformance';
import type { AgentQueuedTurnMethods } from '~/methods/queuedTurn';
import type { AgentQueuedTurnStore } from './queuedTurn';
import { createAgentQueuedTurnMethods } from '~/methods/queuedTurn';
import { AGENT_QUEUED_TURN_STORE_METHODS } from './queuedTurn';

/**
 * Agent queued-turn methods left out of the port: none. Every signature is copied verbatim,
 * but for the owner typed `Types.ObjectId`, which the port states as `IdLike`. The module's
 * error classes (`AgentQueuedTurnCapacityError`, `AgentQueuedTurnConflictError`,
 * `AgentQueuedTurnLaneRetiredError`) are not part of the methods object.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/** The port methods that take no owner, so the port copies them exactly. */
type OwnerlessMethods =
  | 'ensureAgentQueuedTurnIndexes'
  | 'findQueuedTurnsNeedingDelivery'
  | 'claimQueuedTurnsForAdmissionReconciliation'
  | 'markAgentQueuedTurnDeliveryRetired'
  | 'beginAgentQueuedTurnMissingDeliveryRetirement'
  | 'markAgentQueuedTurnMissingDeliveryRetired';

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AgentQueuedTurnStore, AgentQueuedTurnMethods>>,
  Assert<SameSignatures<Pick<AgentQueuedTurnStore, OwnerlessMethods>, AgentQueuedTurnMethods>>,
  Assert<EveryMethodPlaced<AgentQueuedTurnStore, AgentQueuedTurnMethods, Excluded>>,
  Assert<ExclusionsHold<AgentQueuedTurnStore, Excluded>>,
];

describe('AgentQueuedTurnStore port', () => {
  const methods = createAgentQueuedTurnMethods(mongoose);

  it('matches the MongoDB queued-turn methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(AGENT_QUEUED_TURN_STORE_METHODS).size).toBe(
      AGENT_QUEUED_TURN_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...AGENT_QUEUED_TURN_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB queued-turn methods', () => {
    const store: AgentQueuedTurnStore = methods;
    for (const name of AGENT_QUEUED_TURN_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

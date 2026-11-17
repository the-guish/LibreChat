/**
 * Fixtures shared by the `AgentQueuedTurnStore` contract suites (`queuedTurn.contract.ts`,
 * `queuedTurn.admission.contract.ts`): the scopes and inputs of the conversation under test, the
 * steps that walk a turn through publication, claim and admission through the store, and raw
 * turns for legacy and interrupted states. Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import { createHash } from 'node:crypto';
import type {
  AgentQueuedTurnRecord,
  AdmitAgentQueuedTurnResult,
  BeginAgentQueuedTurnAdmissionResult,
} from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import type {
  AgentQueuedTurnStore,
  EnqueueAgentQueuedTurnStoreInput,
  AgentQueuedTurnStoreConversationScope,
} from '~/ports/queuedTurn';
import { readRawWhere } from './support';

export const START: Date = new Date('2026-08-30T12:00:00.000Z');
export const LATER: Date = new Date(START.getTime() + 60_000);
/** The instant `ms` after `from` (by default {@link LATER}). */
export const after = (ms: number, from: Date = LATER): Date => new Date(from.getTime() + ms);

/** The lineage id of a lane's root: the response the first queued turn followed. */
export const rootLineageId = (parentMessageId: string = 'parent-1'): string =>
  `root:${createHash('sha256').update(parentMessageId).digest('base64url')}`;

/** The error a store method rejected with, or a failure when it resolved. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

/** Whether a field reads as unset (absent, or `null` where a backend stores no value). */
export const unset = (value: unknown): boolean => value === undefined || value === null;

/** A claim of the conversation's turn, as `claimNextAgentQueuedTurn` takes it. */
export type ClaimInput = Parameters<AgentQueuedTurnStore['claimNextAgentQueuedTurn']>[0];

/** The helpers of one suite. */
export interface QueuedTurnFixtures {
  turns: () => AgentQueuedTurnStore;
  newId: () => string;
  /** The conversation under test (tenant-1, conversation-1, the case's owner), `overrides` over it. */
  scope: (
    overrides?: Partial<AgentQueuedTurnStoreConversationScope>,
  ) => AgentQueuedTurnStoreConversationScope;
  enqueueInput: (
    overrides?: Partial<EnqueueAgentQueuedTurnStoreInput>,
  ) => EnqueueAgentQueuedTurnStoreInput;
  enqueue: (
    overrides?: Partial<EnqueueAgentQueuedTurnStoreInput>,
  ) => Promise<AgentQueuedTurnRecord>;
  claimInput: (queuedTurnId: string, overrides?: Partial<ClaimInput>) => ClaimInput;
  publish: (turn: AgentQueuedTurnRecord, deliveryKey: string) => Promise<void>;
  startAdmission: (
    turn: AgentQueuedTurnRecord,
    deliveryKey: string,
    extra?: { admissionProtocolVersion?: 2 },
  ) => Promise<{ claim: ClaimInput; started: BeginAgentQueuedTurnAdmissionResult }>;
  admit: (
    turn: AgentQueuedTurnRecord,
    deliveryKey: string,
    generationCreatedAt: number | undefined,
  ) => Promise<AdmitAgentQueuedTurnResult['turn']>;
  quarantine: (
    turn: AgentQueuedTurnRecord,
    deliveryKey: string,
    extra?: { admissionProtocolVersion?: 2 },
  ) => Promise<ClaimInput>;
  storedTurn: (queuedTurnId: string) => Promise<RawRecord>;
  lanes: () => Promise<RawRecord[]>;
  rawTurn: (extra?: RawRecord) => RawRecord;
  seedTurns: (...records: RawRecord[]) => Promise<void>;
}

/** The fixtures of a suite whose current owner `getUser` returns (a new one per case). */
export function queuedTurnFixtures(
  harness: ContractHarness,
  getUser: () => string,
): QueuedTurnFixtures {
  const turns = () => harness.createStores().agentQueuedTurns;
  const newId = () => harness.ids.generate();
  let counter = 0;

  const scope = (
    overrides: Partial<AgentQueuedTurnStoreConversationScope> = {},
  ): AgentQueuedTurnStoreConversationScope => ({
    user: getUser(),
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    ...overrides,
  });
  const enqueueInput = (
    overrides: Partial<EnqueueAgentQueuedTurnStoreInput> = {},
  ): EnqueueAgentQueuedTurnStoreInput => ({
    ...scope(),
    agentId: 'agent-1',
    parentMessageId: 'parent-1',
    clientRequestId: `request-${++counter}`,
    text: 'follow up',
    availableAt: START,
    ...overrides,
  });
  const enqueue = async (overrides: Partial<EnqueueAgentQueuedTurnStoreInput> = {}) =>
    (await turns().enqueueAgentQueuedTurn(enqueueInput(overrides))).turn;
  const claimInput = (queuedTurnId: string, overrides: Partial<ClaimInput> = {}): ClaimInput => ({
    ...scope(),
    queuedTurnId,
    claimId: 'claim-1',
    claimBy: 'worker-1',
    now: START,
    leaseUntil: LATER,
    ...overrides,
  });
  /** Reserves and publishes the turn's delivery `deliveryKey`. */
  const publish = async (turn: AgentQueuedTurnRecord, deliveryKey: string) => {
    const target = {
      ...scope({ conversationId: turn.conversationId, tenantId: turn.tenantId }),
      queuedTurnId: turn.queuedTurnId,
      deliveryKey,
    };
    await turns().reserveAgentQueuedTurnDelivery(target);
    await turns().markQueuedTurnScheduled({ ...target, scheduledAt: START });
  };
  /** Publishes, claims (the claim id is the delivery key) and starts the turn's admission. */
  const startAdmission = async (
    turn: AgentQueuedTurnRecord,
    deliveryKey: string,
    extra: { admissionProtocolVersion?: 2 } = {},
  ) => {
    await publish(turn, deliveryKey);
    const claim = claimInput(turn.queuedTurnId, {
      claimId: deliveryKey,
      conversationId: turn.conversationId,
      tenantId: turn.tenantId,
    });
    expect((await turns().claimNextAgentQueuedTurn(claim)).outcome).toBe('acquired');
    const started = await turns().beginAgentQueuedTurnAdmission({
      ...claim,
      admissionId: deliveryKey,
      startedAt: START,
      ...extra,
    });
    expect(started.outcome).toBe('started');
    return { claim, started };
  };
  /** Starts and settles the turn's admission with generation `generationCreatedAt`. */
  const admit = async (
    turn: AgentQueuedTurnRecord,
    deliveryKey: string,
    generationCreatedAt: number | undefined,
  ) => {
    const { claim, started } = await startAdmission(turn, deliveryKey);
    const admitted = await turns().markAgentQueuedTurnAdmitted({
      ...claim,
      admissionId: deliveryKey,
      admissionMode: 'ordinary',
      generationId: `generation-${deliveryKey}`,
      ...(generationCreatedAt != null && { generationCreatedAt }),
      ...(started.turn?.admissionEffectivePredecessorCreatedAt != null && {
        effectivePredecessorCreatedAt: started.turn.admissionEffectivePredecessorCreatedAt,
      }),
      lineagePredecessorId: started.turn?.admissionLineagePredecessorId,
      settledAt: START,
    });
    expect(admitted.outcome).toBe('admitted');
    return admitted.turn;
  };
  /** Dead-letters a started admission without evidence: quarantined as indeterminate. */
  const quarantine = async (
    turn: AgentQueuedTurnRecord,
    deliveryKey: string,
    extra: { admissionProtocolVersion?: 2 } = {},
  ) => {
    const { claim } = await startAdmission(turn, deliveryKey, extra);
    const result = await turns().deadLetterAgentQueuedTurn({
      ...scope({ conversationId: turn.conversationId }),
      queuedTurnId: turn.queuedTurnId,
      deliveryKey,
      settledAt: LATER,
      failure: { code: 'ATTEMPTS_EXHAUSTED', message: 'admission result unavailable' },
    });
    expect(result.outcome).toBe('admission_indeterminate');
    return claim;
  };
  const storedTurn = async (queuedTurnId: string) =>
    (await readRawWhere(harness, 'agentqueuedturns', { _id: queuedTurnId }))[0];
  const lanes = () => harness.readRaw('agentqueuedturnsequences');
  /** A raw turn of the conversation (no store rules), `extra` over it. */
  const rawTurn = (extra: RawRecord = {}): RawRecord => ({
    _id: newId(),
    user: getUser(),
    tenantId: 'tenant-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    parentMessageId: 'parent-1',
    clientRequestId: `raw-${++counter}`,
    fingerprint: 'x'.repeat(43),
    laneId: 'lane-raw',
    status: 'queued',
    priority: false,
    text: 'raw turn',
    attempts: 0,
    availableAt: START,
    deliveryState: 'pending',
    createdAt: START,
    updatedAt: START,
    ...extra,
  });
  const seedTurns = (...records: RawRecord[]) => harness.seedRaw('agentqueuedturns', records);

  return {
    turns,
    newId,
    scope,
    enqueueInput,
    enqueue,
    claimInput,
    publish,
    startAdmission,
    admit,
    quarantine,
    storedTurn,
    lanes,
    rawTurn,
    seedTurns,
  };
}

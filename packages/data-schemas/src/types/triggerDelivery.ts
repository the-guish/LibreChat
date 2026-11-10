import type { Document, Types } from 'mongoose';
import type { IAgentEventActorReconciliation } from './convo';

export type AgentTriggerDeliveryStatus =
  | 'staging'
  | 'capability_staging'
  | 'batched'
  | 'pending'
  | 'capability_pending'
  | 'leased'
  | 'capability_leased'
  | 'succeeded'
  | 'capability_dead'
  | 'dead';
export const AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1 = 'event_actor_detached_action_v1';
export const AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_V1 =
  'background_tool_completion_v1';
export const AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2 =
  'background_tool_completion_receipt_v2';
export const AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3 =
  'background_tool_completion_batch_v3';
export const AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1 = 'agent_queued_turn_v1';
export const AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V2 = 'agent_queued_turn_v2';
export const AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS: number = 64 * 1024;
export type AgentTriggerDeliveryOutcome = 'succeeded' | 'retry' | 'dead';

export interface AgentTriggerHandlingState {
  status: 'started' | 'applied' | 'completed_no_action' | 'failed' | 'cancelled';
  conversationId: string;
  streamId: string;
  generationCreatedAt: number;
  startedAt: Date;
  settledAt?: Date;
  error?: string;
  action?: {
    toolName: string;
    toolCallId?: string;
  };
}

/** Private terminal proof for one delivery-owned event-actor invocation. */
export interface AgentEventActorReceipt {
  bindingId: string;
  resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
  checkpoint: IAgentEventActorReconciliation['checkpoint'];
  action: {
    toolName: string;
    toolCallId?: string;
  };
  settledAt: Date;
}

/** Private launch authority for one delivery-owned detached expected action. */
export interface AgentEventActorDetachedAction {
  version: 1;
  invocationId: string;
  expectedToolName: string;
  toolName: string;
  toolCallId: string;
  /** Stable graph-turn identity, independent of retry allocation. */
  turnId: string;
  taskId: string;
  idempotencyKey: string;
  launchAttempt: number;
  status: 'reserved' | 'running' | 'launch_indeterminate' | 'succeeded' | 'failed' | 'cancelled';
  reservedAt: Date;
  observedAt: Date;
  /** A recovery fence, not relaunch authority. Expiry only permits the exact
   * launch to be marked indeterminate while late terminal proof remains valid. */
  recoveryAfter: Date;
  launchedAt?: Date;
  settledAt?: Date;
  result?: string;
  error?: string;
}

export interface AgentTriggerDeliveryFailure {
  code: string;
  message: string;
  certainty: 'definite' | 'ambiguous';
  retryable: boolean;
  attemptedAt: Date;
  status?: number;
}

/** Private terminal result produced before a background-completion delivery is
 * resolved. It is independent of the parent message projection because a fast
 * task can settle before that response row exists. */
export interface AgentBackgroundToolResultReceipt {
  status: 'completed' | 'error' | 'cancelled';
  output: string;
  settledAt: Date;
  resultClaim?: {
    kind: 'wakeup';
    claimId: string;
    claimedAt: Date;
    appliedAt?: Date;
    batchId?: string;
  };
}

export interface AgentTriggerDeliveryHistoryEntry {
  attempt: number;
  outcome: AgentTriggerDeliveryOutcome;
  at: Date;
  workerId: string;
  error?: AgentTriggerDeliveryFailure;
}

export interface IAgentTriggerDelivery {
  _id?: Types.ObjectId;
  deliveryKey: string;
  fingerprint: string;
  orderingKey: string;
  /** Monotonic sequence allocated while holding the lane publication fence. */
  laneSequence: number;
  envelope: unknown;
  user: Types.ObjectId;
  tenantId?: string;
  status: AgentTriggerDeliveryStatus;
  /** Keeps a delivery invisible to pre-capability workers during rolling deploys. */
  requiredWorkerCapability?: string;
  /** Private lifecycle for capability-owned work. The outer delivery status
   * remains a legacy-known, nonclaimable compatibility shield. */
  capabilityStatus?: 'publishing' | 'pending' | 'leased' | 'dead';
  /** Canonical claim ordering timestamp. Old rows omit it and sort first. */
  claimAvailableAt?: Date;
  capabilityLeaseBy?: string;
  capabilityLeaseUntil?: Date;
  capabilityClaimToken?: string;
  /** Durable liveness evidence for process-owned capability work. */
  producerLeaseUntil?: Date;
  /** Durable source of truth for a background completion. */
  backgroundToolResult?: AgentBackgroundToolResultReceipt;
  /** Receipt batching is separate from event-envelope coalescing. */
  backgroundToolResultBatch?: {
    batchId: string;
    dispatchCount: number;
    dispatchId?: string;
    releaseId?: string;
    proofCopiedAt?: Date;
    candidates: string[];
    members?: string[];
    appliedAt?: Date;
    releasing?: true;
  };
  /** Conversation-deletion fence preventing a late producer from restoring private output. */
  backgroundToolResultErasedAt?: Date;
  backgroundToolResultDeletionPendingAt?: Date;
  attempts: number;
  availableAt: Date;
  envelopeBytes?: number;
  coalesceKey?: string;
  coalesceFrom?: Date;
  coalesceUntil?: Date;
  batchSize?: number;
  batchBytes?: number;
  batchMemberIds?: Types.ObjectId[];
  batchRootId?: Types.ObjectId;
  batchRootRequeueCount?: number;
  batchMembersSettledAt?: Date;
  deadLetterExpiresAt?: Date;
  /** Keeps this binding lane serialized until its admitted child turn reaches
   *  an authoritative terminal handling outcome. */
  awaitTerminalHandling?: boolean;
  handling?: AgentTriggerHandlingState;
  actorReceipt?: AgentEventActorReceipt;
  /** Durable launch identity; excluded from ordinary delivery reads. */
  actorDetachedAction?: AgentEventActorDetachedAction;
  /** Bounded audit trail for terminal attempts replaced by an explicit retry. */
  actorDetachedActionHistory?: AgentEventActorDetachedAction[];
  /** Delivery-owned serialization point acquired exactly once before an event
   * actor may invoke an external action. */
  actorActionAdmittedAt?: Date;
  /** Attempt identity that fences admission takeover and release. */
  actorActionAdmissionId?: string;
  /** Account-deletion fence that atomically closes action admission on this delivery. */
  actorActionAdmissionClosedAt?: Date;
  leaseBy?: string;
  leaseUntil?: Date;
  claimToken?: string;
  lastError?: AgentTriggerDeliveryFailure;
  result?: unknown;
  history?: AgentTriggerDeliveryHistoryEntry[];
  settledAt?: Date;
  expiresAt?: Date;
  requeueCount?: number;
  /** Fairness cursor for bounded recovery of rows stranded before lane publication. */
  stagingRecoveryAt?: Date;
  /** Durable proof that successful settlement still owes lane cleanup publication. */
  laneCleanupPendingAt?: Date;
  /** Readiness changed while a worker held this delivery; its next deferral re-checks at once. */
  wakeRequestedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTriggerDeliveryDocument
  extends Omit<IAgentTriggerDelivery, '_id'>,
    Document {}

export interface AgentTriggerDeliveryRecord
  extends Omit<IAgentTriggerDelivery, '_id' | 'createdAt'> {
  id: string;
  createdAt: Date;
}

/** Owner-scoped projection safe for public delivery-status reads. */
export type AgentTriggerDeliveryStatusRecord = Pick<
  AgentTriggerDeliveryRecord,
  | 'deliveryKey'
  | 'status'
  | 'attempts'
  | 'availableAt'
  | 'createdAt'
  | 'settledAt'
  | 'result'
  | 'lastError'
  | 'handling'
>;

export interface IAgentTriggerLaneSequence {
  _id: string;
  value: number;
  user: Types.ObjectId;
  tenantId?: string;
  /** Latest delivery admitted to this lane. Used to reclaim inactive lane counters safely. */
  tailDeliveryId?: Types.ObjectId;
  /** Delivery currently owning the serialized sequence/publication step. */
  publisherDeliveryId?: Types.ObjectId;
  /** Requeue generation captured when this publisher reservation was acquired. */
  publisherRequeueCount?: number;
  publisherStartedAt?: Date;
  cleanupRequestedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTriggerLaneSequenceDocument
  extends Omit<IAgentTriggerLaneSequence, '_id'>,
    Document<string> {}

/** Durable proof that trigger payload cleanup must survive the deleting process. */
export interface IAgentTriggerUserPurge {
  _id: Types.ObjectId;
  fenceStartedAt: Date;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentTriggerUserPurgeDocument
  extends Omit<IAgentTriggerUserPurge, '_id'>,
    Document {}

export interface AgentTriggerDeliveryClaim extends AgentTriggerDeliveryRecord {
  claimToken: string;
  leaseBy: string;
  leaseUntil: Date;
  status: 'leased' | 'capability_leased';
}

export interface AgentTriggerOrderingBlock {
  availableAt: Date;
  leaseUntil?: Date;
  reason?: 'active_handling';
}

/* Inputs and results of the trigger-delivery methods (`~/methods/triggerDelivery`). */

export interface EnqueueAgentTriggerDeliveryInput {
  deliveryKey: string;
  fingerprint: string;
  orderingKey: string;
  envelope: unknown;
  user: string | Types.ObjectId;
  tenantId?: string;
  availableAt: Date;
  envelopeBytes?: number;
  coalesceKey?: string;
  coalesceFrom?: Date;
  coalesceUntil?: Date;
  awaitTerminalHandling?: boolean;
  requiredWorkerCapability?: string;
  producerLeaseUntil?: Date;
}

export type AgentTriggerProducerLeaseStatus =
  | { status: 'live'; leaseUntil: Date }
  | { status: 'expired'; leaseUntil: Date }
  | { status: 'missing' };

export interface PersistAgentBackgroundToolResultInput {
  deliveryKey: string;
  sourceId: string;
  result: AgentBackgroundToolResultReceipt;
}

export type AgentBackgroundToolResultClaim =
  | { status: 'not_ready' }
  | { status: 'claimed'; claimId: string }
  | {
      status: 'acquired';
      results: Array<{
        taskId: string;
        toolCallId: string;
        toolName: string;
        status: AgentBackgroundToolResultReceipt['status'];
        output: string;
      }>;
    };

export interface AgentBackgroundToolResultBatchInput {
  deliveryKey: string;
  sourceId: string;
  userId: string;
  tenantId?: string;
  conversationId: string;
  parentMessageId: string;
  agentId: string;
  limit: number;
  maxMetadataChars: number;
  deliveryClaimToken?: string;
}

export type AgentBackgroundToolResultBatchClaim =
  | { status: 'legacy' }
  | { status: 'not_ready'; waitingForResult?: true }
  | {
      status: 'claimed';
      claimId: string;
      batchId: string;
      ownerStatus: 'pending' | 'applied' | 'recoverable';
    }
  | (Extract<AgentBackgroundToolResultClaim, { status: 'acquired' }> & { batchId: string });

export type AgentBackgroundToolResultBatchOwnerInput = Omit<
  AgentBackgroundToolResultBatchInput,
  'limit' | 'maxMetadataChars' | 'agentId'
> & { agentId?: string };

export type AgentBackgroundToolResultBatchReleaseInput = {
  sourceId: string;
  userId: string;
  conversationId: string;
  parentMessageId: string;
  claimId: string;
  deliveryClaimToken?: string;
  batchId?: string;
  dispatchId?: string;
  /** Retirement and generation-claim CAS proved that no admission can occur. */
  recoveryFenced?: true;
};

export interface AgentTriggerDeliveryFence {
  id: string;
  workerId: string;
  claimToken: string;
}

export interface SettleAgentTriggerHandlingOutcomeInput {
  deliveryKey: string;
  conversationId: string;
  generationCreatedAt: number;
  status: Exclude<AgentTriggerHandlingState['status'], 'started'>;
  settledAt: Date;
  error?: string;
  action?: AgentTriggerHandlingState['action'];
}

export interface SettleAgentEventActorReceiptInput {
  deliveryKey: string;
  user: string | Types.ObjectId;
  tenantId?: string;
  bindingId: string;
  conversationId: string;
  generationCreatedAt: number;
  status: 'applied' | 'failed';
  settledAt: Date;
  error?: string;
  /** Present for executions that acquired the delivery-owned action CAS.
   * Absent only for mixed-version terminal rows created before this field. */
  requiresActionAdmission?: true;
  receipt: Omit<AgentEventActorReceipt, 'bindingId' | 'settledAt'>;
}

export interface AdmitAgentEventActorActionInput extends GetAgentEventActorReceiptInput {
  admittedAt: Date;
  admissionId: string;
}

export interface AgentEventActorActionAdmissionInput extends GetAgentEventActorReceiptInput {
  admissionId: string;
}

/** Durable transition receipt. Storage unavailability remains an exception;
 * callers never collapse it into a conflict or a negative acknowledgement. */
export interface AgentEventActorDetachedTransitionResult {
  status: 'applied' | 'already_applied' | 'conflict';
}

export interface ReserveAgentEventActorDetachedActionInput extends GetAgentEventActorReceiptInput {
  generationCreatedAt: number;
  turnId: string;
  invocationId: string;
  expectedToolName: string;
  toolName: string;
  toolCallId: string;
  reservedAt: Date;
  recoveryAfter: Date;
}

export interface UpdateAgentEventActorDetachedActionInput extends GetAgentEventActorReceiptInput {
  generationCreatedAt: number;
  taskId: string;
  idempotencyKey: string;
  observedAt: Date;
}

export interface MarkAgentEventActorDetachedActionRunningInput
  extends UpdateAgentEventActorDetachedActionInput {
  recoveryAfter: Date;
}

export interface SettleAgentEventActorDetachedActionInput
  extends UpdateAgentEventActorDetachedActionInput {
  status: 'succeeded' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
}

export interface GetAgentEventActorReceiptInput {
  deliveryKey: string;
  user: string | Types.ObjectId;
  tenantId?: string;
  bindingId: string;
  conversationId: string;
}

export type BackfillAgentEventActorReceiptInput = SettleAgentEventActorReceiptInput;

export interface AgentEventActorReceiptStorageMetrics {
  retainedByResolution: Record<AgentEventActorReceipt['resolution'], number>;
  expiryEligible: number;
  retryDeliveries: number;
  deadDeliveries: number;
}

/** A background tool completion that has not reached its conversation yet. */
export interface PendingAgentBackgroundToolCompletion {
  deliveryKey: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  dispatchedAt: Date;
  /** The tool's terminal outcome once it settled; absent while it still runs. */
  result?: { status: AgentBackgroundToolResultReceipt['status']; settledAt: Date };
  /** An automatic delivery holds the result and is starting its turn. */
  claimedByWakeup: boolean;
}

export interface PendingAgentBackgroundToolCompletions {
  completions: PendingAgentBackgroundToolCompletion[];
  /** Completions whose delivery dead-lettered: never delivered, recoverable only by a poll. */
  dead: PendingAgentBackgroundToolCompletion[];
  /** The first page overflowed; separate reads may not cover one complete snapshot. */
  truncated: boolean;
}

export interface UndeliveredAgentTriggerTaskIds {
  taskIds: string[];
  truncated: boolean;
}

/** Selects deferred internal deliveries whose readiness condition just changed. */
export interface ExpediteAgentTriggerDeliveriesInput {
  sourceIds: readonly string[];
  /** Exact deliveries, e.g. the one whose result just became durable. */
  deliveryKeys?: readonly string[];
  /** Every matching delivery of one principal, e.g. after one of its generations settled. */
  user?: string | Types.ObjectId;
  /** Narrows a principal's selection to deliveries that resume this conversation. */
  conversationId?: string;
  /** Exact tasks within a principal's conversation, including a repaired attempt's predecessor. */
  taskIds?: readonly string[];
  now: Date;
}

export interface ExpediteAgentTriggerDeliveriesResult {
  /** Deferred, unheld deliveries moved to `now`. */
  expedited: number;
  /** Deliveries a worker held, marked so their next deferral re-checks at once. */
  held: number;
}

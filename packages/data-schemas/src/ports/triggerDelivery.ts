/**
 * Agent trigger delivery store port: the durable queue that delivers agent triggers (remote API
 * events, background tool completions, queued turns, Event Actor actions) to workers. A delivery
 * is published on its ordering lane, claimed under a lease, attempted, and settled succeeded,
 * retried or dead; it also carries the receipts that make its effects exactly-once: background
 * tool results and their claims, terminal handling outcomes, Event Actor admissions, detached
 * actions and receipts. Nothing here may import `mongoose`. Signatures are those of
 * `AgentTriggerDeliveryMethods` (`~/methods/triggerDelivery`), copied verbatim but for owner
 * and batch member ids typed `Types.ObjectId`, which the port states as `IdLike`;
 * `triggerDelivery.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - A delivery is addressed by its `deliveryKey` (unique, chosen by the producer) or by the `id`
 *   the store handed out. Reads and writes are also scoped to the tenant in the current async
 *   context, the way the tenant-isolation plugin scopes them today
 *   (`~/models/plugins/tenantIsolation`).
 * - Deliveries of one `orderingKey` (a lane) are delivered in the order they were published.
 * - The user-purge methods read the owner's user record (its trigger deletion fence), and the
 *   purge sweep whether a conversation still exists; an adapter reads those records itself.
 * - Writes are compare-and-set: a worker write holds only under its claim (the
 *   `AgentTriggerDeliveryFence`: delivery `id`, `workerId`, `claimToken`) and, where given, its
 *   `attempt`; a receipt write holds only while each expected identity still matches. A miss
 *   resolves `false`, `null` or `conflict`; repeating a write that already landed resolves
 *   `true` or its replay outcome, never a second effect.
 * - Malformed input (an oversized string, a non-positive limit or attempt, an invalid date)
 *   throws a `TypeError`.
 * - `enqueueAgentTriggerDelivery` throws `AgentTriggerDeliveryConflictError` (exported from this
 *   package) when its `deliveryKey` was used with a different `fingerprint`.
 * - `recovery`, where a method takes it, has `required` set to `true` when the method settled the
 *   delivery but left follow-up work (batch members, lane cleanup) for the recovery sweeps.
 * - `activity`, where a method takes it, has `found` set to `true` when the method found any
 *   work to do.
 *
 * Known leaks kept for now so callers stay unchanged: the records returned
 * (`AgentTriggerDeliveryRecord` and those built from it) carry the owner and batch member ids
 * as ObjectIds.
 */
import type {
  AgentEventActorReceipt,
  AgentTriggerHandlingState,
  AgentTriggerDeliveryClaim,
  AgentTriggerDeliveryRecord,
  AgentTriggerDeliveryFence,
  AgentTriggerDeliveryFailure,
  AgentTriggerOrderingBlock,
  AgentTriggerProducerLeaseStatus,
  AgentTriggerDeliveryStatusRecord,
  AgentEventActorDetachedAction,
  AgentBackgroundToolResultClaim,
  AgentBackgroundToolResultReceipt,
  AgentBackgroundToolResultBatchClaim,
  AgentBackgroundToolResultBatchInput,
  AgentBackgroundToolResultBatchOwnerInput,
  AgentBackgroundToolResultBatchReleaseInput,
  AgentEventActorActionAdmissionInput,
  AgentEventActorDetachedTransitionResult,
  AgentEventActorReceiptStorageMetrics,
  AdmitAgentEventActorActionInput,
  BackfillAgentEventActorReceiptInput,
  EnqueueAgentTriggerDeliveryInput,
  ExpediteAgentTriggerDeliveriesInput,
  ExpediteAgentTriggerDeliveriesResult,
  GetAgentEventActorReceiptInput,
  IAgentTriggerDelivery,
  MarkAgentEventActorDetachedActionRunningInput,
  PendingAgentBackgroundToolCompletions,
  PersistAgentBackgroundToolResultInput,
  ReserveAgentEventActorDetachedActionInput,
  SettleAgentEventActorDetachedActionInput,
  SettleAgentEventActorReceiptInput,
  SettleAgentTriggerHandlingOutcomeInput,
  UndeliveredAgentTriggerTaskIds,
  UpdateAgentEventActorDetachedActionInput,
} from '~/types';
import type { IdLike, WithIdLike } from './common';
import { listPortMethods } from './common';

/** {@link GetAgentEventActorReceiptInput} with its owner stated as `IdLike`. */
export type AgentEventActorReceiptStoreInput = WithIdLike<GetAgentEventActorReceiptInput, 'user'>;

export interface TriggerDeliveryStore {
  /* ------------------------------------------------------------ setup */

  /** Builds the indexes of deliveries, lanes and user-purge markers. */
  ensureAgentTriggerDeliveryIndexes(): Promise<void>;

  /* ------------------------------------------------------------ publish and claim */

  /**
   * Publishes a delivery at the end of its lane. A retry with the same `deliveryKey` and
   * `fingerprint` resolves the delivery it stored, `replayed` (finishing its publication if a
   * crash interrupted it). Throws as the header says.
   */
  enqueueAgentTriggerDelivery(
    input: WithIdLike<EnqueueAgentTriggerDeliveryInput, 'user'>,
  ): Promise<{ delivery: AgentTriggerDeliveryRecord; replayed: boolean }>;
  /**
   * Claims the next due delivery (one whose worker capability, if any, is among
   * `workerCapabilities`) under `claimToken` until `leaseUntil`; `null` when none is due.
   */
  claimNextAgentTriggerDelivery(input: {
    workerId: string;
    claimToken: string;
    now: Date;
    leaseUntil: Date;
    workerCapabilities?: string[];
  }): Promise<AgentTriggerDeliveryClaim | null>;
  /** What blocks the delivery behind an unsettled earlier delivery of its lane, or `null`. */
  findEarlierAgentTriggerDelivery(
    delivery: Pick<AgentTriggerDeliveryRecord, 'orderingKey' | 'laneSequence'>,
  ): Promise<AgentTriggerOrderingBlock | null>;
  /** The deliveries coalesced into this batch root. */
  getAgentTriggerDeliveryBatch(delivery: {
    id: string;
    batchMemberIds?: IdLike[];
  }): Promise<AgentTriggerDeliveryRecord[]>;
  /** Releases the caller's claim without consuming an attempt; due again at `availableAt`. */
  releaseAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & { availableAt: Date },
  ): Promise<boolean>;
  /** Starts an attempt under a live claim; resolves its number, or `null` when the claim is lost. */
  beginAgentTriggerDeliveryAttempt(
    input: AgentTriggerDeliveryFence & { now: Date },
  ): Promise<number | null>;
  /**
   * Releases a pre-dispatch deferral and gives back the attempt `beginAgentTriggerDeliveryAttempt`
   * consumed. `expedited` when readiness changed while the delivery was held: it is due now
   * instead.
   */
  deferAgentTriggerDeliveryAttempt(
    input: AgentTriggerDeliveryFence & { attempt: number; availableAt: Date },
  ): Promise<boolean | 'expedited'>;
  /** Settles the claimed attempt succeeded with its `result` (and batch members with it). */
  completeAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      result: unknown;
      settledAt: Date;
      handling?: AgentTriggerHandlingState;
      awaitTerminalHandling?: true;
    },
    recovery?: { required: boolean },
  ): Promise<boolean>;
  /** Releases the claimed attempt for a retry at `availableAt`, recording `error`. */
  retryAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      availableAt: Date;
    },
  ): Promise<boolean>;
  /** Settles the claimed attempt dead, recording `error`. */
  deadLetterAgentTriggerDelivery(
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      settledAt: Date;
      /** When the dead letter expires; absent keeps it until an operator acts. */
      expiresAt?: Date;
      receiptRetryAt?: Date;
    },
    recovery?: { required: boolean },
  ): Promise<boolean>;
  /**
   * Retires an internal delivery whose producer proved its result will never become
   * dispatchable, keyed by its identity rather than a claim, so the lane is unblocked even while
   * a worker holds it.
   */
  retireAgentTriggerDelivery(
    input: {
      deliveryKey: string;
      sourceId: string;
      settledAt: Date;
      reason: string;
      onlyIfUnclaimed?: boolean;
      onlyIfDead?: boolean;
      /** Accept transport success without a terminal handling receipt, unless the
       * delivery explicitly keeps its lane open for terminal handling. */
      allowSucceeded?: boolean;
      /** True only when this call retired the delivery, not when it had already
       * succeeded, e.g. delivered by a resolver that won the race. */
      requireTransition?: boolean;
    },
    recovery?: { required: boolean },
  ): Promise<boolean>;
  /** Extends the producer's liveness lease on its delivery; never shortens it. */
  renewAgentTriggerDeliveryProducerLease(input: {
    deliveryKey: string;
    sourceId: string;
    leaseUntil: Date;
  }): Promise<boolean>;
  /** The producer's liveness lease on its delivery, as of `now`. */
  getAgentTriggerDeliveryProducerLease(input: {
    deliveryKey: string;
    sourceId: string;
    now: Date;
  }): Promise<AgentTriggerProducerLeaseStatus>;
  /** Moves deferred deliveries whose readiness just changed to `now`, or flags held ones. */
  expediteAgentTriggerDeliveries(
    input: WithIdLike<ExpediteAgentTriggerDeliveriesInput, 'user'>,
  ): Promise<ExpediteAgentTriggerDeliveriesResult>;
  /** Records the terminal handling outcome of the delivery's generation in `conversationId`. */
  settleAgentTriggerHandlingOutcome(
    input: SettleAgentTriggerHandlingOutcomeInput,
  ): Promise<boolean>;

  /* ------------------------------------------------------------ reads and operations */

  /** The delivery of `deliveryKey`, or `null`. */
  getAgentTriggerDelivery(deliveryKey: string): Promise<AgentTriggerDeliveryRecord | null>;
  /**
   * The public status of the owner's delivery from remote API key `sourceKeyId` (a batch
   * member reports its root's status), or `null`.
   */
  getAgentTriggerDeliveryStatus(
    deliveryKey: string,
    user: IdLike,
    sourceKeyId: string,
    tenantId?: string,
  ): Promise<AgentTriggerDeliveryStatusRecord | null>;
  /** The most recently updated dead deliveries, up to `limit` (default 50, at most 200). */
  getAgentTriggerDeadLetters(limit?: number): Promise<AgentTriggerDeliveryRecord[]>;
  /** Republishes the dead delivery `id` on its lane, due at `availableAt`, or `null`. */
  requeueAgentTriggerDelivery(
    id: string,
    availableAt: Date,
  ): Promise<AgentTriggerDeliveryRecord | null>;
  /** How many of the owner's deliveries are being worked on as of `now`. */
  countActiveAgentTriggerDeliveriesByUser(user: IdLike, now: Date): Promise<number>;

  /* ------------------------------------------------------------ background tool results */

  /**
   * The background completions of one conversation not yet delivered (still running, or
   * settled and waiting), without their content.
   */
  listPendingAgentBackgroundToolCompletions(input: {
    user: IdLike;
    conversationId: string;
    sourceId: string;
    /** One task's completion, e.g. to discard it. */
    taskId?: string;
    limit?: number;
  }): Promise<PendingAgentBackgroundToolCompletions>;
  /** Task ids of one conversation's undelivered internal deliveries from one source. */
  listUndeliveredAgentTriggerTaskIds(input: {
    user: IdLike;
    conversationId: string;
    sourceId: string;
  }): Promise<UndeliveredAgentTriggerTaskIds>;
  /** Stores a background tool's terminal result on its delivery; the first result wins. */
  persistAgentBackgroundToolResult(input: PersistAgentBackgroundToolResultInput): Promise<boolean>;
  /** The background tool result stored on the delivery, or `null`. */
  getAgentBackgroundToolResult(input: {
    deliveryKey: string;
    sourceId: string;
  }): Promise<AgentBackgroundToolResultReceipt | null>;
  /** The claim on the task's stored result, or `null`. */
  getAgentBackgroundToolResultClaim(input: {
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    taskId: string;
  }): Promise<AgentBackgroundToolResultReceipt['resultClaim'] | null>;
  /** Elects exactly one continuation for the stored results of a parent message. */
  claimAgentBackgroundToolResults(input: {
    deliveryKey: string;
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    agentId?: string;
    claimId: string;
    limit?: number;
  }): Promise<AgentBackgroundToolResultClaim>;
  /** Releases the claims of `claimId` (and its batch) on stored results. */
  releaseAgentBackgroundToolResultClaims(
    input: AgentBackgroundToolResultBatchReleaseInput,
  ): Promise<boolean>;
  /** Collects stored results into the delivery's batch, claiming each one. */
  claimAgentBackgroundToolResultBatch(
    input: AgentBackgroundToolResultBatchInput,
  ): Promise<AgentBackgroundToolResultBatchClaim>;
  /** The delivery's result batch, or `null`. */
  getAgentBackgroundToolResultBatch(
    input: AgentBackgroundToolResultBatchOwnerInput,
  ): Promise<IAgentTriggerDelivery['backgroundToolResultBatch'] | null>;
  /** Records that dispatch `dispatchId` of the batch started. */
  beginAgentBackgroundToolResultBatchDispatch(
    input: AgentBackgroundToolResultBatchOwnerInput & { batchId: string; dispatchId: string },
  ): Promise<boolean>;
  /** Confirms the batch was admitted, settling its members. */
  confirmAgentBackgroundToolResultBatch(
    input: AgentBackgroundToolResultBatchOwnerInput & { batchId: string },
  ): Promise<boolean>;

  /* ------------------------------------------------------------ Event Actor receipts */

  /** Admits the delivery's Event Actor action under `admissionId`. */
  admitAgentEventActorAction(
    input: WithIdLike<AdmitAgentEventActorActionInput, 'user'>,
  ): Promise<boolean>;
  /** Releases the action admission `admissionId`. */
  releaseAgentEventActorAction(
    input: WithIdLike<AgentEventActorActionAdmissionInput, 'user'>,
  ): Promise<boolean>;
  /** The admission id of the delivery's action, or `null`. */
  getAgentEventActorActionAdmission(
    input: AgentEventActorReceiptStoreInput,
  ): Promise<string | null>;
  /** Whether the delivery's action is admitted under `admissionId`. */
  hasAgentEventActorActionAdmission(
    input: WithIdLike<AgentEventActorActionAdmissionInput, 'user'>,
  ): Promise<boolean>;
  /** Gives one replica launch authority for the exact detached action. */
  reserveAgentEventActorDetachedAction(
    input: WithIdLike<ReserveAgentEventActorDetachedActionInput, 'user'>,
  ): Promise<{
    status: 'reserved' | 'replay' | 'conflict';
    action: AgentEventActorDetachedAction;
  }>;
  /** Acknowledges the detached action's launch. */
  markAgentEventActorDetachedActionRunning(
    input: WithIdLike<MarkAgentEventActorDetachedActionRunningInput, 'user'>,
  ): Promise<AgentEventActorDetachedTransitionResult>;
  /** Records that the detached action's launch outcome is unknown; only terminal proof closes it. */
  markAgentEventActorDetachedActionLaunchIndeterminate(
    input: WithIdLike<UpdateAgentEventActorDetachedActionInput, 'user'>,
  ): Promise<AgentEventActorDetachedTransitionResult>;
  /** Records the detached action's terminal outcome once. */
  settleAgentEventActorDetachedAction(
    input: WithIdLike<SettleAgentEventActorDetachedActionInput, 'user'>,
  ): Promise<AgentEventActorDetachedTransitionResult>;
  /** The detached action of the delivery's generation, or `null`. */
  getAgentEventActorDetachedAction(
    input: AgentEventActorReceiptStoreInput & { generationCreatedAt: number },
  ): Promise<AgentEventActorDetachedAction | null>;
  /** Records the delivery's Event Actor receipt once. */
  settleAgentEventActorReceipt(
    input: WithIdLike<SettleAgentEventActorReceiptInput, 'user'>,
  ): Promise<boolean>;
  /** The delivery's Event Actor receipt, or `null`. */
  getAgentEventActorReceipt(
    input: AgentEventActorReceiptStoreInput,
  ): Promise<AgentEventActorReceipt | null>;
  /** Moves a receipt recorded before the delivery ledger onto its terminal delivery. */
  backfillAgentEventActorReceipt(
    input: WithIdLike<BackfillAgentEventActorReceiptInput, 'user'>,
  ): Promise<boolean>;
  /** Counts of retained receipts and of receipt deliveries retrying or dead, as of `now`. */
  getAgentEventActorReceiptStorageMetrics(now: Date): Promise<AgentEventActorReceiptStorageMetrics>;

  /* ------------------------------------------------------------ recovery sweeps */

  /** Finishes publications and reservations crashed writers left; resolves how many. */
  recoverAgentTriggerLanePublications(
    limit?: number,
    activity?: { found: boolean },
  ): Promise<number>;
  /** Finishes settling the members of settled batches; resolves how many batches. */
  recoverAgentTriggerBatchReceipts(limit?: number, activity?: { found: boolean }): Promise<number>;
  /** Removes the ordering state of lanes whose last delivery settled; resolves how many. */
  reclaimInactiveAgentTriggerLanes(limit?: number, activity?: { found: boolean }): Promise<number>;

  /* ------------------------------------------------------------ deletion */

  /**
   * Arms a purge marker for the owner before their account deletion commits, and closes their
   * deliveries to new Event Actor admissions. Throws unless the owner's user record holds the
   * deletion fence `fenceStartedAt`.
   */
  prepareAgentTriggerUserPurge(
    user: IdLike,
    fenceStartedAt: Date,
    tenantId?: string,
  ): Promise<void>;
  /**
   * Disarms the purge marker of the deletion attempt `fenceStartedAt` and reopens admissions;
   * `false` when the owner's user record no longer holds that fence.
   */
  cancelAgentTriggerUserPurge(user: IdLike, fenceStartedAt: Date): Promise<boolean>;
  /**
   * Erases the pending results of conversations since deleted, disarms purge markers whose
   * deletion attempt was abandoned, and finishes the purges of owners now gone; resolves how
   * many purges it finished.
   */
  recoverAgentTriggerUserPurges(limit?: number, activity?: { found: boolean }): Promise<number>;
  /** Deletes every delivery, lane and purge marker of the owner (and their queued turns). */
  deleteAgentTriggerDeliveriesByUser(user: IdLike): Promise<void>;
  /** Erases the background tool results stored for the owner's conversations. */
  eraseAgentTriggerDeliveryConversationResults(
    user: IdLike,
    conversationIds: string[],
  ): Promise<void>;
  /** Fences the owner's conversations' background results before they are erased. */
  prepareAgentTriggerConversationResultErasure(
    user: IdLike,
    conversationIds: string[],
  ): Promise<void>;
}

/** Every method of {@link TriggerDeliveryStore}, for adapters and conformance checks. */
export const TRIGGER_DELIVERY_STORE_METHODS: ReadonlyArray<keyof TriggerDeliveryStore> =
  listPortMethods<TriggerDeliveryStore>({
    ensureAgentTriggerDeliveryIndexes: true,
    enqueueAgentTriggerDelivery: true,
    claimNextAgentTriggerDelivery: true,
    findEarlierAgentTriggerDelivery: true,
    getAgentTriggerDeliveryBatch: true,
    releaseAgentTriggerDelivery: true,
    beginAgentTriggerDeliveryAttempt: true,
    deferAgentTriggerDeliveryAttempt: true,
    completeAgentTriggerDelivery: true,
    retryAgentTriggerDelivery: true,
    deadLetterAgentTriggerDelivery: true,
    retireAgentTriggerDelivery: true,
    renewAgentTriggerDeliveryProducerLease: true,
    getAgentTriggerDeliveryProducerLease: true,
    expediteAgentTriggerDeliveries: true,
    settleAgentTriggerHandlingOutcome: true,
    getAgentTriggerDelivery: true,
    getAgentTriggerDeliveryStatus: true,
    getAgentTriggerDeadLetters: true,
    requeueAgentTriggerDelivery: true,
    countActiveAgentTriggerDeliveriesByUser: true,
    listPendingAgentBackgroundToolCompletions: true,
    listUndeliveredAgentTriggerTaskIds: true,
    persistAgentBackgroundToolResult: true,
    getAgentBackgroundToolResult: true,
    getAgentBackgroundToolResultClaim: true,
    claimAgentBackgroundToolResults: true,
    releaseAgentBackgroundToolResultClaims: true,
    claimAgentBackgroundToolResultBatch: true,
    getAgentBackgroundToolResultBatch: true,
    beginAgentBackgroundToolResultBatchDispatch: true,
    confirmAgentBackgroundToolResultBatch: true,
    admitAgentEventActorAction: true,
    releaseAgentEventActorAction: true,
    getAgentEventActorActionAdmission: true,
    hasAgentEventActorActionAdmission: true,
    reserveAgentEventActorDetachedAction: true,
    markAgentEventActorDetachedActionRunning: true,
    markAgentEventActorDetachedActionLaunchIndeterminate: true,
    settleAgentEventActorDetachedAction: true,
    getAgentEventActorDetachedAction: true,
    settleAgentEventActorReceipt: true,
    getAgentEventActorReceipt: true,
    backfillAgentEventActorReceipt: true,
    getAgentEventActorReceiptStorageMetrics: true,
    recoverAgentTriggerLanePublications: true,
    recoverAgentTriggerBatchReceipts: true,
    reclaimInactiveAgentTriggerLanes: true,
    prepareAgentTriggerUserPurge: true,
    cancelAgentTriggerUserPurge: true,
    recoverAgentTriggerUserPurges: true,
    deleteAgentTriggerDeliveriesByUser: true,
    eraseAgentTriggerDeliveryConversationResults: true,
    prepareAgentTriggerConversationResultErasure: true,
  });

/**
 * Agent queued-turn store port: the follow-up turns a user queues on a conversation while an
 * agent is still generating, and the per-conversation lane that orders them. A turn moves from
 * queued through claimed and admitted (or cancelled, or dead), and carries the reservation of
 * the durable trigger delivery that runs it. Nothing here may import `mongoose`. Signatures are
 * those of `AgentQueuedTurnMethods` (`~/methods/queuedTurn`), copied verbatim but for the owner,
 * typed `Types.ObjectId`, which the port states as `IdLike`; `queuedTurn.spec.ts` fails the
 * typecheck if the MongoDB methods stop satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - A turn is addressed by its owner (`user`), tenant (`tenantId`; absent addresses turns stored
 *   without one) and, where given, conversation, plus its `queuedTurnId`. Reads and writes are
 *   also scoped to the tenant in the current async context, the way the tenant-isolation plugin
 *   scopes them today (`~/models/plugins/tenantIsolation`).
 * - Writes are compare-and-set: each expected status, claim (`claimId`, `claimBy`), admission or
 *   delivery key given must still hold. A miss resolves `conflict` (with the turn as it now is,
 *   or `null`), `missing`, or `false`; repeating a write that already landed resolves its
 *   `already_*` outcome, never a second effect.
 * - Malformed input (an oversized string, a non-positive limit, an invalid date or lease)
 *   throws a `TypeError`.
 * - `enqueueAgentQueuedTurn` throws `AgentQueuedTurnConflictError` when its idempotency key was
 *   used with a different payload, `AgentQueuedTurnCapacityError` when the conversation already
 *   holds the maximum of 100 active turns, and `AgentQueuedTurnLaneRetiredError`
 *   while the conversation is being deleted (all exported from this package).
 * - `activity`, where a method takes it, has `found` set to `true` when the method found any
 *   work to do.
 *
 * Known leaks kept for now so callers stay unchanged: the records returned
 * (`AgentQueuedTurnRecord` and those built from it) carry the owner as an ObjectId; and a string
 * `user` must be the canonical (lowercase hex) form of the id the store handed out, since the
 * lane a turn is ordered in is keyed by the owner's string form.
 */
import type {
  AgentQueuedTurnRecord,
  AgentQueuedTurnFailure,
  AgentQueuedTurnPredecessor,
  AgentQueuedTurnClaimFence,
  AgentQueuedTurnOwnerScope,
  AgentQueuedTurnActiveRecord,
  AgentQueuedTurnDeletionTarget,
  AgentQueuedTurnAdmissionEvidence,
  AgentQueuedTurnConversationScope,
  ClaimAgentQueuedTurnReconciliationInput,
  BeginAgentQueuedTurnAdmissionResult,
  ReserveAgentQueuedTurnDeliveryResult,
  DeadLetterAgentQueuedTurnResult,
  ScheduleAgentQueuedTurnResult,
  ReleaseAgentQueuedTurnResult,
  CancelAgentQueuedTurnResult,
  AdmitAgentQueuedTurnResult,
  ClaimAgentQueuedTurnResult,
  EnqueueAgentQueuedTurnInput,
} from '~/types';
import type { IdLike, WithIdLike } from './common';
import { listPortMethods } from './common';

/** {@link AgentQueuedTurnOwnerScope} with its owner stated as `IdLike`. */
export type AgentQueuedTurnStoreOwnerScope = WithIdLike<AgentQueuedTurnOwnerScope, 'user'>;
/** {@link AgentQueuedTurnConversationScope} with its owner stated as `IdLike`. */
export type AgentQueuedTurnStoreConversationScope = WithIdLike<
  AgentQueuedTurnConversationScope,
  'user'
>;
/** {@link AgentQueuedTurnClaimFence} with its owner stated as `IdLike`. */
export type AgentQueuedTurnStoreClaimFence = WithIdLike<AgentQueuedTurnClaimFence, 'user'>;
/** {@link EnqueueAgentQueuedTurnInput} with its owner stated as `IdLike`. */
export type EnqueueAgentQueuedTurnStoreInput = WithIdLike<EnqueueAgentQueuedTurnInput, 'user'>;

export interface AgentQueuedTurnStore {
  /* ------------------------------------------------------------ setup */

  /** Builds the queued-turn indexes, settling lanes left without a total order first. */
  ensureAgentQueuedTurnIndexes(): Promise<void>;

  /* ------------------------------------------------------------ queue and reads */

  /**
   * Queues a turn at the end of its conversation's lane (or ahead of the queued ones, with
   * `priority`). A retry with the same `clientRequestId` and payload resolves to the turn it
   * stored, `replayed`. Throws as the header says.
   */
  enqueueAgentQueuedTurn(
    input: EnqueueAgentQueuedTurnStoreInput,
  ): Promise<{ turn: AgentQueuedTurnRecord; replayed: boolean }>;
  /** The conversation's turn queued under `clientRequestId`, or `null`. */
  getAgentQueuedTurnByClientRequestId(
    input: AgentQueuedTurnStoreConversationScope & { clientRequestId: string },
  ): Promise<AgentQueuedTurnRecord | null>;
  /** The conversation's queued and claimed turns, in lane order, up to `limit` (1 to 100). */
  listActiveAgentQueuedTurns(
    input: AgentQueuedTurnStoreConversationScope & { limit?: number },
  ): Promise<AgentQueuedTurnActiveRecord[]>;
  /**
   * The conversation's active and dead turns, plus those queued under `clientRequestIds` (at
   * most 100), in lane order.
   */
  listAgentQueuedTurnReceipts(
    input: AgentQueuedTurnStoreConversationScope & { clientRequestIds?: readonly string[] },
  ): Promise<AgentQueuedTurnActiveRecord[]>;
  /**
   * Finishes queuing turns a crash left half-queued, and resolves the turns whose delivery must
   * still be published, up to `limit` (1 to 1000).
   */
  findQueuedTurnsNeedingDelivery(
    limit?: number,
    activity?: { found: boolean },
  ): Promise<AgentQueuedTurnRecord[]>;
  /**
   * The effective predecessor of the turn at lane position `sequence`, the boundary its
   * admission must follow; `null` when the lane gives it none it can rely on.
   */
  getEffectiveAgentQueuedTurnPredecessor(
    input: AgentQueuedTurnStoreConversationScope & {
      sequence: number;
      rootParentMessageId: string;
      expectedPredecessorCreatedAt?: number;
      allowLegacyPredecessorInference?: boolean;
    },
  ): Promise<AgentQueuedTurnPredecessor | null>;

  /* ------------------------------------------------------------ delivery */

  /** Reserves `deliveryKey` for a queued or claimed turn that has no delivery yet. */
  reserveAgentQueuedTurnDelivery(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
    },
  ): Promise<ReserveAgentQueuedTurnDeliveryResult>;
  /** Records that the turn's reserved delivery `deliveryKey` was published. */
  markQueuedTurnScheduled(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      scheduledAt?: Date;
    },
  ): Promise<ScheduleAgentQueuedTurnResult>;

  /* ------------------------------------------------------------ claim and admission */

  /** Cancels the owner's turn unless it is terminal or its admission has started. */
  cancelAgentQueuedTurn(
    input: AgentQueuedTurnStoreOwnerScope & {
      queuedTurnId: string;
      conversationId?: string;
      settledAt?: Date;
    },
  ): Promise<CancelAgentQueuedTurnResult>;
  /**
   * Claims the turn until `leaseUntil` when no other turn of its lane holds the admission slot.
   * The same live claim resolves `replayed`; `blocked` when another turn holds the slot;
   * `missing` when the turn or its lane is gone or the turn is no longer active.
   */
  claimNextAgentQueuedTurn(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      claimId: string;
      claimBy: string;
      now: Date;
      leaseUntil: Date;
    },
  ): Promise<ClaimAgentQueuedTurnResult>;
  /** Releases the caller's claim: back to the queue until `availableAt`, or dead. */
  releaseAgentQueuedTurn(
    input: AgentQueuedTurnStoreClaimFence &
      (
        | { disposition: 'retry'; availableAt: Date }
        | {
            disposition: 'dead';
            settledAt: Date;
            failure: AgentQueuedTurnFailure;
          }
      ),
  ): Promise<ReleaseAgentQueuedTurnResult>;
  /**
   * Starts the claimed turn's admission under `admissionId`. `retired` when its lane was
   * retired; `order_unavailable` when its lane order cannot be established.
   */
  beginAgentQueuedTurnAdmission(
    input: AgentQueuedTurnStoreClaimFence & {
      admissionId: string;
      startedAt: Date;
      admissionProtocolVersion?: 2;
    },
  ): Promise<BeginAgentQueuedTurnAdmissionResult>;
  /** Settles the claimed turn admitted, with the generation it started. */
  markAgentQueuedTurnAdmitted(
    input: AgentQueuedTurnStoreClaimFence & {
      admissionId: string;
      admissionMode: 'warm' | 'ordinary';
      generationId?: string;
      generationCreatedAt?: number;
      effectivePredecessorCreatedAt?: number;
      lineagePredecessorId?: string;
      settledAt: Date;
    },
  ): Promise<AdmitAgentQueuedTurnResult>;
  /** Whether the turn was admitted with exactly this admission and generation. */
  hasAgentQueuedTurnAdmissionReceipt(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      admissionId: string;
      generationId: string;
      generationCreatedAt: number;
      effectivePredecessorCreatedAt?: number;
      lineagePredecessorId?: string;
    },
  ): Promise<boolean>;
  /**
   * Settles the turn of delivery `deliveryKey` dead. With `admissionEvidence`, a started
   * admission is reconciled to admitted instead; without it, one is left indeterminate for
   * reconciliation.
   */
  deadLetterAgentQueuedTurn(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      settledAt: Date;
      failure: AgentQueuedTurnFailure;
      admissionEvidence?: AgentQueuedTurnAdmissionEvidence;
      reconciliationClaimId?: string;
      reconciliationClaimBy?: string;
    },
  ): Promise<DeadLetterAgentQueuedTurnResult>;
  /**
   * Claims turns whose admission outcome is indeterminate for reconciliation until
   * `leaseUntil`, up to `limit` (1 to 1000).
   */
  claimQueuedTurnsForAdmissionReconciliation(
    input: ClaimAgentQueuedTurnReconciliationInput,
    activity?: { found: boolean },
  ): Promise<AgentQueuedTurnRecord[]>;
  /** Releases the caller's reconciliation claim on the turn and defers it until `availableAt`. */
  deferAgentQueuedTurnAdmissionReconciliation(
    input: AgentQueuedTurnStoreConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      claimId: string;
      claimBy: string;
      availableAt: Date;
    },
  ): Promise<boolean>;

  /* ------------------------------------------------------------ deletion */

  /**
   * Deletes the owner's turns and lanes (of one conversation, when given); resolves how many
   * turns.
   */
  deleteAgentQueuedTurns(
    input: AgentQueuedTurnStoreOwnerScope & { conversationId?: string },
  ): Promise<number>;
  /**
   * First step of deleting conversations: retires their lanes, cancels their turns whose
   * admission has not started, and resolves the delivery keys still to retire. Throws while an
   * admission is in flight.
   */
  prepareAgentQueuedTurnConversationDeletion(input: {
    user: IdLike;
    targets: readonly AgentQueuedTurnDeletionTarget[];
    settledAt?: Date;
  }): Promise<string[]>;
  /**
   * Last step of deleting conversations: deletes their turns; resolves how many. Throws while
   * one of them is still active, admitting, or holds a delivery not yet retired.
   */
  deletePreparedAgentQueuedTurnConversations(input: {
    user: IdLike;
    targets: readonly AgentQueuedTurnDeletionTarget[];
  }): Promise<number>;
  /** Marks the terminal turn of `deliveryKey` delivery-retired; whether it is. */
  markAgentQueuedTurnDeliveryRetired(input: { deliveryKey: string }): Promise<boolean>;
  /**
   * Fences the terminal turn of a published `deliveryKey` before its delivery is probed for
   * absence; whether it is fenced.
   */
  beginAgentQueuedTurnMissingDeliveryRetirement(input: { deliveryKey: string }): Promise<boolean>;
  /** Marks a fenced turn of `deliveryKey` delivery-retired; whether it is. */
  markAgentQueuedTurnMissingDeliveryRetired(input: { deliveryKey: string }): Promise<boolean>;
  /** Deletes every turn and lane of the owner (account deletion); resolves how many turns. */
  deleteAllAgentQueuedTurnsForUser(input: { user: IdLike }): Promise<number>;
}

/** Every method of {@link AgentQueuedTurnStore}, for adapters and conformance checks. */
export const AGENT_QUEUED_TURN_STORE_METHODS: ReadonlyArray<keyof AgentQueuedTurnStore> =
  listPortMethods<AgentQueuedTurnStore>({
    ensureAgentQueuedTurnIndexes: true,
    enqueueAgentQueuedTurn: true,
    getAgentQueuedTurnByClientRequestId: true,
    listActiveAgentQueuedTurns: true,
    listAgentQueuedTurnReceipts: true,
    findQueuedTurnsNeedingDelivery: true,
    getEffectiveAgentQueuedTurnPredecessor: true,
    reserveAgentQueuedTurnDelivery: true,
    markQueuedTurnScheduled: true,
    cancelAgentQueuedTurn: true,
    claimNextAgentQueuedTurn: true,
    releaseAgentQueuedTurn: true,
    beginAgentQueuedTurnAdmission: true,
    markAgentQueuedTurnAdmitted: true,
    hasAgentQueuedTurnAdmissionReceipt: true,
    deadLetterAgentQueuedTurn: true,
    claimQueuedTurnsForAdmissionReconciliation: true,
    deferAgentQueuedTurnAdmissionReconciliation: true,
    deleteAgentQueuedTurns: true,
    prepareAgentQueuedTurnConversationDeletion: true,
    deletePreparedAgentQueuedTurnConversations: true,
    markAgentQueuedTurnDeliveryRetired: true,
    beginAgentQueuedTurnMissingDeliveryRetirement: true,
    markAgentQueuedTurnMissingDeliveryRetired: true,
    deleteAllAgentQueuedTurnsForUser: true,
  });

import type { Model, Types } from 'mongoose';
import type {
  AgentBackgroundToolResultReceipt,
  AgentEventActorDetachedAction,
  AgentTriggerDeliveryClaim,
  AgentEventActorReceipt,
  AgentTriggerDeliveryFailure,
  AgentTriggerHandlingState,
  AgentTriggerDeliveryRecord,
  AgentTriggerDeliveryStatusRecord,
  AgentTriggerOrderingBlock,
  IAgentTriggerDelivery,
  IAgentTriggerDeliveryDocument,
  IAgentTriggerLaneSequenceDocument,
  IAgentTriggerUserPurgeDocument,
  EnqueueAgentTriggerDeliveryInput,
  AgentTriggerProducerLeaseStatus,
  PersistAgentBackgroundToolResultInput,
  AgentBackgroundToolResultClaim,
  AgentBackgroundToolResultBatchInput,
  AgentBackgroundToolResultBatchClaim,
  AgentBackgroundToolResultBatchOwnerInput,
  AgentBackgroundToolResultBatchReleaseInput,
  AgentTriggerDeliveryFence,
  SettleAgentTriggerHandlingOutcomeInput,
  SettleAgentEventActorReceiptInput,
  AdmitAgentEventActorActionInput,
  AgentEventActorActionAdmissionInput,
  AgentEventActorDetachedTransitionResult,
  ReserveAgentEventActorDetachedActionInput,
  UpdateAgentEventActorDetachedActionInput,
  MarkAgentEventActorDetachedActionRunningInput,
  SettleAgentEventActorDetachedActionInput,
  GetAgentEventActorReceiptInput,
  BackfillAgentEventActorReceiptInput,
  AgentEventActorReceiptStorageMetrics,
  PendingAgentBackgroundToolCompletions,
  UndeliveredAgentTriggerTaskIds,
  ExpediteAgentTriggerDeliveriesInput,
  ExpediteAgentTriggerDeliveriesResult,
} from '~/types/triggerDelivery';
import type {
  TriggerDeliveryCollection,
  TriggerDeliveryRulesDeps,
  TriggerDeliveryFilter,
} from './triggerDeliveryRules';
import { createAgentTriggerDeliveryMethodsOnSteps } from './triggerDeliveryRules';
import { createIndexesWithRetry } from '~/utils/retry';

const DUPLICATE_KEY = 11000;

type DuplicateKeyError = { code?: number };

export type {
  EnqueueAgentTriggerDeliveryInput,
  AgentTriggerProducerLeaseStatus,
  PersistAgentBackgroundToolResultInput,
  AgentBackgroundToolResultClaim,
  AgentBackgroundToolResultBatchInput,
  AgentBackgroundToolResultBatchClaim,
  AgentBackgroundToolResultBatchOwnerInput,
  AgentBackgroundToolResultBatchReleaseInput,
  AgentTriggerDeliveryFence,
  SettleAgentTriggerHandlingOutcomeInput,
  SettleAgentEventActorReceiptInput,
  AdmitAgentEventActorActionInput,
  AgentEventActorActionAdmissionInput,
  AgentEventActorDetachedTransitionResult,
  ReserveAgentEventActorDetachedActionInput,
  UpdateAgentEventActorDetachedActionInput,
  MarkAgentEventActorDetachedActionRunningInput,
  SettleAgentEventActorDetachedActionInput,
  GetAgentEventActorReceiptInput,
  BackfillAgentEventActorReceiptInput,
  AgentEventActorReceiptStorageMetrics,
  PendingAgentBackgroundToolCompletion,
  PendingAgentBackgroundToolCompletions,
  UndeliveredAgentTriggerTaskIds,
  ExpediteAgentTriggerDeliveriesInput,
  ExpediteAgentTriggerDeliveriesResult,
} from '~/types/triggerDelivery';

export type { AgentEventActorReceiptMetric } from './triggerDeliveryRules';
export {
  CLAIM_CAS_MAX_ATTEMPTS,
  AgentTriggerClaimContentionError,
  AgentTriggerDeliveryConflictError,
  recordAgentEventActorReceiptMetric,
  setAgentEventActorReceiptMetricObserver,
} from './triggerDeliveryRules';

export interface AgentTriggerDeliveryMethods {
  ensureAgentTriggerDeliveryIndexes: () => Promise<void>;
  enqueueAgentTriggerDelivery: (
    input: EnqueueAgentTriggerDeliveryInput,
  ) => Promise<{ delivery: AgentTriggerDeliveryRecord; replayed: boolean }>;
  claimNextAgentTriggerDelivery: (input: {
    workerId: string;
    claimToken: string;
    now: Date;
    leaseUntil: Date;
    workerCapabilities?: string[];
  }) => Promise<AgentTriggerDeliveryClaim | null>;
  findEarlierAgentTriggerDelivery: (
    delivery: Pick<AgentTriggerDeliveryRecord, 'orderingKey' | 'laneSequence'>,
  ) => Promise<AgentTriggerOrderingBlock | null>;
  getAgentTriggerDeliveryBatch: (
    delivery: Pick<AgentTriggerDeliveryRecord, 'id' | 'batchMemberIds'>,
  ) => Promise<AgentTriggerDeliveryRecord[]>;
  releaseAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & { availableAt: Date },
  ) => Promise<boolean>;
  beginAgentTriggerDeliveryAttempt: (
    input: AgentTriggerDeliveryFence & { now: Date },
  ) => Promise<number | null>;
  /** `expedited` when readiness changed while the delivery was held: it is due now instead. */
  deferAgentTriggerDeliveryAttempt: (
    input: AgentTriggerDeliveryFence & { attempt: number; availableAt: Date },
  ) => Promise<boolean | 'expedited'>;
  completeAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      result: unknown;
      settledAt: Date;
      handling?: AgentTriggerHandlingState;
      awaitTerminalHandling?: true;
    },
    recovery?: { required: boolean },
  ) => Promise<boolean>;
  retireAgentTriggerDelivery: (
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
  ) => Promise<boolean>;
  renewAgentTriggerDeliveryProducerLease: (input: {
    deliveryKey: string;
    sourceId: string;
    leaseUntil: Date;
  }) => Promise<boolean>;
  getAgentTriggerDeliveryProducerLease: (input: {
    deliveryKey: string;
    sourceId: string;
    now: Date;
  }) => Promise<AgentTriggerProducerLeaseStatus>;
  listPendingAgentBackgroundToolCompletions: (input: {
    user: string | Types.ObjectId;
    conversationId: string;
    sourceId: string;
    /** One task's completion, e.g. to discard it. */
    taskId?: string;
    limit?: number;
  }) => Promise<PendingAgentBackgroundToolCompletions>;
  /** Task ids of one conversation's undelivered internal deliveries from one source. */
  listUndeliveredAgentTriggerTaskIds: (input: {
    user: string | Types.ObjectId;
    conversationId: string;
    sourceId: string;
  }) => Promise<UndeliveredAgentTriggerTaskIds>;
  expediteAgentTriggerDeliveries: (
    input: ExpediteAgentTriggerDeliveriesInput,
  ) => Promise<ExpediteAgentTriggerDeliveriesResult>;
  persistAgentBackgroundToolResult: (
    input: PersistAgentBackgroundToolResultInput,
  ) => Promise<boolean>;
  getAgentBackgroundToolResult: (input: {
    deliveryKey: string;
    sourceId: string;
  }) => Promise<AgentBackgroundToolResultReceipt | null>;
  getAgentBackgroundToolResultClaim: (input: {
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    taskId: string;
  }) => Promise<AgentBackgroundToolResultReceipt['resultClaim'] | null>;
  claimAgentBackgroundToolResults: (input: {
    deliveryKey: string;
    sourceId: string;
    userId: string;
    conversationId: string;
    parentMessageId: string;
    agentId?: string;
    claimId: string;
    limit?: number;
  }) => Promise<AgentBackgroundToolResultClaim>;
  releaseAgentBackgroundToolResultClaims: (
    input: AgentBackgroundToolResultBatchReleaseInput,
  ) => Promise<boolean>;
  claimAgentBackgroundToolResultBatch: (
    input: AgentBackgroundToolResultBatchInput,
  ) => Promise<AgentBackgroundToolResultBatchClaim>;
  getAgentBackgroundToolResultBatch: (
    input: AgentBackgroundToolResultBatchOwnerInput,
  ) => Promise<IAgentTriggerDelivery['backgroundToolResultBatch'] | null>;
  beginAgentBackgroundToolResultBatchDispatch: (
    input: AgentBackgroundToolResultBatchOwnerInput & { batchId: string; dispatchId: string },
  ) => Promise<boolean>;
  confirmAgentBackgroundToolResultBatch: (
    input: AgentBackgroundToolResultBatchOwnerInput & { batchId: string },
  ) => Promise<boolean>;
  settleAgentTriggerHandlingOutcome: (
    input: SettleAgentTriggerHandlingOutcomeInput,
  ) => Promise<boolean>;
  admitAgentEventActorAction: (input: AdmitAgentEventActorActionInput) => Promise<boolean>;
  releaseAgentEventActorAction: (input: AgentEventActorActionAdmissionInput) => Promise<boolean>;
  getAgentEventActorActionAdmission: (
    input: GetAgentEventActorReceiptInput,
  ) => Promise<string | null>;
  hasAgentEventActorActionAdmission: (
    input: AgentEventActorActionAdmissionInput,
  ) => Promise<boolean>;
  reserveAgentEventActorDetachedAction: (
    input: ReserveAgentEventActorDetachedActionInput,
  ) => Promise<{
    status: 'reserved' | 'replay' | 'conflict';
    action: AgentEventActorDetachedAction;
  }>;
  markAgentEventActorDetachedActionRunning: (
    input: MarkAgentEventActorDetachedActionRunningInput,
  ) => Promise<AgentEventActorDetachedTransitionResult>;
  markAgentEventActorDetachedActionLaunchIndeterminate: (
    input: UpdateAgentEventActorDetachedActionInput,
  ) => Promise<AgentEventActorDetachedTransitionResult>;
  settleAgentEventActorDetachedAction: (
    input: SettleAgentEventActorDetachedActionInput,
  ) => Promise<AgentEventActorDetachedTransitionResult>;
  getAgentEventActorDetachedAction: (
    input: GetAgentEventActorReceiptInput & { generationCreatedAt: number },
  ) => Promise<AgentEventActorDetachedAction | null>;
  settleAgentEventActorReceipt: (input: SettleAgentEventActorReceiptInput) => Promise<boolean>;
  getAgentEventActorReceipt: (
    input: GetAgentEventActorReceiptInput,
  ) => Promise<AgentEventActorReceipt | null>;
  backfillAgentEventActorReceipt: (input: BackfillAgentEventActorReceiptInput) => Promise<boolean>;
  getAgentEventActorReceiptStorageMetrics: (
    now: Date,
  ) => Promise<AgentEventActorReceiptStorageMetrics>;
  retryAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      availableAt: Date;
    },
  ) => Promise<boolean>;
  deadLetterAgentTriggerDelivery: (
    input: AgentTriggerDeliveryFence & {
      attempt: number;
      error: AgentTriggerDeliveryFailure;
      settledAt: Date;
      /** When the dead letter expires; absent keeps it until an operator acts. */
      expiresAt?: Date;
      receiptRetryAt?: Date;
    },
    recovery?: { required: boolean },
  ) => Promise<boolean>;
  getAgentTriggerDelivery: (deliveryKey: string) => Promise<AgentTriggerDeliveryRecord | null>;
  getAgentTriggerDeliveryStatus: (
    deliveryKey: string,
    user: string | Types.ObjectId,
    sourceKeyId: string,
    tenantId?: string,
  ) => Promise<AgentTriggerDeliveryStatusRecord | null>;
  getAgentTriggerDeadLetters: (limit?: number) => Promise<AgentTriggerDeliveryRecord[]>;
  requeueAgentTriggerDelivery: (
    id: string,
    availableAt: Date,
  ) => Promise<AgentTriggerDeliveryRecord | null>;
  countActiveAgentTriggerDeliveriesByUser: (
    user: string | Types.ObjectId,
    now: Date,
  ) => Promise<number>;
  recoverAgentTriggerLanePublications: (
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<number>;
  recoverAgentTriggerBatchReceipts: (
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<number>;
  reclaimInactiveAgentTriggerLanes: (
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<number>;
  prepareAgentTriggerUserPurge: (
    user: string | Types.ObjectId,
    fenceStartedAt: Date,
    tenantId?: string,
  ) => Promise<void>;
  cancelAgentTriggerUserPurge: (
    user: string | Types.ObjectId,
    fenceStartedAt: Date,
  ) => Promise<boolean>;
  recoverAgentTriggerUserPurges: (limit?: number, activity?: { found: boolean }) => Promise<number>;
  deleteAgentTriggerDeliveriesByUser: (user: string | Types.ObjectId) => Promise<void>;
  eraseAgentTriggerDeliveryConversationResults: (
    user: string | Types.ObjectId,
    conversationIds: string[],
  ) => Promise<void>;
  prepareAgentTriggerConversationResultErasure: (
    user: string | Types.ObjectId,
    conversationIds: string[],
  ) => Promise<void>;
}

/**
 * The trigger delivery methods on the mongoose models: the protocol of `./triggerDeliveryRules`
 * on the models themselves (the same driver calls as before, in the same order), plus the insert,
 * the index build, the receipt aggregation and the id check.
 */
export function createAgentTriggerDeliveryMethods(
  mongoose: typeof import('mongoose'),
  deps: {
    releaseBatchProjections?: TriggerDeliveryRulesDeps['releaseBatchProjections'];
    purgeQueuedTurnsForUser?: (user: string | Types.ObjectId) => Promise<unknown>;
  } = {},
): AgentTriggerDeliveryMethods {
  const Delivery = () =>
    mongoose.models.AgentTriggerDelivery as Model<IAgentTriggerDeliveryDocument>;
  const LaneSequence = () =>
    mongoose.models.AgentTriggerLaneSequence as Model<IAgentTriggerLaneSequenceDocument>;
  const UserPurge = () =>
    mongoose.models.AgentTriggerUserPurge as Model<IAgentTriggerUserPurgeDocument>;
  /** A mongoose model is the lean query subset the rules run on. */
  const collection = (model: unknown): TriggerDeliveryCollection =>
    model as unknown as TriggerDeliveryCollection;
  return createAgentTriggerDeliveryMethodsOnSteps(
    {
      deliveries: () => collection(mongoose.models.AgentTriggerDelivery),
      lanes: () => collection(mongoose.models.AgentTriggerLaneSequence),
      purges: () => collection(mongoose.models.AgentTriggerUserPurge),
      users: () => collection(mongoose.models.User),
      conversations: () => collection(mongoose.models.Conversation),
      async createDelivery(document: TriggerDeliveryFilter) {
        const created = await Delivery().create(document);
        return created.toObject();
      },
      async buildIndexes() {
        await Promise.all([
          createIndexesWithRetry(Delivery()),
          createIndexesWithRetry(LaneSequence()),
          createIndexesWithRetry(UserPurge()),
        ]);
      },
      countReceiptsByResolution: () =>
        Delivery().aggregate<{
          _id: AgentEventActorReceipt['resolution'];
          count: number;
        }>([
          { $match: { actorReceipt: { $exists: true } } },
          { $group: { _id: '$actorReceipt.resolution', count: { $sum: 1 } } },
        ]),
      isDuplicateKey: (error) => (error as DuplicateKeyError)?.code === DUPLICATE_KEY,
      isStoreId: (value) => mongoose.isObjectIdOrHexString(value),
    },
    deps as TriggerDeliveryRulesDeps,
  ) as AgentTriggerDeliveryMethods;
}

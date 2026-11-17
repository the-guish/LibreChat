import type { FilterQuery, Model, Types } from 'mongoose';
import type {
  IAgentQueuedTurn,
  IAgentQueuedTurnDocument,
  IAgentQueuedTurnSequence,
  IAgentQueuedTurnSequenceDocument,
  AgentQueuedTurnRecord,
  AgentQueuedTurnActiveRecord,
  AgentQueuedTurnFailure,
  AgentQueuedTurnOwnerScope,
  AgentQueuedTurnConversationScope,
  AgentQueuedTurnDeletionTarget,
  EnqueueAgentQueuedTurnInput,
  AgentQueuedTurnClaimFence,
  CancelAgentQueuedTurnResult,
  ReleaseAgentQueuedTurnResult,
  AdmitAgentQueuedTurnResult,
  DeadLetterAgentQueuedTurnResult,
  ScheduleAgentQueuedTurnResult,
  ReserveAgentQueuedTurnDeliveryResult,
  ClaimAgentQueuedTurnResult,
  BeginAgentQueuedTurnAdmissionResult,
  AgentQueuedTurnAdmissionEvidence,
  AgentQueuedTurnPredecessor,
  ClaimAgentQueuedTurnReconciliationInput,
} from '~/types/queuedTurn';
import type { QueuedTurnCollectionSteps, QueuedTurnQuery } from './queuedTurnRules';
import {
  laneKey,
  conversationScope,
  conversationFields,
  requireBoundedString,
  createAgentQueuedTurnProtocol,
} from './queuedTurnRules';
import { createIndexesWithRetry } from '~/utils/retry';

/** The rules shared with the PostgreSQL store; the error classes are the same classes. */
export {
  MAX_ACTIVE_AGENT_QUEUED_TURNS,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnLaneRetiredError,
} from './queuedTurnRules';

const DUPLICATE_KEY = 11000;
const CLAIM_LANE_INDEX = 'agent_queued_turn_claim_lane';
const ADMISSION_STARTED_LANE_INDEX = 'agent_queued_turn_admission_started_lane';
const NAMESPACE_EXISTS = 48;

interface DuplicateKeyError {
  code?: number;
}

interface DuplicateAdmissionLane {
  _id: {
    tenantId?: string | null;
    user: Types.ObjectId;
    conversationId: string;
    laneId: string;
  };
  count: number;
}

export type {
  AgentQueuedTurnOwnerScope,
  AgentQueuedTurnConversationScope,
  AgentQueuedTurnDeletionTarget,
  EnqueueAgentQueuedTurnInput,
  AgentQueuedTurnClaimFence,
  CancelAgentQueuedTurnResult,
  ReleaseAgentQueuedTurnResult,
  AdmitAgentQueuedTurnResult,
  DeadLetterAgentQueuedTurnResult,
  ScheduleAgentQueuedTurnResult,
  ReserveAgentQueuedTurnDeliveryResult,
  ClaimAgentQueuedTurnResult,
  BeginAgentQueuedTurnAdmissionResult,
  AgentQueuedTurnAdmissionEvidence,
  AgentQueuedTurnPredecessor,
  ClaimAgentQueuedTurnReconciliationInput,
} from '~/types/queuedTurn';

export interface AgentQueuedTurnMethods {
  ensureAgentQueuedTurnIndexes: () => Promise<void>;
  enqueueAgentQueuedTurn: (
    input: EnqueueAgentQueuedTurnInput,
  ) => Promise<{ turn: AgentQueuedTurnRecord; replayed: boolean }>;
  getAgentQueuedTurnByClientRequestId: (
    input: AgentQueuedTurnConversationScope & { clientRequestId: string },
  ) => Promise<AgentQueuedTurnRecord | null>;
  listActiveAgentQueuedTurns: (
    input: AgentQueuedTurnConversationScope & { limit?: number },
  ) => Promise<AgentQueuedTurnActiveRecord[]>;
  listAgentQueuedTurnReceipts: (
    input: AgentQueuedTurnConversationScope & { clientRequestIds?: readonly string[] },
  ) => Promise<AgentQueuedTurnActiveRecord[]>;
  findQueuedTurnsNeedingDelivery: (
    limit?: number,
    activity?: { found: boolean },
  ) => Promise<AgentQueuedTurnRecord[]>;
  claimQueuedTurnsForAdmissionReconciliation: (
    input: ClaimAgentQueuedTurnReconciliationInput,
    activity?: { found: boolean },
  ) => Promise<AgentQueuedTurnRecord[]>;
  deferAgentQueuedTurnAdmissionReconciliation: (
    input: AgentQueuedTurnConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      claimId: string;
      claimBy: string;
      availableAt: Date;
    },
  ) => Promise<boolean>;
  reserveAgentQueuedTurnDelivery: (
    input: AgentQueuedTurnConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
    },
  ) => Promise<ReserveAgentQueuedTurnDeliveryResult>;
  markQueuedTurnScheduled: (
    input: AgentQueuedTurnConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      scheduledAt?: Date;
    },
  ) => Promise<ScheduleAgentQueuedTurnResult>;
  cancelAgentQueuedTurn: (
    input: AgentQueuedTurnOwnerScope & {
      queuedTurnId: string;
      conversationId?: string;
      settledAt?: Date;
    },
  ) => Promise<CancelAgentQueuedTurnResult>;
  claimNextAgentQueuedTurn: (
    input: AgentQueuedTurnConversationScope & {
      queuedTurnId: string;
      claimId: string;
      claimBy: string;
      now: Date;
      leaseUntil: Date;
    },
  ) => Promise<ClaimAgentQueuedTurnResult>;
  releaseAgentQueuedTurn: (
    input: AgentQueuedTurnClaimFence &
      (
        | { disposition: 'retry'; availableAt: Date }
        | {
            disposition: 'dead';
            settledAt: Date;
            failure: AgentQueuedTurnFailure;
          }
      ),
  ) => Promise<ReleaseAgentQueuedTurnResult>;
  beginAgentQueuedTurnAdmission: (
    input: AgentQueuedTurnClaimFence & {
      admissionId: string;
      startedAt: Date;
      admissionProtocolVersion?: 2;
    },
  ) => Promise<BeginAgentQueuedTurnAdmissionResult>;
  markAgentQueuedTurnAdmitted: (
    input: AgentQueuedTurnClaimFence & {
      admissionId: string;
      admissionMode: 'warm' | 'ordinary';
      generationId?: string;
      generationCreatedAt?: number;
      effectivePredecessorCreatedAt?: number;
      lineagePredecessorId?: string;
      settledAt: Date;
    },
  ) => Promise<AdmitAgentQueuedTurnResult>;
  hasAgentQueuedTurnAdmissionReceipt: (
    input: AgentQueuedTurnConversationScope & {
      queuedTurnId: string;
      admissionId: string;
      generationId: string;
      generationCreatedAt: number;
      effectivePredecessorCreatedAt?: number;
      lineagePredecessorId?: string;
    },
  ) => Promise<boolean>;
  deadLetterAgentQueuedTurn: (
    input: AgentQueuedTurnConversationScope & {
      queuedTurnId: string;
      deliveryKey: string;
      settledAt: Date;
      failure: AgentQueuedTurnFailure;
      admissionEvidence?: AgentQueuedTurnAdmissionEvidence;
      reconciliationClaimId?: string;
      reconciliationClaimBy?: string;
    },
  ) => Promise<DeadLetterAgentQueuedTurnResult>;
  getEffectiveAgentQueuedTurnPredecessor: (
    input: AgentQueuedTurnConversationScope & {
      sequence: number;
      rootParentMessageId: string;
      expectedPredecessorCreatedAt?: number;
      allowLegacyPredecessorInference?: boolean;
    },
  ) => Promise<AgentQueuedTurnPredecessor | null>;
  deleteAgentQueuedTurns: (
    input: AgentQueuedTurnOwnerScope & { conversationId?: string },
  ) => Promise<number>;
  prepareAgentQueuedTurnConversationDeletion: (input: {
    user: Types.ObjectId;
    targets: readonly AgentQueuedTurnDeletionTarget[];
    settledAt?: Date;
  }) => Promise<string[]>;
  deletePreparedAgentQueuedTurnConversations: (input: {
    user: Types.ObjectId;
    targets: readonly AgentQueuedTurnDeletionTarget[];
  }) => Promise<number>;
  markAgentQueuedTurnDeliveryRetired: (input: { deliveryKey: string }) => Promise<boolean>;
  beginAgentQueuedTurnMissingDeliveryRetirement: (input: {
    deliveryKey: string;
  }) => Promise<boolean>;
  markAgentQueuedTurnMissingDeliveryRetired: (input: { deliveryKey: string }) => Promise<boolean>;
  deleteAllAgentQueuedTurnsForUser: (input: { user: Types.ObjectId }) => Promise<number>;
}

/**
 * The protocol's storage steps on `model`, each one driver call with the options the protocol
 * names (`lean` reads, `new: true` updates), so the calls and their order are those the
 * protocol makes.
 */
function modelSteps<T, D>(model: () => Model<D>): QueuedTurnCollectionSteps<T> {
  const filterOf = (filter: QueuedTurnQuery) => filter as FilterQuery<D>;
  return {
    findOne(filter, options = {}) {
      let query = model().findOne(filterOf(filter));
      if (options.sort != null) query = query.sort(options.sort);
      if (options.select != null) query = query.select(options.select);
      return query.lean<T>() as unknown as Promise<T | null>;
    },
    find(filter, options = {}) {
      let query = model().find(filterOf(filter));
      if (options.sort != null) query = query.sort(options.sort);
      if (options.limit != null) query = query.limit(options.limit);
      if (options.select != null) query = query.select(options.select);
      return query.lean<T[]>() as unknown as Promise<T[]>;
    },
    exists: (filter) =>
      model().exists(filterOf(filter)) as unknown as Promise<{ _id: unknown } | null>,
    distinct: (path, filter) =>
      model().distinct(path, filterOf(filter)) as unknown as Promise<unknown[]>,
    create: async (document) => (await model().create(document)).toObject() as T,
    findOneAndUpdate(filter, update, options = {}) {
      return model()
        .findOneAndUpdate(filterOf(filter), update, {
          new: true,
          ...(options.sort != null && { sort: options.sort }),
          ...(options.upsert != null && { upsert: options.upsert }),
        })
        .lean<T>() as unknown as Promise<T | null>;
    },
    updateOne: (filter, update) =>
      model().updateOne(filterOf(filter), update) as unknown as Promise<{
        matchedCount: number;
        modifiedCount: number;
      }>,
    updateMany: (filter, update) => model().updateMany(filterOf(filter), update),
    deleteMany: (filter) =>
      model().deleteMany(filterOf(filter)) as unknown as Promise<{ deletedCount: number }>,
  };
}

export function createAgentQueuedTurnMethods(
  mongoose: typeof import('mongoose'),
): AgentQueuedTurnMethods {
  const Turn = () => mongoose.models.AgentQueuedTurn as Model<IAgentQueuedTurnDocument>;
  const Sequence = () =>
    mongoose.models.AgentQueuedTurnSequence as Model<IAgentQueuedTurnSequenceDocument>;

  /** Pre-fence replicas could start two admissions after the first owner moved
   * to a legacy dead shell. Such a lane has no reconstructible total order.
   * Retire it and terminalize every nonterminal row before installing the
   * unique fence so upgrades remain available without guessing at ordering. */
  async function quarantineDuplicateAdmissionLanes(): Promise<number> {
    const lanes = await Turn().aggregate<DuplicateAdmissionLane>([
      {
        $match: {
          $or: [{ status: 'claimed' }, { admissionStartedAt: { $exists: true } }],
        },
      },
      {
        $group: {
          _id: {
            tenantId: '$tenantId',
            user: '$user',
            conversationId: '$conversationId',
            laneId: '$laneId',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]);
    for (const lane of lanes) {
      const scopeInput: AgentQueuedTurnConversationScope = {
        user: lane._id.user,
        ...(lane._id.tenantId != null && { tenantId: lane._id.tenantId }),
        conversationId: requireBoundedString(lane._id.conversationId, 256),
      };
      const scope = conversationScope(scopeInput);
      const laneId = requireBoundedString(lane._id.laneId, 128);
      const settledAt = new Date();
      await Sequence().updateOne(
        { _id: laneKey(scopeInput), ...scope },
        {
          $set: { retiredAt: settledAt },
          $setOnInsert: { ...conversationFields(scopeInput), laneId, value: 0 },
          $unset: {
            reservationId: 1,
            writerId: 1,
            writerUntil: 1,
            expiresAt: 1,
          },
        },
        { upsert: true },
      );
      await Turn().updateMany(
        {
          ...scope,
          laneId,
          $or: [
            { status: { $in: ['reserving', 'queued', 'claimed'] } },
            { admissionStartedAt: { $exists: true } },
          ],
        },
        {
          $set: {
            status: 'dead',
            terminalReceipt: {
              outcome: 'dead',
              settledAt,
              failure: {
                code: 'QUEUED_TURN_ADMISSION_ORDER_UNAVAILABLE',
                message:
                  'Multiple queued turns crossed the admission boundary without a durable order. Delete or replace this conversation before continuing.',
              },
            },
          },
          $unset: {
            activeSlot: 1,
            admissionSlot: 1,
            claimId: 1,
            claimBy: 1,
            claimUntil: 1,
            admissionId: 1,
            admissionStartedAt: 1,
            admissionEffectivePredecessorCreatedAt: 1,
            admissionLineagePredecessorId: 1,
            admissionProtocolVersion: 1,
            reconciliationAvailableAt: 1,
            reconciliationClaimId: 1,
            reconciliationClaimBy: 1,
            reconciliationClaimUntil: 1,
          },
        },
      );
    }
    return lanes.length;
  }

  async function ensureAgentQueuedTurnIndexes(): Promise<void> {
    for (const model of [Turn(), Sequence()]) {
      await model.createCollection().catch((error: unknown) => {
        if ((error as DuplicateKeyError).code !== NAMESPACE_EXISTS) {
          throw error;
        }
      });
    }
    const indexNames = new Set((await Turn().listIndexes()).map((index) => index.name));
    if (!indexNames.has(CLAIM_LANE_INDEX) || !indexNames.has(ADMISSION_STARTED_LANE_INDEX)) {
      for (let attempt = 0; ; attempt++) {
        await quarantineDuplicateAdmissionLanes();
        try {
          await createIndexesWithRetry(Turn());
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            attempt >= 4 ||
            (error as DuplicateKeyError).code !== DUPLICATE_KEY ||
            (!message.includes(CLAIM_LANE_INDEX) && !message.includes(ADMISSION_STARTED_LANE_INDEX))
          ) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
      }
    } else {
      await createIndexesWithRetry(Turn());
    }
    await createIndexesWithRetry(Sequence());
  }

  return {
    ensureAgentQueuedTurnIndexes,
    ...createAgentQueuedTurnProtocol({
      turns: modelSteps<IAgentQueuedTurn, IAgentQueuedTurnDocument>(Turn),
      lanes: modelSteps<IAgentQueuedTurnSequence, IAgentQueuedTurnSequenceDocument>(Sequence),
      isDuplicateKey: (error) => (error as DuplicateKeyError).code === DUPLICATE_KEY,
    }),
  };
}

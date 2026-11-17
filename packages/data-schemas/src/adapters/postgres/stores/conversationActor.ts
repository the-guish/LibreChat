/**
 * The subagent threads and the agent event actor of the PostgreSQL conversation store
 * (`./conversation`): the thread reads and the one-time reservation, the cross-replica lease, the
 * private event binding, the actor head committed by a full compare-and-set, the SDK suspension
 * fence, the legacy-turn fence, and the reconciliation journal with its storage metrics and the
 * bounded expiry sweep of legacy settled receipts. Filters and updates are the shared rules of
 * `~/methods/conversationRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Typed storage (docs/postgres-port/PHASE4.md §1.4): the journal
 * (`agentEventActorReconciliations`) and the cleanup list (`agentEventActorCleanup`) are child
 * tables, so its `$elemMatch` conditions (also under `$not`) are `EXISTS` over the rows, its
 * positional `$` writes update the first matching row and its `$pull`s delete by predicate,
 * through the primitive's lock and recheck (§3.5); the head (`agentEventActor`) is flattened
 * columns with three child tables of its own (`skillManifest`, `contextMeta.fadingTiers`,
 * `compactionSemanticIndex.entries`), replaced as a whole on every commit; the suspension
 * evidence is a `json` column.
 *
 * The head commit compares the expected head as a whole: its subdocuments and subdocument arrays
 * by value, which the query language cannot state. So the commit (and the stale closure of a
 * resumed commit, its negation) locks the conversation row, checks the head on the locked row
 * (`writeCheckedConversation`) and writes through the primitive with the rest of the condition.
 */
import { sql } from 'kysely';
import type {
  IAgentEventActorSnapshot,
  IActiveSubagentThreadLease,
  ISubagentThreadReservation,
} from '~/types';
import type { AgentEventActorCommitResult } from '~/methods/conversationRules';
import type { ConversationTables } from './conversationSupport';
import type { ConversationStore } from '~/ports/conversation';
import type { PostgresStoreContext } from './context';
import {
  nextActorState,
  legacyReceiptPull,
  actorCommitUpdate,
  threadTenantFilter,
  closeSuspensionUpdate,
  resumedCommitOutcome,
  holdsClosedSuspension,
  NO_OPEN_RECONCILIATION,
  actorSuspensionRecord,
  headOnCheckpointFilter,
  isVerifiableCheckpoint,
  expiredLegacyReceiptIds,
  expectedActorHeadFilter,
  legacyReceiptExpiryLimit,
  protectingDeliveryFilter,
  removableLegacyReceiptIds,
  subagentThreadReadRecord,
  agentEventBindingRecordOf,
  agentEventActorSnapshotOf,
  settlementAuthorityFilter,
  reconciliationTransition,
  assertReconciliationThread,
  AGENT_EVENT_BINDING_FIELDS,
  cancellableSuspensionFilter,
  SUBAGENT_THREAD_READ_FIELDS,
  suspensionPredecessorFilter,
  activeSubagentThreadLeasesOf,
  pendingReconciliationElement,
  exactReconciliationCheckpoint,
  validateAgentEventActorCommit,
  clearableReconciliationElement,
  resolvableReconciliationElement,
  reconciliationTransitionElement,
  AGENT_EVENT_ACTOR_SNAPSHOT_FIELDS,
  validateAgentEventActorSuspension,
  LEGACY_RECEIPT_EXPIRY_DEFAULT_LIMIT,
  AGENT_EVENT_ACTOR_RECEIPT_RETENTION_MS,
  validateAgentEventActorSuspensionClaim,
} from '~/methods/conversationRules';
import { matchesStoredState, writeCheckedConversation } from './conversationSupport';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { activeExpirationFilter } from '~/utils/retention';
import { runStoreSql, storeWhere } from './context';
import logger from '~/config/winston';

type ActorMethods = Pick<
  ConversationStore,
  | 'getSubagentThreadForParent'
  | 'listSubagentThreadsForParent'
  | 'reserveSubagentThread'
  | 'acquireSubagentThreadLease'
  | 'renewSubagentThreadLease'
  | 'releaseSubagentThreadLease'
  | 'countActiveSubagentThreadLeases'
  | 'listActiveSubagentThreadLeases'
  | 'getAgentEventBinding'
  | 'getAgentEventActorSnapshot'
  | 'commitAgentEventActorState'
  | 'storeAgentEventActorSuspension'
  | 'claimAgentEventActorSuspension'
  | 'settleAgentEventActorSuspension'
  | 'cancelAgentEventActorSuspension'
  | 'beginAgentEventActorLegacyTurn'
  | 'completeAgentEventActorLegacyTurn'
  | 'recordAgentEventActorReconciliation'
  | 'resolveAgentEventActorReconciliation'
  | 'clearAgentEventActorReconciliation'
  | 'getAgentEventActorReconciliationStorageMetrics'
  | 'expireLegacyAgentEventActorReceipts'
>;

/** The head fields the commit compares on the locked row. */
const ACTOR_HEAD_FIELDS = {
  agentEventActor: 1,
  agentEventActorEpoch: 1,
  agentEventActorLegacyTurn: 1,
} as const;

/** The fields a commit returns of the record it replaced. */
const ACTOR_COMMIT_RETURN = '+agentEventActor +agentEventActorSuspension';

const tenantOf = (tenantId?: string) => threadTenantFilter(tenantId);
const live = () => activeExpirationFilter();

export function createPostgresConversationActorMethods(
  context: PostgresStoreContext,
  tables: ConversationTables,
): ActorMethods {
  const conversations = () => tables.conversations();
  /** The legacy receipt sweep's page cursor, per store instance (as on MongoDB). */
  let legacyReceiptExpiryCursor: string | undefined;

  /** An event-bound subagent thread of the owner in its exact tenant. */
  const actorOwner = (input: { user: string; conversationId: string; tenantId?: string }) => ({
    user: input.user,
    conversationId: input.conversationId,
    subagentThread: { $exists: true },
    agentEventBinding: { $exists: true },
    ...tenantOf(input.tenantId),
    ...live(),
  });

  const getAgentEventActorSnapshot: ActorMethods['getAgentEventActorSnapshot'] = async (input) =>
    agentEventActorSnapshotOf(
      await conversations().findOne(actorOwner(input), {
        projection: AGENT_EVENT_ACTOR_SNAPSHOT_FIELDS,
      }),
    );

  const snapshotOf = (input: {
    user: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<IAgentEventActorSnapshot | undefined> => getAgentEventActorSnapshot(input);

  const methods: ActorMethods = {
    async getSubagentThreadForParent(input) {
      try {
        const conversation = await conversations().findOne(
          {
            user: input.user,
            conversationId: input.conversationId,
            'subagentThread.parentConversationId': input.parentConversationId,
            ...tenantOf(input.tenantId),
            ...live(),
          },
          { projection: SUBAGENT_THREAD_READ_FIELDS },
        );
        return conversation == null ? null : subagentThreadReadRecord(conversation);
      } catch (error) {
        logger.error('[getSubagentThreadForParent] Error getting child conversation', error);
        throw new Error('Error getting child conversation');
      }
    },

    async listSubagentThreadsForParent(input) {
      try {
        const found = await conversations().find(
          {
            user: input.user,
            'subagentThread.parentConversationId': input.parentConversationId,
            ...tenantOf(input.tenantId),
            ...live(),
          },
          {
            projection: SUBAGENT_THREAD_READ_FIELDS,
            sort: { updatedAt: -1, conversationId: 1, _id: 1 },
            limit: input.limit,
          },
        );
        return found.map(subagentThreadReadRecord);
      } catch (error) {
        logger.error('[listSubagentThreadsForParent] Error listing child conversations', error);
        throw new Error('Error listing child conversations');
      }
    },

    async reserveSubagentThread(input): Promise<ISubagentThreadReservation> {
      const filter = {
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null
          ? { tenantId: { $exists: false } }
          : { tenantId: input.tenantId }),
      };
      try {
        return await context.transactions.transaction(async (tx) => {
          const result = await conversations().updateOne(
            filter,
            {
              $setOnInsert: {
                ...input.conversation,
                user: input.user,
                conversationId: input.conversationId,
                messages: [],
              },
            },
            { upsert: true, tx },
          );
          const conversation = await conversations().findOne(
            result.upsertedId != null ? { _id: result.upsertedId } : filter,
            { projection: '+agentEventBinding', tx },
          );
          if (conversation == null) {
            throw new Error('Unable to reserve the subagent thread.');
          }
          return { conversation, created: result.upsertedId != null };
        });
      } catch (error) {
        /** Concurrent reservations can race at the unique index. The record that won is the
         * reservation; callers still validate its immutable lineage before use. */
        if (error instanceof StoreDuplicateKeyError) {
          const existing = await conversations().findOne(filter, {
            projection: '+agentEventBinding',
          });
          if (existing != null) {
            return { conversation: existing, created: false };
          }
        }
        throw error;
      }
    },

    async acquireSubagentThreadLease(input) {
      const result = await conversations().updateOne(
        {
          user: input.user,
          conversationId: input.conversationId,
          subagentThread: { $exists: true },
          ...tenantOf(input.tenantId),
          $or: [
            { subagentThreadLease: { $exists: false } },
            { 'subagentThreadLease.expiresAt': { $lte: input.now } },
            { 'subagentThreadLease.token': input.token },
          ],
        },
        {
          $set: {
            subagentThreadLease: {
              token: input.token,
              taskId: input.taskId,
              expiresAt: input.expiresAt,
            },
            /** Child threads are hidden from normal recents. Stamp the task start explicitly so
             * bounded parent discovery promotes real new activity; automatic timestamps stay
             * disabled for lease heartbeats/releases. */
            updatedAt: input.now,
          },
        },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },

    async renewSubagentThreadLease(input) {
      const result = await conversations().updateOne(
        {
          user: input.user,
          conversationId: input.conversationId,
          ...tenantOf(input.tenantId),
          'subagentThreadLease.token': input.token,
          'subagentThreadLease.expiresAt': { $gt: input.now },
        },
        { $set: { 'subagentThreadLease.expiresAt': input.expiresAt } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },

    async releaseSubagentThreadLease(input) {
      const result = await conversations().updateOne(
        {
          user: input.user,
          conversationId: input.conversationId,
          ...tenantOf(input.tenantId),
          'subagentThreadLease.token': input.token,
        },
        { $unset: { subagentThreadLease: 1 } },
        { timestamps: false },
      );
      return result.modifiedCount === 1;
    },

    countActiveSubagentThreadLeases(input) {
      return conversations().count({
        user: input.user,
        ...tenantOf(input.tenantId),
        'subagentThreadLease.expiresAt': { $gt: input.now },
      });
    },

    async listActiveSubagentThreadLeases(input): Promise<IActiveSubagentThreadLease[]> {
      const found = await conversations().find(
        {
          user: input.user,
          ...tenantOf(input.tenantId),
          'subagentThreadLease.expiresAt': { $gt: input.now },
        },
        { projection: 'conversationId subagentThread.parentConversationId +subagentThreadLease' },
      );
      return activeSubagentThreadLeasesOf(found);
    },

    async getAgentEventBinding(input) {
      return agentEventBindingRecordOf(
        await conversations().findOne(
          {
            user: input.user,
            'agentEventBinding.bindingId': input.bindingId,
            'agentEventBinding.sourceKeyId': input.sourceKeyId,
            ...tenantOf(input.tenantId),
            ...live(),
          },
          { projection: AGENT_EVENT_BINDING_FIELDS },
        ),
      );
    },

    getAgentEventActorSnapshot,

    async storeAgentEventActorSuspension(input) {
      validateAgentEventActorSuspension(
        input.conversationId,
        input.suspension,
        input.actionId,
        input.jobCreatedAt,
        input.previous,
      );
      /** The predecessor clause follows the expiration clause in one object literal, as on
       * MongoDB: a first suspension's `$or` replaces the expiration `$or` (NOTE(contract)). */
      const ownership = {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        agentEventBinding: { $exists: true },
        agentEventActorReconciliations: {
          $elemMatch: {
            invocationId: input.suspension.invocation.invocationId,
            status: 'invocation_pending',
          },
        },
        ...tenantOf(input.tenantId),
        ...live(),
        ...suspensionPredecessorFilter(input.previous),
      };
      const suspension = actorSuspensionRecord(input);
      let stored = await conversations().findOneAndUpdate(
        {
          ...ownership,
          ...(input.invalidateHead === true ? { agentEventActor: { $exists: true } } : {}),
        },
        {
          $set: {
            agentEventActorSuspension: suspension,
            ...(input.invalidateHead === true ? { 'agentEventActor.requiresColdStart': true } : {}),
          },
        },
        { returnDocument: 'before', timestamps: false, projection: '_id' },
      );
      /** A headless actor is already guaranteed to cold-start; publish the successor without
       * manufacturing a partial canonical state. */
      if (stored == null && input.invalidateHead === true) {
        stored = await conversations().findOneAndUpdate(
          { ...ownership, agentEventActor: { $exists: false } },
          { $set: { agentEventActorSuspension: suspension } },
          { returnDocument: 'before', timestamps: false, projection: '_id' },
        );
      }
      return { status: stored == null ? 'stale' : 'stored' };
    },

    async claimAgentEventActorSuspension(input) {
      validateAgentEventActorSuspensionClaim(input);
      const claimed = await conversations().findOneAndUpdate(
        {
          user: input.user,
          conversationId: input.conversationId,
          subagentThread: { $exists: true },
          agentEventBinding: { $exists: true },
          'agentEventActorSuspension.status': { $in: ['pending', 'pending_owned'] },
          'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
          'agentEventActorSuspension.suspension.attempt': input.attempt,
          'agentEventActorSuspension.actionId': input.actionId,
          'agentEventActorSuspension.jobCreatedAt': input.jobCreatedAt,
          ...tenantOf(input.tenantId),
          ...live(),
        },
        {
          $set: {
            'agentEventActorSuspension.status': 'claimed_owned',
            'agentEventActorSuspension.resumeAttemptId': input.resumeAttemptId,
            'agentEventActorSuspension.observedAt': new Date(),
          },
          $unset: {
            'agentEventActorSuspension.outcome': 1,
            'agentEventActorSuspension.closedAt': 1,
          },
        },
        { returnDocument: 'before', timestamps: false, projection: '_id' },
      );
      return { status: claimed == null ? 'stale' : 'claimed' };
    },

    async settleAgentEventActorSuspension(input) {
      const settled = await conversations().findOneAndUpdate(
        {
          user: input.user,
          conversationId: input.conversationId,
          'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
          'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
          'agentEventActorSuspension.suspension.attempt': input.attempt,
          'agentEventActorSuspension.resumeAttemptId': input.resumeAttemptId,
          agentEventActorReconciliations: {
            $elemMatch: pendingReconciliationElement(input.invocationId, input.checkpoint),
          },
          ...tenantOf(input.tenantId),
        },
        {
          $set: closeSuspensionUpdate('settled'),
          $pull: {
            agentEventActorReconciliations: pendingReconciliationElement(
              input.invocationId,
              input.checkpoint,
            ),
          },
        },
        { returnDocument: 'before', timestamps: false, projection: '_id' },
      );
      if (settled != null) {
        return { status: 'settled' };
      }
      return holdsClosedSuspension(await snapshotOf(input), 'settled', input)
        ? { status: 'settled' }
        : { status: 'stale' };
    },

    async cancelAgentEventActorSuspension(input) {
      const cancelled = await conversations().findOneAndUpdate(
        {
          user: input.user,
          conversationId: input.conversationId,
          ...cancellableSuspensionFilter(input.claimedResumeAttemptId),
          'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
          'agentEventActorSuspension.suspension.attempt': input.attempt,
          agentEventActorReconciliations: {
            $elemMatch: pendingReconciliationElement(input.invocationId, input.checkpoint),
          },
          ...tenantOf(input.tenantId),
        },
        {
          $set: closeSuspensionUpdate('cancelled'),
          $pull: {
            agentEventActorReconciliations: pendingReconciliationElement(
              input.invocationId,
              input.checkpoint,
            ),
          },
        },
        { returnDocument: 'before', timestamps: false, projection: '_id' },
      );
      if (cancelled != null) {
        return { status: 'cancelled' };
      }
      return holdsClosedSuspension(await snapshotOf(input), 'cancelled', {
        suspensionId: input.suspensionId,
        attempt: input.attempt,
      })
        ? { status: 'cancelled' }
        : { status: 'stale' };
    },

    async commitAgentEventActorState(input): Promise<AgentEventActorCommitResult> {
      validateAgentEventActorCommit(input);
      const expected = expectedActorHeadFilter(input);
      const claim = {
        ...actorOwner(input),
        agentEventActorReconciliations: {
          $elemMatch: { invocationId: input.invocationId, status: 'invocation_pending' },
        },
        ...settlementAuthorityFilter(input.settlementAuthority),
      };
      const nextState = nextActorState(input);
      const previous = await writeCheckedConversation(context, {
        filter: claim,
        projection: ACTOR_HEAD_FIELDS,
        check: (record) => matchesStoredState(record, expected),
        write: (id, tx) =>
          conversations().findOneAndUpdate(
            { ...claim, _id: id },
            actorCommitUpdate(input, nextState),
            {
              returnDocument: 'before',
              timestamps: false,
              projection: ACTOR_COMMIT_RETURN,
              tx,
            },
          ),
      });
      if (previous != null) {
        return {
          status: 'committed',
          state: nextState,
          ...(previous.agentEventActor?.previousCheckpoint == null
            ? {}
            : { prunableCheckpoint: previous.agentEventActor.previousCheckpoint }),
        };
      }
      if (input.settlementAuthority != null) {
        /** A resumed action must close its claim even when another head won. The negated
         * head check makes this mutually exclusive with the commit above; the retained closure
         * is the ambiguous-reply receipt. */
        const closedStale = await writeCheckedConversation(context, {
          filter: claim,
          projection: ACTOR_HEAD_FIELDS,
          check: (record) => !matchesStoredState(record, expected),
          write: (id, tx) =>
            conversations().findOneAndUpdate(
              { ...claim, _id: id },
              { $set: closeSuspensionUpdate('stale') },
              {
                returnDocument: 'before',
                timestamps: false,
                projection: ACTOR_COMMIT_RETURN,
                tx,
              },
            ),
        });
        if (closedStale != null) {
          return {
            status: 'stale',
            ...(closedStale.agentEventActor == null ? {} : { state: closedStale.agentEventActor }),
          };
        }
        return resumedCommitOutcome(await snapshotOf(input), input.settlementAuthority);
      }
      const current = await snapshotOf(input);
      return {
        status: 'stale',
        ...(current?.state == null ? {} : { state: current.state }),
      };
    },

    async beginAgentEventActorLegacyTurn(input) {
      const ownership = {
        ...actorOwner(input),
        agentEventActorLegacyTurn: { $exists: false },
        ...NO_OPEN_RECONCILIATION,
      };
      const legacyTurn = { token: input.token, startedAt: new Date() };
      /** Mutually exclusive classic updates for the headful and headless shapes, as on
       * MongoDB. A head cannot appear between them without first creating an unresolved fork
       * lifecycle, which the shared ownership filter rejects. */
      const openedWithHead = await conversations().findOneAndUpdate(
        { ...ownership, 'agentEventActor.generation': { $exists: true } },
        {
          $set: {
            agentEventActorLegacyTurn: legacyTurn,
            'agentEventActor.requiresColdStart': true,
          },
        },
        { returnDocument: 'after', timestamps: false, projection: '_id' },
      );
      if (openedWithHead != null) {
        return true;
      }
      const openedHeadless = await conversations().findOneAndUpdate(
        { ...ownership, 'agentEventActor.generation': { $exists: false } },
        { $set: { agentEventActorLegacyTurn: legacyTurn } },
        { returnDocument: 'after', timestamps: false, projection: '_id' },
      );
      return openedHeadless != null;
    },

    async completeAgentEventActorLegacyTurn(input) {
      const sealed = await conversations().findOneAndUpdate(
        { ...actorOwner(input), 'agentEventActorLegacyTurn.token': input.token },
        { $unset: { agentEventActorLegacyTurn: 1 }, $inc: { agentEventActorEpoch: 1 } },
        { returnDocument: 'after', timestamps: false, projection: '_id' },
      );
      return sealed != null;
    },

    async recordAgentEventActorReconciliation(input) {
      assertReconciliationThread(input.conversationId, input.reconciliation.checkpoint.threadId);
      const ownership = actorOwner(input);
      const existing = await conversations().findOne(ownership, {
        projection: '+agentEventActorReconciliations',
      });
      const journal = existing?.agentEventActorReconciliations ?? [];
      const current = journal.find(
        (item) => item.invocationId === input.reconciliation.invocationId,
      );
      if (current != null) {
        const { confirmsActionAdmission, canTransition, sameIdentity } = reconciliationTransition(
          current,
          input.reconciliation,
        );
        /** A pending record is an exclusive ownership fence, not an idempotent receipt. A
         * second executor must not inherit the first owner's claim. */
        if (input.reconciliation.status === 'invocation_pending' && !confirmsActionAdmission) {
          return false;
        }
        if (!canTransition) {
          return sameIdentity;
        }
        const transitioned = await conversations().findOneAndUpdate(
          {
            ...ownership,
            agentEventActorReconciliations: {
              $elemMatch: reconciliationTransitionElement(current, confirmsActionAdmission),
            },
          },
          { $set: { 'agentEventActorReconciliations.$': input.reconciliation } },
          { returnDocument: 'after', timestamps: false, projection: '_id' },
        );
        return transitioned != null;
      }
      /** Every post-acquisition state must transition the exact pending lifecycle. Never
       * recreate a marker after terminal recovery has already removed it. */
      if (input.reconciliation.status !== 'invocation_pending') {
        return false;
      }
      const recorded = await conversations().findOneAndUpdate(
        {
          ...ownership,
          agentEventActorLegacyTurn: { $exists: false },
          ...NO_OPEN_RECONCILIATION,
          'agentEventActorReconciliations.invocationId': {
            $ne: input.reconciliation.invocationId,
          },
        },
        { $push: { agentEventActorReconciliations: input.reconciliation } },
        {
          returnDocument: 'after',
          timestamps: false,
          projection: '+agentEventActorReconciliations',
        },
      );
      /** Another writer won the same invocation fence while this write raced otherwise. */
      return (
        recorded?.agentEventActorReconciliations?.some(
          (item) => item.invocationId === input.reconciliation.invocationId,
        ) === true
      );
    },

    async resolveAgentEventActorReconciliation(input) {
      assertReconciliationThread(input.conversationId, input.checkpoint.threadId);
      const exactCheckpoint = exactReconciliationCheckpoint(input.invocationId, input.checkpoint);
      if (!isVerifiableCheckpoint(input.resolution, input.checkpoint)) {
        return false;
      }
      const owner = actorOwner(input);
      const options = { returnDocument: 'after' as const, timestamps: false, projection: '_id' };
      if (input.resolution === 'checkpoint_verified') {
        const settled = await conversations().findOneAndUpdate(
          {
            ...owner,
            ...headOnCheckpointFilter(input.checkpoint),
            agentEventActorReconciliations: {
              $elemMatch: { ...exactCheckpoint, status: 'history_persisted' },
            },
          },
          {
            $set: {
              'agentEventActorReconciliations.$.status': 'settled',
              'agentEventActorReconciliations.$.resolution': 'checkpoint_verified',
              'agentEventActorReconciliations.$.observedAt': new Date(),
            },
            $unset: { 'agentEventActorReconciliations.$.error': 1 },
          },
          options,
        );
        if (settled != null) {
          return true;
        }
        /** A verification retry may replay only a receipt that verification itself settled. A
         * compensated receipt must fail this resolve so the caller re-reads and honors the
         * compensation instead. */
        const replay = await conversations().exists({
          ...owner,
          ...headOnCheckpointFilter(input.checkpoint),
          agentEventActorReconciliations: {
            $elemMatch: {
              ...exactCheckpoint,
              status: 'settled',
              resolution: 'checkpoint_verified',
            },
          },
        });
        return replay != null;
      }
      const resolution = input.resolution;
      const checkpointFilter = resolvableReconciliationElement({ ...input, resolution });
      const ownership = {
        ...owner,
        agentEventActorReconciliations: { $elemMatch: checkpointFilter },
      };
      if (resolution === 'invocation_abandoned') {
        const abandoned = await conversations().findOneAndUpdate(
          ownership,
          { $pull: { agentEventActorReconciliations: checkpointFilter } },
          options,
        );
        return abandoned != null;
      }
      /** Repair and compensation both act on an invocation whose action already reached the
       * outside world, so the receipt survives as the durable same-invocation tombstone. */
      const retainedReceipt = {
        'agentEventActorReconciliations.$.status': 'settled',
        'agentEventActorReconciliations.$.resolution': resolution,
        'agentEventActorReconciliations.$.observedAt': new Date(),
      };
      const resolved = await conversations().findOneAndUpdate(
        { ...ownership, agentEventActor: { $exists: true } },
        { $set: { ...retainedReceipt, 'agentEventActor.requiresColdStart': true } },
        options,
      );
      if (resolved != null) {
        return true;
      }
      /** Compensation before a first committed head retires the exact fence without creating
       * a partial actor state that cannot be resumed. */
      const resolvedWithoutHead = await conversations().findOneAndUpdate(
        { ...ownership, agentEventActor: { $exists: false } },
        { $set: retainedReceipt },
        options,
      );
      if (resolvedWithoutHead != null) {
        return true;
      }
      /** A retried repair finds its own retained receipt already settled. */
      const replayed = await conversations().exists({
        ...owner,
        agentEventActorReconciliations: {
          $elemMatch: { ...exactCheckpoint, status: 'settled', resolution },
        },
      });
      return replayed != null;
    },

    async clearAgentEventActorReconciliation(input) {
      assertReconciliationThread(input.conversationId, input.checkpoint.threadId);
      if (!isVerifiableCheckpoint(input.resolution, input.checkpoint)) {
        return false;
      }
      const owner = actorOwner(input);
      const lifecycle = clearableReconciliationElement(input);
      const options = { returnDocument: 'after' as const, timestamps: false, projection: '_id' };
      const clearedWithHead = await conversations().findOneAndUpdate(
        {
          ...owner,
          agentEventActor: { $exists: true },
          ...(input.resolution === 'checkpoint_verified' &&
            headOnCheckpointFilter(input.checkpoint)),
          agentEventActorReconciliations: { $elemMatch: lifecycle },
        },
        {
          ...(input.resolution === 'checkpoint_verified'
            ? {}
            : { $set: { 'agentEventActor.requiresColdStart': true } }),
          $pull: { agentEventActorReconciliations: lifecycle },
        },
        options,
      );
      if (clearedWithHead != null) {
        return true;
      }
      if (input.resolution !== 'checkpoint_verified') {
        const clearedWithoutHead = await conversations().findOneAndUpdate(
          {
            ...owner,
            agentEventActor: { $exists: false },
            agentEventActorReconciliations: { $elemMatch: lifecycle },
          },
          { $pull: { agentEventActorReconciliations: lifecycle } },
          options,
        );
        if (clearedWithoutHead != null) {
          return true;
        }
      }
      const conflict = await conversations().exists({
        ...owner,
        agentEventActorReconciliations: { $elemMatch: { invocationId: input.invocationId } },
      });
      if (conflict != null) {
        return false;
      }
      return (await conversations().exists(owner)) != null;
    },

    async getAgentEventActorReconciliationStorageMetrics(now) {
      /** `count(*)` and `min` over the journal's child table, joined to the conversations of
       * the active tenant (the plugin scopes the aggregate on MongoDB). */
      const { rows } = await runStoreSql<{ pending: string | number; oldest: Date | null }>(
        context,
        sql`SELECT count(*) AS pending, min(c."observedAt") AS oldest
          FROM "conversations__agentEventActorReconciliations" c
          JOIN conversations t ON t._id = c._parent
          WHERE c."status" IS DISTINCT FROM 'settled' AND ${storeWhere(
            context,
            'conversations',
            {},
          )}`,
      );
      const pending = Number(rows[0]?.pending ?? 0);
      const oldest = rows[0]?.oldest;
      const oldestObservedAt = oldest == null ? undefined : new Date(oldest);
      return {
        pending,
        oldestPendingAgeSeconds:
          oldestObservedAt == null
            ? 0
            : Math.max(0, (now.getTime() - oldestObservedAt.getTime()) / 1000),
      };
    },

    async expireLegacyAgentEventActorReceipts(
      now,
      limit = LEGACY_RECEIPT_EXPIRY_DEFAULT_LIMIT,
      activity,
    ) {
      if (Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid date');
      }
      const boundedLimit = legacyReceiptExpiryLimit(limit);
      const cutoff = new Date(now.getTime() - AGENT_EVENT_ACTOR_RECEIPT_RETENTION_MS);
      /** Advance a bounded candidate page before querying delivery protection. Reaching the end
       * resets the cursor so newly expiry-eligible older rows enter the next sweep without
       * making any one pass collection-wide. */
      const candidates = await conversations().find(
        legacyReceiptExpiryCursor == null ? {} : { _id: { $gt: legacyReceiptExpiryCursor } },
        {
          projection: { _id: 1, agentEventActorReconciliations: 1 },
          sort: { _id: 1 },
          limit: boundedLimit,
        },
      );
      if (candidates.length === 0) {
        legacyReceiptExpiryCursor = undefined;
        return 0;
      }
      legacyReceiptExpiryCursor = String(candidates[candidates.length - 1]._id);
      /** A full page is not an empty sweep: later conversations may contain expired receipts. */
      if (activity != null && candidates.length === boundedLimit) activity.found = true;
      const expiredInvocationIds = expiredLegacyReceiptIds(candidates, cutoff);
      if (expiredInvocationIds.length === 0) return 0;
      if (activity != null) activity.found = true;
      const protectedInvocationIds = new Set(
        (await tables
          .triggerDeliveries()
          .distinct('deliveryKey', protectingDeliveryFilter(expiredInvocationIds))) as string[],
      );
      const operations = candidates.flatMap((candidate) => {
        const removable = removableLegacyReceiptIds(candidate, cutoff, protectedInvocationIds);
        return removable.length === 0
          ? []
          : [
              {
                updateOne: {
                  filter: { _id: String(candidate._id) },
                  update: legacyReceiptPull(removable, cutoff),
                },
              },
            ];
      });
      if (operations.length === 0) {
        return 0;
      }
      const result = await conversations().bulk(operations, { ordered: false, timestamps: false });
      return result.modifiedCount;
    },
  };
  return methods;
}

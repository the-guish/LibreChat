/**
 * The PostgreSQL `ScheduleStore` (`~/ports/schedule`) on the `schedules` and `scheduleruns`
 * tables, through the collection primitive, with the filters and updates of
 * `~/methods/scheduleRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Typed storage (docs/postgres-port/PHASE4.md §1.4): `cadence`, `deletionSuspension` and
 * `lastRun` are flattened into columns, `lastRun.mcp` and `scheduleruns.mcp` are child tables,
 * `countedFor` is a `timestamptz[]` (its `$push` with `$slice` keeps the newest 64 in counted
 * order), `mcpConsent` is `json`.
 *
 * Concurrency (§3.5): every guarded write is one primitive operation whose filter is re-evaluated
 * on the locked row, so of racing claims exactly one wins and every worker write stays fenced on
 * its claim token, expected next run and config revision. The due-schedule claim takes rows
 * oldest `nextRunAt` first with `SKIP LOCKED` (a queue claim). The MCP receipt predicates (`$nor`
 * with `'mcp.detail'` and `$elemMatch` on the run's child table) and the receipt `$addToSet` take
 * the primitive's lock and recheck in a new statement, so a receipt and a settlement racing on one
 * run linearize: whichever locks the row second sees the other's child rows. The partial unique
 * indexes decide the run slots (one `started` run per occurrence, per schedule and per capacity
 * slot), the per-owner schedule slots (rows being deleted excluded) and the create replay key
 * (rows being deleted included); a `StoreDuplicateKeyError` names the violated key's fields,
 * which map to the conflicts the port reports.
 *
 * Writes that leave `updatedAt` alone pass `timestamps: false`, as on MongoDB. The indexes come
 * with the migrations, so `ensureScheduleIndexes` resolves at once; the erased tombstones expire
 * through the TTL sweeper (`erasedAt`, partial on `erased = true`).
 */
import { randomUUID } from 'node:crypto';
import { projectScheduleMCPReceipt } from 'librechat-data-provider';
import type {
  ISchedule,
  IScheduleRun,
  RecordRunOutcomeParams,
  StartedRunReservation,
} from '~/types';
import type { ScheduleStore, ScheduleStoreData, ScheduleRunStoreData } from '~/ports/schedule';
import type { PostgresStoreContext } from './context';
import {
  restoreWrite,
  resumeLease,
  retryRestore,
  leaseRelease,
  bookkeptWrite,
  runProjectOf,
  holdsLiveLease,
  manualRunLease,
  scheduleAdvance,
  scheduleArming,
  scheduleDisable,
  tombstoneWrite,
  pauseTransition,
  suspensionWrite,
  abortClaimWrite,
  activeRunFilter,
  dueScheduleClaim,
  fireDetailsWrite,
  mcpReceiptWrite,
  stopAttemptWrite,
  terminalLastRun,
  resumeClaimWrite,
  abortRenewalWrite,
  eraseAttemptWrite,
  heldClaimFilter,
  lastRunProjection,
  runDeletionFilter,
  scheduleOwnerEdit,
  leaseReleaseFilter,
  liveScheduleFilter,
  resumeClaimRelease,
  terminalTransition,
  RESTORE_PROJECTION,
  capacityOccupancyOf,
  disabledReasonClear,
  ACTIVE_RUN_STATUSES,
  configRevisionFilter,
  ownerSchedulesFilter,
  reconciliationWindow,
  scheduleDeletionMark,
  terminalCounterWrite,
  unbookkeptRunsWindow,
  capacityHoldersFilter,
  SUSPENSION_PROJECTION,
  tombstoneContentFields,
  resumeLeaseConsumption,
  scheduleIdentityFilter,
  unarmedScheduleDeletion,
  unarmedSchedulesFilter,
  ABORT_STATE_PROJECTION,
  acknowledgesMCPReceipts,
  deletingSchedulesWindow,
  failureDisableDecision,
  overlapSkipCounterWrite,
  resolvedProjectWrite,
  settledReceiptRunFilter,
  balanceSkipCounterWrite,
  balanceSkipDisableGuard,
  OWNER_LISTING_PROJECTION,
  suspendedSchedulesFilter,
  MCP_COMPLETION_PROJECTION,
  suspensionCandidatesFilter,
  mcpToolAuthFailureReceipts,
  scheduleMCPCompletionStateOf,
} from '~/methods/scheduleRules';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { getTable } from '../schema/descriptor';
import { asRecord } from './context';

type ScheduleRow = ISchedule & Record<string, unknown>;
type RunRow = IScheduleRun & Record<string, unknown>;

/** The run-slot and owner-slot unique keys, by the fields a duplicate key names. */
const OCCURRENCE_KEY = ['scheduleId', 'scheduledFor'];
const ACTIVE_RUN_KEY = ['scheduleId'];
const CAPACITY_SLOT_KEY = ['capacitySlot'];
const OWNER_SLOT_KEY = ['user', 'slot'];
const CLIENT_REQUEST_KEY = ['user', 'clientRequestId'];

/** Whether `error` is a duplicate key of exactly the unique key `fields`. */
function isDuplicateOf(error: unknown, fields: readonly string[]): boolean {
  if (!(error instanceof StoreDuplicateKeyError) || error.keyValue == null) {
    return false;
  }
  const keys = Object.keys(error.keyValue);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

/** The top-level paths of the `schedules` table, as the schema declares them. */
const SCHEDULE_PATHS: readonly string[] = (
  getTable(SCHEMA_DESCRIPTOR, 'schedules')?.fields ?? []
).map((field) => field.path);

export function createPostgresScheduleStore(context: PostgresStoreContext): ScheduleStore {
  const schedules = () => context.collections().collection<ScheduleRow>('schedules');
  const runs = () => context.collections().collection<RunRow>('scheduleruns');

  /** Writes an occurrence's result onto the card (order-fenced; no `updatedAt`). */
  async function projectLastRun(
    scheduleId: string,
    lastRun: NonNullable<ISchedule['lastRun']>,
    scheduledFor: Date,
    revisionFilter: Record<string, unknown> = {},
  ): Promise<void> {
    const projection = lastRunProjection(scheduleId, lastRun, scheduledFor, revisionFilter);
    await schedules().updateOne(projection.filter, projection.update, { timestamps: false });
  }

  async function disableSchedule(
    id: string,
    reason: Parameters<ScheduleStore['disableSchedule']>[1],
    expectedClaimToken?: string,
    expectedConfigRevision?: number,
    counterGuard?: Record<string, unknown>,
  ): Promise<void> {
    const disable = scheduleDisable(
      id,
      reason,
      expectedClaimToken,
      expectedConfigRevision,
      counterGuard,
    );
    await schedules().updateOne(disable.filter, disable.update);
  }

  /** The counters, card, success clear and failure policy of a terminal occurrence. */
  async function applyTerminalBookkeeping(
    params: RecordRunOutcomeParams & { firedAt: Date; expectConfigRevision?: number },
  ): Promise<void> {
    const lastRun = terminalLastRun(params);
    const revisionFilter = configRevisionFilter(params.expectConfigRevision);
    const counters = terminalCounterWrite(params);
    await schedules().updateOne(counters.filter, counters.update);
    await projectLastRun(params.scheduleId, lastRun, params.scheduledFor, revisionFilter);
    if (params.status === 'success') {
      const clear = disabledReasonClear(params.scheduleId);
      await schedules().updateOne(clear.filter, clear.update);
    }
    if (params.status === 'error') {
      const schedule = await schedules().findOne({ id: params.scheduleId });
      const decision = failureDisableDecision(schedule, params);
      if (decision != null) {
        await disableSchedule(
          params.scheduleId,
          decision.reason,
          undefined,
          params.expectConfigRevision,
          decision.counterGuard,
        );
      }
    }
  }

  /** The card, the balance-skip streak and its auto-disable policy. */
  async function applyBalanceSkipBookkeeping(params: {
    scheduleId: string;
    scheduledFor: Date;
    firedAt: Date;
    conversationId?: string;
    rowRevision?: number;
    balanceSkipDisableThreshold?: number;
  }): Promise<void> {
    await projectLastRun(
      params.scheduleId,
      {
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
        status: 'skipped_balance',
        firedAt: params.firedAt,
      },
      params.scheduledFor,
      configRevisionFilter(params.rowRevision),
    );
    if (params.balanceSkipDisableThreshold == null) {
      return;
    }
    const counter = balanceSkipCounterWrite(
      params.scheduleId,
      params.scheduledFor,
      params.rowRevision,
    );
    const schedule = await schedules().findOneAndUpdate(counter.filter, counter.update, {
      returnDocument: 'after',
    });
    const current = schedule ?? (await schedules().findOne({ id: params.scheduleId }));
    const counterGuard = balanceSkipDisableGuard(current, params.balanceSkipDisableThreshold);
    if (counterGuard != null) {
      await disableSchedule(
        params.scheduleId,
        'insufficient_balance',
        undefined,
        params.rowRevision,
        counterGuard,
      );
    }
  }

  /** The card of an overlap skip, which breaks the balance-skip streak. */
  async function applyOverlapSkipBookkeeping(params: {
    scheduleId: string;
    scheduledFor: Date;
    firedAt: Date;
    rowRevision?: number;
  }): Promise<void> {
    await projectLastRun(
      params.scheduleId,
      { status: 'skipped_overlap', firedAt: params.firedAt },
      params.scheduledFor,
      configRevisionFilter(params.rowRevision),
    );
    const counter = overlapSkipCounterWrite(
      params.scheduleId,
      params.scheduledFor,
      params.rowRevision,
    );
    await schedules().updateOne(counter.filter, counter.update);
  }

  async function markBookkept(scheduleId: string, scheduledFor: Date): Promise<void> {
    const bookkept = bookkeptWrite(scheduleId, scheduledFor);
    await runs().updateOne(bookkept.filter, bookkept.update);
  }

  async function insertScheduleRun(data: ScheduleRunStoreData): Promise<IScheduleRun | null> {
    try {
      return await runs().insertOne(asRecord(data));
    } catch (error) {
      if (error instanceof StoreDuplicateKeyError) {
        return null;
      }
      throw error;
    }
  }

  async function eraseScheduleIfDrained(id: string): Promise<boolean> {
    const deleting = await schedules().findOne({ id }, { projection: '_id leaseUntil deleting' });
    // A peer already erased this row. Do not touch orphan or unrelated run history.
    if (deleting == null) return true;
    if (deleting.deleting !== true) return false;
    if (holdsLiveLease(deleting.leaseUntil, Date.now())) {
      return false;
    }
    const active = await runs().exists({ scheduleId: id, status: { $in: ACTIVE_RUN_STATUSES } });
    if (active != null) {
      return false;
    }
    await runs().deleteMany({ scheduleId: id });
    const tombstone = tombstoneWrite(id, tombstoneContentFields(SCHEDULE_PATHS), new Date());
    const tombstoned = await schedules().updateOne(tombstone.filter, tombstone.update, {
      timestamps: false,
    });
    if (tombstoned.matchedCount === 0) {
      await schedules().deleteOne({ id, deleting: true });
    }
    return true;
  }

  const store: ScheduleStore = {
    async ensureScheduleIndexes() {
      // The indexes come with the migrations.
    },

    async createSchedule(data) {
      return schedules().insertOne(asRecord(data));
    },

    async createScheduleWithSlot(data: ScheduleStoreData, maxPerUser) {
      const userId = data.user;
      for (let attempt = 0; attempt <= maxPerUser; attempt++) {
        const used = await schedules().find(ownerSchedulesFilter(userId), {
          projection: 'slot',
        });
        const taken = new Set(
          used.map((row) => row.slot).filter((slot): slot is number => typeof slot === 'number'),
        );
        if (used.length >= maxPerUser) {
          return 'limit';
        }
        let slot = 0;
        while (taken.has(slot)) {
          slot++;
        }
        if (slot >= maxPerUser) {
          return 'limit';
        }
        try {
          return await schedules().insertOne(asRecord({ ...data, slot, deleting: false }));
        } catch (error) {
          if (isDuplicateOf(error, OWNER_SLOT_KEY)) {
            continue;
          }
          // A retry of a create whose first attempt committed resolves to that row, also
          // while it is being deleted (the replay key spans rows being deleted).
          if (isDuplicateOf(error, CLIENT_REQUEST_KEY) && data.clientRequestId) {
            const existing = await schedules().findOne({
              user: userId,
              clientRequestId: data.clientRequestId,
            });
            if (existing != null) {
              return existing;
            }
          }
          throw error;
        }
      }
      return 'limit';
    },

    async deleteUnarmedSchedule(id, userId, expectedConfigRevision) {
      const deletion = unarmedScheduleDeletion(id, userId, expectedConfigRevision);
      const claimed = await schedules().findOneAndUpdate(deletion.filter, deletion.update, {
        returnDocument: 'after',
        projection: '_id',
      });
      if (claimed == null) {
        const still = await schedules().findOne({ id, user: userId }, { projection: 'deleting' });
        if (still == null) {
          return 'missing';
        }
        return still.deleting === true ? 'draining' : 'kept';
      }
      return (await eraseScheduleIfDrained(id)) ? 'deleted' : 'draining';
    },

    async updateScheduleById(id, userId, update, unset, options) {
      const edit = scheduleOwnerEdit(id, userId, update, unset, options);
      const cleared = await schedules().findOneAndUpdate(
        edit.pausedCard.filter,
        edit.pausedCard.update,
        { returnDocument: 'after' },
      );
      if (cleared != null) {
        return cleared;
      }
      return schedules().findOneAndUpdate(edit.plain.filter, edit.plain.update, {
        returnDocument: 'after',
      });
    },

    async getScheduleById(id, userId) {
      return schedules().findOne(liveScheduleFilter(id, userId));
    },

    async getSchedulesByUser(userId) {
      return schedules().find(ownerSchedulesFilter(userId), {
        sort: { updatedAt: -1 },
        projection: OWNER_LISTING_PROJECTION,
      });
    },

    async countSchedulesByUser(userId) {
      return schedules().count(ownerSchedulesFilter(userId));
    },

    async getScheduleByClientRequestId(userId, clientRequestId) {
      return schedules().findOne({ user: userId, clientRequestId });
    },

    async markScheduleDeleting(id, userId) {
      const mark = scheduleDeletionMark(id, userId);
      return schedules().findOneAndUpdate(mark.filter, mark.update, { returnDocument: 'after' });
    },

    async claimDueSchedule(params) {
      const claim = dueScheduleClaim(params, new Date(), randomUUID());
      return schedules().findOneAndUpdate(claim.filter, claim.update, {
        returnDocument: 'after',
        sort: claim.sort,
        skipLocked: true,
      });
    },

    async acquireManualRunLease(id, userId, leaseMs) {
      const lease = manualRunLease(id, userId, leaseMs, new Date(), randomUUID());
      return schedules().findOneAndUpdate(lease.filter, lease.update, { returnDocument: 'after' });
    },

    async acquireResumeLease(id, expectedConfigRevision, requireEnabled, leaseMs) {
      const lease = resumeLease(
        id,
        expectedConfigRevision,
        requireEnabled,
        leaseMs,
        new Date(),
        randomUUID(),
      );
      return schedules().findOneAndUpdate(lease.filter, lease.update, { returnDocument: 'after' });
    },

    async consumeResumeLease(
      id,
      expectedClaimToken,
      expectedLeaseBy,
      requireEnabled,
      expectedConfigRevision,
    ) {
      const consumption = resumeLeaseConsumption(
        id,
        expectedClaimToken,
        expectedLeaseBy,
        requireEnabled,
        expectedConfigRevision,
        new Date(),
      );
      const result = await schedules().updateOne(consumption.filter, consumption.update);
      return result.matchedCount > 0;
    },

    async releaseLease(id, expectedClaimToken) {
      const result = await schedules().updateOne(
        leaseReleaseFilter(id, expectedClaimToken),
        leaseRelease(),
      );
      return result.matchedCount > 0;
    },

    async releaseLeaseByHolder(id, leaseBy) {
      await schedules().updateOne({ id, leaseBy }, leaseRelease());
    },

    async revalidateClaim(id, claimToken, requireEnabled = true) {
      const row = await schedules().exists(
        heldClaimFilter(id, claimToken, requireEnabled, new Date()),
      );
      return row != null;
    },

    async advanceSchedule(id, nextRunAt, expectedNextRunAt, expectedClaimToken) {
      const advance = scheduleAdvance(id, nextRunAt, expectedNextRunAt, expectedClaimToken);
      const result = await schedules().updateOne(advance.filter, advance.update);
      return result.matchedCount > 0;
    },

    async disableSchedule(id, reason, expectedClaimToken, expectedConfigRevision) {
      await disableSchedule(id, reason, expectedClaimToken, expectedConfigRevision);
    },

    async persistResolvedProject(id, chatProjectId, expectedClaimToken) {
      const write = resolvedProjectWrite(id, chatProjectId, expectedClaimToken);
      await schedules().updateOne(write.filter, write.update);
    },

    async getUnarmedSchedules(limit) {
      return schedules().find(unarmedSchedulesFilter(), { limit });
    },

    async armSchedule(id, nextRunAt, expectedConfigRevision) {
      const arming = scheduleArming(id, nextRunAt, expectedConfigRevision);
      const result = await schedules().updateOne(arming.filter, arming.update);
      return result.modifiedCount > 0;
    },

    insertScheduleRun,

    async reserveStartedRun(data): Promise<StartedRunReservation> {
      try {
        return { run: await runs().insertOne(asRecord({ ...data, status: 'started' })) };
      } catch (error) {
        if (isDuplicateOf(error, OCCURRENCE_KEY)) {
          const existing = await runs().findOne(
            { scheduleId: data.scheduleId, scheduledFor: data.scheduledFor },
            { projection: 'status' },
          );
          return { conflict: 'duplicate', existingStatus: existing?.status };
        }
        if (isDuplicateOf(error, CAPACITY_SLOT_KEY)) {
          return { conflict: 'slot-taken' };
        }
        if (isDuplicateOf(error, ACTIVE_RUN_KEY)) {
          return { conflict: 'overlap' };
        }
        throw error;
      }
    },

    async getCapacityOccupancy() {
      const rows = await runs().find(capacityHoldersFilter(), { projection: 'capacitySlot' });
      return capacityOccupancyOf(rows);
    },

    async countActiveRuns() {
      return runs().count({ status: 'started' });
    },

    async getScheduleRunProject(scheduleId, scheduledFor) {
      const run = await runs().findOne(
        { scheduleId, scheduledFor: new Date(scheduledFor) },
        { projection: 'chatProjectId' },
      );
      return runProjectOf(run);
    },

    async requestRunAbort(scheduleId, scheduledFor, source) {
      const now = new Date();
      if (source === 'stop') {
        const attempt = stopAttemptWrite(scheduleId, scheduledFor, now);
        const stamped = await runs().updateOne(attempt.filter, attempt.update);
        if (stamped.matchedCount > 0) {
          return true;
        }
        const holder = await runs().exists(activeRunFilter(scheduleId, scheduledFor));
        return holder != null ? 'in_progress' : false;
      }
      const claim = abortClaimWrite(scheduleId, scheduledFor, now, source);
      const claimed = await runs().updateOne(claim.filter, claim.update);
      if (claimed.matchedCount > 0) {
        return true;
      }
      const renewal = abortRenewalWrite(scheduleId, scheduledFor, now);
      const renewed = await runs().updateOne(renewal.filter, renewal.update);
      return renewed.matchedCount > 0;
    },

    async getScheduleRunAbortState(scheduleId, scheduledFor) {
      return runs().findOne({ scheduleId, scheduledFor }, { projection: ABORT_STATE_PROJECTION });
    },

    async markRunAbortPersisted(scheduleId, scheduledFor) {
      await runs().updateOne(
        { scheduleId, scheduledFor },
        { $set: { abortPersistedAt: new Date() } },
        { timestamps: false },
      );
    },

    async getScheduleMCPCompletionState(identity) {
      const schedule = await schedules().findOne(scheduleIdentityFilter(identity), {
        projection: MCP_COMPLETION_PROJECTION,
      });
      return scheduleMCPCompletionStateOf(identity, schedule);
    },

    async recordMCPToolAuthFailure(input) {
      const { binding, receipts } = mcpToolAuthFailureReceipts(input);
      const write = mcpReceiptWrite(binding, receipts);
      const updated = await runs().updateOne(write.filter, write.update, { timestamps: false });
      if (updated.matchedCount > 0) return true;
      if (receipts.length === 0) return false;
      const terminal = await runs().findOne(settledReceiptRunFilter(binding), {
        projection: 'mcp',
      });
      if (!terminal) return false;
      return acknowledgesMCPReceipts(terminal.mcp, receipts);
    },

    async markRunResumeClaimed(scheduleId, scheduledFor, capacitySlot) {
      try {
        const claim = resumeClaimWrite(scheduleId, scheduledFor, capacitySlot, new Date());
        const claimed = await runs().findOneAndUpdate(claim.filter, claim.update, {
          returnDocument: 'after',
          timestamps: false,
        });
        return claimed == null ? { conflict: 'not-paused' } : { capacitySlot };
      } catch (error) {
        if (isDuplicateOf(error, CAPACITY_SLOT_KEY)) {
          return { conflict: 'slot-taken' };
        }
        if (isDuplicateOf(error, ACTIVE_RUN_KEY)) {
          return { conflict: 'overlap' };
        }
        throw error;
      }
    },

    async releaseRunResumeClaim(scheduleId, scheduledFor, capacitySlot) {
      const release = resumeClaimRelease(scheduleId, scheduledFor, capacitySlot);
      const released = await runs().updateOne(release.filter, release.update, {
        timestamps: false,
      });
      return released.modifiedCount > 0;
    },

    async setRunFireDetails(scheduleId, scheduledFor, details) {
      const write = fireDetailsWrite(scheduleId, scheduledFor, details);
      await runs().updateOne(write.filter, write.update);
    },

    async deleteScheduleRun(scheduleId, scheduledFor, expectedStatus, expectedConversationId) {
      await runs().deleteOne(
        runDeletionFilter(scheduleId, scheduledFor, expectedStatus, expectedConversationId),
      );
    },

    async getActiveRunsForSchedule(scheduleId) {
      return runs().find(
        { scheduleId, status: { $in: ACTIVE_RUN_STATUSES } },
        { projection: '+checkpointNamespace' },
      );
    },

    async getActiveRunsForUser(userId, statuses = ACTIVE_RUN_STATUSES) {
      return runs().find({ user: userId, status: { $in: statuses } });
    },

    async recordRunOutcome(input) {
      const firedAt = new Date();
      const params: RecordRunOutcomeParams = {
        ...input,
        ...projectScheduleMCPReceipt({ status: input.status, error: input.error, mcp: input.mcp }),
      };
      if (params.status === 'requires_action') {
        // The row transition first, then the card (fenced by the run's config revision, at
        // the run's own fire time).
        const transition = pauseTransition(params);
        const paused = await runs().findOneAndUpdate(transition.filter, transition.update, {
          returnDocument: 'before',
        });
        if (paused == null) {
          return;
        }
        await projectLastRun(
          params.scheduleId,
          {
            conversationId: params.conversationId,
            status: params.status,
            firedAt: paused.firedAt ?? firedAt,
          },
          params.scheduledFor,
          configRevisionFilter(paused.configRevision),
        );
        return;
      }
      const terminal = terminalTransition(params, firedAt);
      let settled = await runs().findOneAndUpdate(
        {
          ...terminal.runFilter,
          ...(terminal.canOverride ? { $nor: terminal.receiptPredicates } : {}),
        },
        terminal.update(
          terminal.incomingFailure ? 'error' : params.status,
          terminal.incomingFailure ? terminal.authError : params.error,
        ),
        { returnDocument: 'after' },
      );
      let effectiveParams: RecordRunOutcomeParams = terminal.incomingFailure
        ? { ...params, status: 'error', error: terminal.authError }
        : params;
      if (settled == null && terminal.canOverride) {
        settled = await runs().findOneAndUpdate(
          { $and: [terminal.runFilter, { $or: terminal.receiptPredicates }] },
          terminal.update('error', terminal.authError),
          { returnDocument: 'after' },
        );
        if (settled != null) {
          effectiveParams = {
            ...params,
            status: 'error',
            error: terminal.authError,
            mcp: settled.mcp,
          };
        }
      }
      // No-match guard: never touch schedule bookkeeping without a matching run.
      if (settled == null) {
        return;
      }
      effectiveParams = { ...effectiveParams, mcp: settled.mcp };
      if (effectiveParams.status === 'skipped_balance') {
        await applyBalanceSkipBookkeeping({
          scheduleId: params.scheduleId,
          scheduledFor: params.scheduledFor,
          firedAt: settled.firedAt ?? firedAt,
          conversationId: params.conversationId,
          rowRevision: settled.configRevision,
          balanceSkipDisableThreshold: params.balanceSkipDisableThreshold,
        });
      } else {
        await applyTerminalBookkeeping({
          ...effectiveParams,
          firedAt: settled.firedAt ?? firedAt,
          expectConfigRevision: settled.configRevision,
        });
      }
      await markBookkept(params.scheduleId, params.scheduledFor);
    },

    async recordSkippedRun(data, balanceSkipDisableThreshold) {
      const firedAt = new Date();
      const inserted = await insertScheduleRun({
        ...data,
        firedAt,
        settledAt: firedAt,
        bookkept: false,
      });
      let rowRevision = inserted?.configRevision;
      let rowFiredAt = firedAt;
      if (inserted == null) {
        // A retry replays only the same skip, at the original fire time; an occurrence that
        // already ran is left alone.
        const existing = await runs().findOne(
          { scheduleId: data.scheduleId, scheduledFor: data.scheduledFor },
          { projection: 'status configRevision firedAt' },
        );
        if (existing == null || existing.status !== data.status) {
          return;
        }
        rowRevision = existing.configRevision;
        rowFiredAt = existing.firedAt ?? firedAt;
      }
      if (data.status === 'skipped_balance') {
        await applyBalanceSkipBookkeeping({
          scheduleId: data.scheduleId,
          scheduledFor: data.scheduledFor,
          firedAt: rowFiredAt,
          rowRevision,
          balanceSkipDisableThreshold,
        });
      } else {
        await applyOverlapSkipBookkeeping({
          scheduleId: data.scheduleId,
          scheduledFor: data.scheduledFor,
          firedAt: rowFiredAt,
          rowRevision,
        });
      }
      await markBookkept(data.scheduleId, data.scheduledFor);
    },

    async getUnbookkeptRuns(olderThan, limit) {
      const window = unbookkeptRunsWindow(olderThan);
      return runs().find(window.filter, { sort: window.sort, limit });
    },

    async finalizeBookkeeping(params) {
      // NOTE(contract): no run row is required; the replay counts the occurrence and projects
      // the card at the replay time when none exists, as on MongoDB.
      const run = await runs().findOne(
        { scheduleId: params.scheduleId, scheduledFor: params.scheduledFor },
        { projection: 'configRevision firedAt' },
      );
      const firedAt = run?.firedAt ?? new Date();
      if (params.status === 'skipped_balance') {
        await applyBalanceSkipBookkeeping({
          scheduleId: params.scheduleId,
          scheduledFor: params.scheduledFor,
          firedAt,
          conversationId: params.conversationId,
          rowRevision: run?.configRevision,
          balanceSkipDisableThreshold: params.balanceSkipDisableThreshold,
        });
      } else if (params.status === 'skipped_overlap') {
        await applyOverlapSkipBookkeeping({
          scheduleId: params.scheduleId,
          scheduledFor: params.scheduledFor,
          firedAt,
          rowRevision: run?.configRevision,
        });
      } else {
        await applyTerminalBookkeeping({
          ...params,
          firedAt,
          expectConfigRevision: run?.configRevision,
        });
      }
      await markBookkept(params.scheduleId, params.scheduledFor);
    },

    async getRunsForReconciliation(olderThan, limit) {
      const startedWindow = reconciliationWindow('started', olderThan);
      const pausedWindow = reconciliationWindow('requires_action', olderThan);
      const [started, paused] = await Promise.all([
        runs().find(startedWindow.filter, { sort: startedWindow.sort, limit }),
        runs().find(pausedWindow.filter, { sort: pausedWindow.sort, limit }),
      ]);
      return [...started, ...paused];
    },

    async markRunsReconciled(list) {
      const ids = list.map((run) => run._id).filter((id) => id != null);
      if (ids.length === 0) {
        return;
      }
      await runs().updateMany(
        { _id: { $in: ids } },
        { $set: { reconciledAt: new Date() } },
        { timestamps: false },
      );
    },

    async suspendUserSchedulesForDeletion(userId, token) {
      const candidates = await schedules().find(suspensionCandidatesFilter(userId, token), {
        projection: SUSPENSION_PROJECTION,
      });
      if (candidates.length === 0) {
        return;
      }
      await schedules().bulk(
        candidates.map((schedule) => ({ updateOne: suspensionWrite(schedule, userId, token) })),
        { ordered: false },
      );
    },

    async restoreUserSchedulesFromDeletion(userId, token) {
      await retryRestore(async () => {
        const suspended = await schedules().find(suspendedSchedulesFilter(userId, token), {
          projection: RESTORE_PROJECTION,
        });
        if (suspended.length === 0) {
          return;
        }
        await schedules().bulk(
          suspended.map((schedule) => ({ updateOne: restoreWrite(schedule, userId, token) })),
          { ordered: false },
        );
      });
    },

    async getDeletingSchedules(limit) {
      const window = deletingSchedulesWindow();
      return schedules().find(window.filter, { sort: window.sort, limit });
    },

    async markEraseAttempted(ids) {
      if (ids.length === 0) {
        return;
      }
      const attempt = eraseAttemptWrite(ids, new Date());
      await schedules().updateMany(attempt.filter, attempt.update, { timestamps: false });
    },

    async getDeletingScheduleIds(userId, limit) {
      const window = deletingSchedulesWindow(userId);
      const rows = await schedules().find(window.filter, {
        sort: window.sort,
        projection: 'id',
        limit,
      });
      return rows.map((row) => row.id);
    },

    eraseScheduleIfDrained,

    async deleteSchedulesByUser(userId) {
      // Runs before schedules, so a partial failure stays retryable.
      await runs().deleteMany({ user: userId });
      await schedules().deleteMany({ user: userId });
    },
  };
  return store;
}

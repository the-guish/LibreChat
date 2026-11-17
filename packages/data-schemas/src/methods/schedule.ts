import { randomUUID } from 'node:crypto';
import { projectScheduleMCPReceipt } from 'librechat-data-provider';
import type { ScheduleRunStatus, ScheduleDisabledReason } from 'librechat-data-provider';
import type { ScheduleMCPOutcome, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { Model, Types, AnyBulkWriteOperation } from 'mongoose';
import type {
  ISchedule,
  IScheduleDocument,
  IScheduleRun,
  IScheduleRunDocument,
  ClaimDueScheduleParams,
  RecordRunOutcomeParams,
  StartedRunReservation,
  ResumedRunReservation,
} from '~/types/schedule';
import {
  restoreWrite,
  resumeLease,
  retryRestore,
  bookkeptWrite,
  runProjectOf,
  holdsLiveLease,
  manualRunLease,
  scheduleAdvance,
  scheduleArming,
  scheduleDisable,
  tombstoneWrite,
  leaseRelease,
  pauseTransition,
  suspensionWrite,
  activeRunFilter,
  abortClaimWrite,
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
} from './scheduleRules';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { createIndexesWithRetry } from '~/utils/retry';

const DUPLICATE_KEY = 11000;

type DuplicateKeyError = {
  code?: number;
  keyPattern?: Record<string, number>;
  errmsg?: string;
  message?: string;
};

/** DocumentDB can omit keyPattern; retain the deployed default index names as a fallback. */
function matchesRunDuplicate(
  error: unknown,
  fields: readonly string[],
  indexName: string,
): boolean {
  const err = error as DuplicateKeyError;
  if (err?.code !== DUPLICATE_KEY) {
    return false;
  }
  const keyPattern = err.keyPattern;
  if (keyPattern != null) {
    return (
      Object.keys(keyPattern).length === fields.length &&
      fields.every((field) => Object.prototype.hasOwnProperty.call(keyPattern, field))
    );
  }
  const message = err.errmsg || err.message;
  return typeof message === 'string' && /\bindex:\s+(\S+)/.exec(message)?.[1] === indexName;
}

/** A duplicate-key error whose conflict is the {scheduleId, scheduledFor} occurrence index. */
function isOccurrenceDuplicate(error: unknown): boolean {
  return matchesRunDuplicate(error, ['scheduleId', 'scheduledFor'], 'scheduleId_1_scheduledFor_1');
}

/** A duplicate-key error whose conflict is the single-active-run partial index. */
function isActiveRunConflict(error: unknown): boolean {
  return matchesRunDuplicate(error, ['scheduleId'], 'scheduleId_1');
}

/** A duplicate-key error whose conflict is the GLOBAL {capacitySlot} cap index. */
function isCapacitySlotConflict(error: unknown): boolean {
  return matchesRunDuplicate(error, ['capacitySlot'], 'capacitySlot_1');
}

/** A duplicate-key error whose conflict is the per-user {user, slot} cap index. */
function isSlotConflict(error: unknown): boolean {
  const err = error as DuplicateKeyError;
  return err?.code === DUPLICATE_KEY && err.keyPattern != null && 'slot' in err.keyPattern;
}

/** A duplicate-key error whose conflict is the per-user create-idempotency index. */
function isClientRequestConflict(error: unknown): boolean {
  const err = error as DuplicateKeyError;
  return (
    err?.code === DUPLICATE_KEY && err.keyPattern != null && 'clientRequestId' in err.keyPattern
  );
}

export type {
  ClaimDueScheduleParams,
  RecordRunOutcomeParams,
  StartedRunReservation,
  ResumedRunReservation,
} from '~/types/schedule';

export type ScheduleMethods = {
  /** Resolves live state only for a task's captured schedule identity. */
  getScheduleMCPCompletionState: (
    identity: ScheduledMCPIdentity,
  ) => Promise<{ identity: ScheduledMCPIdentity; enrolled: boolean } | null>;
  ensureScheduleIndexes: () => Promise<void>;
  createSchedule: (data: Partial<ISchedule>) => Promise<ISchedule>;
  createScheduleWithSlot: (
    data: Partial<ISchedule>,
    maxPerUser: number,
  ) => Promise<ISchedule | 'limit'>;
  updateScheduleById: (
    id: string,
    userId: string | Types.ObjectId,
    update: Partial<ISchedule>,
    unset?: Record<string, 1>,
    options?: { expectedConfigRevision?: number; preserveMCPConsentRevision?: string },
  ) => Promise<ISchedule | null>;
  deleteUnarmedSchedule: (
    id: string,
    userId: string | Types.ObjectId,
    expectedConfigRevision?: number,
  ) => Promise<'deleted' | 'draining' | 'kept' | 'missing'>;
  getScheduleById: (id: string, userId?: string | Types.ObjectId) => Promise<ISchedule | null>;
  getSchedulesByUser: (userId: string | Types.ObjectId) => Promise<ISchedule[]>;
  countSchedulesByUser: (userId: string | Types.ObjectId) => Promise<number>;
  claimDueSchedule: (params: ClaimDueScheduleParams) => Promise<ISchedule | null>;
  acquireManualRunLease: (
    id: string,
    userId: string | Types.ObjectId,
    leaseMs: number,
  ) => Promise<ISchedule | null>;
  acquireResumeLease: (
    id: string,
    expectedConfigRevision: number | undefined,
    requireEnabled: boolean,
    leaseMs: number,
  ) => Promise<ISchedule | null>;
  consumeResumeLease: (
    id: string,
    expectedClaimToken: string,
    expectedLeaseBy: string,
    requireEnabled: boolean,
    expectedConfigRevision?: number,
  ) => Promise<boolean>;
  releaseLease: (id: string, expectedClaimToken?: string) => Promise<boolean>;
  releaseLeaseByHolder: (id: string, leaseBy: string) => Promise<void>;
  revalidateClaim: (id: string, claimToken: string, requireEnabled?: boolean) => Promise<boolean>;
  advanceSchedule: (
    id: string,
    nextRunAt: Date | null,
    expectedNextRunAt?: Date | null,
    expectedClaimToken?: string,
  ) => Promise<boolean>;
  disableSchedule: (
    id: string,
    reason: ScheduleDisabledReason,
    expectedClaimToken?: string,
    expectedConfigRevision?: number,
    /** Extra filter pinning the counter the disable DECISION was made on, so a
     *  concurrent outcome that reset the streak invalidates this stale write. */
    counterGuard?: Record<string, unknown>,
  ) => Promise<void>;
  insertScheduleRun: (data: Partial<IScheduleRun>) => Promise<IScheduleRun | null>;
  /** Converges the schedule row on the destination a fire resolved; claim-token
   *  fenced, and never bumps configRevision (this is not an owner edit). */
  persistResolvedProject: (
    id: string,
    chatProjectId: string | undefined,
    expectedClaimToken?: string,
  ) => Promise<void>;
  /** The destination one occurrence used; null when the row is absent. */
  getScheduleRunProject: (
    scheduleId: string,
    scheduledFor: string | Date,
  ) => Promise<{ recorded: boolean; chatProjectId?: string } | null>;
  reserveStartedRun: (data: Partial<IScheduleRun>) => Promise<StartedRunReservation>;
  getCapacityOccupancy: () => Promise<{ takenSlots: number[]; unslotted: number }>;
  requestRunAbort: (
    scheduleId: string,
    scheduledFor: Date,
    source?: IScheduleRun['abortSource'],
  ) => Promise<boolean | 'in_progress'>;
  getScheduleRunAbortState: (
    scheduleId: string,
    scheduledFor: Date,
  ) => Promise<Pick<
    IScheduleRun,
    'status' | 'abortRequestedAt' | 'abortSource' | 'abortPersistedAt' | 'mcp'
  > | null>;
  /** Records an exact live generation's missing OBO authorization before the tool returns. */
  recordMCPToolAuthFailure: (input: {
    scheduleId: string;
    scheduledFor: Date;
    conversationId: string;
    tenantId?: string;
    server: string;
    outcome?: ScheduleMCPOutcome;
    outcomes?: ScheduleMCPOutcome[];
  }) => Promise<boolean>;
  markRunResumeClaimed: (
    scheduleId: string,
    scheduledFor: Date,
    capacitySlot: number,
  ) => Promise<ResumedRunReservation>;
  releaseRunResumeClaim: (
    scheduleId: string,
    scheduledFor: Date,
    capacitySlot: number,
  ) => Promise<boolean>;
  markRunAbortPersisted: (scheduleId: string, scheduledFor: Date) => Promise<void>;
  setRunFireDetails: (
    scheduleId: string,
    scheduledFor: Date,
    details: { conversationId: string; droppedFileIds?: string[]; mcp?: IScheduleRun['mcp'] },
  ) => Promise<void>;
  countActiveRuns: () => Promise<number>;
  deleteScheduleRun: (
    scheduleId: string,
    scheduledFor: Date,
    expectedStatus?: ScheduleRunStatus,
    expectedConversationId?: string,
  ) => Promise<void>;
  markScheduleDeleting: (id: string, userId: string | Types.ObjectId) => Promise<ISchedule | null>;
  getActiveRunsForSchedule: (scheduleId: string) => Promise<IScheduleRun[]>;
  getActiveRunsForUser: (
    userId: string | Types.ObjectId,
    statuses?: readonly ScheduleRunStatus[],
  ) => Promise<IScheduleRun[]>;
  suspendUserSchedulesForDeletion: (
    userId: string | Types.ObjectId,
    token: string,
  ) => Promise<void>;
  restoreUserSchedulesFromDeletion: (
    userId: string | Types.ObjectId,
    token: string,
  ) => Promise<void>;
  getDeletingSchedules: (limit: number) => Promise<ISchedule[]>;
  markEraseAttempted: (ids: string[]) => Promise<void>;
  getScheduleByClientRequestId: (
    userId: string | Types.ObjectId,
    clientRequestId: string,
  ) => Promise<ISchedule | null>;
  getDeletingScheduleIds: (userId: string | Types.ObjectId, limit: number) => Promise<string[]>;
  getUnarmedSchedules: (limit: number) => Promise<ISchedule[]>;
  armSchedule: (id: string, nextRunAt: Date, expectedConfigRevision?: number) => Promise<boolean>;
  eraseScheduleIfDrained: (id: string) => Promise<boolean>;
  deleteSchedulesByUser: (userId: string | Types.ObjectId) => Promise<void>;
  getUnbookkeptRuns: (olderThan: Date, limit: number) => Promise<IScheduleRun[]>;
  finalizeBookkeeping: (params: RecordRunOutcomeParams) => Promise<void>;
  recordRunOutcome: (params: RecordRunOutcomeParams) => Promise<void>;
  recordSkippedRun: (
    data: Partial<IScheduleRun> & {
      scheduleId: string;
      scheduledFor: Date;
      status: Extract<ScheduleRunStatus, 'skipped_overlap' | 'skipped_balance'>;
    },
    balanceSkipDisableThreshold?: number,
  ) => Promise<void>;
  getRunsForReconciliation: (olderThan: Date, limit: number) => Promise<IScheduleRun[]>;
  markRunsReconciled: (runs: Array<Pick<IScheduleRun, '_id'>>) => Promise<void>;
};

export function createScheduleMethods(mongoose: typeof import('mongoose')): ScheduleMethods {
  const Schedule = () => mongoose.models.Schedule as Model<IScheduleDocument>;
  const ScheduleRun = () => mongoose.models.ScheduleRun as Model<IScheduleRunDocument>;

  /**
   * Explicitly builds the Schedule/ScheduleRun indexes. Required because
   * `MONGO_AUTO_INDEX=false` disables Mongoose's automatic index creation —
   * without this the unique idempotency index and the TTL retention index would
   * never exist. Called once before the engine starts.
   */
  async function ensureScheduleIndexes(): Promise<void> {
    await createIndexesWithRetry(Schedule());
    await createIndexesWithRetry(ScheduleRun());
  }

  async function createSchedule(data: Partial<ISchedule>): Promise<ISchedule> {
    const doc = await Schedule().create(data);
    return doc.toObject();
  }

  /**
   * Creates a schedule in the lowest free per-user slot, enforcing maxPerUser
   * ATOMICALLY: the {user, slot} partial unique index is the sole arbiter, so
   * concurrent creates that pick the same slot collide (duplicate key) and one
   * retries the next free slot — no read-then-count window, no drift. Returns
   * 'limit' when all slots in [0, maxPerUser) are held by the user's live schedules.
   */
  async function createScheduleWithSlot(
    data: Partial<ISchedule>,
    maxPerUser: number,
  ): Promise<ISchedule | 'limit'> {
    const userId = data.user;
    // Bound the retries by maxPerUser+1: each collision advances to a distinct
    // slot, so a caller can lose at most (slots occupied) races before it either
    // wins a free slot or finds every slot taken.
    for (let attempt = 0; attempt <= maxPerUser; attempt++) {
      const used = await Schedule()
        .find(ownerSchedulesFilter(userId))
        .select('slot')
        .lean<Array<{ slot?: number }>>();
      const taken = new Set(
        used.map((s) => s.slot).filter((s): s is number => typeof s === 'number'),
      );
      // Every live row consumes capacity, including legacy/internal rows created
      // before the slot allocator existed. Slots remain the atomic collision key.
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
        const doc = await Schedule().create({ ...data, slot, deleting: false });
        return doc.toObject();
      } catch (error) {
        if (isSlotConflict(error)) {
          continue;
        }
        // A RETRY of a create whose first attempt already committed. Hand back the
        // original row so the caller re-arms and reports that one, instead of minting a
        // second recurring schedule for a single user intent.
        if (isClientRequestConflict(error) && data.clientRequestId) {
          const existing = await Schedule()
            .findOne({ user: userId, clientRequestId: data.clientRequestId })
            .lean<ISchedule>();
          if (existing != null) {
            return existing;
          }
        }
        throw error;
      }
    }
    return 'limit';
  }

  /**
   * Owner edit (the filters and updates are `scheduleOwnerEdit`'s). The first write drops a
   * paused card in the same atomic write as the revision bump; the second applies the edit
   * when there is no pause to clear, and its `null` is the gone/conflict signal.
   */
  async function updateScheduleById(
    id: string,
    userId: string | Types.ObjectId,
    update: Partial<ISchedule>,
    unset?: Record<string, 1>,
    /** Optional edit-generation fence, so two overlapping owner edits cannot each
     *  persist state derived from a row the other has already replaced. */
    options?: { expectedConfigRevision?: number; preserveMCPConsentRevision?: string },
  ): Promise<ISchedule | null> {
    const edit = scheduleOwnerEdit(id, userId, update, unset, options);
    const cleared = await Schedule()
      .findOneAndUpdate(edit.pausedCard.filter, edit.pausedCard.update, { new: true })
      .lean<ISchedule>();
    if (cleared != null) {
      return cleared;
    }
    return Schedule()
      .findOneAndUpdate(edit.plain.filter, edit.plain.update, { new: true })
      .lean<ISchedule>();
  }

  /**
   * Rolls back a fresh create whose arming write failed — but ONLY while the row is
   * still the unarmed, unedited revision this attempt inserted. An
   * ambiguously-committed arm, or a concurrent create-retry that armed the row and
   * already answered 201, leaves an ARMED row this rollback must not erase; a
   * concurrent PATCH that edited the row while leaving it unarmed (e.g. disabling
   * it) moved the revision, and deleting it would erase the owner's edit. 'kept'
   * tells the caller the row survived in some later state.
   *
   * The claim is a SOFT delete, never a hard one: an unarmed row is visible in the
   * owner's list and Run Now-able, so a live manual generation can already hold its
   * lease and an active run row — hard-deleting would erase a billed generation's
   * evidence out from under it. The erase runs only once drained (no active run, no
   * live lease); otherwise 'draining' hands the hidden row to the ordinary
   * erase-on-settle / sweep teardown.
   */
  async function deleteUnarmedSchedule(
    id: string,
    userId: string | Types.ObjectId,
    expectedConfigRevision?: number,
  ): Promise<'deleted' | 'draining' | 'kept' | 'missing'> {
    const deletion = unarmedScheduleDeletion(id, userId, expectedConfigRevision);
    const claimed = await Schedule()
      .findOneAndUpdate(deletion.filter, deletion.update, { new: true })
      .select('_id')
      .lean();
    if (claimed == null) {
      const still = await Schedule()
        .findOne({ id, user: userId })
        .select('deleting')
        .lean<Pick<ISchedule, 'deleting'>>();
      if (still == null) {
        return 'missing';
      }
      return still.deleting === true ? 'draining' : 'kept';
    }
    const erased = await eraseScheduleIfDrained(id);
    return erased ? 'deleted' : 'draining';
  }

  async function getScheduleById(
    id: string,
    userId?: string | Types.ObjectId,
  ): Promise<ISchedule | null> {
    return Schedule().findOne(liveScheduleFilter(id, userId)).lean<ISchedule>();
  }

  async function getSchedulesByUser(userId: string | Types.ObjectId): Promise<ISchedule[]> {
    // Hide schedules pending erasure (soft-deleted, draining their active runs)
    // so a deleted schedule disappears immediately for the owner.
    return Schedule()
      .find(ownerSchedulesFilter(userId))
      .sort({ updatedAt: -1 })
      .select(OWNER_LISTING_PROJECTION)
      .lean<ISchedule[]>();
  }

  async function countSchedulesByUser(userId: string | Types.ObjectId): Promise<number> {
    return Schedule().countDocuments(ownerSchedulesFilter(userId));
  }

  /**
   * Atomically claims one due schedule by taking a lease. The per-document CAS
   * is the sole multi-instance dispatch arbiter: exactly one caller wins each
   * due schedule regardless of replica count, with or without Redis. Stamps a
   * fresh `claimToken` the winner carries through every subsequent write.
   *
   * Due-ness and lease expiry compare against THIS worker's clock. DocumentDB
   * supports neither pipeline-form updates nor `$$NOW` (see
   * misc/documentdb/documentdb-compat.md), so the server-clock CAS is not
   * expressible portably; the CAS itself still arbitrates every race, and the
   * exposure is bounded by inter-replica clock skew (NTP-order) against a
   * 5-minute lease and per-minute cadence granularity.
   */
  async function claimDueSchedule(params: ClaimDueScheduleParams): Promise<ISchedule | null> {
    const claim = dueScheduleClaim(params, new Date(), randomUUID());
    return Schedule()
      .findOneAndUpdate(claim.filter, claim.update, { new: true, sort: claim.sort })
      .lean<ISchedule>();
  }

  /**
   * Takes the schedule's lease for a manual run-now, serializing concurrent
   * `POST /:id/run` requests (and blocking against an engine claim) so a
   * double-click can't start two runs. Owner-scoped. Returns the FRESH schedule row
   * (post-image, with the new claim token) so the caller fires the current snapshot
   * — an edit that committed after the route read the schedule but before this lease
   * is reflected here, not the stale pre-edit prompt/agent. Null if already leased.
   */
  async function acquireManualRunLease(
    id: string,
    userId: string | Types.ObjectId,
    leaseMs: number,
  ): Promise<ISchedule | null> {
    // Same worker-clock CAS shape as claimDueSchedule (DocumentDB rules out `$$NOW`
    // and pipeline updates); the CAS still serializes concurrent run-now clicks, and
    // clock skew only shifts WHEN an expired lease becomes re-acquirable. The claim
    // token doubles as the lease's unique holder discriminator.
    const lease = manualRunLease(id, userId, leaseMs, new Date(), randomUUID());
    return Schedule().findOneAndUpdate(lease.filter, lease.update, { new: true }).lean<ISchedule>();
  }

  /**
   * Takes a short-lived schedule-document fence for a paused run's resume. The
   * approval and its ScheduleRun row live in different stores, so this claim is
   * carried through the approval CAS and atomically consumed immediately after it.
   * An owner edit rotates claimToken; a policy disable clears the lease/enabled bit.
   * Either therefore makes consumeResumeLease fail before provider execution starts.
   */
  async function acquireResumeLease(
    id: string,
    expectedConfigRevision: number | undefined,
    requireEnabled: boolean,
    leaseMs: number,
  ): Promise<ISchedule | null> {
    const lease = resumeLease(
      id,
      expectedConfigRevision,
      requireEnabled,
      leaseMs,
      new Date(),
      randomUUID(),
    );
    return Schedule().findOneAndUpdate(lease.filter, lease.update, { new: true }).lean<ISchedule>();
  }

  /**
   * Atomically linearizes a scheduled resume against owner edits, deletion, policy
   * disable, lease expiry, and takeover, then releases the short-lived fence. A
   * successful match means the approval was consumed under the same live schedule
   * generation that acquired the fence; a miss must stop before provider execution.
   */
  async function consumeResumeLease(
    id: string,
    expectedClaimToken: string,
    expectedLeaseBy: string,
    requireEnabled: boolean,
    expectedConfigRevision?: number,
  ): Promise<boolean> {
    const consumption = resumeLeaseConsumption(
      id,
      expectedClaimToken,
      expectedLeaseBy,
      requireEnabled,
      expectedConfigRevision,
      new Date(),
    );
    const result = await Schedule().updateOne(consumption.filter, consumption.update);
    return (result.matchedCount ?? 0) > 0;
  }

  /**
   * Releases a lease WITHOUT advancing nextRunAt (manual runs never reschedule).
   * Fenced on the claim token when provided so a stale worker cannot strip a lease
   * a different claimer now holds.
   */
  async function releaseLease(id: string, expectedClaimToken?: string): Promise<boolean> {
    const result = await Schedule().updateOne(
      leaseReleaseFilter(id, expectedClaimToken),
      leaseRelease(),
    );
    return (result.matchedCount ?? 0) > 0;
  }

  /**
   * Releases a lease fenced on the lease HOLDER (`leaseBy`) rather than the claim
   * token. Used when a fire is superseded by an owner edit that rotated the token
   * (so a token-fenced release would no-op): the worker still owns the lease, so it
   * must clear it — otherwise the edited schedule (and Run now) is reported "already
   * in progress" until the lease TTL, even though no run was dispatched. A takeover
   * changed `leaseBy`, so this correctly no-ops and never strips the new holder's lease.
   */
  async function releaseLeaseByHolder(id: string, leaseBy: string): Promise<void> {
    await Schedule().updateOne({ id, leaseBy }, leaseRelease());
  }

  /**
   * Whether the caller still holds an authoritative claim on the schedule: it is
   * not being deleted, its claim token is unchanged, and its lease has not expired.
   * Called as the last check before the loopback POST so an owner
   * delete/edit or a lease-expiry re-claim between claim and fire aborts the fire
   * instead of dispatching a stale occurrence. `requireEnabled` additionally checks
   * `enabled` (automatic fires must stop once disabled); a manual run-now passes
   * false since the user explicitly triggered it, but delete/edit still fence it.
   */
  async function revalidateClaim(
    id: string,
    claimToken: string,
    requireEnabled = true,
  ): Promise<boolean> {
    const row = await Schedule()
      .findOne(heldClaimFilter(id, claimToken, requireEnabled, new Date()))
      .select('_id')
      .lean();
    return row != null;
  }

  /**
   * Advances past a fired (or skipped) occurrence and releases the lease. When
   * `expectedNextRunAt` is given, the update is predicated on the schedule still
   * sitting on the claimed occurrence; when `expectedClaimToken` is given it is
   * additionally fenced on the claim, so a stale worker (whose lease expired and
   * was re-claimed, or whose schedule the owner edited) cannot clobber a newer
   * claimer's nextRunAt/lease. A predicate miss simply no-ops the stale write.
   */
  async function advanceSchedule(
    id: string,
    nextRunAt: Date | null,
    expectedNextRunAt?: Date | null,
    expectedClaimToken?: string,
  ): Promise<boolean> {
    const advance = scheduleAdvance(id, nextRunAt, expectedNextRunAt, expectedClaimToken);
    const result = await Schedule().updateOne(advance.filter, advance.update);
    return (result.matchedCount ?? 0) > 0;
  }

  /**
   * Disables a schedule. Preflight disables from the leased worker pass their
   * `expectedClaimToken` so a stale worker cannot flip a schedule the owner just
   * re-enabled/edited (rotating the token) back to disabled or clear a newer
   * claimer's lease. POLICY disables (auto-disable) instead pass the config
   * generation of the RUN that tripped the threshold: the counter update they follow
   * is revision-fenced, so leaving the disable itself unfenced let a stale run (or a
   * reconciler replay of one) disable a schedule the owner had since edited and
   * re-enabled. Absent on either side disables the fence.
   */
  async function disableSchedule(
    id: string,
    reason: ScheduleDisabledReason,
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
    await Schedule().updateOne(disable.filter, disable.update);
  }

  /**
   * The destination one OCCURRENCE actually used, for re-validating a paused run.
   *
   * `recorded` is the load-bearing part. A reservation ALWAYS writes the field (null
   * when deliberately unscoped), so a row missing the key is one written before this
   * existed — "unknown", not "no project". Callers fall back to the schedule-level
   * resolution only for unknown, and treat a recorded null as the genuinely unscoped
   * occurrence it is. Returns null when there is no row at all.
   */
  async function getScheduleRunProject(
    scheduleId: string,
    scheduledFor: string | Date,
  ): Promise<{ recorded: boolean; chatProjectId?: string } | null> {
    const run = await ScheduleRun()
      .findOne({ scheduleId, scheduledFor: new Date(scheduledFor) })
      .select('chatProjectId')
      .lean<{ chatProjectId?: string | null } | null>();
    return runProjectOf(run);
  }

  /**
   * Converges the row on the destination a fire actually RESOLVED, so the stored id
   * never lies about where this schedule's conversations are going.
   *
   * An operator pin outranks the stored id at fire time, and the wire projection
   * already reports the pin — but the row kept its old value, so a paused occurrence
   * could only be re-validated against a project its conversation was never filed
   * under. Claim-token fenced like every other worker-side write, and deliberately
   * WITHOUT a configRevision bump: this is the server reconciling itself to policy,
   * not an owner edit, and bumping would fence an in-flight occurrence off its own run.
   */
  async function persistResolvedProject(
    id: string,
    chatProjectId: string | undefined,
    expectedClaimToken?: string,
  ): Promise<void> {
    const write = resolvedProjectWrite(id, chatProjectId, expectedClaimToken);
    await Schedule().updateOne(write.filter, write.update);
  }

  /**
   * Inserts the run row BEFORE firing. The unique {scheduleId, scheduledFor}
   * index makes this the durable idempotency claim: null means this occurrence
   * was already fired (or is in flight) by another claimer or a prior life.
   * Used for non-`started` rows (skips); started rows go through reserveStartedRun.
   */
  async function insertScheduleRun(data: Partial<IScheduleRun>): Promise<IScheduleRun | null> {
    try {
      const doc = await ScheduleRun().create(data);
      return doc.toObject();
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Reserves the single active-run slot for a fired occurrence by inserting a
   * `started` run. Two distinct duplicate-key outcomes: the {scheduleId,
   * scheduledFor} index means this occurrence already fired ('duplicate'); the
   * single-active partial index means another occurrence of the same schedule is
   * already active ('overlap'). The DB enforces both atomically — no read-then-insert.
   */
  async function reserveStartedRun(data: Partial<IScheduleRun>): Promise<StartedRunReservation> {
    try {
      const doc = await ScheduleRun().create({ ...data, status: 'started' });
      return { run: doc.toObject() };
    } catch (error) {
      if (isOccurrenceDuplicate(error)) {
        // Report the EXISTING row's status. A duplicate means another fire owns this
        // occurrence — but "owns" and "already finished" need opposite handling, and the
        // caller cannot distinguish them without this.
        const existing = await ScheduleRun()
          .findOne({ scheduleId: data.scheduleId, scheduledFor: data.scheduledFor })
          .select('status')
          .lean<Pick<IScheduleRun, 'status'>>();
        return { conflict: 'duplicate', existingStatus: existing?.status };
      }
      // Checked BEFORE overlap: the global cap index and the per-schedule active
      // index are different failures and drive different caller behavior (retry the
      // next slot vs skip the occurrence).
      if (isCapacitySlotConflict(error)) {
        return { conflict: 'slot-taken' };
      }
      if (isActiveRunConflict(error)) {
        return { conflict: 'overlap' };
      }
      throw error;
    }
  }

  /** Capacity-slot occupancy for the allocator: which slots are held by generation
   *  runs, plus how many legacy rows hold no slot (they shrink the effective cap so
   *  the bound stays conservative during rollout rather than transiently overshooting).
   *  Admission-only rows never dispatched and are excluded even if settlement crashed. */
  async function getCapacityOccupancy(): Promise<{ takenSlots: number[]; unslotted: number }> {
    const rows = await ScheduleRun()
      .find(capacityHoldersFilter())
      .select('capacitySlot')
      .lean<Array<{ capacitySlot?: number }>>();
    return capacityOccupancyOf(rows);
  }

  /**
   * Records that an abort was requested WITHOUT freeing the capacity slot: the run
   * keeps counting against fireConcurrency until its generation owner confirms
   * settlement by writing a terminal outcome.
   *
   * The stamp is RENEWED per attempt, not first-wins: the fences read
   * `abortRequestedAt` for freshness, and a retry abort signalled against a live
   * generation must re-arm them — a 31-minute-old stamp from a failed first attempt
   * must not let a drain read the retry's post-abort job state as settled. Callers
   * therefore only invoke this against a generation they observed LIVE (or unknown);
   * stamping cleanup aborts of already-terminal jobs would re-fence a dead owner
   * forever and block the reconciler's recovery.
   *
   * Source semantics: a 'stop' attempt takes the source and re-opens the persistence
   * marker (the Stop route persists writes the owner's barrier must wait on, and each
   * attempt resolves it anew); a 'deletion' request renews freshness but never steals
   * the source from an UNRESOLVED stop attempt — the route may still be persisting,
   * and the owner's barrier keys off `abortSource === 'stop'`.
   * Classic operators only (DocumentDB).
   */
  async function requestRunAbort(
    scheduleId: string,
    scheduledFor: Date,
    source?: IScheduleRun['abortSource'],
  ): Promise<boolean | 'in_progress'> {
    const now = new Date();
    if (source === 'stop') {
      // SERIALIZED per run: only one unresolved fresh stop attempt may exist. A second
      // Stop stamping over a live one would re-open the persistence marker, and its
      // own lost-CAS resolution would then release the settlement barrier while the
      // FIRST attempt (the terminal-CAS winner) was still pruning and saving. The
      // guarded update is the arbiter; a loser answers 'in_progress' and must neither
      // signal the abort nor resolve anything.
      const attempt = stopAttemptWrite(scheduleId, scheduledFor, now);
      const stamped = await ScheduleRun().updateOne(attempt.filter, attempt.update);
      if ((stamped.matchedCount ?? 0) > 0) {
        return true;
      }
      const holder = await ScheduleRun()
        .findOne(activeRunFilter(scheduleId, scheduledFor))
        .select('_id')
        .lean();
      return holder != null ? 'in_progress' : false;
    }
    const claim = abortClaimWrite(scheduleId, scheduledFor, now, source);
    const claimed = await ScheduleRun().updateOne(claim.filter, claim.update);
    if ((claimed.matchedCount ?? 0) > 0) {
      return true;
    }
    // An unresolved stop attempt holds the source; renew freshness only.
    const renewal = abortRenewalWrite(scheduleId, scheduledFor, now);
    const renewed = await ScheduleRun().updateOne(renewal.filter, renewal.update);
    return (renewed.matchedCount ?? 0) > 0;
  }

  /** Captured origin cannot adopt a later grant or a different schedule root. */
  async function getScheduleMCPCompletionState(identity: ScheduledMCPIdentity): Promise<{
    identity: ScheduledMCPIdentity;
    enrolled: boolean;
  } | null> {
    const schedule = await Schedule()
      .findOne(scheduleIdentityFilter(identity))
      .select(MCP_COMPLETION_PROJECTION)
      .read('primary')
      .lean<ISchedule>();
    return scheduleMCPCompletionStateOf(identity, schedule);
  }

  /** The generation owner's abort-coordination view (see abortPersistedAt). */
  async function getScheduleRunAbortState(
    scheduleId: string,
    scheduledFor: Date,
  ): Promise<Pick<
    IScheduleRun,
    'status' | 'abortRequestedAt' | 'abortSource' | 'abortPersistedAt' | 'mcp'
  > | null> {
    return ScheduleRun()
      .findOne({ scheduleId, scheduledFor })
      .select(ABORT_STATE_PROJECTION)
      .lean<Pick<
        IScheduleRun,
        'status' | 'abortRequestedAt' | 'abortSource' | 'abortPersistedAt' | 'mcp'
      > | null>();
  }

  /**
   * Stamps a paused run as RESUME-CLAIMED: its approval was consumed and a
   * continuation is running. While fresh, a re-paused job's state is a hand-off in
   * flight (segment writes still landing), not settleable evidence. The pause
   * record ($unset below) is the completion signal; a crash leaves the stamp to
   * age out on the caller's staleness bound.
   */
  async function markRunResumeClaimed(
    scheduleId: string,
    scheduledFor: Date,
    capacitySlot: number,
  ): Promise<ResumedRunReservation> {
    try {
      const claim = resumeClaimWrite(scheduleId, scheduledFor, capacitySlot, new Date());
      const claimed = await ScheduleRun().findOneAndUpdate(claim.filter, claim.update, {
        new: true,
        timestamps: false,
      });
      return claimed == null ? { conflict: 'not-paused' } : { capacitySlot };
    } catch (error) {
      if (isCapacitySlotConflict(error)) {
        return { conflict: 'slot-taken' };
      }
      if (isActiveRunConflict(error)) {
        return { conflict: 'overlap' };
      }
      throw error;
    }
  }

  /** Roll back a resume reservation only while the exact slot this caller claimed
   * still belongs to this occurrence. The approval job is checked separately by the
   * controller before crossing this seam, so a committed/racing resume never has its
   * capacity released by a losing request. */
  async function releaseRunResumeClaim(
    scheduleId: string,
    scheduledFor: Date,
    capacitySlot: number,
  ): Promise<boolean> {
    const release = resumeClaimRelease(scheduleId, scheduledFor, capacitySlot);
    const released = await ScheduleRun().updateOne(release.filter, release.update, {
      timestamps: false,
    });
    return (released.modifiedCount ?? 0) > 0;
  }

  /** Stamped by the interactive Stop route once ALL its writes (checkpoint prune,
   *  partial-response save) have landed; releases the generation owner's settlement
   *  barrier. Bookkeeping only: never touches `updatedAt`. */
  async function markRunAbortPersisted(scheduleId: string, scheduledFor: Date): Promise<void> {
    await ScheduleRun().updateOne(
      { scheduleId, scheduledFor },
      { $set: { abortPersistedAt: new Date() } },
      { timestamps: false },
    );
  }

  async function recordMCPToolAuthFailure(
    input: Parameters<ScheduleMethods['recordMCPToolAuthFailure']>[0],
  ): Promise<boolean> {
    const { binding, receipts } = mcpToolAuthFailureReceipts(input);
    const write = mcpReceiptWrite(binding, receipts);
    const updated = await ScheduleRun().updateOne(write.filter, write.update, {
      timestamps: false,
    });
    if ((updated.matchedCount ?? 0) > 0) return true;
    if (receipts.length === 0) return false;
    // A durable replay acknowledges existing evidence, never appends a late diagnosis.
    const terminal = await ScheduleRun()
      .findOne(settledReceiptRunFilter(binding))
      .select('mcp')
      .lean<Pick<IScheduleRun, 'mcp'>>();
    if (!terminal) return false;
    return acknowledgesMCPReceipts(terminal.mcp, receipts);
  }

  /** Count of in-flight scheduled runs (across all schedules) for the fire cap. */
  async function countActiveRuns(): Promise<number> {
    return ScheduleRun().countDocuments({ status: 'started' });
  }

  /**
   * Writes an occurrence's result onto the schedule card, fenced on occurrence order
   * so a delayed outcome can never overwrite a NEWER occurrence's projection. The
   * fence is absent-tolerant: rows written before `lastRun.scheduledFor` existed
   * project once and then start ordering normally.
   */
  async function projectLastRun(
    scheduleId: string,
    lastRun: NonNullable<ISchedule['lastRun']>,
    scheduledFor: Date,
    revisionFilter: Record<string, unknown> = {},
  ): Promise<void> {
    const projection = lastRunProjection(scheduleId, lastRun, scheduledFor, revisionFilter);
    await Schedule().updateOne(
      projection.filter,
      projection.update,
      // Run-state bookkeeping, not a config edit: re-affirmed pauses would
      // otherwise bump updatedAt (and reorder updated-time listings) every
      // reconciliation pass for as long as an approval sits waiting.
      { timestamps: false },
    );
  }

  /**
   * Applies the schedule-side bookkeeping (lastRun + counters + auto-disable) for
   * a terminal occurrence. Idempotent via the per-occurrence `countedFor` guard:
   * the $inc lands at most once per occurrence no matter how many times it is
   * retried (inline finish, reconciler catch of an un-`bookkept` run, crash-replay),
   * even when a later occurrence's counting interleaves with an earlier paused one.
   *
   * The counter write is ORDER-fenced (`countersAsOf`) as a whole and CONFIG-REVISION
   * fenced: `failureCount` and `balanceSkipCount` are consecutive streaks, so a late
   * older occurrence must not rebuild one a newer success cleared, and a run that
   * started under an older owner config must not walk toward auto-disable.
   */
  async function applyTerminalBookkeeping(
    params: RecordRunOutcomeParams & { firedAt: Date; expectConfigRevision?: number },
  ): Promise<void> {
    const lastRun = terminalLastRun(params);
    const revisionFilter = configRevisionFilter(params.expectConfigRevision);
    const counters = terminalCounterWrite(params);
    await Schedule().updateOne(counters.filter, counters.update);
    // The card projection is ORDER-fenced, unlike the counters above (idempotent and
    // order-insensitive): a `requires_action` run doesn't block later occurrences, so a
    // resumed pause — or a reconciler replay — routinely settles AFTER a newer run
    // already finished, and must not roll the card back to its older result.
    await projectLastRun(params.scheduleId, lastRun, params.scheduledFor, revisionFilter);
    // A success clears a transient disable reason ONLY while the schedule is still
    // enabled. Predicated on `enabled` separately so it can't leak into the
    // count-guarded update above (which must run regardless of enabled state).
    if (params.status === 'success') {
      const clear = disabledReasonClear(params.scheduleId);
      await Schedule().updateOne(clear.filter, clear.update);
    }
    // Auto-disable is a POLICY re-evaluated on EVERY call (idempotent), NOT gated
    // on the count guard — so if a crash landed the $inc but not the disable, the
    // reconciler's replay still disables. Reads current state after the count.
    if (params.status === 'error') {
      const schedule = await Schedule().findOne({ id: params.scheduleId }).lean<ISchedule>();
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

  /**
   * Balance-skip streak bookkeeping, shared by the pre-fire skip (recordSkippedRun)
   * and a mid-generation balance refusal settling a `started` row (recordRunOutcome
   * with `skipped_balance`): projects the card, walks the consecutive-balance-skip
   * streak (per-occurrence idempotent via `countedFor`, order-fenced via
   * `countersAsOf`), and applies the insufficient_balance auto-disable policy.
   */
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
    const schedule = await Schedule()
      .findOneAndUpdate(counter.filter, counter.update, { new: true })
      .lean<ISchedule>();
    // Auto-disable is a POLICY re-evaluated on EVERY call (idempotent), NOT gated on
    // the count guard — if a crash landed the $inc but not the disable, the replay's
    // guarded update no-ops to null, so re-read and still disable at/over threshold.
    const current =
      schedule ?? (await Schedule().findOne({ id: params.scheduleId }).lean<ISchedule>());
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

  /**
   * Overlap-skip bookkeeping, shared by the pre-fire skip (recordSkippedRun) and its
   * crash-retry replay (finalizeBookkeeping): projects the skip onto the card and
   * BREAKS the consecutive-balance-skip streak (an overlap is an intervening
   * non-balance outcome). Both writes are idempotent and order-fenced, so replays
   * are safe.
   */
  async function applyOverlapSkipBookkeeping(params: {
    scheduleId: string;
    scheduledFor: Date;
    firedAt: Date;
    rowRevision?: number;
  }): Promise<void> {
    // Through the ORDERED projection: writing `lastRun` directly dropped the
    // `scheduledFor` marker, after which the next projection read the marker as absent
    // and let an older occurrence's outcome overwrite this newer skip.
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
    await Schedule().updateOne(counter.filter, counter.update);
  }

  /**
   * Terminal (or pause) transition for a run + lastRun/failure bookkeeping.
   * Matches a run row still in `started` OR `requires_action`. Crash-retryable:
   * the run row is marked `bookkept:false` at terminalization and only flipped
   * to `true` after bookkeeping lands, so a crash in between is re-applied by the
   * reconciler (`getUnbookkeptRuns`), while `countedFor` keeps it idempotent.
   * A `skipped_balance` settlement (a mid-generation balance refusal) takes the same
   * guarded row transition but walks the balance-skip streak instead of the failure
   * streak — the owner's credits, not the schedule, are at fault.
   */
  async function recordRunOutcome(params: RecordRunOutcomeParams): Promise<void> {
    const firedAt = new Date();
    params = {
      ...params,
      ...projectScheduleMCPReceipt({ status: params.status, error: params.error, mcp: params.mcp }),
    };
    if (params.status === 'requires_action') {
      // PAUSE (HITL): win the ROW transition first, then project the card. A read-then-
      // write guard let a concurrent resume terminalize the run between the two, after
      // which the card was pinned to "Needs approval" forever — the row update no-op'd
      // (already terminal) while the card write had landed. Matching `requires_action`
      // too keeps a retried pause re-affirming the card, and keeps the transition
      // crash-recoverable: the reconciler re-invokes this for a row in either state.
      // The match is also the anti-spoof guard a bare scheduleId would bypass.
      const transition = pauseTransition(params);
      const paused = await ScheduleRun().findOneAndUpdate(transition.filter, transition.update, {
        new: false,
      });
      if (paused == null) {
        // A resume/denial fence is not authority to terminalize. The generation-aware
        // service owns denied-pause abort, provider drain and steer recovery.
        return;
      }
      // Revision-fenced like the terminal path: an owner edit landing between the fire
      // and the approval must not have the OLD config's pause stamped on it. The ROW's
      // fire time, not the projection time: reconciliation re-affirms a long-lived pause
      // every pass, and a fresh stamp per pass walked the card's timestamp forward.
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
    // TERMINAL: flip the run row (match-guarded), then apply bookkeeping. `bookkept` is
    // set false at the flip and true only after bookkeeping lands, so a crash between is
    // re-applied by the reconciler (getUnbookkeptRuns) while countedFor keeps counters idempotent.
    const terminal = terminalTransition(params, firedAt);
    let settled = await ScheduleRun()
      .findOneAndUpdate(
        {
          ...terminal.runFilter,
          ...(terminal.canOverride ? { $nor: terminal.receiptPredicates } : {}),
        },
        terminal.update(
          terminal.incomingFailure ? 'error' : params.status,
          terminal.incomingFailure ? terminal.authError : params.error,
        ),
        { new: true },
      )
      .lean<IScheduleRun>();
    let effectiveParams = terminal.incomingFailure
      ? { ...params, status: 'error' as const, error: terminal.authError }
      : params;
    if (settled == null && terminal.canOverride) {
      settled = await ScheduleRun()
        .findOneAndUpdate(
          { $and: [terminal.runFilter, { $or: terminal.receiptPredicates }] },
          terminal.update('error', terminal.authError),
          { new: true },
        )
        .lean<IScheduleRun>();
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
    // The post-image is the authoritative union, including receipts admitted just before this CAS.
    effectiveParams = { ...effectiveParams, mcp: settled.mcp };
    // SINGLE SEAM: the config fence is DERIVED here from the row being settled, not
    // passed in by each caller. Callers only say "this occurrence reached status X" and
    // structurally cannot forget a token — which is exactly how the reconcile and
    // balance-skip paths previously shipped unfenced.
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
    const bookkept = bookkeptWrite(params.scheduleId, params.scheduledFor);
    await ScheduleRun().updateOne(bookkept.filter, bookkept.update);
  }

  async function recordSkippedRun(
    data: Partial<IScheduleRun> & {
      scheduleId: string;
      scheduledFor: Date;
      status: Extract<ScheduleRunStatus, 'skipped_overlap' | 'skipped_balance'>;
    },
    balanceSkipDisableThreshold?: number,
  ): Promise<void> {
    const firedAt = new Date();
    // A duplicate {scheduleId, scheduledFor} row means a prior attempt inserted it.
    // Proceed as a retry ONLY when that row is the SAME skip — otherwise this claim
    // is a retry of an occurrence that actually started/terminalized (e.g. the POST
    // was accepted but advanceSchedule failed before releasing the lease), and
    // rewriting lastRun/counters would mislabel a real run as a skip (and could
    // walk it toward auto-disable). The streak $inc is separately guarded per
    // occurrence by `countedFor`, so a genuine same-skip retry can't double-count.
    // `bookkept: false` until the schedule-side writes land: a crash in between is
    // replayed by the reconciler (getUnbookkeptRuns), exactly like a terminal run —
    // a duplicate claim of this occurrence advances past the terminal row without
    // re-running bookkeeping, so nothing else would ever repair a half-applied skip.
    const inserted = await insertScheduleRun({
      ...data,
      firedAt,
      settledAt: firedAt,
      bookkept: false,
    });
    let rowRevision = inserted?.configRevision;
    let rowFiredAt = firedAt;
    if (inserted == null) {
      const existing = await ScheduleRun()
        .findOne({ scheduleId: data.scheduleId, scheduledFor: data.scheduledFor })
        .select('status configRevision firedAt')
        .lean<Pick<IScheduleRun, 'status' | 'configRevision' | 'firedAt'>>();
      if (existing == null || existing.status !== data.status) {
        return;
      }
      rowRevision = existing.configRevision;
      // A retry re-projects the ORIGINAL occurrence, not the retry moment.
      rowFiredAt = existing.firedAt ?? firedAt;
    }
    // Same single seam as recordRunOutcome: the config fence is DERIVED from the row,
    // never passed by the caller. A skip decided under an older owner config must not
    // stamp the card (or walk the balance streak toward auto-disable) on a schedule the
    // owner has since edited. Absent on either side disables the fence.
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
    const bookkept = bookkeptWrite(data.scheduleId, data.scheduledFor);
    await ScheduleRun().updateOne(bookkept.filter, bookkept.update);
  }

  async function setRunFireDetails(
    scheduleId: string,
    scheduledFor: Date,
    details: { conversationId: string; droppedFileIds?: string[]; mcp?: IScheduleRun['mcp'] },
  ): Promise<void> {
    const write = fireDetailsWrite(scheduleId, scheduledFor, details);
    await ScheduleRun().updateOne(write.filter, write.update);
  }

  /**
   * Non-terminal runs old enough to need a job-store status check. Fetches
   * `started` (capacity-consuming) and `requires_action` (paused) in separate
   * budgeted round-robin buckets so a backlog of live rows in either state
   * cannot starve an orphaned run out of every sweep.
   */
  async function getRunsForReconciliation(olderThan: Date, limit: number): Promise<IScheduleRun[]> {
    // ROUND-ROBIN, not oldest-first, in both windows: ordering by when each row was last
    // examined (never-examined first) gives every row a turn, so a full window of
    // legitimate long-running generations or still-live pauses cannot hide an abandoned
    // run behind it forever.
    const startedWindow = reconciliationWindow('started', olderThan);
    const pausedWindow = reconciliationWindow('requires_action', olderThan);
    const [started, paused] = await Promise.all([
      ScheduleRun()
        .find(startedWindow.filter)
        .sort(startedWindow.sort)
        .limit(limit)
        .lean<IScheduleRun[]>(),
      ScheduleRun()
        .find(pausedWindow.filter)
        .sort(pausedWindow.sort)
        .limit(limit)
        .lean<IScheduleRun[]>(),
    ]);
    return [...started, ...paused];
  }

  /** Stamps rows as examined, so each bounded reconciliation window rotates instead
   *  of re-serving the same rows forever. Bookkeeping only: never touches `updatedAt`. */
  async function markRunsReconciled(runs: Array<Pick<IScheduleRun, '_id'>>): Promise<void> {
    const ids = runs.map((run) => run._id).filter((id) => id != null);
    if (ids.length === 0) {
      return;
    }
    await ScheduleRun().updateMany(
      { _id: { $in: ids } },
      { $set: { reconciledAt: new Date() } },
      { timestamps: false },
    );
  }

  /** Settled runs (terminal outcomes AND skips) whose schedule bookkeeping never
   *  landed — a crash between the row write and the card/counter writes.
   *  Least-recently-attempted first (the paused window's rotation): a row whose
   *  replay keeps failing must rotate to the back, or a batch of them re-fills
   *  this bounded window forever and every later row's counters never land. */
  async function getUnbookkeptRuns(olderThan: Date, limit: number): Promise<IScheduleRun[]> {
    const window = unbookkeptRunsWindow(olderThan);
    return ScheduleRun().find(window.filter).sort(window.sort).limit(limit).lean<IScheduleRun[]>();
  }

  /** Re-applies (idempotent) bookkeeping for a terminal run and marks it bookkept. */
  async function finalizeBookkeeping(params: RecordRunOutcomeParams): Promise<void> {
    // Same single seam as recordRunOutcome: derive the config fence from the row, so the
    // crash-retry path cannot apply bookkeeping the inline path would have refused.
    // The row's ORIGINAL firedAt is reused too: this replay runs minutes (or many
    // retries) after the fact, and stamping the replay time onto lastRun would keep
    // walking the card's timestamp forward every time the recovery path fires.
    const run = await ScheduleRun()
      .findOne({ scheduleId: params.scheduleId, scheduledFor: params.scheduledFor })
      .select('configRevision firedAt')
      .lean<Pick<IScheduleRun, 'configRevision' | 'firedAt'>>();
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
    const bookkept = bookkeptWrite(params.scheduleId, params.scheduledFor);
    await ScheduleRun().updateOne(bookkept.filter, bookkept.update);
  }

  /**
   * Deletes a run row (used to roll back a capacity reservation). Status-fenced
   * when `expectedStatus` is provided so a rollback cannot delete a row a
   * concurrent process already advanced (e.g. to a terminal outcome). Fenced
   * additionally on `expectedConversationId` so a fire only ever deletes the
   * reservation IT inserted.
   */
  async function deleteScheduleRun(
    scheduleId: string,
    scheduledFor: Date,
    expectedStatus?: ScheduleRunStatus,
    expectedConversationId?: string,
  ): Promise<void> {
    await ScheduleRun().deleteOne(
      runDeletionFilter(scheduleId, scheduledFor, expectedStatus, expectedConversationId),
    );
  }

  /**
   * Soft-deletes a schedule for the owner: disables it (so the engine can no
   * longer claim it), rotates the claim token (fencing any in-flight worker), and
   * marks it `deleting` so it is hidden and awaits erasure once its active runs
   * drain. Returns the updated row (for aborting its in-flight jobs) or null.
   */
  async function markScheduleDeleting(
    id: string,
    userId: string | Types.ObjectId,
  ): Promise<ISchedule | null> {
    // Keep leaseUntil/leaseBy so a fire that already leased this occurrence still
    // serializes against a re-claim while it unwinds. Only clear nextRunAt
    // (belt-and-suspenders atop enabled:false to stop new claims); the lease
    // releases itself when the fire finishes, or via TTL.
    //
    // IDEMPOTENT: deliberately NOT gated on `deleting: { $ne: true }`. The mark is the
    // first of several steps (read active runs, abort their jobs, prune checkpoints,
    // erase when drained), and if any of those threw — or the process exited — a
    // one-shot mark made every retry answer 404, stranding the schedule with its job
    // and checkpoint alive. Re-marking an already-deleting schedule is harmless (the
    // fields are already at these values; the token rotates again, which only re-fences
    // stale workers), and it lets the caller re-drive the rest of the teardown.
    const mark = scheduleDeletionMark(id, userId);
    return Schedule().findOneAndUpdate(mark.filter, mark.update, { new: true }).lean<ISchedule>();
  }

  /** In-flight (non-terminal) runs of a schedule — the jobs a delete must abort. */
  async function getActiveRunsForSchedule(scheduleId: string): Promise<IScheduleRun[]> {
    return ScheduleRun()
      .find({ scheduleId, status: { $in: ACTIVE_RUN_STATUSES } })
      .select('+checkpointNamespace')
      .lean<IScheduleRun[]>();
  }

  /**
   * In-flight runs across all of a user's schedules — for account-deletion quiescing,
   * and, narrowed to `started`, for the schedules list. The narrowing matters there:
   * this collection is indexed by status, not by user, and `started` rows are bounded
   * globally by the capacity slots while `requires_action` rows can accumulate for as
   * long as an approval waits.
   */
  async function getActiveRunsForUser(
    userId: string | Types.ObjectId,
    statuses: readonly ScheduleRunStatus[] = ACTIVE_RUN_STATUSES,
  ): Promise<IScheduleRun[]> {
    return ScheduleRun()
      .find({ user: userId, status: { $in: statuses } })
      .lean<IScheduleRun[]>();
  }

  /**
   * REVERSIBLE quiesce ahead of account deletion. Snapshots each schedule's pre-suspension
   * enabled/next-run state under this attempt's `token`, then fences firing (disable, clear
   * `nextRunAt`, rotate `claimToken`). It deliberately does NOT set `deleting`: a suspended
   * row must not be erased, because a deletion the controller later cancels has to restore
   * it. On a successful deletion the hard-delete cascade removes the row (and this snapshot)
   * anyway. Snapshotting needs each row's current values, which a classic (DocumentDB-safe)
   * update cannot copy, so it reads then `bulkWrite`s — fenced per row so a row already
   * suspended by this token, soft-deleted, or edited out from under the read is left alone.
   */
  async function suspendUserSchedulesForDeletion(
    userId: string | Types.ObjectId,
    token: string,
  ): Promise<void> {
    const schedules = await Schedule()
      .find(suspensionCandidatesFilter(userId, token))
      .select(SUSPENSION_PROJECTION)
      .lean<Array<Pick<ISchedule, 'id' | 'enabled' | 'nextRunAt' | 'deletionSuspension'>>>();
    if (schedules.length === 0) {
      return;
    }
    const ops = schedules.map((schedule) => ({
      updateOne: suspensionWrite(schedule, userId, token),
    }));
    await tenantSafeBulkWrite(Schedule(), ops as AnyBulkWriteOperation[], { ordered: false });
  }

  /**
   * Reverses {@link suspendUserSchedulesForDeletion} when a deletion attempt is cancelled.
   * Restores enabled/next-run from the snapshot and clears the suspension — but ONLY for
   * rows still carrying this exact attempt's token and not independently soft-deleted, so a
   * schedule the owner deleted (or a newer attempt re-suspended) is never resurrected.
   *
   * RETRIED, because its callers cannot retry it later. A cancelled deletion restores while
   * the user-deletion fence is still armed and then releases that fence; once released,
   * nothing re-drives this, and a single transient failure would strand the owner's live
   * account with silently disabled, next-run-less schedules. Retrying is safe: every attempt
   * re-reads only the rows STILL carrying this token, so a partially-applied unordered write
   * converges on exactly the stragglers, and a fully-applied one finds nothing and returns.
   * Throws the last failure so callers still surface it.
   */
  async function restoreUserSchedulesFromDeletion(
    userId: string | Types.ObjectId,
    token: string,
  ): Promise<void> {
    await retryRestore(() => restoreSuspendedBatch(userId, token));
  }

  async function restoreSuspendedBatch(
    userId: string | Types.ObjectId,
    token: string,
  ): Promise<void> {
    const suspended = await Schedule()
      .find(suspendedSchedulesFilter(userId, token))
      .select(RESTORE_PROJECTION)
      .lean<Array<Pick<ISchedule, 'id' | 'deletionSuspension'>>>();
    if (suspended.length === 0) {
      return;
    }
    const ops = suspended.map((schedule) => ({ updateOne: restoreWrite(schedule, userId, token) }));
    await tenantSafeBulkWrite(Schedule(), ops as AnyBulkWriteOperation[], { ordered: false });
  }

  /**
   * Enabled schedules with no `nextRunAt`. Creation arms in a second write, so a crash
   * or a failed arm leaves this state — and `claimDueSchedule` sorts on `nextRunAt`, so
   * the row is permanently inert while still occupying the owner's slot.
   */
  async function getUnarmedSchedules(limit: number): Promise<ISchedule[]> {
    return Schedule().find(unarmedSchedulesFilter()).limit(limit).lean<ISchedule[]>();
  }

  /**
   * Arms an unarmed schedule — the ONE arming CAS every creation path shares (the
   * original POST, its idempotent replay, and the reconciler's unarmed sweep).
   * Conditional on still being unarmed, so concurrent armers collapse to a single
   * write: it never rotates the claim token (which would fence an occurrence the
   * engine already claimed off the freshly-armed row) and never bumps the config
   * revision (which would break a concurrent PATCH's CAS). `expectedConfigRevision`
   * additionally fences the original POST's arm against a PATCH that landed after
   * the insert — the edit's own arming governs then. Returns whether THIS call armed.
   */
  async function armSchedule(
    id: string,
    nextRunAt: Date,
    expectedConfigRevision?: number,
  ): Promise<boolean> {
    const arming = scheduleArming(id, nextRunAt, expectedConfigRevision);
    const result = await Schedule().updateOne(arming.filter, arming.update);
    return (result.modifiedCount ?? 0) > 0;
  }

  /** Soft-deleted schedules awaiting erasure (drained of active runs). ROUND-ROBIN
   *  on the last sweep attempt (never-attempted first): an unsorted window re-served
   *  the same first rows every pass, so a batch of undrainable rows (live runs or
   *  leases) starved every row behind it out of the sweep indefinitely. */
  async function getDeletingSchedules(limit: number): Promise<ISchedule[]> {
    const window = deletingSchedulesWindow();
    return Schedule().find(window.filter).sort(window.sort).limit(limit).lean<ISchedule[]>();
  }

  /** Stamps deleting rows as attempted so the erasure window rotates. Bookkeeping
   *  only: never touches `updatedAt`. */
  async function markEraseAttempted(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const attempt = eraseAttemptWrite(ids, new Date());
    await Schedule().updateMany(attempt.filter, attempt.update, { timestamps: false });
  }

  /** Resolves the schedule a prior create attempt with this idempotency key committed,
   *  including one already soft-deleted (a retry must see its key as claimed while the
   *  row drains, mirroring the unique index, which deliberately spans deleting rows). */
  async function getScheduleByClientRequestId(
    userId: string | Types.ObjectId,
    clientRequestId: string,
  ): Promise<ISchedule | null> {
    return Schedule().findOne({ user: userId, clientRequestId }).lean<ISchedule>();
  }

  /** Ids of an owner's soft-deleted schedules, for a lazy erase retry on a read path
   *  in topologies that run no reconciler. Projected to ids: the caller only re-drives
   *  eraseScheduleIfDrained, and the rows carry prompt text this need not load. */
  async function getDeletingScheduleIds(
    userId: string | Types.ObjectId,
    limit: number,
  ): Promise<string[]> {
    // Least-recently-attempted first (missing sorts before any date), for the same
    // reason the erasure sweep rotates: an unsorted `.limit()` window pins the same
    // stuck rows forever once the owner has more deleting rows than the limit, and
    // the ones beyond it never get their deletion re-driven. Callers stamp
    // markEraseAttempted after each attempt to rotate the window.
    const window = deletingSchedulesWindow(userId);
    const rows = await Schedule()
      .find(window.filter)
      .sort(window.sort)
      .select('id')
      .limit(limit)
      .lean<Array<Pick<ISchedule, 'id'>>>();
    return rows.map((row) => row.id);
  }

  /**
   * Erases a soft-deleted schedule and its runs ONLY once it has fully drained, so a
   * live loopback generation's evidence is never destroyed out from under it. Drained
   * means BOTH: (a) no run is active, and (b) no LIVE lease is held. The lease check
   * is essential — a worker can have CLAIMED the schedule but not yet inserted its
   * `started` reservation (or be mid-rollback of one); erasing in that window would
   * let the worker then insert a ghost row against a gone schedule that it can no
   * longer prove it owns. Returns whether it erased.
   */
  async function eraseScheduleIfDrained(id: string): Promise<boolean> {
    // A live lease (leaseUntil in the future) means a worker still holds the claim.
    // Worker clock, DocumentDB-portable, with the skew margin: a lease reads as live
    // until MARGIN past its expiry, so a clock-ahead erasure worker cannot destroy a
    // row a skew-behind holder still legitimately claims.
    const deleting = await Schedule()
      .findOne({ id })
      .select('_id leaseUntil deleting')
      .lean<Pick<ISchedule, 'leaseUntil' | 'deleting'>>();
    // A peer already erased this row. Do not touch orphan or unrelated run history.
    if (deleting == null) return true;
    if (deleting.deleting !== true) return false;
    if (holdsLiveLease(deleting.leaseUntil, Date.now())) {
      return false;
    }
    const active = await ScheduleRun()
      .findOne({ scheduleId: id, status: { $in: ACTIVE_RUN_STATUSES } })
      .select('_id')
      .lean();
    if (active != null) {
      return false;
    }
    await ScheduleRun().deleteMany({ scheduleId: id });
    // Rows carrying a create-idempotency key leave a content-free TOMBSTONE instead
    // of vanishing: a create whose response was lost retries with the same key, and
    // if the owner deleted the schedule before that retry arrived, a hard delete
    // would let the retry recreate the recurring work they just removed. ALLOWLIST,
    // not a blocklist: everything except the replay-detection identity is unset,
    // derived from the live schema paths so a field added later cannot silently
    // survive into the tombstone.
    const tombstone = tombstoneWrite(
      id,
      tombstoneContentFields(Object.keys(Schedule().schema.paths)),
      new Date(),
    );
    const tombstoned = await Schedule().updateOne(
      tombstone.filter,
      tombstone.update,
      // Not a config edit; the tombstone must not surface in updated-time listings.
      { timestamps: false },
    );
    if (tombstoned.matchedCount === 0) {
      await Schedule().deleteOne({ id, deleting: true });
    }
    return true;
  }

  /** Cascade for account deletion: removes a user's schedules and their runs. */
  async function deleteSchedulesByUser(userId: string | Types.ObjectId): Promise<void> {
    // Delete RUNS before SCHEDULES so a partial failure is retryable: both are
    // user-scoped and idempotent, so a crash after the runs delete leaves the
    // schedules for a retry to re-delete (deleting schedules first would orphan the
    // runs — a re-run finds no schedules and never removes the leftover run rows).
    await ScheduleRun().deleteMany({ user: userId });
    await Schedule().deleteMany({ user: userId });
  }

  return {
    ensureScheduleIndexes,
    createSchedule,
    createScheduleWithSlot,
    updateScheduleById,
    deleteUnarmedSchedule,
    getScheduleById,
    getSchedulesByUser,
    countSchedulesByUser,
    claimDueSchedule,
    acquireManualRunLease,
    acquireResumeLease,
    consumeResumeLease,
    releaseLease,
    releaseLeaseByHolder,
    revalidateClaim,
    advanceSchedule,
    disableSchedule,
    insertScheduleRun,
    reserveStartedRun,
    getCapacityOccupancy,
    requestRunAbort,
    persistResolvedProject,
    getScheduleRunProject,
    getScheduleRunAbortState,
    getScheduleMCPCompletionState,
    recordMCPToolAuthFailure,
    markRunResumeClaimed,
    releaseRunResumeClaim,
    markRunAbortPersisted,
    setRunFireDetails,
    countActiveRuns,
    deleteScheduleRun,
    markScheduleDeleting,
    getActiveRunsForSchedule,
    getActiveRunsForUser,
    suspendUserSchedulesForDeletion,
    restoreUserSchedulesFromDeletion,
    getDeletingSchedules,
    markEraseAttempted,
    getScheduleByClientRequestId,
    getDeletingScheduleIds,
    getUnarmedSchedules,
    armSchedule,
    eraseScheduleIfDrained,
    deleteSchedulesByUser,
    getUnbookkeptRuns,
    finalizeBookkeeping,
    recordRunOutcome,
    recordSkippedRun,
    getRunsForReconciliation,
    markRunsReconciled,
  };
}

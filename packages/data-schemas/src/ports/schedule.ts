/**
 * Schedule store port: recurring agent schedules (the owner's configuration, the engine's lease
 * and claim state, the card projection of the last run) and their per-occurrence run rows (the
 * idempotency claim, the capacity slot, abort and resume coordination, bookkeeping replay).
 * Nothing here may import `mongoose`. Signatures are those of `ScheduleMethods`
 * (`~/methods/schedule`), copied verbatim but for owner and record ids typed `Types.ObjectId`,
 * which the port states as `IdLike`, the fields `updateScheduleById` unsets, which the port
 * states as a `$unset` record of the store query language (`./query`), and `disableSchedule`'s
 * internal counter guard (see below); `schedule.spec.ts` fails the typecheck if the MongoDB
 * methods stop satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - A schedule is addressed by its logical `id` (and, for owner-facing calls, its owner); a run
 *   by its occurrence, `(scheduleId, scheduledFor)`, which is unique.
 * - Writes are compare-and-set: each expected claim token, lease holder, config revision, status
 *   or occurrence given must still hold, or the write does nothing (and resolves `false` where it
 *   resolves a boolean). An owner edit rotates the claim token and bumps the config revision;
 *   worker and policy writes never bump the revision.
 * - A schedule being deleted (`deleting`) is hidden from owner reads and cannot be claimed.
 * - Lease expiry compares against the calling worker's clock; takeovers of another worker's
 *   lease allow for clock skew between workers.
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`).
 *
 * `disableSchedule` is stated without the MongoDB method's trailing `counterGuard` (a filter
 * merged into the write's, pinning the failure or balance-skip count the disable was decided
 * on): only the methods' own auto-disable policies (`recordRunOutcome`, the balance-skip
 * policy) pass it, inside the module, so no caller of the port does; a MongoDB method still
 * satisfies the narrower signature. Another store applies the same fence inside its own
 * auto-disable policies.
 *
 * Known leaks kept for now so callers stay unchanged: `ISchedule` and `IScheduleRun` (records
 * and the write data built from them) carry ObjectId `_id` and `user` fields, which the port
 * states as `IdLike` only where a caller passes them in.
 */
import type { ScheduleRunStatus, ScheduleDisabledReason } from 'librechat-data-provider';
import type { ScheduleMCPOutcome, ScheduledMCPIdentity } from 'librechat-data-provider';
import type {
  ISchedule,
  IScheduleRun,
  ClaimDueScheduleParams,
  RecordRunOutcomeParams,
  StartedRunReservation,
  ResumedRunReservation,
} from '~/types';
import type { IdLike, WithIdLike } from './common';
import { listPortMethods } from './common';

/** Schedule fields to write, with its `_id` and owner stated as `IdLike`. */
export type ScheduleStoreData = WithIdLike<Partial<ISchedule>, '_id' | 'user'>;
/** Run-row fields to write, with its `_id` and owner stated as `IdLike`. */
export type ScheduleRunStoreData = WithIdLike<Partial<IScheduleRun>, '_id' | 'user'>;

export interface ScheduleStore {
  /* ------------------------------------------------------------ setup */

  /** Builds the schedule and run indexes; called once before the engine starts. */
  ensureScheduleIndexes(): Promise<void>;

  /* ------------------------------------------------------------ owner: schedules */

  /** Stores a schedule as given and resolves to it. */
  createSchedule(data: ScheduleStoreData): Promise<ISchedule>;
  /**
   * Stores a schedule in its owner's lowest free slot; `'limit'` when the owner's live schedules
   * already hold `maxPerUser` slots. A retry of a create whose first attempt committed (same
   * `clientRequestId`) resolves to the row that attempt stored.
   */
  createScheduleWithSlot(data: ScheduleStoreData, maxPerUser: number): Promise<ISchedule | 'limit'>;
  /**
   * Rolls back a fresh create whose arming failed: soft-deletes the owner's schedule only while
   * it is still unarmed (and at `expectedConfigRevision`, when given), then erases it once
   * drained. `'kept'` when it survived in a later state, `'draining'` when it awaits erasure.
   */
  deleteUnarmedSchedule(
    id: string,
    userId: IdLike,
    expectedConfigRevision?: number,
  ): Promise<'deleted' | 'draining' | 'kept' | 'missing'>;
  /**
   * Owner edit of the owner's schedule, unless it is being deleted: sets the fields of `update`,
   * removes the fields `unset` names (callers name `disabledReason` and `chatProjectId`),
   * rotates its claim token and bumps its config revision, and drops a paused last-run card
   * (`requires_action`) in the same write. With `expectedConfigRevision`, only while the
   * schedule is still at that revision. With `preserveMCPConsentRevision` (which needs
   * `expectedConfigRevision`), only while its MCP consent was recorded at that consent revision
   * for that config revision (and, when `update` sets `chatProjectId`, while the schedule is
   * already filed under that project), carrying the consent to the new revision; such an edit
   * may only change the activation state (`enabled`, `nextRunAt`, `failureCount`,
   * `balanceSkipCount`, `chatProjectId`, unsetting `disabledReason`), or it throws. Resolves to
   * the updated row, or `null` when nothing matched.
   */
  updateScheduleById(
    id: string,
    userId: IdLike,
    update: Partial<ISchedule>,
    unset?: { [path: string]: 1 },
    options?: { expectedConfigRevision?: number; preserveMCPConsentRevision?: string },
  ): Promise<ISchedule | null>;
  /** The schedule `id` (of `userId`, when given), unless it is being deleted; or `null`. */
  getScheduleById(id: string, userId?: IdLike): Promise<ISchedule | null>;
  /** The owner's schedules, except those being deleted. */
  getSchedulesByUser(userId: IdLike): Promise<ISchedule[]>;
  /** How many schedules the owner has, except those being deleted. */
  countSchedulesByUser(userId: IdLike): Promise<number>;
  /**
   * The schedule a prior create with this idempotency key stored, including one being deleted;
   * or `null`.
   */
  getScheduleByClientRequestId(userId: IdLike, clientRequestId: string): Promise<ISchedule | null>;
  /**
   * Soft-deletes the owner's schedule: disables it, rotates its claim token and hides it until
   * its active runs drain. Resolves to the updated row, or `null`.
   */
  markScheduleDeleting(id: string, userId: IdLike): Promise<ISchedule | null>;

  /* ------------------------------------------------------------ engine: leases and claims */

  /**
   * Claims one due schedule by taking its lease for `leaseMs`, with a fresh claim token the
   * winner carries through every later write. Exactly one caller wins each due schedule.
   */
  claimDueSchedule(params: ClaimDueScheduleParams): Promise<ISchedule | null>;
  /**
   * Takes the owner's schedule lease for a manual run; resolves to the fresh row (with the new
   * claim token), or `null` when it is already leased.
   */
  acquireManualRunLease(id: string, userId: IdLike, leaseMs: number): Promise<ISchedule | null>;
  /**
   * Takes a short-lived lease fencing a paused run's resume, while the schedule is at
   * `expectedConfigRevision` (when given) and, with `requireEnabled`, enabled.
   */
  acquireResumeLease(
    id: string,
    expectedConfigRevision: number | undefined,
    requireEnabled: boolean,
    leaseMs: number,
  ): Promise<ISchedule | null>;
  /**
   * Releases a resume lease while it is still the one taken (claim token and holder), unexpired,
   * and the schedule unchanged; `false` means the resume must stop before running.
   */
  consumeResumeLease(
    id: string,
    expectedClaimToken: string,
    expectedLeaseBy: string,
    requireEnabled: boolean,
    expectedConfigRevision?: number,
  ): Promise<boolean>;
  /** Releases the lease without advancing the next run. */
  releaseLease(id: string, expectedClaimToken?: string): Promise<boolean>;
  /** Releases the lease while `leaseBy` still holds it, whatever its claim token. */
  releaseLeaseByHolder(id: string, leaseBy: string): Promise<void>;
  /**
   * Whether the caller still holds the claim: the schedule is not being deleted, its claim token
   * is unchanged, its lease has not expired and, with `requireEnabled`, it is enabled.
   */
  revalidateClaim(id: string, claimToken: string, requireEnabled?: boolean): Promise<boolean>;
  /**
   * Moves the schedule past a fired or skipped occurrence and releases its lease, while it still
   * sits on `expectedNextRunAt` and holds `expectedClaimToken` (each when given).
   */
  advanceSchedule(
    id: string,
    nextRunAt: Date | null,
    expectedNextRunAt?: Date | null,
    expectedClaimToken?: string,
  ): Promise<boolean>;
  /**
   * Disables the schedule for `reason` and releases its lease, while it still holds
   * `expectedClaimToken` and sits at `expectedConfigRevision` (each when given).
   */
  disableSchedule(
    id: string,
    reason: ScheduleDisabledReason,
    expectedClaimToken?: string,
    expectedConfigRevision?: number,
  ): Promise<void>;
  /**
   * Stores the project a fire resolved for the schedule (`undefined` clears it), without
   * bumping its config revision.
   */
  persistResolvedProject(
    id: string,
    chatProjectId: string | undefined,
    expectedClaimToken?: string,
  ): Promise<void>;
  /** Enabled schedules with no next run (a create whose arming failed), up to `limit`. */
  getUnarmedSchedules(limit: number): Promise<ISchedule[]>;
  /**
   * Arms an unarmed schedule (at `expectedConfigRevision`, when given); resolves whether this
   * call armed it. Never rotates the claim token or bumps the revision.
   */
  armSchedule(id: string, nextRunAt: Date, expectedConfigRevision?: number): Promise<boolean>;

  /* ------------------------------------------------------------ runs */

  /**
   * Stores a run row; `null` when its occurrence already has one. For rows that do not take a
   * capacity slot (skips); a started run goes through `reserveStartedRun`.
   */
  insertScheduleRun(data: ScheduleRunStoreData): Promise<IScheduleRun | null>;
  /**
   * Stores a `started` run for a fired occurrence, holding its schedule's single active-run slot
   * and the capacity slot it names. A conflict says which: the occurrence already has a row
   * (with that row's status), another occurrence is active, or the capacity slot is taken.
   */
  reserveStartedRun(data: ScheduleRunStoreData): Promise<StartedRunReservation>;
  /**
   * The capacity slots held by started generation runs, and how many such runs hold none.
   */
  getCapacityOccupancy(): Promise<{ takenSlots: number[]; unslotted: number }>;
  /** How many runs are in flight across every schedule. */
  countActiveRuns(): Promise<number>;
  /** The project one occurrence recorded (`recorded: false`: none was), or `null` with no run. */
  getScheduleRunProject(
    scheduleId: string,
    scheduledFor: string | Date,
  ): Promise<{ recorded: boolean; chatProjectId?: string } | null>;
  /**
   * Records that the run's abort was requested, keeping its capacity slot until it settles.
   * `'in_progress'` when an earlier stop attempt still serializes the run.
   */
  requestRunAbort(
    scheduleId: string,
    scheduledFor: Date,
    source?: IScheduleRun['abortSource'],
  ): Promise<boolean | 'in_progress'>;
  /** The run's status and abort coordination state, or `null` with no run. */
  getScheduleRunAbortState(
    scheduleId: string,
    scheduledFor: Date,
  ): Promise<Pick<
    IScheduleRun,
    'status' | 'abortRequestedAt' | 'abortSource' | 'abortPersistedAt' | 'mcp'
  > | null>;
  /** Records that the stop route's writes for the run have landed. */
  markRunAbortPersisted(scheduleId: string, scheduledFor: Date): Promise<void>;
  /** The live MCP enrollment state of a task's captured schedule identity, or `null`. */
  getScheduleMCPCompletionState(
    identity: ScheduledMCPIdentity,
  ): Promise<{ identity: ScheduledMCPIdentity; enrolled: boolean } | null>;
  /**
   * Records an exact live generation's missing MCP authorization on its run before the tool
   * returns; resolves whether it was recorded.
   */
  recordMCPToolAuthFailure(input: {
    scheduleId: string;
    scheduledFor: Date;
    conversationId: string;
    tenantId?: string;
    server: string;
    outcome?: ScheduleMCPOutcome;
    outcomes?: ScheduleMCPOutcome[];
  }): Promise<boolean>;
  /**
   * Moves a paused run back to `started` under `capacitySlot`, stamped resume-claimed. A
   * conflict says the run is not paused, another occurrence is active, or the slot is taken.
   */
  markRunResumeClaimed(
    scheduleId: string,
    scheduledFor: Date,
    capacitySlot: number,
  ): Promise<ResumedRunReservation>;
  /** Rolls a resume reservation back while the run still holds exactly `capacitySlot`. */
  releaseRunResumeClaim(
    scheduleId: string,
    scheduledFor: Date,
    capacitySlot: number,
  ): Promise<boolean>;
  /**
   * Records the conversation a fire dispatched, any attachments it dropped and its MCP
   * outcomes, on the run reserved for that conversation.
   */
  setRunFireDetails(
    scheduleId: string,
    scheduledFor: Date,
    details: { conversationId: string; droppedFileIds?: string[]; mcp?: IScheduleRun['mcp'] },
  ): Promise<void>;
  /**
   * Deletes a run row (a capacity reservation rolled back), while it is still at
   * `expectedStatus` and `expectedConversationId` (each when given).
   */
  deleteScheduleRun(
    scheduleId: string,
    scheduledFor: Date,
    expectedStatus?: ScheduleRunStatus,
    expectedConversationId?: string,
  ): Promise<void>;
  /** The schedule's in-flight runs. */
  getActiveRunsForSchedule(scheduleId: string): Promise<IScheduleRun[]>;
  /** The owner's in-flight runs, or only those at `statuses`. */
  getActiveRunsForUser(
    userId: IdLike,
    statuses?: readonly ScheduleRunStatus[],
  ): Promise<IScheduleRun[]>;

  /* ------------------------------------------------------------ outcomes and bookkeeping */

  /**
   * Settles (or pauses) a started or paused run and applies its schedule bookkeeping: the card,
   * the failure or balance-skip streak, and the auto-disable policy. Idempotent per occurrence
   * and replayable after a crash.
   */
  recordRunOutcome(params: RecordRunOutcomeParams): Promise<void>;
  /**
   * Stores a skipped occurrence and applies its bookkeeping; a retry of the same skip replays
   * it, while an occurrence that already ran is left alone.
   */
  recordSkippedRun(
    data: ScheduleRunStoreData & {
      scheduleId: string;
      scheduledFor: Date;
      status: Extract<ScheduleRunStatus, 'skipped_overlap' | 'skipped_balance'>;
    },
    balanceSkipDisableThreshold?: number,
  ): Promise<void>;
  /** Settled runs fired before `olderThan` whose bookkeeping never landed, up to `limit`. */
  getUnbookkeptRuns(olderThan: Date, limit: number): Promise<IScheduleRun[]>;
  /** Re-applies a settled run's bookkeeping (idempotent) and marks it done. */
  finalizeBookkeeping(params: RecordRunOutcomeParams): Promise<void>;
  /**
   * In-flight runs fired before `olderThan` that need a job-state check, up to `limit` of each
   * status, least recently examined first.
   */
  getRunsForReconciliation(olderThan: Date, limit: number): Promise<IScheduleRun[]>;
  /** Stamps runs as examined, so the reconciliation window rotates. */
  markRunsReconciled(runs: Array<WithIdLike<Pick<IScheduleRun, '_id'>, '_id'>>): Promise<void>;

  /* ------------------------------------------------------------ deletion and erasure */

  /**
   * Suspends every schedule of the owner ahead of account deletion, reversibly: snapshots its
   * state under `token`, then disables it, clears its next run and rotates its claim token.
   */
  suspendUserSchedulesForDeletion(userId: IdLike, token: string): Promise<void>;
  /**
   * Restores the schedules suspended under `token` that are not being deleted (retried a few
   * times; throws the last failure).
   */
  restoreUserSchedulesFromDeletion(userId: IdLike, token: string): Promise<void>;
  /** Schedules being deleted and not yet erased, least recently attempted first, up to `limit`. */
  getDeletingSchedules(limit: number): Promise<ISchedule[]>;
  /** Stamps schedules being deleted as attempted, so the erasure window rotates. */
  markEraseAttempted(ids: string[]): Promise<void>;
  /** Ids of the owner's schedules being deleted and not yet erased, up to `limit`. */
  getDeletingScheduleIds(userId: IdLike, limit: number): Promise<string[]>;
  /**
   * Erases a schedule being deleted once it has no active run and no live lease; resolves
   * whether it is erased.
   */
  eraseScheduleIfDrained(id: string): Promise<boolean>;
  /** Deletes every schedule of the owner and their runs (account deletion). */
  deleteSchedulesByUser(userId: IdLike): Promise<void>;
}

/** Every method of {@link ScheduleStore}, for adapters and conformance checks. */
export const SCHEDULE_STORE_METHODS: ReadonlyArray<keyof ScheduleStore> =
  listPortMethods<ScheduleStore>({
    ensureScheduleIndexes: true,
    createSchedule: true,
    createScheduleWithSlot: true,
    deleteUnarmedSchedule: true,
    updateScheduleById: true,
    getScheduleById: true,
    getSchedulesByUser: true,
    countSchedulesByUser: true,
    getScheduleByClientRequestId: true,
    markScheduleDeleting: true,
    claimDueSchedule: true,
    acquireManualRunLease: true,
    acquireResumeLease: true,
    consumeResumeLease: true,
    releaseLease: true,
    releaseLeaseByHolder: true,
    revalidateClaim: true,
    advanceSchedule: true,
    disableSchedule: true,
    persistResolvedProject: true,
    getUnarmedSchedules: true,
    armSchedule: true,
    insertScheduleRun: true,
    reserveStartedRun: true,
    getCapacityOccupancy: true,
    countActiveRuns: true,
    getScheduleRunProject: true,
    requestRunAbort: true,
    getScheduleRunAbortState: true,
    markRunAbortPersisted: true,
    getScheduleMCPCompletionState: true,
    recordMCPToolAuthFailure: true,
    markRunResumeClaimed: true,
    releaseRunResumeClaim: true,
    setRunFireDetails: true,
    deleteScheduleRun: true,
    getActiveRunsForSchedule: true,
    getActiveRunsForUser: true,
    recordRunOutcome: true,
    recordSkippedRun: true,
    getUnbookkeptRuns: true,
    finalizeBookkeeping: true,
    getRunsForReconciliation: true,
    markRunsReconciled: true,
    suspendUserSchedulesForDeletion: true,
    restoreUserSchedulesFromDeletion: true,
    getDeletingSchedules: true,
    markEraseAttempted: true,
    getDeletingScheduleIds: true,
    eraseScheduleIfDrained: true,
    deleteSchedulesByUser: true,
  });

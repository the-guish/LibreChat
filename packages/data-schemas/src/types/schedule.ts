import type {
  ScheduleRunStatus,
  ScheduleDisabledReason,
  TScheduleCadence,
} from 'librechat-data-provider';
import type { ScheduledMCPEnrollment } from 'librechat-data-provider';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export interface ISchedule {
  _id?: Types.ObjectId;
  id: string;
  user: Types.ObjectId;
  tenantId?: string;
  name: string;
  prompt: string;
  agent_id: string;
  cadence: TScheduleCadence;
  timezone: string;
  target: 'new';
  /** Chat project every run's conversation is filed under. Re-validated at each
   *  fire; a pinned operator project (interface.schedules.projectId) overrides it. */
  chatProjectId?: string;
  file_ids?: string[];
  tools?: string[];
  mcpConsent?: ScheduledMCPEnrollment;
  cron?: string;
  enabled: boolean;
  disabledReason?: ScheduleDisabledReason;
  nextRunAt?: Date;
  leaseUntil?: Date;
  leaseBy?: string;
  claimToken?: string;
  /** Owner-config generation; bumped only by an owner edit. */
  configRevision?: number;
  deleting?: boolean;
  /** Reversible account-deletion suspension. Set at quiesce under a per-attempt token
   *  that snapshots the pre-suspension enabled/next-run state, so a deletion that is
   *  later cancelled restores exactly this row (fenced to its token) instead of leaving
   *  a live user with silently disabled schedules. Distinct from `deleting`, which marks
   *  a row for erasure. */
  deletionSuspension?: {
    token: string;
    enabled: boolean;
    nextRunAt?: Date;
  };
  erased?: boolean;
  erasedAt?: Date;
  slot?: number;
  /** Client-supplied idempotency key of the create that produced this row. */
  clientRequestId?: string;
  /** Digest of the ORIGINAL create payload, stamped at insert and never edited.
   *  Replay matching compares against this rather than mutable schedule state, so a
   *  PATCH landing between the first attempt and its retry cannot fail the retry. */
  clientRequestDigest?: string;
  /** When an erasure sweep last attempted this soft-deleted row; orders the sweep
   *  window so undrainable rows cannot starve the ones behind them. */
  eraseAttemptedAt?: Date;
  lastRun?: {
    conversationId?: string;
    status: ScheduleRunStatus;
    error?: string;
    mcp?: ScheduleMCPOutcome[];
    firedAt: Date;
    /** The OCCURRENCE this projection came from; orders the card against delayed
     *  outcomes (a resumed pause, a reconciler replay) arriving after a newer run. */
    scheduledFor?: Date;
  };
  runCount: number;
  failureCount: number;
  balanceSkipCount: number;
  countedFor?: Date[];
  /** Newest occurrence applied to the streak counters; orders them like the card. */
  countersAsOf?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IScheduleDocument extends Omit<ISchedule, 'id' | '_id'>, Document {
  id: string;
}

export interface IScheduleRun {
  mcp?: ScheduleMCPOutcome[];
  _id?: Types.ObjectId;
  scheduleId: string;
  user: Types.ObjectId;
  tenantId?: string;
  scheduledFor: Date;
  firedAt?: Date;
  conversationId?: string;
  checkpointNamespace?: string;
  status: ScheduleRunStatus;
  error?: string;
  /** Deterministic durable-trigger delivery key for this occurrence, stamped at
   *  reservation (before enqueue). Lets reconciliation read the delivery's live/dead
   *  state instead of orphan-settling a jobless run that is merely deferred (Retry-After)
   *  or that dead-lettered before a generation ever started. */
  deliveryKey?: string;
  /** The destination project THIS occurrence actually used, recorded at reservation
   *  because the schedule-level value can move on (an operator pin redirects later
   *  fires, and a paused run does not block them), leaving the row describing a project
   *  this occurrence's conversation was never filed under.
   *
   *  ALWAYS written, `null` for a deliberately unscoped occurrence: an absent key means
   *  "this row predates the field", which is a different thing from "this run had no
   *  project" and must not be validated as if it were. */
  chatProjectId?: string | null;
  droppedFileIds?: string[];
  durationMs?: number;
  bookkept?: boolean;
  /** Set only by terminal writes; the retention TTL index expires on this field. */
  settledAt?: Date;
  /** Global concurrency slot held while `started`. */
  capacitySlot?: number;
  /** A started row used only to durably settle admission failure bookkeeping. It
   * never dispatched generation work and therefore does not consume capacity. */
  admissionOnly?: boolean;
  /** When an abort was requested; capacity is held until settlement is confirmed. */
  abortRequestedAt?: Date;
  /** Who requested the abort: the interactive Stop route ('stop', which persists a
   *  partial response before the run may settle) or a deletion path ('deletion'). */
  abortSource?: 'stop' | 'deletion';
  /** Stamped by the interactive Stop route once every write it makes (checkpoint
   *  prune, partial-response save) has landed; the generation owner defers its
   *  terminal settlement until this appears so the run can never leave the active
   *  set while the route is still persisting. */
  abortPersistedAt?: Date;
  /** The schedule's configRevision at claim time. */
  configRevision?: number;
  /** When reconciliation last examined this row; rotates each bounded non-terminal
   *  window so no abandoned row can starve behind a full batch of live runs. */
  reconciledAt?: Date;
  resumeClaimedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IScheduleRunDocument extends Omit<IScheduleRun, '_id'>, Document {}

/** The schedule fields scheduled-MCP consent reads, and the consent stored on it. */
export interface ScheduleConsentSnapshot {
  compatible?: boolean;
  agentId: string;
  enabled: boolean;
  configRevision: number;
  enrollment: ScheduledMCPEnrollment | null;
}

export interface ClaimDueScheduleParams {
  instanceId: string;
  leaseMs: number;
}

export interface RecordRunOutcomeParams {
  scheduleId: string;
  scheduledFor: Date;
  status: Extract<
    ScheduleRunStatus,
    'success' | 'error' | 'requires_action' | 'interrupted' | 'skipped_balance' | 'skipped_overlap'
  >;
  conversationId?: string;
  checkpointNamespace?: string;
  /** Erase the run row's RESERVED conversationId in the same terminal write: a
   *  pre-start abort reserved an id but never created the conversation, and any
   *  recovery replay that reads the row would otherwise project a dead link. */
  clearConversationId?: boolean;
  error?: string;
  /** Sanitized per-server MCP readiness outcomes for this occurrence. */
  mcp?: IScheduleRun['mcp'];
  durationMs?: number;
  autoDisableAfterFailures: number;
  /** Consecutive-balance-skip auto-disable threshold; required to settle a run as
   *  `skipped_balance` (a mid-generation balance refusal), ignored otherwise. */
  balanceSkipDisableThreshold?: number;
  /**
   * RECOVERY REPLAY of a pause, from an actor holding a possibly-stale row snapshot:
   * apply the transition only while no FRESH resume claim owns the row — that is, the
   * row carries no `resumeClaimedAt`, or one older than this cutoff. Without the fence,
   * two clustered sweepers observing the same unprojected pause race: the first projects
   * it, the owner's approval then claims a fresh slot (`markRunResumeClaimed` sets
   * `started` + `resumeClaimedAt` in ONE write), and the second still passes its
   * snapshot-based hand-off check and unsets the capacity slot and claim stamp out from
   * under the running continuation.
   *
   * A CUTOFF rather than a mere existence check, because the stamp outlives its meaning:
   * a worker that dies between claiming and resuming leaves it set forever, and rejecting
   * on existence alone would strand that row `started` — holding its capacity slot, with
   * its approval unresumable (`markRunResumeClaimed` only matches `requires_action`) —
   * which is the very state this replay exists to recover. Pass the same staleness bound
   * the caller's own in-flight check uses so the two agree.
   *
   * Never set by the generation owner: its own re-pause legitimately clears the stamp as
   * the hand-off's completion signal.
   */
  resumeClaimStaleBefore?: Date;
}

/** Outcome of reserving the single-active-run slot for a fired occurrence. */
export type StartedRunReservation =
  | { run: IScheduleRun }
  | {
      conflict: 'duplicate' | 'overlap' | 'slot-taken';
      /** For a `duplicate`, the status of the row that already holds this occurrence.
       *  A TERMINAL status means the occurrence is finished and merely never advanced
       *  past; an active one means another worker is still running it. */
      existingStatus?: ScheduleRunStatus;
    };

/** Outcome of promoting a paused occurrence back into the capacity-consuming
 * `started` set. Both conflicts are database-arbitrated by the same partial
 * unique indexes used for a first fire. */
export type ResumedRunReservation =
  | { capacitySlot: number }
  | { conflict: 'not-paused' | 'overlap' | 'slot-taken' };

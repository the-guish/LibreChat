/**
 * The schedule store's domain rules, shared by the MongoDB methods (`./schedule`) and the
 * PostgreSQL store (`adapters/postgres/stores/schedule.ts`; docs/postgres-port/PHASE4.md §8,
 * S10a): the lease and abort windows, the run statuses each read and write names, the filters and
 * updates of every guarded write (the owner edit with its paused-card branch, the lease claims and
 * releases, the worker fences, the abort coordination, the MCP receipt predicates, the pause and
 * settlement transitions, the card projection, the streak counters with their per-occurrence and
 * order fences, the auto-disable policies, the account-deletion suspension and restore, the
 * erasure tombstone), and the pure reads of what those writes leave (the capacity occupancy, the
 * recorded project, the MCP completion state, the receipt acknowledgment). Each function builds
 * fresh objects, so a driver casting a filter in place never changes another call's. Nothing here
 * may import `mongoose` or the MongoDB driver.
 */
import { randomUUID } from 'node:crypto';
import {
  getScheduleMCPDisabledReason,
  isScheduleMCPAuthorizationFailure,
  scheduledMCPFailureReasonSchema,
  mergeScheduleMCPReceipts,
} from 'librechat-data-provider';
import type { ScheduleRunStatus, ScheduleDisabledReason } from 'librechat-data-provider';
import type { ScheduleMCPOutcome, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ISchedule, IScheduleRun, RecordRunOutcomeParams } from '~/types/schedule';

/** A filter or an update, as both backends' query languages spell it. */
export type ScheduleQuery = Record<string, unknown>;

/** A guarded write: the filter the record must still match, and the update. */
export interface ScheduleWrite {
  filter: ScheduleQuery;
  update: ScheduleQuery;
}

/**
 * Tolerance for inter-replica wall-clock skew on the worker-clock lease
 * comparisons (DocumentDB rules out the server-clock `$$NOW` CAS). Applied only
 * where one worker judges ANOTHER worker's lease expired — taking over a due
 * claim, or declaring a deleting schedule drained — so a clock-ahead worker
 * cannot steal a lease its holder still considers live. Never applied where a
 * worker checks its OWN lease (revalidateClaim), which is self-consistent.
 * NTP-managed fleets sit orders of magnitude under this.
 */
export const LEASE_SKEW_MARGIN_MS: number = 30_000;

/**
 * Age past which an unresolved interactive-stop attempt is presumed dead and its
 * per-run serialization claim becomes takeable again. Mirrors the api layer's
 * ABORT_OWNER_PRESUMED_ALIVE_MS — one presumption, two enforcement points.
 */
export const ABORT_STAMP_STALE_MS: number = 30 * 60_000;

/**
 * Upper bound on the per-schedule `countedFor` idempotency set. Far larger than
 * the number of a single schedule's occurrences that can be terminal (or awaiting
 * reconciliation) at once, so an occurrence's marker is never evicted before any
 * possible crash-replay, while the array stays bounded.
 */
export const COUNTED_FOR_WINDOW: number = 64;

/** Statuses that occupy a schedule's live capacity / block a concurrent occurrence. */
export const ACTIVE_RUN_STATUSES: ScheduleRunStatus[] = ['started', 'requires_action'];

/** Card statuses that represent a SETTLED occurrence — everything except the pause. */
export const TERMINAL_CARD_STATUSES: ScheduleRunStatus[] = [
  'success',
  'error',
  'interrupted',
  'skipped_overlap',
  'skipped_balance',
];

/** Run statuses of a settled occurrence, as the settled-run reads name them. */
export const SETTLED_RUN_STATUSES: ScheduleRunStatus[] = [
  'success',
  'error',
  'interrupted',
  'skipped_balance',
  'skipped_overlap',
];

/** How many times a cancelled deletion's restore is tried before its failure is thrown. */
export const RESTORE_ATTEMPTS: number = 3;

/** The fields a consent-preserving owner edit may set (the activation state). */
const CONSENT_PRESERVING_FIELDS = [
  'enabled',
  'nextRunAt',
  'failureCount',
  'balanceSkipCount',
  'chatProjectId',
];

/** The ONLY fields an erasure tombstone keeps: replay-detection identity plus the
 *  flags that keep it inert to sweeps and resolvable by the create replay path. */
export const TOMBSTONE_IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  '_id',
  '__v',
  'id',
  'user',
  'tenantId',
  'clientRequestId',
  'clientRequestDigest',
  'deleting',
  'erased',
  'erasedAt',
  'enabled',
  'createdAt',
  'updatedAt',
]);

/* ------------------------------------------------------------ owner edits */

/** The two branches of an owner edit: the one dropping a paused card, and the plain one. */
export interface ScheduleOwnerEdit {
  /** Matches only while the card still shows a pause, and drops it in the same write. */
  pausedCard: ScheduleWrite;
  /** Matches otherwise (the gone/conflict signal when it misses too). */
  plain: ScheduleWrite;
}

/**
 * The owner edit (`updateScheduleById`). Rotates `claimToken` on every update so an in-flight
 * engine claim (which captured the prior token) is fenced off: its disable/advance/release
 * writes and its pre-dispatch revalidation no-op, and it cannot fire an edited or re-enabled
 * schedule. Throws when a consent-preserving edit asks for more than the activation state.
 */
export function scheduleOwnerEdit(
  id: string,
  userId: unknown,
  update: Partial<ISchedule>,
  unset?: Record<string, 1>,
  options?: { expectedConfigRevision?: number; preserveMCPConsentRevision?: string },
): ScheduleOwnerEdit {
  const preserveConsent = options?.preserveMCPConsentRevision != null;
  if (
    preserveConsent &&
    (options?.expectedConfigRevision == null ||
      Object.keys(update).some((key) => !CONSENT_PRESERVING_FIELDS.includes(key)) ||
      Object.keys(unset ?? {}).some((key) => key !== 'disabledReason'))
  )
    throw new Error('Consent continuity is limited to activation state');
  const filter = (): ScheduleQuery => ({
    id,
    user: userId,
    deleting: { $ne: true },
    ...(preserveConsent && {
      'mcpConsent.version': 1,
      'mcpConsent.revision': options!.preserveMCPConsentRevision,
      'mcpConsent.scheduleRevision': options!.expectedConfigRevision,
    }),
    ...(preserveConsent && update.chatProjectId != null && { chatProjectId: update.chatProjectId }),
    ...(options?.expectedConfigRevision !== undefined
      ? { configRevision: options.expectedConfigRevision }
      : {}),
  });
  const claimToken = randomUUID();
  const mutation = (): ScheduleQuery => ({
    $set: {
      ...update,
      claimToken,
      ...(preserveConsent && {
        'mcpConsent.scheduleRevision': options!.expectedConfigRevision! + 1,
      }),
    },
    // The ONLY writer of configRevision: an owner edit moves the config
    // generation forward atomically with the claim-token rotation, so a run
    // that started under the old config can detect it and skip bookkeeping.
    // Worker/policy writes (claim, lease, advance, disable, bookkeeping) never
    // bump it, and deletion deliberately does not either — a draining run must
    // still be able to record its outcome before erasure.
    $inc: { configRevision: 1 },
  });
  return {
    // FIRST branch: if the card still shows a pause, drop that projection in the SAME
    // atomic write as the revision bump. A `requires_action` card present at edit time
    // was projected by a run that captured the pre-edit revision; its terminal outcome
    // is revision-fenced (projectLastRun), so once this bump lands it can never replace
    // the card — and a disabling edit means no future occurrence will either, leaving it
    // stuck on "Needs approval" for a dead action. The clear is fenced on the projection
    // STILL being that pause (not a stale handler pre-read), so a terminal outcome or a
    // newer occurrence that raced in fails this branch and is preserved by the second.
    // DocumentDB rules out a conditional pipeline `$unset`, so this is a classic-operator
    // CAS branch rather than one update.
    pausedCard: {
      filter: { ...filter(), 'lastRun.status': 'requires_action' },
      update: { ...mutation(), $unset: { lastRun: 1, ...(unset ?? {}) } },
    },
    // SECOND branch: no dead pause to clear (terminal history survives untouched), or the
    // row is gone / a concurrent edit moved the revision — a null here is the true
    // gone/conflict signal the caller distinguishes.
    plain: { filter: filter(), update: { ...mutation(), ...(unset ? { $unset: unset } : {}) } },
  };
}

/**
 * The soft delete of a fresh create whose arming failed (`deleteUnarmedSchedule`): only while
 * the row is still the unarmed, unedited revision this attempt inserted.
 */
export function unarmedScheduleDeletion(
  id: string,
  userId: unknown,
  expectedConfigRevision?: number,
): ScheduleWrite {
  return {
    filter: {
      id,
      user: userId,
      deleting: { $ne: true },
      nextRunAt: { $exists: false },
      ...(expectedConfigRevision != null ? { configRevision: expectedConfigRevision } : {}),
    },
    update: { $set: { enabled: false, deleting: true, claimToken: randomUUID() } },
  };
}

/** The owner's soft delete (`markScheduleDeleting`), idempotent on purpose. */
export function scheduleDeletionMark(id: string, userId: unknown): ScheduleWrite {
  return {
    filter: { id, user: userId },
    update: {
      $set: { enabled: false, deleting: true, claimToken: randomUUID() },
      $unset: { nextRunAt: 1 },
    },
  };
}

/** The owner's schedules, except those being deleted (the owner listing and count). */
export function ownerSchedulesFilter(userId: unknown): ScheduleQuery {
  return { user: userId, deleting: { $ne: true } };
}

/** The schedule `id` (of `userId`, when given), unless it is being deleted. */
export function liveScheduleFilter(id: string, userId?: unknown): ScheduleQuery {
  const filter: ScheduleQuery = { id, deleting: { $ne: true } };
  if (userId != null) {
    filter.user = userId;
  }
  return filter;
}

/** The fields the owner listing leaves out (the engine's lease and claim). */
export const OWNER_LISTING_PROJECTION: string = '-leaseUntil -leaseBy -claimToken';

/* ------------------------------------------------------------ leases and claims */

/**
 * The lease states another worker may take: none, released, or expired past the skew margin
 * (`{ $lt }` never matches a missing lease, so the `$or` names it).
 */
export function leaseTakeoverClauses(now: Date): ScheduleQuery[] {
  const takeoverCutoff = new Date(now.getTime() - LEASE_SKEW_MARGIN_MS);
  return [
    { leaseUntil: { $exists: false } },
    { leaseUntil: null },
    { leaseUntil: { $lt: takeoverCutoff } },
  ];
}

/**
 * The engine's claim of one due schedule (`claimDueSchedule`), oldest next run first. Due-ness
 * and lease expiry compare against the worker's clock; `{ $lte }` matches neither missing nor
 * null `nextRunAt`, so unarmed rows stay unclaimable.
 */
export function dueScheduleClaim(
  params: { instanceId: string; leaseMs: number },
  now: Date,
  claimToken: string,
): ScheduleWrite & { sort: Record<string, 1> } {
  return {
    filter: {
      enabled: true,
      deleting: { $ne: true },
      nextRunAt: { $lte: now },
      $or: leaseTakeoverClauses(now),
    },
    update: {
      $set: {
        leaseUntil: new Date(now.getTime() + params.leaseMs),
        leaseBy: params.instanceId,
        claimToken,
      },
    },
    sort: { nextRunAt: 1 },
  };
}

/**
 * A manual run-now's lease (`acquireManualRunLease`), under a unique holder: the superseded-fire
 * cleanup releases by holder, so a stale run-now must never match a newer one's lease.
 */
export function manualRunLease(
  id: string,
  userId: unknown,
  leaseMs: number,
  now: Date,
  claimToken: string,
): ScheduleWrite {
  const leaseBy = `manual:${claimToken}`;
  return {
    filter: { id, user: userId, deleting: { $ne: true }, $or: leaseTakeoverClauses(now) },
    update: { $set: { leaseUntil: new Date(now.getTime() + leaseMs), leaseBy, claimToken } },
  };
}

/** The short-lived fence of a paused run's resume (`acquireResumeLease`). */
export function resumeLease(
  id: string,
  expectedConfigRevision: number | undefined,
  requireEnabled: boolean,
  leaseMs: number,
  now: Date,
  claimToken: string,
): ScheduleWrite {
  const leaseBy = `resume:${claimToken}`;
  return {
    filter: {
      id,
      deleting: { $ne: true },
      ...(requireEnabled ? { enabled: true } : {}),
      ...(expectedConfigRevision !== undefined ? { configRevision: expectedConfigRevision } : {}),
      $or: leaseTakeoverClauses(now),
    },
    update: {
      $set: {
        leaseUntil: new Date(now.getTime() + leaseMs),
        leaseBy,
        claimToken,
      },
    },
  };
}

/** The update that releases a lease. */
export function leaseRelease(): ScheduleQuery {
  return { $unset: { leaseUntil: 1, leaseBy: 1 } };
}

/** Consuming a resume fence (`consumeResumeLease`): still the one taken, unexpired, unchanged. */
export function resumeLeaseConsumption(
  id: string,
  expectedClaimToken: string,
  expectedLeaseBy: string,
  requireEnabled: boolean,
  expectedConfigRevision: number | undefined,
  now: Date,
): ScheduleWrite {
  return {
    filter: {
      id,
      claimToken: expectedClaimToken,
      leaseBy: expectedLeaseBy,
      deleting: { $ne: true },
      leaseUntil: { $gt: now },
      ...(requireEnabled ? { enabled: true } : {}),
      ...(expectedConfigRevision !== undefined ? { configRevision: expectedConfigRevision } : {}),
    },
    update: leaseRelease(),
  };
}

/** The lease release fenced on the claim token when one is given (`releaseLease`). */
export function leaseReleaseFilter(id: string, expectedClaimToken?: string): ScheduleQuery {
  const filter: ScheduleQuery = { id };
  if (expectedClaimToken !== undefined) {
    filter.claimToken = expectedClaimToken;
  }
  return filter;
}

/**
 * Whether the caller still holds the claim (`revalidateClaim`). Worker clock: `$gt` matches
 * neither a missing nor a null `leaseUntil`, so a released lease reads as invalid.
 */
export function heldClaimFilter(
  id: string,
  claimToken: string,
  requireEnabled: boolean,
  now: Date,
): ScheduleQuery {
  return {
    id,
    claimToken,
    deleting: { $ne: true },
    ...(requireEnabled ? { enabled: true } : {}),
    leaseUntil: { $gt: now },
  };
}

/** Moving past a fired or skipped occurrence and releasing the lease (`advanceSchedule`). */
export function scheduleAdvance(
  id: string,
  nextRunAt: Date | null,
  expectedNextRunAt?: Date | null,
  expectedClaimToken?: string,
): ScheduleWrite {
  const filter: ScheduleQuery = { id };
  if (expectedNextRunAt !== undefined) {
    filter.nextRunAt = expectedNextRunAt;
  }
  if (expectedClaimToken !== undefined) {
    filter.claimToken = expectedClaimToken;
  }
  return {
    filter,
    update: {
      $set: { ...(nextRunAt ? { nextRunAt } : {}) },
      $unset: { leaseUntil: 1, leaseBy: 1, ...(nextRunAt ? {} : { nextRunAt: 1 }) },
    },
  };
}

/**
 * Disabling a schedule and releasing its lease (`disableSchedule`), fenced on the claim token,
 * the config revision and (for the policy disables) the counter the decision was made on.
 */
export function scheduleDisable(
  id: string,
  reason: ScheduleDisabledReason,
  expectedClaimToken?: string,
  expectedConfigRevision?: number,
  counterGuard?: Record<string, unknown>,
): ScheduleWrite {
  const filter: ScheduleQuery = { id, ...counterGuard };
  if (expectedClaimToken !== undefined) {
    filter.claimToken = expectedClaimToken;
  }
  if (expectedConfigRevision !== undefined) {
    filter.configRevision = expectedConfigRevision;
  }
  return {
    filter,
    update: {
      $set: { enabled: false, disabledReason: reason },
      $unset: { leaseUntil: 1, leaseBy: 1 },
    },
  };
}

/** Storing the project a fire resolved (`persistResolvedProject`), without an owner edit. */
export function resolvedProjectWrite(
  id: string,
  chatProjectId: string | undefined,
  expectedClaimToken?: string,
): ScheduleWrite {
  const filter: ScheduleQuery = { id };
  if (expectedClaimToken !== undefined) {
    filter.claimToken = expectedClaimToken;
  }
  return {
    filter,
    update: chatProjectId == null ? { $unset: { chatProjectId: 1 } } : { $set: { chatProjectId } },
  };
}

/** Enabled schedules with no next run (`getUnarmedSchedules`). */
export function unarmedSchedulesFilter(): ScheduleQuery {
  return { enabled: true, deleting: { $ne: true }, nextRunAt: { $exists: false } };
}

/** The one arming CAS every creation path shares (`armSchedule`). */
export function scheduleArming(
  id: string,
  nextRunAt: Date,
  expectedConfigRevision?: number,
): ScheduleWrite {
  return {
    filter: {
      id,
      enabled: true,
      deleting: { $ne: true },
      nextRunAt: { $exists: false },
      ...(expectedConfigRevision != null ? { configRevision: expectedConfigRevision } : {}),
    },
    update: { $set: { nextRunAt } },
  };
}

/* ------------------------------------------------------------ runs */

/**
 * The project one occurrence recorded, from its run's `chatProjectId` (key presence, not
 * truthiness: a stored `null` is a recorded decision, an absent key is not); `null` without a run.
 */
export function runProjectOf(
  run: { chatProjectId?: string | null } | null,
): { recorded: boolean; chatProjectId?: string } | null {
  if (run == null) {
    return null;
  }
  const recorded = Object.prototype.hasOwnProperty.call(run, 'chatProjectId');
  return recorded && run.chatProjectId != null
    ? { recorded, chatProjectId: run.chatProjectId }
    : { recorded };
}

/** Started generation runs, for the capacity allocator (admission-only rows excluded). */
export function capacityHoldersFilter(): ScheduleQuery {
  return { status: 'started', admissionOnly: { $ne: true } };
}

/** The slots the started generation runs hold, and how many hold none. */
export function capacityOccupancyOf(rows: Array<{ capacitySlot?: number }>): {
  takenSlots: number[];
  unslotted: number;
} {
  const takenSlots: number[] = [];
  let unslotted = 0;
  for (const row of rows) {
    if (typeof row.capacitySlot === 'number') {
      takenSlots.push(row.capacitySlot);
    } else {
      unslotted += 1;
    }
  }
  return { takenSlots, unslotted };
}

/** The active run of one occurrence. */
export function activeRunFilter(scheduleId: string, scheduledFor: Date): ScheduleQuery {
  return { scheduleId, scheduledFor, status: { $in: ACTIVE_RUN_STATUSES } };
}

/**
 * The serialized stop attempt (`requestRunAbort` with `'stop'`): only one unresolved fresh stop
 * attempt may exist; a stale one (its route presumed dead) is claimable again.
 */
export function stopAttemptWrite(scheduleId: string, scheduledFor: Date, now: Date): ScheduleWrite {
  const staleCutoff = new Date(now.getTime() - ABORT_STAMP_STALE_MS);
  return {
    filter: {
      scheduleId,
      scheduledFor,
      status: { $in: ACTIVE_RUN_STATUSES },
      $nor: [
        {
          abortSource: 'stop',
          abortPersistedAt: { $exists: false },
          abortRequestedAt: { $gt: staleCutoff },
        },
      ],
    },
    update: {
      $set: { abortRequestedAt: now, abortSource: 'stop' },
      $unset: { abortPersistedAt: 1 },
    },
  };
}

/** An abort request that may take the source (no unresolved stop attempt holds it). */
export function abortClaimWrite(
  scheduleId: string,
  scheduledFor: Date,
  now: Date,
  source?: IScheduleRun['abortSource'],
): ScheduleWrite {
  return {
    filter: {
      scheduleId,
      scheduledFor,
      status: { $in: ACTIVE_RUN_STATUSES },
      $or: [{ abortSource: { $ne: 'stop' } }, { abortPersistedAt: { $exists: true } }],
    },
    update: { $set: { abortRequestedAt: now, ...(source ? { abortSource: source } : {}) } },
  };
}

/** Renewing an abort's freshness only (an unresolved stop attempt holds the source). */
export function abortRenewalWrite(
  scheduleId: string,
  scheduledFor: Date,
  now: Date,
): ScheduleWrite {
  return {
    filter: activeRunFilter(scheduleId, scheduledFor),
    update: { $set: { abortRequestedAt: now } },
  };
}

/** The schedule fields the MCP completion state reads. */
export const MCP_COMPLETION_PROJECTION: string = 'agent_id mcpConsent deleting erased';

/** The schedule of a task's captured identity. */
export function scheduleIdentityFilter(identity: ScheduledMCPIdentity): ScheduleQuery {
  return { id: identity.scheduleId, user: identity.ownerId, tenantId: identity.tenantId };
}

/** Captured origin cannot adopt a later grant or a different schedule root. */
export function scheduleMCPCompletionStateOf(
  identity: ScheduledMCPIdentity,
  schedule: Pick<ISchedule, 'agent_id' | 'deleting' | 'erased' | 'mcpConsent'> | null,
): { identity: ScheduledMCPIdentity; enrolled: boolean } {
  return {
    identity,
    enrolled:
      !schedule ||
      schedule.agent_id !== identity.agentId ||
      schedule.deleting === true ||
      schedule.erased === true ||
      schedule.mcpConsent !== undefined,
  };
}

/** The run fields the abort coordination reads. */
export const ABORT_STATE_PROJECTION: string =
  'status abortRequestedAt abortSource abortPersistedAt mcp';

/** A paused run moving back to `started` under a capacity slot (`markRunResumeClaimed`). */
export function resumeClaimWrite(
  scheduleId: string,
  scheduledFor: Date,
  capacitySlot: number,
  now: Date,
): ScheduleWrite {
  return {
    filter: { scheduleId, scheduledFor, status: 'requires_action' },
    update: { $set: { status: 'started', capacitySlot, resumeClaimedAt: now } },
  };
}

/** Rolling a resume reservation back while the run holds exactly `capacitySlot`. */
export function resumeClaimRelease(
  scheduleId: string,
  scheduledFor: Date,
  capacitySlot: number,
): ScheduleWrite {
  return {
    filter: { scheduleId, scheduledFor, status: 'started', capacitySlot },
    update: {
      $set: { status: 'requires_action' },
      $unset: { capacitySlot: 1, resumeClaimedAt: 1 },
    },
  };
}

/** The receipts an MCP authorization failure records, and the run binding it must match. */
export function mcpToolAuthFailureReceipts(input: {
  scheduleId: string;
  scheduledFor: Date;
  conversationId: string;
  tenantId?: string;
  server: string;
  outcome?: ScheduleMCPOutcome;
  outcomes?: ScheduleMCPOutcome[];
}): { binding: ScheduleQuery; receipts: ScheduleMCPOutcome[] } {
  const binding = {
    scheduleId: input.scheduleId,
    scheduledFor: input.scheduledFor,
    conversationId: input.conversationId,
    ...(input.tenantId ? { tenantId: input.tenantId } : { tenantId: { $exists: false } }),
  };
  const receipts: ScheduleMCPOutcome[] = input.outcomes ?? [
    input.outcome ?? {
      server: input.server,
      status: 'mcp_configuration_missing',
      detail: 'unattended_auth_required',
    },
  ];
  return { binding, receipts };
}

/** Appending receipts to a live run of the binding, without touching its update time. */
export function mcpReceiptWrite(
  binding: ScheduleQuery,
  receipts: ScheduleMCPOutcome[],
): ScheduleWrite {
  return {
    filter: { ...binding, status: { $in: ['started', 'requires_action'] } },
    update: { $addToSet: { mcp: { $each: receipts } } },
  };
}

/** The settled run of the binding, whose receipts a durable replay may acknowledge. */
export function settledReceiptRunFilter(binding: ScheduleQuery): ScheduleQuery {
  return {
    ...binding,
    status: { $in: ['success', 'error', 'interrupted', 'skipped_balance', 'skipped_overlap'] },
  };
}

/** A durable replay acknowledges existing evidence, never appends a late diagnosis. */
export function acknowledgesMCPReceipts(
  admittedReceipts: ScheduleMCPOutcome[] | undefined,
  receipts: ScheduleMCPOutcome[],
): boolean {
  const admitted = mergeScheduleMCPReceipts(admittedReceipts ?? []);
  return mergeScheduleMCPReceipts(admitted, receipts).length === admitted.length;
}

/** Recording what a fire dispatched on the run reserved for that conversation. */
export function fireDetailsWrite(
  scheduleId: string,
  scheduledFor: Date,
  details: { conversationId: string; droppedFileIds?: string[]; mcp?: IScheduleRun['mcp'] },
): ScheduleWrite {
  return {
    filter: { scheduleId, scheduledFor, conversationId: details.conversationId },
    update: {
      $set: {
        conversationId: details.conversationId,
        ...(details.droppedFileIds?.length ? { droppedFileIds: details.droppedFileIds } : {}),
      },
      ...(details.mcp?.length ? { $addToSet: { mcp: { $each: details.mcp } } } : {}),
    },
  };
}

/** The rollback delete of a run, fenced on the expected status and conversation. */
export function runDeletionFilter(
  scheduleId: string,
  scheduledFor: Date,
  expectedStatus?: ScheduleRunStatus,
  expectedConversationId?: string,
): ScheduleQuery {
  const filter: ScheduleQuery = { scheduleId, scheduledFor };
  if (expectedStatus !== undefined) {
    filter.status = expectedStatus;
  }
  if (expectedConversationId !== undefined) {
    filter.conversationId = expectedConversationId;
  }
  return filter;
}

/** Non-terminal runs of one status fired before `olderThan`, least recently examined first. */
export function reconciliationWindow(
  status: 'started' | 'requires_action',
  olderThan: Date,
): { filter: ScheduleQuery; sort: Record<string, 1> } {
  return { filter: { status, firedAt: { $lt: olderThan } }, sort: { reconciledAt: 1, firedAt: 1 } };
}

/** Settled runs whose bookkeeping never landed, least recently attempted first. */
export function unbookkeptRunsWindow(olderThan: Date): {
  filter: ScheduleQuery;
  sort: Record<string, 1>;
} {
  return {
    filter: {
      status: {
        $in: ['success', 'error', 'interrupted', 'skipped_balance', 'skipped_overlap'],
      },
      bookkept: false,
      firedAt: { $lt: olderThan },
    },
    sort: { reconciledAt: 1, firedAt: 1 },
  };
}

/* ------------------------------------------------------------ the card and the counters */

/** The config fence of a run's bookkeeping (absent on either side disables it). */
export function configRevisionFilter(revision?: number | null): ScheduleQuery {
  return revision != null ? { configRevision: revision } : {};
}

/**
 * The order fence of the streak counters: absent-tolerant, so schedules written before the
 * watermark existed count once and then order normally.
 */
export function counterOrderFilter(scheduledFor: Date): ScheduleQuery {
  return {
    $or: [{ countersAsOf: { $exists: false } }, { countersAsOf: { $lte: scheduledFor } }],
  };
}

/**
 * Writing an occurrence's result onto the card (`projectLastRun`), fenced on occurrence order so
 * a delayed outcome never overwrites a newer occurrence's projection, and (for a pause) never
 * walking this occurrence's settled card back to "Needs approval". Run-state bookkeeping: the
 * write leaves `updatedAt` alone.
 */
export function lastRunProjection(
  scheduleId: string,
  lastRun: NonNullable<ISchedule['lastRun']>,
  scheduledFor: Date,
  revisionFilter: ScheduleQuery = {},
): ScheduleWrite {
  // A PAUSE is the only non-terminal projection, and it is the one that can still
  // arrive late for its own occurrence: the row transition is won first, and a resume
  // can terminalize and project between that CAS and this write. Occurrence ordering
  // alone permits it (same `scheduledFor`), so refuse to walk this occurrence's card
  // backwards from a settled result to "Needs approval" — which nothing would correct
  // until the next occurrence ran.
  const notAlreadySettled =
    lastRun.status === 'requires_action'
      ? {
          $nor: [
            {
              $and: [
                { 'lastRun.scheduledFor': scheduledFor },
                { 'lastRun.status': { $in: TERMINAL_CARD_STATUSES } },
              ],
            },
          ],
        }
      : {};
  return {
    filter: {
      id: scheduleId,
      $or: [
        { 'lastRun.scheduledFor': { $exists: false } },
        { 'lastRun.scheduledFor': { $lte: scheduledFor } },
      ],
      ...notAlreadySettled,
      ...revisionFilter,
    },
    update: { $set: { lastRun: { ...lastRun, scheduledFor } } },
  };
}

/** The card of a terminal occurrence. */
export function terminalLastRun(
  params: RecordRunOutcomeParams & { firedAt: Date },
): NonNullable<ISchedule['lastRun']> {
  return {
    conversationId: params.conversationId,
    status: params.status,
    error: params.error,
    mcp: params.mcp,
    firedAt: params.firedAt,
  };
}

/**
 * The counter write of a terminal occurrence (`applyTerminalBookkeeping`): idempotent per
 * occurrence through the bounded `countedFor` set, ordered by `countersAsOf`, fenced by the run's
 * config revision. Everything that must land atomically WITH the count is in this one update: the
 * balance-skip streak resets on any non-balance outcome, a success clears the failure streak.
 */
export function terminalCounterWrite(
  params: RecordRunOutcomeParams & { expectConfigRevision?: number },
): ScheduleWrite {
  const isFailure = params.status === 'error';
  const isSuccess = params.status === 'success';
  return {
    filter: {
      id: params.scheduleId,
      countedFor: { $ne: params.scheduledFor },
      ...configRevisionFilter(params.expectConfigRevision),
      ...counterOrderFilter(params.scheduledFor),
    },
    update: {
      $set: {
        balanceSkipCount: 0,
        countersAsOf: params.scheduledFor,
        ...(isSuccess ? { failureCount: 0 } : {}),
      },
      $push: { countedFor: { $each: [params.scheduledFor], $slice: -COUNTED_FOR_WINDOW } },
      ...(isSuccess ? { $inc: { runCount: 1 } } : {}),
      ...(isFailure ? { $inc: { failureCount: 1 } } : {}),
    },
  };
}

/**
 * A success clears a transient disable reason only while the schedule is still enabled (an
 * older run settling after newer outcomes disabled it must keep the reason).
 */
export function disabledReasonClear(scheduleId: string): ScheduleWrite {
  return { filter: { id: scheduleId, enabled: true }, update: { $unset: { disabledReason: 1 } } };
}

/**
 * The failure auto-disable decision on the schedule as read after the count: the threshold (1 for
 * an MCP failure needing user action), the reason, and the counter guard the disable carries.
 * `null` when the schedule is not to be disabled.
 */
export function failureDisableDecision(
  schedule: Pick<ISchedule, 'enabled' | 'failureCount'> | null,
  params: Pick<RecordRunOutcomeParams, 'mcp' | 'autoDisableAfterFailures' | 'scheduledFor'>,
): { reason: ScheduleDisabledReason; counterGuard: Record<string, unknown> } | null {
  const mcpReason = getScheduleMCPDisabledReason(params.mcp);
  const threshold = mcpReason ? 1 : params.autoDisableAfterFailures;
  if (!(schedule?.enabled && schedule.failureCount >= threshold)) {
    return null;
  }
  // Carry the COUNT this decision was made on, not just the revision. The read
  // and the disable are separate statements, and a concurrent success resets
  // the failure streak to zero — a revision-only fence would still let this stale
  // decision disable a schedule whose streak had just been cleared.
  return {
    reason: mcpReason ?? 'too_many_failures',
    counterGuard: {
      failureCount: { $gte: threshold },
      ...(mcpReason ? { countersAsOf: params.scheduledFor } : {}),
    },
  };
}

/** The balance-skip streak's per-occurrence, ordered and revision-fenced increment. */
export function balanceSkipCounterWrite(
  scheduleId: string,
  scheduledFor: Date,
  rowRevision?: number,
): ScheduleWrite {
  return {
    filter: {
      id: scheduleId,
      countedFor: { $ne: scheduledFor },
      ...configRevisionFilter(rowRevision),
      ...counterOrderFilter(scheduledFor),
    },
    update: {
      $inc: { balanceSkipCount: 1 },
      $set: { countersAsOf: scheduledFor },
      $push: { countedFor: { $each: [scheduledFor], $slice: -COUNTED_FOR_WINDOW } },
    },
  };
}

/** The insufficient-balance auto-disable decision, with the counter guard it carries. */
export function balanceSkipDisableGuard(
  schedule: Pick<ISchedule, 'enabled' | 'balanceSkipCount'> | null,
  threshold: number,
): Record<string, unknown> | null {
  if (!(schedule?.enabled && schedule.balanceSkipCount >= threshold)) {
    return null;
  }
  return { balanceSkipCount: { $gte: threshold } };
}

/** An overlap breaks the balance-skip streak (an intervening non-balance outcome). */
export function overlapSkipCounterWrite(
  scheduleId: string,
  scheduledFor: Date,
  rowRevision?: number,
): ScheduleWrite {
  return {
    filter: {
      id: scheduleId,
      ...configRevisionFilter(rowRevision),
      ...counterOrderFilter(scheduledFor),
    },
    update: { $set: { balanceSkipCount: 0, countersAsOf: scheduledFor } },
  };
}

/* ------------------------------------------------------------ settlement */

/**
 * The run receipts that refuse a pause and turn a settlement into an error: an unattended-auth
 * diagnosis, or a non-ready receipt with a failure reason that allows no automatic replay.
 */
export function mcpReceiptPredicates(): ScheduleQuery[] {
  return [
    { 'mcp.detail': 'unattended_auth_required' },
    {
      mcp: {
        $elemMatch: {
          reason: { $in: scheduledMCPFailureReasonSchema.options },
          status: { $ne: 'ready' },
          automaticReplay: false,
        },
      },
    },
  ];
}

/**
 * Fences a stale-snapshot recovery replay against a resume that claimed the row after the
 * snapshot was taken, while letting an abandoned claim be recovered.
 */
export function resumeClaimFence(resumeClaimStaleBefore?: Date): ScheduleQuery {
  return resumeClaimStaleBefore != null
    ? {
        $or: [
          { resumeClaimedAt: { $exists: false } },
          { resumeClaimedAt: { $lt: resumeClaimStaleBefore } },
        ],
      }
    : {};
}

/**
 * The pause transition of a started or paused run (`recordRunOutcome` with `requires_action`):
 * refused while a receipt denies it; leaving `started` frees the capacity slot, and the pause
 * record clears the resume claim (the hand-off's completion signal).
 */
export function pauseTransition(params: RecordRunOutcomeParams): ScheduleWrite {
  return {
    filter: {
      scheduleId: params.scheduleId,
      scheduledFor: params.scheduledFor,
      status: { $in: ['started', 'requires_action'] },
      $nor: mcpReceiptPredicates(),
      ...resumeClaimFence(params.resumeClaimStaleBefore),
    },
    update: {
      $set: {
        status: 'requires_action',
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
        ...(params.checkpointNamespace != null
          ? { checkpointNamespace: params.checkpointNamespace }
          : {}),
      },
      $unset: { capacitySlot: 1, resumeClaimedAt: 1 },
    },
  };
}

/** The terminal transition's pieces (`recordRunOutcome` with a settled status). */
export interface TerminalTransition {
  /** The run row the settlement matches (still started or paused, the resume fence). */
  runFilter: ScheduleQuery;
  /** Whether a durable receipt may turn this settlement into an error. */
  canOverride: boolean;
  /** Whether the incoming receipts already carry an authorization failure. */
  incomingFailure: boolean;
  /** The predicates of {@link mcpReceiptPredicates}. */
  receiptPredicates: ScheduleQuery[];
  /** The error a receipt-forced settlement records. */
  authError: string;
  /** The update settling the row at `status` with `error`. */
  update: (status: RecordRunOutcomeParams['status'], error: string | undefined) => ScheduleQuery;
}

/**
 * Builds the terminal transition of `params` at `settledAt`. The absence check of the receipts
 * is part of the row update, not a stale read: a concurrent receipt either wins first (the
 * fallback records an error) or loses to terminalization (and can no longer stamp this run).
 */
export function terminalTransition(
  params: RecordRunOutcomeParams,
  settledAt: Date,
): TerminalTransition {
  const runFilter = {
    scheduleId: params.scheduleId,
    scheduledFor: params.scheduledFor,
    status: { $in: ['started', 'requires_action'] },
    ...resumeClaimFence(params.resumeClaimStaleBefore),
  };
  const canOverride =
    params.status === 'success' ||
    params.status === 'error' ||
    params.status === 'skipped_balance' ||
    params.status === 'interrupted';
  const incomingFailure =
    (canOverride && params.mcp?.some(isScheduleMCPAuthorizationFailure)) === true;
  const authError =
    params.status === 'error' && params.error
      ? params.error
      : 'MCP unattended authorization unavailable';
  const update = (status: RecordRunOutcomeParams['status'], error: string | undefined) => ({
    $set: {
      status,
      bookkept: false,
      settledAt,
      ...(params.conversationId && !params.clearConversationId
        ? { conversationId: params.conversationId }
        : {}),
      ...(error ? { error } : {}),
      ...(params.durationMs != null ? { durationMs: params.durationMs } : {}),
    },
    // Merge in the same transition; neither a receipt race nor a crash can lose a source.
    ...(params.mcp?.length && { $addToSet: { mcp: { $each: params.mcp } } }),
    // Only terminal settlement releases the global capacity slot, not an abort request.
    $unset: {
      capacitySlot: 1,
      admissionOnly: 1,
      ...(params.clearConversationId ? { conversationId: 1 } : {}),
    },
  });
  return {
    runFilter,
    canOverride,
    incomingFailure,
    receiptPredicates: mcpReceiptPredicates(),
    authError,
    update,
  };
}

/** Marks an occurrence's run as bookkept (its schedule-side writes landed). */
export function bookkeptWrite(scheduleId: string, scheduledFor: Date): ScheduleWrite {
  return { filter: { scheduleId, scheduledFor }, update: { $set: { bookkept: true } } };
}

/* ------------------------------------------------------------ deletion and erasure */

/** The owner's schedules a suspension under `token` takes (not deleting, not already its own). */
export function suspensionCandidatesFilter(userId: unknown, token: string): ScheduleQuery {
  return {
    user: userId,
    deleting: { $ne: true },
    'deletionSuspension.token': { $ne: token },
  };
}

/** The schedule fields a suspension snapshots. */
export const SUSPENSION_PROJECTION: string = 'id enabled nextRunAt deletionSuspension';

/**
 * The suspension of one schedule under `token`: snapshot its pre-suspension state (carrying an
 * abandoned attempt's snapshot forward, which still holds the true state), then fence firing.
 */
export function suspensionWrite(
  schedule: Pick<ISchedule, 'id' | 'enabled' | 'nextRunAt' | 'deletionSuspension'>,
  userId: unknown,
  token: string,
): ScheduleWrite {
  // A row already suspended by an ABANDONED earlier attempt (its process died before
  // restoring) still holds the only record of the true pre-suspension state. Carry that
  // snapshot forward and merely take ownership with this attempt's token — re-reading
  // the row's CURRENT values would snapshot the suspended state itself (disabled, no
  // next run) and permanently strand the schedule when this attempt later restores.
  const existing = schedule.deletionSuspension;
  const snapshotEnabled = existing != null ? existing.enabled === true : schedule.enabled === true;
  const snapshotNextRunAt = existing != null ? existing.nextRunAt : schedule.nextRunAt;
  return {
    filter: {
      id: schedule.id,
      user: userId,
      deleting: { $ne: true },
      'deletionSuspension.token': { $ne: token },
    },
    update: {
      $set: {
        enabled: false,
        claimToken: randomUUID(),
        deletionSuspension: {
          token,
          enabled: snapshotEnabled,
          ...(snapshotNextRunAt != null ? { nextRunAt: snapshotNextRunAt } : {}),
        },
      },
      $unset: { nextRunAt: 1 as const },
    },
  };
}

/** The owner's schedules suspended under `token` that are not being deleted. */
export function suspendedSchedulesFilter(userId: unknown, token: string): ScheduleQuery {
  return { user: userId, 'deletionSuspension.token': token, deleting: { $ne: true } };
}

/** The schedule fields a restore reads. */
export const RESTORE_PROJECTION: string = 'id deletionSuspension';

/** Restoring one schedule from its snapshot, only while it still carries this attempt's token. */
export function restoreWrite(
  schedule: Pick<ISchedule, 'id' | 'deletionSuspension'>,
  userId: unknown,
  token: string,
): ScheduleWrite {
  const snapshot = schedule.deletionSuspension;
  const restoreNextRunAt = snapshot?.nextRunAt;
  return {
    filter: {
      id: schedule.id,
      user: userId,
      'deletionSuspension.token': token,
      deleting: { $ne: true },
    },
    update: {
      $set: {
        enabled: snapshot?.enabled === true,
        claimToken: randomUUID(),
        ...(restoreNextRunAt != null ? { nextRunAt: restoreNextRunAt } : {}),
      },
      $unset: {
        deletionSuspension: 1 as const,
        ...(restoreNextRunAt == null ? { nextRunAt: 1 as const } : {}),
      },
    },
  };
}

/** Runs `attempt` up to {@link RESTORE_ATTEMPTS} times, throwing the last failure. */
export async function retryRestore(attempt: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let index = 1; index <= RESTORE_ATTEMPTS; index++) {
    try {
      await attempt();
      return;
    } catch (error) {
      lastError = error;
      if (index < RESTORE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 100 * index));
      }
    }
  }
  throw lastError;
}

/** Schedules being deleted and not yet erased (of `userId`, when given), for the sweeps. */
export function deletingSchedulesWindow(userId?: unknown): {
  filter: ScheduleQuery;
  sort: Record<string, 1>;
} {
  return {
    filter: {
      ...(userId !== undefined ? { user: userId } : {}),
      deleting: true,
      erased: { $ne: true },
    },
    sort: { eraseAttemptedAt: 1 },
  };
}

/** Stamping schedules being deleted as attempted, so the erasure window rotates. */
export function eraseAttemptWrite(ids: string[], now: Date): ScheduleWrite {
  return {
    filter: { id: { $in: ids }, deleting: true },
    update: { $set: { eraseAttemptedAt: now } },
  };
}

/** Whether a deleting schedule's lease still reads as live (the skew margin past its expiry). */
export function holdsLiveLease(leaseUntil: Date | null | undefined, now: number): boolean {
  return leaseUntil != null && leaseUntil.getTime() > now - LEASE_SKEW_MARGIN_MS;
}

/** The top-level schedule fields a tombstone unsets: every field but the identity. */
export function tombstoneContentFields(paths: Iterable<string>): string[] {
  return [...new Set([...paths].map((path) => path.split('.')[0]))].filter(
    (field) => !TOMBSTONE_IDENTITY_FIELDS.has(field),
  );
}

/**
 * The content-free tombstone of a schedule created under an idempotency key: only the replay
 * identity remains, for the TTL window on `erasedAt`. Not a config edit (no `updatedAt`).
 */
export function tombstoneWrite(id: string, contentFields: string[], now: Date): ScheduleWrite {
  return {
    filter: { id, deleting: true, clientRequestId: { $exists: true } },
    update: {
      $set: { erased: true, erasedAt: now, enabled: false },
      $unset: Object.fromEntries(contentFields.map((field) => [field, 1])),
    },
  };
}

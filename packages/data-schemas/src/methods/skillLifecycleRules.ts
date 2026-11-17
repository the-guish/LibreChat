/**
 * The skill lifecycle store's domain rules, shared by the MongoDB methods (`./skillLifecycle`)
 * and the PostgreSQL store (`adapters/postgres/stores/skillLifecycle.ts`;
 * docs/postgres-port/PHASE4.md §8, S8): the conditions of the deletion journal's leases (which
 * deletions a worker may claim, renew or complete), of the blob cleanup sweep and its leases
 * (which upload intents await cleanup, and which a worker may claim), the intent a legacy file
 * gets when its skill's deletion is journaled, and the cleanup batches' size rule. Nothing here may
 * import `mongoose` or the MongoDB driver: ids are whatever the backend hands out.
 */

/** How many legacy files' intents one backfill write carries. */
export const LEGACY_BACKFILL_BATCH_SIZE = 100;

/** The intents whose blob may still need cleanup: not committed, or committed and not cleaned. */
export const pendingSkillCleanupFilter: Record<string, unknown> = {
  $or: [{ state: { $ne: 'committed' } }, { state: 'committed', cleanedAt: { $exists: false } }],
};

/** Throws for a cleanup batch size that is not a positive integer. */
export function assertCleanupBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid cleanup batch size');
}

/** Not completed, or completed with a recheck that is unscheduled or due at `now`. */
function deletionDue(now: Date): Record<string, unknown> {
  return {
    $or: [
      { completedAt: { $exists: false } },
      { nextCheckAt: { $exists: false } },
      { nextCheckAt: { $lte: now } },
    ],
  };
}

/** The deletions a worker may claim at `now`: no live claim, and not completed or due a recheck. */
export function claimableSkillDeletionsFilter(now: Date): Record<string, unknown> {
  return {
    $and: [
      { $or: [{ claimExpiresAt: { $exists: false } }, { claimExpiresAt: { $lte: now } }] },
      deletionDue(now),
    ],
  };
}

/** The deletion of the skill if `owner` may claim it at `now` (its own claim included). */
export function skillDeletionClaimFilter(
  skillId: unknown,
  owner: string,
  now: Date,
): Record<string, unknown> {
  return {
    skillId,
    $and: [
      {
        $or: [
          { claimExpiresAt: { $exists: false } },
          { claimExpiresAt: { $lte: now } },
          { claimOwner: owner },
        ],
      },
      deletionDue(now),
    ],
  };
}

/**
 * The upsert that publishes a legacy file's blob reference when its skill's deletion is
 * journaled: a committed intent created as `legacy-backfill` (keyed by the file id and its
 * tenant), never replacing an existing intent.
 */
export function legacyBackfillIntentWrite(
  skillId: unknown,
  file: {
    file_id: string;
    tenantId?: string;
    source?: unknown;
    storageKey?: unknown;
    filepath?: unknown;
    author?: unknown;
  },
): { filter: Record<string, unknown>; update: Record<string, unknown> } {
  return {
    filter: {
      fileId: file.file_id,
      ...(file.tenantId ? { tenantId: file.tenantId } : {}),
    },
    update: {
      $setOnInsert: {
        skillId,
        fileId: file.file_id,
        source: file.source,
        storageKey: file.storageKey ?? file.filepath,
        author: file.author,
        writerId: 'legacy-backfill',
        state: 'committed',
      },
    },
  };
}

/** Abandoned, or committed with cleanup requested (and, with `uncleaned`, not yet cleaned). */
function awaitingCleanup(uncleaned: boolean): Record<string, unknown> {
  return {
    $or: [
      { state: 'abandoned' },
      {
        state: 'committed',
        cleanupRequestedAt: { $exists: true },
        ...(uncleaned ? { cleanedAt: { $exists: false } } : {}),
      },
    ],
  };
}

/** The recheck of a cleanup is unscheduled or due at `now`. */
function cleanupDue(now: Date): Record<string, unknown> {
  return { $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: { $lte: now } }] };
}

/** The intents a cleanup worker may claim at `now`: awaiting cleanup, no hold, no live claim, due. */
export function claimableSkillUploadCleanupsFilter(now: Date): Record<string, unknown> {
  return {
    cleanupHoldOwner: { $exists: false },
    ...awaitingCleanup(true),
    $and: [
      { $or: [{ claimExpiresAt: { $exists: false } }, { claimExpiresAt: { $lte: now } }] },
      cleanupDue(now),
    ],
  };
}

/** The intent if `owner` may claim its cleanup at `now` (its own claim included). */
export function skillUploadCleanupClaimFilter(
  fileId: string,
  owner: string,
  now: Date,
): Record<string, unknown> {
  return {
    fileId,
    cleanupHoldOwner: { $exists: false },
    ...awaitingCleanup(true),
    $and: [
      {
        $or: [
          { claimExpiresAt: { $exists: false } },
          { claimExpiresAt: { $lte: now } },
          { claimOwner: owner },
        ],
      },
      cleanupDue(now),
    ],
  };
}

/**
 * The intent while `owner` holds a live cleanup claim on it at `now`. Finishing the cleanup
 * changes eligibility for a new claim, not ownership of this lease, so a cleaned committed blob
 * still matches.
 */
export function skillUploadCleanupLeaseFilter(
  fileId: string,
  owner: string,
  now: Date,
): Record<string, unknown> {
  return {
    fileId,
    cleanupHoldOwner: { $exists: false },
    claimOwner: owner,
    claimExpiresAt: { $gt: now },
    ...awaitingCleanup(false),
  };
}

/** The write that ends a cleanup hold, requesting the blob's cleanup with `cleanup`. */
export function finishCleanupHoldUpdate(cleanup: boolean, now: Date): Record<string, unknown> {
  return cleanup
    ? {
        $set: { cleanupRequestedAt: now },
        $unset: { cleanupHoldOwner: '', nextCheckAt: '' },
      }
    : { $unset: { cleanupHoldOwner: '', cleanupRequestedAt: '' } };
}

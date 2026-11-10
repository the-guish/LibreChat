/**
 * Skill lifecycle store port: the durable bookkeeping behind deleting a skill and the blobs its
 * files are stored in — the deletion journal a cleanup worker drives to completion, and the upload
 * intents that record each blob's storage key before any bytes are written, so no blob is ever
 * left without a reference. Storage effects (writing and deleting blobs) are the caller's; this
 * store only records them. Nothing here may import `mongoose`. Signatures are those of
 * `SkillLifecycleMethods` (`~/methods/skillLifecycle`) with skill ids that take an ObjectId stated
 * as `IdLike`; `skillLifecycle.spec.ts` fails the typecheck if the MongoDB methods stop
 * satisfying them.
 *
 * Deletion: `beginSkillDeletion` marks the skill deleting (which frees its name) and journals the
 * deletion; a crash between the two is repaired by `discoverUnjournaledDeletions`. Workers claim
 * a deletion under a lease (`claimSkillDeletion`, renewed with `refreshSkillDeletionClaim`),
 * complete it under that lease, and may schedule a later recheck of a completed one.
 *
 * Uploads: an intent moves `uploading` → `committing` → `committed`, or to `abandoned`; one
 * writer owns it (`writerId`). A blob awaits cleanup while its intent is abandoned, or committed
 * with cleanup requested, until it is marked cleaned; cleanup workers claim such intents under a
 * lease the same way. A committed intent may carry a cleanup hold, which keeps it from being
 * swept until its owner finishes the hold. The `recoverStopped*` methods are for operators only,
 * once they have confirmed independently that the writer or holder has stopped.
 *
 * Known leak kept for now so callers stay unchanged: `ISkillDeletion`, `ISkillUploadIntent` and
 * `ISkillFile` carry ObjectIds (`skillId`, `author`).
 */
import type {
  ISkillFile,
  ISkillDeletion,
  ISkillUploadIntent,
  SkillUploadIntentInput,
  StoppedSkillUploadRecovery,
  StoppedSkillUploadCleanupHoldRecovery,
} from '~/types';
import type { IdLike } from './common';
import { listPortMethods } from './common';

export interface SkillLifecycleStore {
  /**
   * Marks the skill deleting and journals its deletion (recording an upload intent for each of
   * its files that predates intents); resolves to the journal, or `null` when there is no such
   * skill.
   */
  beginSkillDeletion(id: string): Promise<ISkillDeletion | null>;
  /** The deletion journal of the skill, or `null` when its deletion has not begun. */
  getSkillDeletion(id: string): Promise<ISkillDeletion | null>;
  /**
   * Journals up to `limit` (100 by default) skills marked deleting whose journal is incomplete,
   * least recently attempted first; resolves how many it journaled. A failure is logged and the
   * skill is retried on a later call.
   */
  discoverUnjournaledDeletions(limit?: number): Promise<number>;
  /** Up to `limit` (100 by default) deletions not completed, least recently updated first. */
  listPendingSkillDeletions(limit?: number): Promise<ISkillDeletion[]>;
  /**
   * Up to `limit` (100 by default) deletions a worker may claim now (no live claim, and not
   * completed or due for a recheck), least recently attempted first.
   */
  listSkillDeletionTombstones(limit?: number): Promise<ISkillDeletion[]>;
  /** Records that a worker attempted the deletion now. */
  noteSkillDeletionAttempt(skillId: IdLike): Promise<void>;
  /**
   * Claims the deletion for `owner` for `leaseMs` (or renews `owner`'s own claim); `false` when
   * another owner holds a live claim, or it is completed and not due for a recheck.
   */
  claimSkillDeletion(skillId: IdLike, owner: string, leaseMs: number): Promise<boolean>;
  /** Renews `owner`'s live claim to end `leaseMs` from now; `false` when it lost the claim. */
  refreshSkillDeletionClaim(skillId: IdLike, owner: string, leaseMs: number): Promise<boolean>;
  /** Gives up the claim if `owner` holds it. */
  releaseSkillDeletionClaim(skillId: IdLike, owner: string): Promise<void>;
  /** Marks the deletion completed under `owner`'s live claim; `false` when it lost the claim. */
  completeSkillDeletion(skillId: IdLike, owner: string): Promise<boolean>;
  /** Makes a completed deletion pending again, dropping any scheduled recheck. */
  reopenSkillDeletion(skillId: IdLike): Promise<void>;
  /**
   * Schedules a recheck of the completed deletion `delayMs` from now, under `owner`'s live
   * claim; `false` when it lost the claim or the deletion is not completed.
   */
  scheduleSkillDeletionRecheck(skillId: IdLike, owner: string, delayMs: number): Promise<boolean>;
  /**
   * Records the upload `uploading` before any bytes are written. Throws an error with code
   * `SKILL_DELETING` when the skill is being deleted or absent, leaving the intent abandoned.
   */
  reserveSkillUploadIntent(input: SkillUploadIntentInput): Promise<ISkillUploadIntent>;
  /**
   * Moves the writer's intent from `from` to `to`; `true` when it moved or was already in `to`.
   */
  transitionSkillUploadIntent(
    fileId: string,
    writerId: string,
    from: ISkillUploadIntent['state'],
    to: ISkillUploadIntent['state'],
  ): Promise<boolean>;
  /**
   * The skill's upload intents; with `cleanupOnly`, only those whose blob may still need
   * cleanup (not committed, or committed and not cleaned).
   */
  listSkillUploadIntents(
    skillId: IdLike,
    options?: { cleanupOnly?: boolean },
  ): Promise<ISkillUploadIntent[]>;
  /**
   * The skill's files (without their cached content) in batches of `batchSize`; throws when
   * `batchSize` is not a positive integer.
   */
  iterateSkillCleanupFiles(skillId: string, batchSize: number): AsyncIterable<ISkillFile[]>;
  /** As `listSkillUploadIntents` with `cleanupOnly`, in batches of `batchSize`. */
  iterateSkillCleanupIntents(
    skillId: string,
    batchSize: number,
  ): AsyncIterable<ISkillUploadIntent[]>;
  /** Whether an upload to the skill is `uploading` or `committing`. */
  hasInFlightSkillUploads(skillId: string): Promise<boolean>;
  /** Those of the file ids the skill has a file for. */
  listExistingSkillFileIds(skillId: string, fileIds: string[]): Promise<string[]>;
  /** The upload intent of the file, or `null`. */
  getSkillUploadIntent(fileId: string): Promise<ISkillUploadIntent | null>;
  /**
   * Operator-only: settles the stopped writer's `uploading` or `committing` intent as committed
   * when the skill has the file, abandoned when not.
   */
  recoverStoppedSkillUploadIntent(
    fileId: string,
    expectedWriterId: string,
  ): Promise<StoppedSkillUploadRecovery>;
  /**
   * Ends `owner`'s cleanup hold on the committed intent, requesting cleanup of its blob with
   * `cleanup`; `false` when `owner` holds none.
   */
  finishSkillUploadCleanupHold(fileId: string, owner: string, cleanup: boolean): Promise<boolean>;
  /**
   * Operator-only: ends the stopped holder's cleanup hold, requesting cleanup when the skill has
   * no file for the intent.
   */
  recoverStoppedSkillUploadCleanupHold(
    fileId: string,
    expectedOwner: string,
  ): Promise<StoppedSkillUploadCleanupHoldRecovery>;
  /**
   * Up to `limit` (100 by default) intents whose blob awaits cleanup that a worker may claim now
   * (no hold, no live claim, not scheduled later), least recently attempted first.
   */
  listAbandonedSkillUploadIntents(limit?: number): Promise<ISkillUploadIntent[]>;
  /**
   * Claims the intent's cleanup for `owner` for `leaseMs` (or renews `owner`'s own claim);
   * `false` when it is not awaiting cleanup, is held, or another owner holds a live claim.
   */
  claimAbandonedSkillUploadIntent(fileId: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Renews `owner`'s live cleanup claim to end `leaseMs` from now; `false` when it lost it. */
  refreshAbandonedSkillUploadIntentClaim(
    fileId: string,
    owner: string,
    leaseMs: number,
  ): Promise<boolean>;
  /** Records that a worker attempted the intent's cleanup now. */
  noteAbandonedSkillUploadIntentAttempt(fileId: string): Promise<void>;
  /** Gives up the cleanup claim if `owner` holds it. */
  releaseAbandonedSkillUploadIntentClaim(fileId: string, owner: string): Promise<void>;
  /** Whether the skill has the file. */
  skillFileExistsForIntent(skillId: string, fileId: string): Promise<boolean>;
  /** Records that the intent's blob was cleaned up. */
  markSkillUploadIntentCleaned(fileId: string): Promise<void>;
  /**
   * Abandons a committed intent not yet cleaned up, so its blob is swept; throws when the
   * intent is missing, or neither abandoned nor cleaned up afterwards.
   */
  queueCommittedSkillUploadCleanup(fileId: string): Promise<void>;
  /**
   * Schedules the next cleanup check of the intent `delayMs` from now, under `owner`'s live
   * claim; `false` when it lost the claim.
   */
  scheduleAbandonedSkillUploadIntentRecheck(
    fileId: string,
    owner: string,
    delayMs: number,
  ): Promise<boolean>;
}

/** Every method of {@link SkillLifecycleStore}, for adapters and conformance checks. */
export const SKILL_LIFECYCLE_STORE_METHODS: ReadonlyArray<keyof SkillLifecycleStore> =
  listPortMethods<SkillLifecycleStore>({
    beginSkillDeletion: true,
    getSkillDeletion: true,
    discoverUnjournaledDeletions: true,
    listPendingSkillDeletions: true,
    listSkillDeletionTombstones: true,
    noteSkillDeletionAttempt: true,
    claimSkillDeletion: true,
    refreshSkillDeletionClaim: true,
    releaseSkillDeletionClaim: true,
    completeSkillDeletion: true,
    reopenSkillDeletion: true,
    scheduleSkillDeletionRecheck: true,
    reserveSkillUploadIntent: true,
    transitionSkillUploadIntent: true,
    listSkillUploadIntents: true,
    iterateSkillCleanupFiles: true,
    iterateSkillCleanupIntents: true,
    hasInFlightSkillUploads: true,
    listExistingSkillFileIds: true,
    getSkillUploadIntent: true,
    recoverStoppedSkillUploadIntent: true,
    finishSkillUploadCleanupHold: true,
    recoverStoppedSkillUploadCleanupHold: true,
    listAbandonedSkillUploadIntents: true,
    claimAbandonedSkillUploadIntent: true,
    refreshAbandonedSkillUploadIntentClaim: true,
    noteAbandonedSkillUploadIntentAttempt: true,
    releaseAbandonedSkillUploadIntentClaim: true,
    skillFileExistsForIntent: true,
    markSkillUploadIntentCleaned: true,
    queueCommittedSkillUploadCleanup: true,
    scheduleAbandonedSkillUploadIntentRecheck: true,
  });

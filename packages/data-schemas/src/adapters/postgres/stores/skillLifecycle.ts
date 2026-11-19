/**
 * The PostgreSQL `SkillLifecycleStore` (`~/ports/skillLifecycle`): the deletion journal
 * (`skilldeletions`) and the blob upload intents (`skilluploadintents`), with the deletion mark on
 * `skills` and the file rows of `skillfiles`, through the collection primitive, with the
 * conditions of `~/methods/skillLifecycleRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - **Leases** (deletion claims, cleanup claims, renewals, completions, rechecks) are guarded
 *   single-row updates: the primitive locks the row and re-evaluates the guard on the locked row
 *   (§3.5), so of two workers racing for one journal or intent exactly one holds it.
 * - **Journal**: the mark (`findOneAndUpdate` on the live skill) frees the name in the same row
 *   write; the journal is an insert-only upsert on the skill id run as the system, so it keeps
 *   the skill's tenant whatever the caller's context; a legacy file gets its intent through
 *   insert-only upserts in batches of {@link LEGACY_BACKFILL_BATCH_SIZE} (`bulk`, unordered), read
 *   in keyset pages; the journal flag is cleared last, so a crash in between is repaired by
 *   `discoverUnjournaledDeletions`.
 * - **Cleanup cursors**: `iterateSkillCleanupFiles` and `iterateSkillCleanupIntents` read keyset
 *   pages on `_id` (`_id > last`, `batchSize` rows) in an async generator, so no cursor is held
 *   across awaits, and rows deleted or marked cleaned while the caller works on a batch neither
 *   shift nor repeat the next one. The batch size is checked before the first read, so the
 *   iteration rejects with 'Invalid cleanup batch size' (MongoDB masks that message, see the
 *   contract's NOTE).
 */
import type {
  ISkillDeletion,
  ISkillUploadIntent,
  StoppedSkillUploadRecovery,
  StoppedSkillUploadCleanupHoldRecovery,
} from '~/types/skillDeletion';
import type { PgBulkOperation, PgFilter, PgRecord, PgCollection } from '../collection';
import type { SkillLifecycleStore } from '~/ports/skillLifecycle';
import type { PostgresStoreContext } from './context';
import type { ISkillFile } from '~/types/skill';
import {
  assertCleanupBatchSize,
  finishCleanupHoldUpdate,
  pendingSkillCleanupFilter,
  legacyBackfillIntentWrite,
  skillDeletionClaimFilter,
  LEGACY_BACKFILL_BATCH_SIZE,
  skillUploadCleanupClaimFilter,
  skillUploadCleanupLeaseFilter,
  claimableSkillDeletionsFilter,
  claimableSkillUploadCleanupsFilter,
} from '~/methods/skillLifecycleRules';
import { skillDeletionMark, skillDeletingError } from '~/methods/skillRules';
import { runAsSystem } from '~/config/tenantContext';
import { toIdColumn } from '../values';
import logger from '~/config/winston';

type SkillRecord = PgRecord & {
  _id: string;
  author?: string;
  tenantId?: string;
  deletingAt?: Date;
  deletionNeedsJournal?: boolean;
};
type FileRecord = PgRecord & ISkillFile & { _id: string };
type DeletionRecord = PgRecord & ISkillDeletion;
type IntentRecord = PgRecord & ISkillUploadIntent & { _id: string };

/**
 * The rows of `collection` matching `filter` in keyset pages of `batchSize` on `_id`, each page
 * read in its own statement once the caller asks for it.
 */
async function* keysetPages<T extends PgRecord & { _id: string }>(
  collection: () => PgCollection<T>,
  filter: PgFilter,
  batchSize: number,
  projection?: string,
): AsyncGenerator<T[]> {
  let last: string | undefined;
  for (;;) {
    const page = await collection().find(
      last === undefined ? filter : { $and: [filter, { _id: { $gt: last } }] },
      { sort: { _id: 1 }, limit: batchSize, ...(projection ? { projection } : {}) },
    );
    if (page.length === 0) {
      return;
    }
    yield page;
    if (page.length < batchSize) {
      return;
    }
    last = page[page.length - 1]._id;
  }
}

export function createPostgresSkillLifecycleStore(
  context: PostgresStoreContext,
): SkillLifecycleStore {
  const skills = () => context.collections().collection<SkillRecord>('skills');
  const files = () => context.collections().collection<FileRecord>('skillfiles');
  const deletions = () => context.collections().collection<DeletionRecord>('skilldeletions');
  const intents = () => context.collections().collection<IntentRecord>('skilluploadintents');

  async function beginSkillDeletion(id: string): Promise<ISkillDeletion | null> {
    const skillId = toIdColumn(id);
    const skill = await skills().findOneAndUpdate(
      { _id: skillId, deletingAt: { $exists: false } },
      // The reserved name cannot be created through Skill validation. Moving
      // it in the same write as the deletion mark releases the public name
      // under the existing unique index, without an index migration.
      { $set: skillDeletionMark(id, new Date()) },
      { returnDocument: 'after' },
    );
    const existing = skill ?? (await skills().findOne({ _id: skillId }));
    if (!existing?.deletingAt) return null;
    // The parent was resolved under the caller's tenant scope above. Preserve
    // its tenant on the journal even when a legacy caller has no ALS context.
    const journal = (await runAsSystem(() =>
      deletions().findOneAndUpdate(
        { skillId },
        {
          $setOnInsert: {
            skillId,
            author: existing.author,
            tenantId: existing.tenantId,
            startedAt: existing.deletingAt,
          },
        },
        { upsert: true, returnDocument: 'after' },
      ),
    )) as ISkillDeletion;
    if (existing.deletionNeedsJournal) {
      // The marker also covers crashes after the journal insert but before
      // every legacy file has a durable blob reference.
      for await (const page of keysetPages(
        files,
        { skillId },
        LEGACY_BACKFILL_BATCH_SIZE,
        '-content',
      )) {
        const writes: PgBulkOperation[] = page.map((file) => ({
          updateOne: { ...legacyBackfillIntentWrite(skillId, file), upsert: true },
        }));
        await intents().bulk(writes, { ordered: false });
      }
      await skills().updateOne(
        { _id: skillId, deletionNeedsJournal: true },
        { $unset: { deletionNeedsJournal: '' } },
      );
    }
    return journal;
  }

  async function getSkillUploadIntent(fileId: string): Promise<ISkillUploadIntent | null> {
    return intents().findOne({ fileId });
  }

  async function skillFileExistsForIntent(skillId: string, fileId: string): Promise<boolean> {
    return Boolean(await files().exists({ skillId, file_id: fileId }));
  }

  async function finishSkillUploadCleanupHold(
    fileId: string,
    owner: string,
    cleanup: boolean,
  ): Promise<boolean> {
    const result = await intents().updateOne(
      { fileId, state: 'committed', cleanupHoldOwner: owner },
      finishCleanupHoldUpdate(cleanup, new Date()),
    );
    return result.matchedCount === 1;
  }

  const store: SkillLifecycleStore = {
    beginSkillDeletion,

    async getSkillDeletion(id) {
      return deletions().findOne({ skillId: toIdColumn(id) });
    },

    /** Repairs the mark/journal crash gap one skill at a time. */
    async discoverUnjournaledDeletions(limit = 100) {
      let count = 0;
      const pending = await skills().find(
        { deletionNeedsJournal: true },
        { sort: { deletionJournalAttemptAt: 1, deletingAt: 1 }, limit, projection: '_id' },
      );
      for (const skill of pending) {
        await skills().updateOne(
          { _id: skill._id, deletionNeedsJournal: true },
          { $set: { deletionJournalAttemptAt: new Date() } },
        );
        try {
          await beginSkillDeletion(skill._id);
          count++;
        } catch {
          // Keep the marker and rotate this Skill behind other pending backfills.
          logger.warn(`[skill deletion] Journal backfill deferred for ${skill._id}`);
        }
      }
      return count;
    },

    async listPendingSkillDeletions(limit = 100) {
      return deletions().find(
        { completedAt: { $exists: false } },
        { sort: { updatedAt: 1 }, limit },
      );
    },

    async listSkillDeletionTombstones(limit = 100) {
      return deletions().find(claimableSkillDeletionsFilter(new Date()), {
        sort: { lastAttemptAt: 1, startedAt: 1 },
        limit,
      });
    },

    async noteSkillDeletionAttempt(skillId) {
      await deletions().updateOne({ skillId }, { $set: { lastAttemptAt: new Date() } });
    },

    async claimSkillDeletion(skillId, owner, leaseMs) {
      const now = new Date();
      const result = await deletions().updateOne(skillDeletionClaimFilter(skillId, owner, now), {
        $set: { claimOwner: owner, claimExpiresAt: new Date(now.getTime() + leaseMs) },
      });
      return result.matchedCount === 1;
    },

    async refreshSkillDeletionClaim(skillId, owner, leaseMs) {
      const result = await deletions().updateOne(
        { skillId, claimOwner: owner, claimExpiresAt: { $gt: new Date() } },
        { $set: { claimExpiresAt: new Date(Date.now() + leaseMs) } },
      );
      return result.matchedCount === 1;
    },

    async releaseSkillDeletionClaim(skillId, owner) {
      await deletions().updateOne(
        { skillId, claimOwner: owner },
        { $unset: { claimOwner: '', claimExpiresAt: '' } },
      );
    },

    async completeSkillDeletion(skillId, owner) {
      const result = await deletions().updateOne(
        { skillId, claimOwner: owner, claimExpiresAt: { $gt: new Date() } },
        { $set: { completedAt: new Date() } },
      );
      return result.matchedCount === 1;
    },

    async reopenSkillDeletion(skillId) {
      await deletions().updateOne({ skillId }, { $unset: { completedAt: '', nextCheckAt: '' } });
    },

    async scheduleSkillDeletionRecheck(skillId, owner, delayMs) {
      const now = new Date();
      const result = await deletions().updateOne(
        {
          skillId,
          claimOwner: owner,
          claimExpiresAt: { $gt: now },
          completedAt: { $exists: true },
        },
        { $set: { nextCheckAt: new Date(now.getTime() + delayMs) } },
      );
      return result.modifiedCount === 1;
    },

    async reserveSkillUploadIntent(input) {
      // Publish the future blob reference before checking the parent. Deletion
      // marks the parent first, then scans intents: it must either see this row
      // or make the check below fail before any bytes are written.
      try {
        const intent = await intents().insertOne({ ...input, state: 'uploading' });
        const skill = await skills().exists({ _id: input.skillId, deletingAt: { $exists: false } });
        if (!skill) {
          throw skillDeletingError();
        }
        return intent;
      } catch (error) {
        await intents().updateOne(
          { fileId: input.fileId, writerId: input.writerId, state: 'uploading' },
          { $set: { state: 'abandoned' } },
        );
        throw error;
      }
    },

    async transitionSkillUploadIntent(fileId, writerId, from, to) {
      const result = await intents().updateOne(
        { fileId, writerId, state: from },
        { $set: { state: to } },
      );
      if (result.modifiedCount === 1) return true;
      return Boolean(await intents().exists({ fileId, writerId, state: to }));
    },

    async listSkillUploadIntents(skillId, options = {}) {
      return intents().find({
        skillId,
        ...(options.cleanupOnly ? pendingSkillCleanupFilter : {}),
      });
    },

    async *iterateSkillCleanupFiles(skillId, batchSize) {
      assertCleanupBatchSize(batchSize);
      yield* keysetPages(files, { skillId }, batchSize, '-content');
    },

    async *iterateSkillCleanupIntents(skillId, batchSize) {
      assertCleanupBatchSize(batchSize);
      yield* keysetPages(intents, { skillId, ...pendingSkillCleanupFilter }, batchSize);
    },

    async hasInFlightSkillUploads(skillId) {
      return Boolean(
        await intents().exists({ skillId, state: { $in: ['uploading', 'committing'] } }),
      );
    },

    async listExistingSkillFileIds(skillId, fileIds) {
      if (fileIds.length === 0) return [];
      const rows = await files().find(
        { skillId, file_id: { $in: fileIds } },
        { projection: 'file_id' },
      );
      return rows.map((row) => row.file_id);
    },

    getSkillUploadIntent,

    /** Operator-only recovery: call only after independently confirming the writer has stopped. */
    async recoverStoppedSkillUploadIntent(fileId, expectedWriterId) {
      const intent = await getSkillUploadIntent(fileId);
      if (!intent) return { status: 'missing' };
      if (
        intent.writerId !== expectedWriterId ||
        (intent.state !== 'uploading' && intent.state !== 'committing')
      ) {
        return { status: 'changed' };
      }
      const rowExists = await skillFileExistsForIntent(intent.skillId.toString(), fileId);
      const state = rowExists ? 'committed' : 'abandoned';
      const result = await intents().updateOne(
        { fileId, writerId: expectedWriterId, state: intent.state },
        { $set: { state } },
      );
      return (
        result.modifiedCount === 1 ? { status: 'recovered', state } : { status: 'changed' }
      ) as StoppedSkillUploadRecovery;
    },

    finishSkillUploadCleanupHold,

    /** Operator-only recovery after confirming the replacement writer has stopped. */
    async recoverStoppedSkillUploadCleanupHold(fileId, expectedOwner) {
      const intent = await getSkillUploadIntent(fileId);
      if (!intent) return { status: 'missing' };
      if (intent.state !== 'committed' || intent.cleanupHoldOwner !== expectedOwner) {
        return { status: 'changed' };
      }
      const rowExists = await skillFileExistsForIntent(intent.skillId.toString(), fileId);
      const cleanup = !rowExists;
      const released = await finishSkillUploadCleanupHold(fileId, expectedOwner, cleanup);
      return (
        released ? { status: 'recovered', cleanup } : { status: 'changed' }
      ) as StoppedSkillUploadCleanupHoldRecovery;
    },

    async listAbandonedSkillUploadIntents(limit = 100) {
      return intents().find(claimableSkillUploadCleanupsFilter(new Date()), {
        sort: { lastCleanupAttemptAt: 1, createdAt: 1 },
        limit,
      });
    },

    async claimAbandonedSkillUploadIntent(fileId, owner, leaseMs) {
      const now = new Date();
      const result = await intents().updateOne(skillUploadCleanupClaimFilter(fileId, owner, now), {
        $set: { claimOwner: owner, claimExpiresAt: new Date(now.getTime() + leaseMs) },
      });
      return result.matchedCount === 1;
    },

    async refreshAbandonedSkillUploadIntentClaim(fileId, owner, leaseMs) {
      const result = await intents().updateOne(
        skillUploadCleanupLeaseFilter(fileId, owner, new Date()),
        { $set: { claimExpiresAt: new Date(Date.now() + leaseMs) } },
      );
      return result.matchedCount === 1;
    },

    async noteAbandonedSkillUploadIntentAttempt(fileId) {
      await intents().updateOne({ fileId }, { $set: { lastCleanupAttemptAt: new Date() } });
    },

    async releaseAbandonedSkillUploadIntentClaim(fileId, owner) {
      await intents().updateOne(
        { fileId, claimOwner: owner },
        { $unset: { claimOwner: '', claimExpiresAt: '' } },
      );
    },

    skillFileExistsForIntent,

    async markSkillUploadIntentCleaned(fileId) {
      await intents().updateOne({ fileId }, { $set: { cleanedAt: new Date() } });
    },

    /** A committed upload rolled back before publication must remain sweepable. */
    async queueCommittedSkillUploadCleanup(fileId) {
      const result = await intents().updateOne(
        { fileId, state: 'committed', cleanedAt: { $exists: false } },
        { $set: { state: 'abandoned' }, $unset: { nextCheckAt: '' } },
      );
      if (result.matchedCount === 1) return;
      const intent = await intents().findOne({ fileId });
      if (intent?.state !== 'abandoned' && !intent?.cleanedAt) {
        throw new Error(`Skill blob cleanup intent is missing or invalid: ${fileId}`);
      }
    },

    async scheduleAbandonedSkillUploadIntentRecheck(fileId, owner, delayMs) {
      const now = new Date();
      const result = await intents().updateOne(skillUploadCleanupLeaseFilter(fileId, owner, now), {
        $set: { nextCheckAt: new Date(now.getTime() + delayMs) },
      });
      return result.modifiedCount === 1;
    },
  };
  return store;
}

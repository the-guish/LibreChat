/**
 * The PostgreSQL `SkillStore` (`~/ports/skill`): skills (`skills`) and their files
 * (`skillfiles`), with the cleanup references of replaced blobs (`skilluploadintents`) and the
 * agents' `skills` allowlists (`agents`), through the collection primitive, with the validation,
 * derivation and writes of `~/methods/skillRules`. Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * - **Duplicate names**: a create checks the name per author and tenant first and rejects with a
 *   `StoreDuplicateKeyError` carrying MongoDB's message (`A skill with name "…" already exists for
 *   this author`, §3.6); the unique index is the guarantee, and its violation by a racing create
 *   is rethrown with the same message. A rename onto a used name is the primitive's duplicate key.
 * - **Versions**: `updateSkill` is one guarded `findOneAndUpdate` on the expected version (the
 *   primitive locks and rechecks the row, §3.5, so of two writers at one version one wins). File
 *   writes bump the skill's version and file count in the same transaction as the file row
 *   (MongoDB writes them separately; see the deviation in PHASE4.md §8 S8).
 * - **File writes**: the replacement of the file at a path is an upsert in a transaction that
 *   then reads the row back, which tells an insert (file count + 1) from a replacement; with
 *   `expectedFileId` it updates only that revision, with `createOnly` it inserts and the unique
 *   `{ skillId, relativePath }` index decides a race. A replaced blob's cleanup reference is the
 *   upload intent upsert of the rules; a held replacement whose intent a sweeper claimed fails as
 *   a conflict. Replacements `$set` the given fields, so undefined `storageKey`/`storageRegion`
 *   keep the previous values (the pinned NOTE(contract)).
 * - **Agent allowlists** (`finalizeSkillDeletion`): the primitive's `updateMany` on `agents`
 *   without timestamps, with the rules' filters: the value-form `$not: { $elemMatch: { $nin } }`
 *   with `$in` on the `skills` text array is the containment test `skills <@ ids AND skills &&
 *   ids`; C2 translates it on the array itself (`$in` as `&&`, the negated element match as a
 *   `NOT EXISTS` over its unnested elements, which is `<@`), so no hand-written SQL is needed.
 * - **Code-environment references** are written per route key into the `codeEnvRefs` `json`
 *   column (tier 2, read-modify-write under the row lock), through one `bulk`.
 */
import { ResourceType } from 'librechat-data-provider';
import type { ISkill, ISkillFile, DeleteSkillCleanupStep } from '~/types/skill';
import type { OwnedResourceFactoryDeps } from '~/compose/types';
import type { PgBulkOperation, PgRecord } from '../collection';
import type { StoreTransaction } from '~/ports/common';
import type { PostgresStoreContext } from './context';
import type { SkillStore } from '~/ports/skill';
import {
  SKILL_LIST_SORT,
  SKILL_SUMMARY_FIELDS,
  ALWAYS_APPLY_SKILL_FIELDS,
  SKILL_FILE_REPLACED_CACHES,
  skillListPage,
  skillListLimit,
  skillListFilter,
  skillFileFields,
  skillFilesPending,
  decodeSkillCursor,
  skillDeletionMark,
  skillIdCandidates,
  skillCursorFilter,
  prepareSkillCreate,
  prepareSkillUpdate,
  skillDeletingError,
  skillCreateDocument,
  skillFilePathFilter,
  alwaysApplySkillRow,
  assertSkillFilePath,
  skillNameTakenMessage,
  skillFileCodeEnvWrite,
  movesSkillFileStorage,
  malformedSkillDeletion,
  skillFileConflictError,
  warnPartialCodeEnvWrite,
  agentAllowlistPruneWrites,
  replacedSkillBlobIntentWrite,
  backfillDerivedFromFrontmatter,
} from '~/methods/skillRules';
import { createPostgresSkillLifecycleStore } from './skillLifecycle';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { isValidObjectIdString } from '~/utils/objectId';
import { toIdColumn } from '../values';
import logger from '~/config/winston';

type SkillRecord = PgRecord & ISkill & { _id: string };
type FileRecord = PgRecord & ISkillFile & { _id: string };

/** The record types the port states with the store's ids (strings here). */
type SkillResult = Awaited<ReturnType<SkillStore['getSkillById']>> & object;
type FileResult = Awaited<ReturnType<SkillStore['upsertSkillFile']>>;

export function createPostgresSkillStore(
  context: PostgresStoreContext,
  deps: OwnedResourceFactoryDeps,
): SkillStore {
  const skills = () => context.collections().collection<SkillRecord>('skills');
  const files = () => context.collections().collection<FileRecord>('skillfiles');
  const intents = () => context.collections().collection('skilluploadintents');
  const agents = () => context.collections().collection('agents');
  const lifecycle = createPostgresSkillLifecycleStore(context);
  const identity = (id: string) => id;
  const asSkill = (record: SkillRecord | null) => record as unknown as SkillResult | null;
  const asFile = (record: FileRecord | null) => record as unknown as FileResult;

  /** Whether the skill is live (not absent, not being deleted) in the caller's tenant. */
  async function liveSkill(skillId: unknown, tx?: StoreTransaction): Promise<boolean> {
    return Boolean(await skills().exists({ _id: skillId, deletingAt: { $exists: false } }, { tx }));
  }

  /** Bumps the skill's version, adjusting its file count by `delta`. */
  async function bumpSkillVersion(
    skillId: unknown,
    delta: number,
    tx?: StoreTransaction,
  ): Promise<void> {
    const inc: Record<string, number> = { version: 1 };
    if (delta !== 0) {
      inc.fileCount = delta;
    }
    await skills().updateOne({ _id: skillId }, { $inc: inc }, { tx });
  }

  /**
   * Removes deleted skill ids from every agent's `skills` allowlist, without touching their
   * update times (hygiene, not an authored edit); an allowlist made only of deleted ids is
   * emptied and skills disabled unless its scope says what an empty allowlist means.
   */
  async function removeSkillsFromAgentAllowlists(skillIds: string[]): Promise<boolean> {
    if (skillIds.length === 0) {
      return true;
    }
    const { emptied, pulled } = agentAllowlistPruneWrites(skillIds);
    try {
      await agents().updateMany(emptied.filter, emptied.update, { timestamps: false });
      await agents().updateMany(pulled.filter, pulled.update, { timestamps: false });
      return true;
    } catch (error) {
      logger.error(
        '[removeSkillsFromAgentAllowlists] Error pruning agent skill allowlists:',
        error,
      );
      return false;
    }
  }

  /** Publishes the replaced blob's cleanup reference before the file row changes. */
  async function queueReplacedBlob(
    row: Parameters<SkillStore['upsertSkillFile']>[0],
    previous: FileRecord,
  ): Promise<void> {
    const { filter, update } = replacedSkillBlobIntentWrite(row, previous, new Date());
    let result: { matchedCount: number; upsertedCount: number };
    try {
      result = await intents().updateOne(filter, update, { upsert: true });
    } catch (error) {
      // Concurrent replacements can both attempt the legacy upsert.
      // The winner has already published the same cleanup reference.
      if (!(error instanceof StoreDuplicateKeyError)) throw error;
      result = await intents().updateOne(filter, update);
    }
    if (row.cleanupHoldOwner && result.matchedCount !== 1 && result.upsertedCount !== 1) {
      throw skillFileConflictError('Skill blob cleanup is already claimed');
    }
  }

  const store: SkillStore = {
    async createSkill(data) {
      const prepared = prepareSkillCreate(data);
      const author = toIdColumn(data.author);
      const tenantId = data.tenantId ?? null;
      const keyValue = { name: data.name, author, tenantId };
      // The unique index is the guarantee; the check gives the clean message first.
      const existing = await skills().findOne(
        { name: data.name, author, tenantId },
        { projection: '_id' },
      );
      if (existing) {
        throw new StoreDuplicateKeyError(skillNameTakenMessage(data.name), { keyValue });
      }
      try {
        const skill = await skills().insertOne(skillCreateDocument(data, author, prepared));
        return { skill: asSkill(skill) as SkillResult, warnings: prepared.warnings };
      } catch (error) {
        if (error instanceof StoreDuplicateKeyError) {
          throw new StoreDuplicateKeyError(skillNameTakenMessage(data.name), {
            keyValue: error.keyValue ?? keyValue,
            cause: error,
          });
        }
        throw error;
      }
    },

    async getSkillById(id) {
      if (typeof id === 'string' && !isValidObjectIdString(id)) {
        return null;
      }
      return asSkill(await skills().findOne({ _id: id, deletingAt: { $exists: false } }));
    },

    async getSkillByName(name, accessibleIds, options) {
      const preferUserInvocable = options?.preferUserInvocable === true;
      const preferModelInvocable = options?.preferModelInvocable === true;
      const filter = { name, _id: { $in: accessibleIds }, deletingAt: { $exists: false } };
      if (!preferUserInvocable && !preferModelInvocable) {
        const skill = await skills().findOne(filter, { sort: { updatedAt: -1 } });
        return asSkill(backfillDerivedFromFrontmatter(skill));
      }
      /* Every match (typically one), the first satisfying the preference, else the newest. */
      const matches = await skills().find(filter, { sort: { updatedAt: -1 } });
      if (matches.length === 0) {
        return null;
      }
      for (const skill of matches) {
        backfillDerivedFromFrontmatter(skill);
      }
      const preferred = matches.find((skill) => {
        if (preferUserInvocable && skill.userInvocable === false) {
          return false;
        }
        if (preferModelInvocable && skill.disableModelInvocation === true) {
          return false;
        }
        return true;
      });
      return asSkill(preferred ?? matches[0]);
    },

    async getAuthorSkillByName(params) {
      const skill = await skills().findOne(
        {
          name: params.name,
          author: params.author,
          tenantId: params.tenantId ?? null,
          deletingAt: { $exists: false },
        },
        { sort: { updatedAt: -1 } },
      );
      return asSkill(backfillDerivedFromFrontmatter(skill));
    },

    async listSkillsByAccess(params) {
      const limit = skillListLimit(params.limit);
      const filter = skillCursorFilter(
        skillListFilter(params),
        decodeSkillCursor(params.cursor),
        identity,
      );
      const rows = await skills().find(filter, {
        sort: SKILL_LIST_SORT,
        limit: limit + 1,
        projection: SKILL_SUMMARY_FIELDS,
      });
      for (const row of rows) {
        backfillDerivedFromFrontmatter(row);
      }
      const { sliced, has_more, after } = skillListPage(rows, limit);
      return { skills: sliced, has_more, after } as unknown as Awaited<
        ReturnType<SkillStore['listSkillsByAccess']>
      >;
    },

    async listAlwaysApplySkills(params) {
      if (!params.accessibleIds.length) {
        return { skills: [], has_more: false, after: null };
      }
      const limit = skillListLimit(params.limit);
      const filter = skillCursorFilter(
        { _id: { $in: params.accessibleIds }, alwaysApply: true, deletingAt: { $exists: false } },
        decodeSkillCursor(params.cursor),
        identity,
      );
      const rows = await skills().find(filter, {
        sort: SKILL_LIST_SORT,
        limit: limit + 1,
        projection: ALWAYS_APPLY_SKILL_FIELDS,
      });
      const { sliced, has_more, after } = skillListPage(rows, limit);
      return {
        skills: sliced.map((row) => alwaysApplySkillRow<string>(row)),
        has_more,
        after,
      } as unknown as Awaited<ReturnType<SkillStore['listAlwaysApplySkills']>>;
    },

    async findSkillBySourceIdentity(params) {
      const tenantFilter = params.tenantId
        ? { tenantId: params.tenantId }
        : { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
      return asSkill(
        await skills().findOne({
          source: params.source,
          'sourceMetadata.upstreamId': params.upstreamId,
          deletingAt: { $exists: false },
          ...tenantFilter,
        }),
      );
    },

    async listSkillsBySource(params) {
      const rows = await skills().find({
        source: params.source,
        'sourceMetadata.sourceId': params.sourceId,
        deletingAt: { $exists: false },
      });
      return rows as unknown as SkillResult[];
    },

    async updateSkill({ id, expectedVersion, update }) {
      if (!isValidObjectIdString(id)) {
        return { status: 'not_found' };
      }
      const { updateOps, warnings } = prepareSkillUpdate(update);
      const updated = await skills().findOneAndUpdate(
        { _id: id, version: expectedVersion, deletingAt: { $exists: false } },
        updateOps,
        { returnDocument: 'after' },
      );
      if (updated) {
        return { status: 'updated', skill: asSkill(updated) as SkillResult, warnings };
      }
      const current = await skills().findOne({ _id: id, deletingAt: { $exists: false } });
      if (!current) {
        return { status: 'not_found' };
      }
      return { status: 'conflict', current: asSkill(current) as SkillResult };
    },

    async deleteSkill(id) {
      if (!isValidObjectIdString(id)) {
        return malformedSkillDeletion();
      }
      // The storage-aware reconciler owns blob deletion and finalization; this only marks
      // the skill and journals its deletion, never discarding a blob's last reference.
      const journal = await lifecycle.beginSkillDeletion(id);
      return {
        deleted: false,
        skillAbsent: !journal,
        cleanupComplete: !journal,
        failedCleanupSteps: journal ? ['skill_files'] : [],
      };
    },

    /** Finalize only after blob rows are drained; never remove late rows without deleting blobs. */
    async finalizeSkillDeletion(id) {
      const skillId = toIdColumn(id);
      const skill = await skills().findOne({ _id: skillId }, { projection: '_id deletingAt' });
      if (skill && !skill.deletingAt) {
        return skillFilesPending();
      }
      if (await files().exists({ skillId })) {
        return skillFilesPending();
      }
      const failedCleanupSteps: DeleteSkillCleanupStep[] = [];
      if (!(await removeSkillsFromAgentAllowlists([id]))) {
        failedCleanupSteps.push('agent_allowlists');
      }
      try {
        await deps.removeAllPermissions({ resourceType: ResourceType.SKILL, resourceId: id });
      } catch {
        failedCleanupSteps.push('permissions');
        logger.error(`[finalizeSkillDeletion] Error removing permissions for ${id}`);
      }
      if (failedCleanupSteps.length > 0) {
        return { deleted: false, skillAbsent: false, cleanupComplete: false, failedCleanupSteps };
      }
      const result = await skills().deleteOne({ _id: skillId, deletingAt: { $exists: true } });
      return {
        deleted: result.deletedCount === 1,
        skillAbsent: true,
        cleanupComplete: true,
        failedCleanupSteps: [],
      };
    },

    async deleteUserSkills(userId) {
      const soleOwned = await deps.getSoleOwnedResourceIds(toIdColumn(userId), ResourceType.SKILL);
      if (soleOwned.length === 0) {
        return 0;
      }
      // Mark each skill and release its public name in the same row write; the reconciler
      // journals them and backfills their file references outside this request.
      const deletingAt = new Date();
      const operations: PgBulkOperation[] = soleOwned.map((id) => ({
        updateOne: {
          filter: { _id: id, deletingAt: { $exists: false } },
          update: { $set: skillDeletionMark(String(id), deletingAt) },
        },
      }));
      const result = await skills().bulk(operations, { ordered: false });
      return result.modifiedCount;
    },

    async listSkillFiles(skillId) {
      const rows = await files().find(
        { skillId },
        { projection: '-content', sort: { relativePath: 1 } },
      );
      return rows as unknown as FileResult[];
    },

    async getSkillFileByPath(skillId, relativePath) {
      return asFile(await files().findOne({ skillId, relativePath }));
    },

    async upsertSkillFile(row) {
      if (!(await liveSkill(row.skillId))) {
        throw skillDeletingError();
      }
      assertSkillFilePath(row.relativePath);
      if (!row.createOnly) {
        const previous = await files().findOne(
          skillFilePathFilter(row.skillId, row.relativePath, row.expectedFileId),
          { projection: '-content' },
        );
        if (previous && previous.file_id === row.file_id && movesSkillFileStorage(previous, row)) {
          throw skillFileConflictError('Skill file identity cannot change storage location');
        }
        if (previous && previous.file_id !== row.file_id) {
          // Queue the old blob before changing its only live file row. A failed
          // CAS leaves the row in place, so the sweeper will retain its blob.
          await queueReplacedBlob(row, previous);
        }
      }
      const fields = skillFileFields(row);
      if (row.createOnly) {
        if (row.expectedFileId != null) {
          throw new Error('A file cannot require both an absent path and an existing revision');
        }
        return context.transactions.transaction(async (tx) => {
          let created: FileRecord;
          try {
            created = await files().insertOne(fields, { tx });
          } catch (error) {
            if (error instanceof StoreDuplicateKeyError) {
              throw skillFileConflictError('Skill file was created by another writer');
            }
            throw error;
          }
          await bumpSkillVersion(row.skillId, 1, tx);
          return asFile(created);
        });
      }
      const filter = skillFilePathFilter(row.skillId, row.relativePath, row.expectedFileId);
      const update = { $set: fields, $unset: { ...SKILL_FILE_REPLACED_CACHES } };
      return context.transactions.transaction(async (tx) => {
        const result = await files().updateOne(filter, update, {
          upsert: row.expectedFileId == null,
          tx,
        });
        if (result.matchedCount === 0 && result.upsertedCount === 0) {
          throw skillFileConflictError('Skill file changed since it was read');
        }
        const current = await files().findOne(
          result.upsertedId
            ? { _id: result.upsertedId }
            : { skillId: row.skillId, relativePath: row.relativePath },
          { tx },
        );
        if (!current) {
          const error = new Error('Skill file upsert failed to read the saved file row');
          (error as Error & { code?: string }).code = 'SKILL_FILE_UPSERT_NOT_FOUND';
          throw error;
        }
        await bumpSkillVersion(row.skillId, result.upsertedCount === 1 ? 1 : 0, tx);
        return asFile(current);
      });
    },

    async deleteSkillFile(skillId, relativePath, expectedFileId) {
      if (!(await liveSkill(skillId))) {
        throw skillDeletingError();
      }
      return context.transactions.transaction(async (tx) => {
        const result = await files().deleteOne(
          skillFilePathFilter(skillId, relativePath, expectedFileId),
          { tx },
        );
        if (!result.deletedCount) {
          return { deleted: false };
        }
        await bumpSkillVersion(skillId, -1, tx);
        return { deleted: true };
      });
    },

    /** Blob deletion is idempotent; the file row remains the retry manifest until it succeeds. */
    async deleteSkillFileAfterBlob(skillId, fileId) {
      const result = await files().deleteOne({ skillId, file_id: fileId });
      return result.deletedCount === 1;
    },

    async updateSkillFileContent(skillId, relativePath, update, expectedFileId) {
      await files().updateOne(skillFilePathFilter(skillId, relativePath, expectedFileId), {
        $set: update,
      });
    },

    async updateSkillFileCodeEnvIds(updates) {
      if (updates.length === 0) return { matchedCount: 0, modifiedCount: 0 };
      const operations: PgBulkOperation[] = updates.map((update) => ({
        updateOne: skillFileCodeEnvWrite(update),
      }));
      const result = await files().bulk(operations, { ordered: true });
      warnPartialCodeEnvWrite(updates.length, result);
      return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    },

    async findExistingSkillIds(skillIds, isExternalSkillId) {
      const candidates = skillIdCandidates(skillIds);
      if (candidates.length === 0) {
        return [];
      }
      const rows = await skills().find(
        { _id: { $in: candidates }, deletingAt: { $exists: false } },
        { projection: '_id' },
      );
      const existing = new Set(rows.map((row) => row._id));
      return candidates.filter((id) => existing.has(id) || isExternalSkillId?.(id) === true);
    },
  };
  return store;
}

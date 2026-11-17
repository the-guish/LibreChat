import { ResourceType } from 'librechat-data-provider';
import type { CodeEnvRef } from 'librechat-data-provider';
import type { Model, Types, FilterQuery } from 'mongoose';
import type {
  ISkill,
  ISkillDocument,
  ISkillFile,
  ISkillFileDocument,
  ISkillSummary,
  CreateSkillInput,
  CreateSkillResult,
  UpdateSkillInput,
  UpdateSkillResult,
  DeleteSkillResult,
  DeleteSkillCleanupStep,
  UpsertSkillFileInput,
  ListSkillsByAccessParams,
  ListSkillsByAccessResult,
  GetAuthorSkillByNameParams,
  ListAlwaysApplySkillsParams,
  ListAlwaysApplySkillsResult,
} from '~/types/skill';
import type { ISkillUploadIntentDocument } from '~/types/skillDeletion';
import type { IAgent } from '~/types/agent';
import {
  SKILL_LIST_SORT,
  SKILL_SUMMARY_FIELDS,
  ALWAYS_APPLY_SKILL_FIELDS,
  SKILL_FILE_REPLACED_CACHES,
  skillListPage,
  skillFilesPending,
  malformedSkillDeletion,
  skillListLimit,
  skillListFilter,
  skillFileFields,
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
  skillFileConflictError,
  warnPartialCodeEnvWrite,
  agentAllowlistPruneWrites,
  replacedSkillBlobIntentWrite,
  backfillDerivedFromFrontmatter,
} from './skillRules';
import { createSkillLifecycleMethods } from './skillLifecycle';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { isValidObjectIdString } from '~/utils/objectId';
import logger from '~/config/winston';

export {
  partitionIssues,
  validateSkillName,
  validateSkillDescription,
  validateSkillBody,
  validateSkillDisplayTitle,
  validateAlwaysApply,
  getCanonicalSkillFrontmatterKey,
  normalizeSkillFrontmatterKeys,
  validateSkillFrontmatter,
  validateRelativePath,
  inferSkillFileCategory,
  deriveStructuredFrontmatterFields,
  backfillDerivedFromFrontmatter,
} from './skillRules';

export type {
  ValidationIssue,
  DeleteSkillCleanupStep,
  DeleteSkillResult,
  CreateSkillInput,
  UpdateSkillInput,
  GetAuthorSkillByNameParams,
  UpsertSkillFileInput,
  ListSkillsByAccessParams,
  ListSkillsByAccessResult,
  ListAlwaysApplySkillsParams,
  ListAlwaysApplySkillsResult,
  UpdateSkillResult,
  CreateSkillResult,
} from '~/types/skill';

/** The validation helpers and the store rules both backends share live in `./skillRules`. */

type SkillFileUpsertResult = {
  value: (ISkillFile & { _id: Types.ObjectId }) | null;
  lastErrorObject?: {
    updatedExisting?: boolean;
  };
};

/** ---------- Method factory ---------- */

export interface SkillDeps {
  /** Removes all ACL entries for a resource. Injected from PermissionService. */
  removeAllPermissions: (params: { resourceType: string; resourceId: unknown }) => Promise<void>;
  /** Returns resource IDs solely owned by the given user. From createAclEntryMethods. */
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
}

/**
 * Narrows candidate skill ids to those backed by an existing Skill doc or
 * recognized by an injected external skill registry.
 * Existence-only check (no ACL) so pruning an agent allowlist never drops
 * skills the saving user merely can't view. Preserves input order, dedupes,
 * and drops malformed ids — they can't reference anything. Candidates are
 * lowercased before comparison: `isValidObjectIdString` accepts uppercase
 * hex, but `_id.toString()` is always lowercase, and a casing mismatch
 * would silently drop a valid id (and an emptied allowlist means the full
 * catalog — the opposite of the configured scope).
 */
export async function filterExistingSkillIds(
  mongoose: typeof import('mongoose'),
  skillIds: string[],
  isExternalSkillId?: (id: string) => boolean,
): Promise<string[]> {
  const candidates = skillIdCandidates(skillIds);
  if (candidates.length === 0) {
    return [];
  }
  const Skill = mongoose.models.Skill as Model<ISkillDocument>;
  const docs = await Skill.find(
    {
      _id: { $in: candidates.map((id) => new mongoose.Types.ObjectId(id)) },
      deletingAt: { $exists: false },
    },
    { _id: 1 },
  ).lean<Array<{ _id: Types.ObjectId }>>();
  const existing = new Set(docs.map((doc) => doc._id.toString()));
  return candidates.filter((id) => existing.has(id) || isExternalSkillId?.(id) === true);
}

export function createSkillMethods(
  mongoose: typeof import('mongoose'),
  deps: SkillDeps,
): {
  createSkill: (data: CreateSkillInput) => Promise<CreateSkillResult>;
  getSkillById: (id: string | Types.ObjectId) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  getSkillByName: (
    name: string,
    accessibleIds: Types.ObjectId[],
    options?: {
      /**
       * Manual paths (`$` popover, always-apply once Phase 5 lands) set
       * this so a same-name newer `userInvocable: false` duplicate can't
       * shadow the older user-invocable doc the popover surfaced.
       * Disable-model-invocation status is irrelevant here — manually-
       * primed disabled skills are explicitly supported (iter 4).
       */
      preferUserInvocable?: boolean;
      /**
       * Model paths (`skill` / `read_file` tool handlers) set this so a
       * same-name newer `disable-model-invocation: true` duplicate can't
       * shadow the cataloged model-invocable doc. User-invocability is
       * irrelevant here — `userInvocable: false` skills are model-only
       * and remain valid model-invocation targets.
       *
       * Both flags fall back to the newest match when no preferred doc
       * exists, so handlers can still fire their explicit-rejection
       * error paths (e.g. "cannot be invoked by the model" in the
       * disabled-only case).
       */
      preferModelInvocable?: boolean;
    },
  ) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  getAuthorSkillByName: (
    params: GetAuthorSkillByNameParams,
  ) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  listSkillsByAccess: (params: ListSkillsByAccessParams) => Promise<ListSkillsByAccessResult>;
  listAlwaysApplySkills: (
    params: ListAlwaysApplySkillsParams,
  ) => Promise<ListAlwaysApplySkillsResult>;
  updateSkill: (params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }) => Promise<UpdateSkillResult>;
  deleteSkill: (id: string) => Promise<DeleteSkillResult>;
  deleteSkillFileAfterBlob: (skillId: string, fileId: string) => Promise<boolean>;
  finalizeSkillDeletion: (id: string) => Promise<DeleteSkillResult>;
  deleteUserSkills: (userId: Types.ObjectId | string) => Promise<number>;
  findSkillBySourceIdentity: (params: {
    source: 'github' | 'notion';
    upstreamId: string;
    tenantId?: string;
  }) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  listSkillsBySource: (params: {
    source: 'github' | 'notion';
    sourceId: string;
  }) => Promise<Array<ISkill & { _id: Types.ObjectId }>>;
  listSkillFiles: (
    skillId: Types.ObjectId | string,
  ) => Promise<Array<ISkillFile & { _id: Types.ObjectId }>>;
  upsertSkillFile: (row: UpsertSkillFileInput) => Promise<ISkillFile & { _id: Types.ObjectId }>;
  deleteSkillFile: (
    skillId: Types.ObjectId | string,
    relativePath: string,
    expectedFileId?: string,
  ) => Promise<{ deleted: boolean }>;
  getSkillFileByPath: (
    skillId: Types.ObjectId | string,
    relativePath: string,
  ) => Promise<(ISkillFile & { _id: Types.ObjectId }) | null>;
  updateSkillFileContent: (
    skillId: Types.ObjectId | string,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ) => Promise<void>;
  updateSkillFileCodeEnvIds: (
    updates: Array<{
      skillId: Types.ObjectId | string;
      relativePath: string;
      codeEnvRef: CodeEnvRef;
    }>,
  ) => Promise<{ matchedCount: number; modifiedCount: number }>;
  findExistingSkillIds: (
    skillIds: string[],
    isExternalSkillId?: (id: string) => boolean,
  ) => Promise<string[]>;
} {
  const { ObjectId } = mongoose.Types;

  const toObjectId = (id: string) => new ObjectId(id);

  async function createSkill(data: CreateSkillInput): Promise<CreateSkillResult> {
    const prepared = prepareSkillCreate(data);
    const { warnings } = prepared;

    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const author = new mongoose.Types.ObjectId(data.author);

    // Application-level uniqueness check on (name, author, tenantId).
    // The unique index in the schema is the persistent guarantee, but Mongoose
    // creates indexes asynchronously and tests can race ahead of index creation,
    // so we also enforce it here for deterministic behavior and a clean error.
    const existing = await Skill.findOne({
      name: data.name,
      author,
      tenantId: data.tenantId ?? null,
    })
      .select('_id')
      .lean();
    if (existing) {
      const error = new Error(skillNameTakenMessage(data.name));
      (error as Error & { code?: string | number }).code = 11000;
      throw error;
    }

    const doc = await Skill.create(skillCreateDocument(data, author, prepared));
    return {
      skill: doc.toObject() as unknown as ISkill & { _id: Types.ObjectId },
      warnings,
    };
  }

  async function getSkillById(
    id: string | Types.ObjectId,
  ): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    if (typeof id === 'string' && !isValidObjectIdString(id)) {
      return null;
    }
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const doc = await Skill.findOne({ _id: id, deletingAt: { $exists: false } }).lean();
    return (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null;
  }

  async function getSkillByName(
    name: string,
    accessibleIds: Types.ObjectId[],
    options?: {
      /**
       * Manual paths (`$` popover, always-apply once Phase 5 lands) set
       * this so a same-name newer `userInvocable: false` duplicate can't
       * shadow the older user-invocable doc the popover surfaced.
       * Disable-model-invocation status is irrelevant here — manually-
       * primed disabled skills are explicitly supported (iter 4).
       */
      preferUserInvocable?: boolean;
      /**
       * Model paths (`skill` / `read_file` tool handlers) set this so a
       * same-name newer `disable-model-invocation: true` duplicate can't
       * shadow the cataloged model-invocable doc. User-invocability is
       * irrelevant here — `userInvocable: false` skills are model-only
       * and remain valid model-invocation targets.
       *
       * Both flags fall back to the newest match when no preferred doc
       * exists, so handlers can still fire their explicit-rejection
       * error paths (e.g. "cannot be invoked by the model" in the
       * disabled-only case).
       */
      preferModelInvocable?: boolean;
    },
  ): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const preferUserInvocable = options?.preferUserInvocable === true;
    const preferModelInvocable = options?.preferModelInvocable === true;
    /* Single-doc fast path when no preference is requested — preserves
       the previous performance characteristics for callers that just
       want "newest match". */
    if (!preferUserInvocable && !preferModelInvocable) {
      const doc = await Skill.findOne({
        name,
        _id: { $in: accessibleIds },
        deletingAt: { $exists: false },
      })
        .sort({ updatedAt: -1 })
        .lean();
      return backfillDerivedFromFrontmatter(
        (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null,
      );
    }
    /* Multi-doc path: fetch all matching docs (typically 1, rarely 2+
       across same-name duplicates) and pick the first satisfying the
       caller's preference; fall back to newest. */
    const docs = (await Skill.find({
      name,
      _id: { $in: accessibleIds },
      deletingAt: { $exists: false },
    })
      .sort({ updatedAt: -1 })
      .lean()) as unknown as Array<ISkill & { _id: Types.ObjectId }>;
    if (docs.length === 0) {
      return null;
    }
    for (const doc of docs) {
      backfillDerivedFromFrontmatter(doc);
    }
    const preferred = docs.find((d) => {
      if (preferUserInvocable && d.userInvocable === false) {
        return false;
      }
      if (preferModelInvocable && d.disableModelInvocation === true) {
        return false;
      }
      return true;
    });
    return preferred ?? docs[0];
  }

  async function getAuthorSkillByName(
    params: GetAuthorSkillByNameParams,
  ): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const doc = await Skill.findOne({
      name: params.name,
      author: params.author,
      tenantId: params.tenantId ?? null,
      deletingAt: { $exists: false },
    })
      .sort({ updatedAt: -1 })
      .lean();
    return backfillDerivedFromFrontmatter(
      (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null,
    );
  }

  async function listSkillsByAccess(
    params: ListSkillsByAccessParams,
  ): Promise<ListSkillsByAccessResult> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const limit = skillListLimit(params.limit);
    const filter = skillCursorFilter(
      skillListFilter(params),
      decodeSkillCursor(params.cursor),
      toObjectId,
    ) as FilterQuery<ISkillDocument>;

    const rows = await Skill.find(filter)
      .sort(SKILL_LIST_SORT)
      .limit(limit + 1)
      .select(SKILL_SUMMARY_FIELDS)
      .lean();

    /* Defensive read-time fallback. With `frontmatter` excluded from the
       projection, the helper short-circuits immediately; kept in the loop
       so a future projection change (or legacy rows appearing via a
       migration) continues to get runtime-column restoration for free. */
    for (const row of rows) {
      backfillDerivedFromFrontmatter(row as unknown as ISkill);
    }

    const { sliced, has_more, after } = skillListPage(rows, limit);
    return {
      skills: sliced as unknown as Array<ISkillSummary & { _id: Types.ObjectId }>,
      has_more,
      after,
    };
  }

  async function listAlwaysApplySkills(
    params: ListAlwaysApplySkillsParams,
  ): Promise<ListAlwaysApplySkillsResult> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    if (!params.accessibleIds.length) {
      return { skills: [], has_more: false, after: null };
    }
    const limit = skillListLimit(params.limit);

    const baseFilter: FilterQuery<ISkillDocument> = {
      _id: { $in: params.accessibleIds },
      alwaysApply: true,
      deletingAt: { $exists: false },
    };
    const filter = skillCursorFilter(
      baseFilter,
      decodeSkillCursor(params.cursor),
      toObjectId,
    ) as FilterQuery<ISkillDocument>;

    const rows = await Skill.find(filter)
      .sort(SKILL_LIST_SORT)
      .limit(limit + 1)
      .select(ALWAYS_APPLY_SKILL_FIELDS)
      .lean();

    const { sliced, has_more, after } = skillListPage(rows, limit);
    /**
     * `allowedTools` is projected alongside `name`/`body`/`author` so the
     * always-apply prime pipeline (post-Phase 6) can union skill-declared
     * tool allowlists into the agent's effective tool set for the turn —
     * same symmetry as the manual-prime path, which reads the column off
     * `getSkillByName`. Older rows predating the column show up with
     * `allowedTools === undefined` (the backfill helper runs on those at
     * read time elsewhere; per-turn priming is fine with undefined).
     */
    const skills = sliced.map((row) => alwaysApplySkillRow<Types.ObjectId>(row));

    return { skills, has_more, after };
  }

  async function updateSkill(params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }): Promise<UpdateSkillResult> {
    const { id, expectedVersion, update } = params;
    if (!isValidObjectIdString(id)) {
      return { status: 'not_found' };
    }
    const { updateOps, warnings } = prepareSkillUpdate(update);

    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const result = await Skill.findOneAndUpdate(
      { _id: new ObjectId(id), version: expectedVersion, deletingAt: { $exists: false } },
      updateOps,
      { new: true },
    ).lean();

    if (result) {
      return {
        status: 'updated',
        skill: result as unknown as ISkill & { _id: Types.ObjectId },
        warnings,
      };
    }

    const current = await Skill.findOne({ _id: id, deletingAt: { $exists: false } }).lean();
    if (!current) {
      return { status: 'not_found' };
    }
    return {
      status: 'conflict',
      current: current as unknown as ISkill & { _id: Types.ObjectId },
    };
  }

  /**
   * Removes deleted skill ids from every agent's `skills` allowlist. A dangling
   * id is invisible in the builder yet keeps the allowlist non-empty, so the
   * runtime scopes the catalog to an empty intersection and the agent silently
   * loses all skills. Direct `updateMany` on purpose: hygiene, not an authored
   * edit — no version entry, timestamps untouched.
   *
   * Ids are lowercased first: allowlists store canonical `_id.toString()`
   * values, and an uppercase-but-valid id would delete the Skill doc yet
   * leave the dangling entry behind.
   *
   * Agents whose ENTIRE allowlist is being deleted fail closed instead:
   * an emptied allowlist with `skills_enabled: true` means the full
   * accessible catalog at runtime, so a plain `$pull` would silently widen
   * a deliberately restricted agent. Disabling skills preserves the
   * restriction until an author makes a new explicit choice.
   *
   * That inference only applies to agents with no explicit `skills_scope`.
   * With a scope persisted, the field already says what an empty allowlist
   * means -- `selected` resolves to no skills on its own, and `all` means the
   * full catalog on purpose -- so disabling them would turn skills off behind
   * the author's back.
   */
  async function removeSkillsFromAgentAllowlists(skillIds: string[]): Promise<boolean> {
    if (skillIds.length === 0) {
      return true;
    }
    const { emptied, pulled } = agentAllowlistPruneWrites(skillIds);
    const Agent = mongoose.models.Agent as Model<IAgent>;
    try {
      await Agent.updateMany(emptied.filter, emptied.update, { timestamps: false });
      await Agent.updateMany(pulled.filter, pulled.update, { timestamps: false });
      return true;
    } catch (error) {
      logger.error(
        '[removeSkillsFromAgentAllowlists] Error pruning agent skill allowlists:',
        error,
      );
      return false;
    }
  }

  async function deleteSkill(id: string): Promise<DeleteSkillResult> {
    if (!isValidObjectIdString(id)) {
      return malformedSkillDeletion();
    }
    // Legacy callers may still reach this data-only method. It must never
    // discard the last reference to an external blob. The storage-aware API
    // reconciler owns provider deletion and finalization.
    const lifecycle = createSkillLifecycleMethods(mongoose);
    const journal = await lifecycle.beginSkillDeletion(id);
    return {
      deleted: false,
      skillAbsent: !journal,
      cleanupComplete: !journal,
      failedCleanupSteps: journal ? ['skill_files'] : [],
    };
  }

  /** Blob deletion is idempotent; the file row remains the retry manifest until it succeeds. */
  async function deleteSkillFileAfterBlob(skillId: string, fileId: string): Promise<boolean> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const result = await SkillFile.deleteOne({
      skillId: new ObjectId(skillId),
      file_id: fileId,
    });
    return result.deletedCount === 1;
  }

  /** Finalize only after blob rows are drained; never remove late rows without deleting blobs. */
  async function finalizeSkillDeletion(id: string): Promise<DeleteSkillResult> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const objectId = new ObjectId(id);
    const skill = await Skill.findById(objectId).select('_id deletingAt').lean();
    if (skill && !skill.deletingAt) {
      return skillFilesPending();
    }
    if (await SkillFile.exists({ skillId: objectId })) {
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
      return {
        deleted: false,
        skillAbsent: false,
        cleanupComplete: false,
        failedCleanupSteps,
      };
    }
    const result = await Skill.deleteOne({ _id: objectId, deletingAt: { $exists: true } });
    return {
      deleted: result.deletedCount === 1,
      skillAbsent: true,
      cleanupComplete: true,
      failedCleanupSteps: [],
    };
  }

  async function deleteUserSkills(userId: Types.ObjectId | string): Promise<number> {
    const userObjectId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const soleOwned = await deps.getSoleOwnedResourceIds(userObjectId, ResourceType.SKILL);
    if (soleOwned.length === 0) {
      return 0;
    }
    // Mark each Skill and release its public name in the same document write.
    // The reconciler repairs the mark-to-journal gap and backfills file
    // references outside this request.
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const deletingAt = new Date();
    const result = await tenantSafeBulkWrite(
      Skill,
      soleOwned.map((id) => ({
        updateOne: {
          filter: { _id: id, deletingAt: { $exists: false } },
          update: { $set: skillDeletionMark(id.toString(), deletingAt) },
        },
      })),
      { ordered: false },
    );
    return result.modifiedCount;
  }

  async function findSkillBySourceIdentity(params: {
    source: 'github' | 'notion';
    upstreamId: string;
    tenantId?: string;
  }): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const tenantFilter: FilterQuery<ISkillDocument> = params.tenantId
      ? { tenantId: params.tenantId }
      : { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
    const doc = await Skill.findOne({
      source: params.source,
      'sourceMetadata.upstreamId': params.upstreamId,
      deletingAt: { $exists: false },
      ...tenantFilter,
    }).lean();
    return (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null;
  }

  async function listSkillsBySource(params: {
    source: 'github' | 'notion';
    sourceId: string;
  }): Promise<Array<ISkill & { _id: Types.ObjectId }>> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const rows = await Skill.find({
      source: params.source,
      'sourceMetadata.sourceId': params.sourceId,
      deletingAt: { $exists: false },
    }).lean();
    return rows as unknown as Array<ISkill & { _id: Types.ObjectId }>;
  }

  /**
   * Atomically bumps `Skill.version` and adjusts `fileCount` by `delta`.
   * `delta` is `+1` when a new file is inserted, `-1` when one is deleted, and
   * `0` when an existing file is replaced in place.
   *
   * NOTE on consistency: this runs as a **separate** MongoDB operation from
   * the `upsertSkillFile` / `deleteSkillFile` that triggers it. MongoDB only
   * provides multi-document ACID via transactions (which require a replica
   * set), and LibreChat does not currently require that deployment shape. In
   * the rare case where a SkillFile write succeeds but the subsequent
   * `findByIdAndUpdate` here fails (connection drop, primary failover mid-
   * request), the `fileCount` on the parent Skill will drift from the true
   * row count until the next successful upsert/delete corrects it. Options if
   * this ever shows up in practice:
   *   - wrap both ops in a transaction (requires a replica set)
   *   - periodic reconciliation: `fileCount = count(skill_files where skillId = ?)`
   *   - treat `fileCount` as advisory and recompute on read when accuracy
   *     matters
   * For phase 1, skill files are stubbed at the upload boundary, so the risk
   * window doesn't open in practice.
   */
  async function bumpSkillVersionAndAdjustFileCount(
    skillId: Types.ObjectId | string,
    delta: number,
  ): Promise<void> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const updateOps: Record<string, Record<string, number>> = { $inc: { version: 1 } };
    if (delta !== 0) {
      updateOps.$inc.fileCount = delta;
    }
    await Skill.findByIdAndUpdate(skillId, updateOps);
  }

  async function listSkillFiles(
    skillId: Types.ObjectId | string,
  ): Promise<Array<ISkillFile & { _id: Types.ObjectId }>> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const rows = await SkillFile.find({ skillId })
      .select('-content')
      .sort({ relativePath: 1 })
      .lean();
    return rows as unknown as Array<ISkillFile & { _id: Types.ObjectId }>;
  }

  async function upsertSkillFile(
    row: UpsertSkillFileInput,
  ): Promise<ISkillFile & { _id: Types.ObjectId }> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const parent = await Skill.findOne({
      _id: row.skillId,
      deletingAt: { $exists: false },
    })
      .select('_id')
      .lean();
    if (!parent) {
      throw skillDeletingError();
    }
    assertSkillFilePath(row.relativePath);
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    if (!row.createOnly) {
      const previous = await SkillFile.findOne(
        skillFilePathFilter(row.skillId, row.relativePath, row.expectedFileId),
      )
        .select('-content')
        .lean();
      if (previous && previous.file_id === row.file_id && movesSkillFileStorage(previous, row)) {
        throw skillFileConflictError('Skill file identity cannot change storage location');
      }
      if (previous && previous.file_id !== row.file_id) {
        // Queue the old blob before changing its only live file row. A failed
        // CAS leaves the row in place, so the sweeper will retain its blob.
        const SkillUploadIntent = mongoose.models
          .SkillUploadIntent as Model<ISkillUploadIntentDocument>;
        const { filter: intentFilter, update: intentUpdate } = replacedSkillBlobIntentWrite(
          row,
          previous,
          new Date(),
        );
        try {
          await SkillUploadIntent.updateOne(intentFilter, intentUpdate, { upsert: true });
        } catch (error) {
          // Concurrent replacements can both attempt the legacy upsert.
          // The winner has already published the same cleanup reference.
          if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
          const result = await SkillUploadIntent.updateOne(intentFilter, intentUpdate);
          if (row.cleanupHoldOwner && result.matchedCount !== 1) {
            throw skillFileConflictError('Skill blob cleanup is already claimed');
          }
        }
      }
    }
    const fields = skillFileFields(row);
    if (row.createOnly) {
      if (row.expectedFileId != null) {
        throw new Error('A file cannot require both an absent path and an existing revision');
      }
      let created: ISkillFileDocument;
      try {
        created = await SkillFile.create(fields);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 11000) {
          throw skillFileConflictError('Skill file was created by another writer');
        }
        throw error;
      }
      await bumpSkillVersionAndAdjustFileCount(row.skillId, 1);
      return created.toObject() as unknown as ISkillFile & { _id: Types.ObjectId };
    }
    const result = (await SkillFile.findOneAndUpdate(
      skillFilePathFilter(row.skillId, row.relativePath, row.expectedFileId),
      {
        $set: fields,
        $unset: { ...SKILL_FILE_REPLACED_CACHES },
      },
      { new: true, upsert: row.expectedFileId == null, includeResultMetadata: true },
    ).lean()) as unknown as SkillFileUpsertResult;
    const current = result.value;
    if (!current && row.expectedFileId != null) {
      throw skillFileConflictError('Skill file changed since it was read');
    }
    if (!current) {
      const error = new Error('Skill file upsert failed to read the saved file row');
      (error as Error & { code?: string }).code = 'SKILL_FILE_UPSERT_NOT_FOUND';
      throw error;
    }
    const delta = result.lastErrorObject?.updatedExisting === false ? 1 : 0;
    await bumpSkillVersionAndAdjustFileCount(row.skillId, delta);
    return current;
  }

  async function deleteSkillFile(
    skillId: Types.ObjectId | string,
    relativePath: string,
    expectedFileId?: string,
  ): Promise<{ deleted: boolean }> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const parent = await Skill.findOne({
      _id: skillId,
      deletingAt: { $exists: false },
    })
      .select('_id')
      .lean();
    if (!parent) {
      throw skillDeletingError();
    }
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const res = await SkillFile.deleteOne(
      skillFilePathFilter(skillId, relativePath, expectedFileId),
    );
    if (!res.deletedCount) {
      return { deleted: false };
    }
    await bumpSkillVersionAndAdjustFileCount(skillId, -1);
    return { deleted: true };
  }

  // The public surface is scoped to methods that handlers and the user
  async function getSkillFileByPath(
    skillId: Types.ObjectId | string,
    relativePath: string,
  ): Promise<(ISkillFile & { _id: Types.ObjectId }) | null> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const row = await SkillFile.findOne({ skillId, relativePath }).lean();
    return row as unknown as (ISkillFile & { _id: Types.ObjectId }) | null;
  }

  async function updateSkillFileContent(
    skillId: Types.ObjectId | string,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ): Promise<void> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    await SkillFile.updateOne(skillFilePathFilter(skillId, relativePath, expectedFileId), {
      $set: update,
    });
  }

  async function updateSkillFileCodeEnvIds(
    updates: Array<{
      skillId: Types.ObjectId | string;
      relativePath: string;
      codeEnvRef: CodeEnvRef;
    }>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    if (updates.length === 0) return { matchedCount: 0, modifiedCount: 0 };
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const ops = updates.map((u) => ({ updateOne: skillFileCodeEnvWrite(u) }));

    /**
     * The returned `{matchedCount, modifiedCount}` lets callers warn on
     * partial writes — a silent miss here turns every subsequent prime
     * into a fresh upload (massive egress at scale). If the wrapper's
     * tenant injection ends up dropping rows, the warn log makes it
     * visible instead of failing closed.
     */
    const result = await tenantSafeBulkWrite(SkillFile, ops);
    warnPartialCodeEnvWrite(updates.length, result);
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  /**
   * {@link filterExistingSkillIds} on this connection: the candidate ids backed by a stored skill
   * or recognized by `isExternalSkillId`. Without the skill model, the candidates unchanged.
   */
  async function findExistingSkillIds(
    skillIds: string[],
    isExternalSkillId?: (id: string) => boolean,
  ): Promise<string[]> {
    if (!mongoose.models.Skill) {
      return skillIds;
    }
    return filterExistingSkillIds(mongoose, skillIds, isExternalSkillId);
  }

  return {
    createSkill,
    getSkillById,
    getSkillByName,
    getAuthorSkillByName,
    listSkillsByAccess,
    listAlwaysApplySkills,
    updateSkill,
    deleteSkill,
    deleteSkillFileAfterBlob,
    finalizeSkillDeletion,
    deleteUserSkills,
    findSkillBySourceIdentity,
    listSkillsBySource,
    listSkillFiles,
    upsertSkillFile,
    deleteSkillFile,
    getSkillFileByPath,
    updateSkillFileContent,
    updateSkillFileCodeEnvIds,
    findExistingSkillIds,
  };
}

export type SkillMethods = ReturnType<typeof createSkillMethods>;

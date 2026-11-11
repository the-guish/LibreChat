/**
 * Skill store port: skills (a SKILL.md body with its frontmatter and metadata) and the files
 * bundled with them, including the reads that prime skills into a turn. Nothing here may import
 * `mongoose`. Signatures are those of `SkillMethods` (`~/methods/skill`) with ids that take an
 * ObjectId stated as `IdLike`; `skill.spec.ts` fails the typecheck if the MongoDB methods stop
 * satisfying them. The durable bookkeeping of skill deletion and of file blobs is the
 * `SkillLifecycleStore`'s (`./skillLifecycle`).
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`).
 * - A skill whose deletion has begun reads as absent, and its files cannot be written.
 * - Authorization is enforced by callers: the reads take the ids the caller may see
 *   (`accessibleIds`), and the writes act on any skill by id.
 * - A skill's `version` counts its changes, its files' included; `updateSkill` writes only while
 *   the stored version is the expected one.
 * - Creates and updates validate their input and throw (`code` `SKILL_VALIDATION_FAILED`, with
 *   the `issues`) on an error; warnings come back with the result.
 *
 * Every method of the module is in the port.
 *
 * Known leaks kept for now so callers stay unchanged: the records (`ISkillRecord`,
 * `ISkillFileRecord` and the listing rows) carry the store's ObjectIds (`_id`, `author`,
 * `skillId`), and a duplicate name on create is reported with the MongoDB duplicate-key code
 * (`code` 11000), which callers test for.
 */
import type { CodeEnvRef } from 'librechat-data-provider';
import type {
  ISkillRecord,
  ISkillFileRecord,
  CreateSkillInput,
  CreateSkillResult,
  UpdateSkillInput,
  UpdateSkillResult,
  DeleteSkillResult,
  UpsertSkillFileInput,
  ListSkillsByAccessParams,
  ListSkillsByAccessResult,
  GetAuthorSkillByNameParams,
  ListAlwaysApplySkillsParams,
  ListAlwaysApplySkillsResult,
} from '~/types';
import type { IdLike, WithIdLike } from './common';
import { listPortMethods } from './common';

/** {@link CreateSkillInput} with its author stated as `IdLike`. */
export type SkillStoreCreateInput = WithIdLike<CreateSkillInput, 'author'>;
/** {@link GetAuthorSkillByNameParams} with its author stated as `IdLike`. */
export type SkillStoreAuthorNameParams = WithIdLike<GetAuthorSkillByNameParams, 'author'>;
/** {@link UpsertSkillFileInput} with its skill and author stated as `IdLike`. */
export type SkillStoreFileInput = WithIdLike<UpsertSkillFileInput, 'skillId' | 'author'>;
/** {@link ListSkillsByAccessParams} with the accessible skill ids stated as `IdLike`. */
export type SkillStoreListParams = Omit<ListSkillsByAccessParams, 'accessibleIds'> & {
  accessibleIds: IdLike[];
};
/** {@link ListAlwaysApplySkillsParams} with the accessible skill ids stated as `IdLike`. */
export type SkillStoreAlwaysApplyParams = Omit<ListAlwaysApplySkillsParams, 'accessibleIds'> & {
  accessibleIds: IdLike[];
};

export interface SkillStore {
  /* ----------------------------------------------------------- skills */

  /**
   * Creates the skill at version 1, deriving its structured fields (always-apply and the
   * invocation flags) from the input. Throws on a validation error, an author that is not a
   * valid id, or a name the author already uses in the tenant (an error with `code` 11000).
   */
  createSkill(data: SkillStoreCreateInput): Promise<CreateSkillResult>;
  /** The skill, or `null` (also for a malformed id). */
  getSkillById(id: IdLike): Promise<ISkillRecord | null>;
  /**
   * The most recently updated skill named `name` among `accessibleIds`, or `null`. The options
   * prefer a match the user (`preferUserInvocable`) or the model (`preferModelInvocable`) may
   * invoke, falling back to the most recent match.
   */
  getSkillByName(
    name: string,
    accessibleIds: IdLike[],
    options?: { preferUserInvocable?: boolean; preferModelInvocable?: boolean },
  ): Promise<ISkillRecord | null>;
  /** The author's most recently updated skill named `name` in `tenantId` (or none), or `null`. */
  getAuthorSkillByName(params: SkillStoreAuthorNameParams): Promise<ISkillRecord | null>;
  /**
   * One page (at most 100) of skill summaries, most recently updated first: those among
   * `accessibleIds`, or every skill of `manageTenantId` when given, optionally of one category
   * or matching `search` in name, description or title. `cursor` is the opaque cursor a
   * previous page returned.
   */
  listSkillsByAccess(params: SkillStoreListParams): Promise<ListSkillsByAccessResult>;
  /**
   * One page (at most 100) of the always-apply skills among `accessibleIds`, most recently
   * updated first, with their bodies. Empty for no ids.
   */
  listAlwaysApplySkills(params: SkillStoreAlwaysApplyParams): Promise<ListAlwaysApplySkillsResult>;
  /**
   * The skill mirrored from the upstream item `upstreamId` of `source`, of `tenantId` (or of no
   * tenant), or `null`.
   */
  findSkillBySourceIdentity(params: {
    source: 'github' | 'notion';
    upstreamId: string;
    tenantId?: string;
  }): Promise<ISkillRecord | null>;
  /** Every skill mirrored from the sync source `sourceId` of `source`. */
  listSkillsBySource(params: {
    source: 'github' | 'notion';
    sourceId: string;
  }): Promise<ISkillRecord[]>;
  /**
   * Applies the update while the skill is at `expectedVersion`, bumping its version; resolves
   * `conflict` with the current skill otherwise, or `not_found`. Throws on a validation error.
   */
  updateSkill(params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }): Promise<UpdateSkillResult>;
  /**
   * Begins the skill's deletion (marks it deleting and journals it); its files' blobs and the
   * final removal are the deletion reconciler's. Resolves whether the skill is already absent.
   */
  deleteSkill(id: string): Promise<DeleteSkillResult>;
  /**
   * Removes a skill whose deletion has begun once its file rows are drained, along with its
   * permissions and agent allowlist entries; reports which cleanup steps failed.
   */
  finalizeSkillDeletion(id: string): Promise<DeleteSkillResult>;
  /** Begins the deletion of every skill the user solely owns; resolves how many it marked. */
  deleteUserSkills(userId: IdLike): Promise<number>;

  /* ------------------------------------------------------------ files */

  /** The skill's files, by path, without their cached content. */
  listSkillFiles(skillId: IdLike): Promise<ISkillFileRecord[]>;
  /** The skill's file at `relativePath`, with its cached content, or `null`. */
  getSkillFileByPath(skillId: IdLike, relativePath: string): Promise<ISkillFileRecord | null>;
  /**
   * Creates or replaces the skill's file at `relativePath` and bumps the skill's version. A
   * replaced blob is queued for cleanup (or held for `cleanupHoldOwner`). Throws on an invalid
   * path, a skill being deleted, or a conflict with `expectedFileId` or `createOnly`.
   */
  upsertSkillFile(row: SkillStoreFileInput): Promise<ISkillFileRecord>;
  /**
   * Deletes the skill's file at `relativePath` (only while it is `expectedFileId`, when given)
   * and bumps the skill's version; throws when the skill is being deleted.
   */
  deleteSkillFile(
    skillId: IdLike,
    relativePath: string,
    expectedFileId?: string,
  ): Promise<{ deleted: boolean }>;
  /** Deletes the file row `fileId` of the skill once its blob is gone; resolves whether it did. */
  deleteSkillFileAfterBlob(skillId: string, fileId: string): Promise<boolean>;
  /** Caches the file's text content or binary flag (only while it is `expectedFileId`, if given). */
  updateSkillFileContent(
    skillId: IdLike,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ): Promise<void>;
  /** Records each file's code-environment reference; resolves the files matched and changed. */
  updateSkillFileCodeEnvIds(
    updates: Array<{ skillId: IdLike; relativePath: string; codeEnvRef: CodeEnvRef }>,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  /**
   * The candidate ids (well-formed ones, lowercased, each once, in order) backed by a stored skill
   * whose deletion has not begun or recognized by `isExternalSkillId`; existence only, no access
   * check. The candidates unchanged when the store keeps no skills.
   */
  findExistingSkillIds(
    skillIds: string[],
    isExternalSkillId?: (id: string) => boolean,
  ): Promise<string[]>;
}

/** Every method of {@link SkillStore}, for adapters and conformance checks. */
export const SKILL_STORE_METHODS: ReadonlyArray<keyof SkillStore> = listPortMethods<SkillStore>({
  createSkill: true,
  getSkillById: true,
  getSkillByName: true,
  getAuthorSkillByName: true,
  listSkillsByAccess: true,
  listAlwaysApplySkills: true,
  findSkillBySourceIdentity: true,
  listSkillsBySource: true,
  updateSkill: true,
  deleteSkill: true,
  finalizeSkillDeletion: true,
  deleteUserSkills: true,
  listSkillFiles: true,
  getSkillFileByPath: true,
  upsertSkillFile: true,
  deleteSkillFile: true,
  deleteSkillFileAfterBlob: true,
  updateSkillFileContent: true,
  updateSkillFileCodeEnvIds: true,
  findExistingSkillIds: true,
});

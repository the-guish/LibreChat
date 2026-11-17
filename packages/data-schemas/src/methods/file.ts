import { Types } from 'mongoose';
import { FileContext } from 'librechat-data-provider';
import type { TFile, CodeEnvRef, EToolResources } from 'librechat-data-provider';
import type { FilterQuery, SortOrder, Model } from 'mongoose';
import type {
  IMongoFile,
  RunArtifactFile,
  RunArtifactClaim,
  RunArtifactScope,
  CodeFileCommitData,
  RunArtifactRunScope,
  PublishRunArtifactInput,
  ClearFileCodeEnvRefsParams,
  FileStorageCleanupParams,
  DeleteFilesOptions,
  DeleteFilesResult,
  FileOwnerScope,
  ProjectFileRecord,
  ProjectFilesOptions,
  LegacySearchFileRef,
  WorkspaceImportRecord,
  ExpiredFileQueryOptions,
  ClearFileEmbeddingsParams,
  AvailableProjectFilesResult,
  AvailableProjectFilesOptions,
} from '~/types/file';
import type {
  DetachedFile,
  CodeFileClaim,
  PlainFileDocument,
  RunArtifactDocument,
  ProjectFileRecordSource,
  DeferredProvisionResources,
  AvailableProjectFileRecordSource,
} from './fileRules';
import type { IChatProjectDocument } from '~/types';
import {
  codeFileClaim,
  batchFileUpdate,
  fileHoldWrites,
  createFileData,
  fileHoldFilter,
  fileUsageUpdate,
  createFileFilter,
  createFileInsert,
  toolFilesFilter,
  distinctUsageIds,
  runArtifactFilter,
  runArtifactFileId,
  runArtifactInsert,
  expiredFilesFilter,
  codeEnvRefsCleared,
  projectFilesFilter,
  projectDetachWrites,
  toRunFileCandidate,
  fileDeletionScopes,
  PROJECT_FILE_SELECT,
  userCodeFilesFilter,
  codeFileClaimFailure,
  serializeRunArtifact,
  codeFileCommitFilter,
  fileCodeEnvRefUpdate,
  fileDeletionOutcome,
  orphanedPreviewsSweep,
  workspaceImportUpdate,
  fileOwnerTenantFilter,
  fileStorageCleanFilter,
  allowsMissingFileRecord,
  FileStorageConflictError,
  fileEmbeddedEntityUpdate,
  fileStorageCleanupFilter,
  clearFileEmbeddingsFilter,
  clearFileEmbeddingsUpdate,
  runArtifactIdentityFilter,
  codeGeneratedFilesFilter,
  availableProjectFilesQuery,
  allProjectFilesDetachWrite,
  normalizeProjectFileRecord,
  clearFileCodeEnvRefsMatches,
  legacySearchEmbeddingFilter,
  fileDeletionRemainingFilter,
  deferredProvisionFilesFilter,
  AVAILABLE_PROJECT_FILE_SELECT,
  normalizeAvailableProjectFileRecord,
} from './fileRules';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { fileContentUpdate } from './fileContent';
import logger from '../config/winston';

export type {
  FileOwnerScope,
  ProjectFileRecord,
  ProjectFilesOptions,
  LegacySearchFileRef,
  WorkspaceImportRecord,
  ExpiredFileQueryOptions,
  ClearFileEmbeddingsParams,
  AvailableProjectFileRecord,
  AvailableProjectFilesResult,
  AvailableProjectFilesOptions,
} from '~/types/file';

export {
  FileStorageConflictError,
  parseAvailableProjectFilesCursor,
  MAX_AVAILABLE_PROJECT_FILES_LIMIT,
  DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT,
  InvalidAvailableProjectFilesCursorError,
} from './fileRules';

function rethrowCodeFileStorageConflict(error: unknown): never {
  if (error instanceof Error && 'code' in error && error.code === 11000) {
    throw new FileStorageConflictError();
  }
  throw error;
}

/** Factory function that takes mongoose instance and returns the file methods */
export function createFileMethods(mongoose: typeof import('mongoose')): {
  getRunFileCandidates: (fileIds: readonly string[], tenantId?: string | null) => Promise<TFile[]>;
  claimRunArtifactFile: (scope: RunArtifactScope) => Promise<RunArtifactClaim>;
  publishRunArtifactFile: (input: PublishRunArtifactInput) => Promise<RunArtifactFile>;
  findRunArtifactFile: (scope: RunArtifactScope) => Promise<RunArtifactFile | null>;
  listRunArtifacts: (scope: RunArtifactRunScope) => Promise<RunArtifactFile[]>;
  findFileById: (file_id: string, options?: Record<string, unknown>) => Promise<IMongoFile | null>;
  getFiles: (
    filter: FilterQuery<IMongoFile>,
    _sortOptions?: Record<string, SortOrder> | null,
    selectFields?: Record<string, 0 | 1> | string | null,
    limit?: number | null,
  ) => Promise<IMongoFile[] | null>;
  getProjectFiles: (options: ProjectFilesOptions) => Promise<ProjectFileRecord[]>;
  getAvailableProjectFiles: (
    options: AvailableProjectFilesOptions,
  ) => Promise<AvailableProjectFilesResult>;
  getExpiredFiles: (limit?: number, options?: ExpiredFileQueryOptions) => Promise<IMongoFile[]>;
  incrementFileDeletionAttempts: (file_id: string) => Promise<number>;
  deferExpiredFile: (file_id: string, deletionRetryAt: Date) => Promise<void>;
  getToolFilesByIds: (
    fileIds: string[],
    toolResourceSet?: Set<EToolResources>,
    ownerScope?: FileOwnerScope,
  ) => Promise<IMongoFile[]>;
  getCodeGeneratedFiles: (
    conversationId: string,
    threadFileIds?: string[],
    ownerScope?: FileOwnerScope,
  ) => Promise<IMongoFile[]>;
  getUserCodeFiles: (fileIds: string[], ownerScope: FileOwnerScope) => Promise<IMongoFile[]>;
  getDeferredProvisionFiles: (
    fileIds: string[],
    ownerScope: FileOwnerScope,
    resources?: {
      code?: boolean;
      search?: boolean;
      codeRouteKey?: string;
      searchNamespaces?: string[];
      hydrateProvisioned?: boolean;
    },
  ) => Promise<IMongoFile[]>;
  claimCodeFile: (data: {
    filename: string;
    conversationId: string;
    file_id: string;
    user: string;
    tenantId?: string | null;
    sourceDispatchedAt?: number;
  }) => Promise<IMongoFile>;
  commitCodeFile: (data: CodeFileCommitData, sourceDispatchedAt?: number) => Promise<boolean>;
  createFile: (data: Partial<IMongoFile>, disableTTL?: boolean) => Promise<IMongoFile | null>;
  updateFile: (
    data: Partial<IMongoFile> & { file_id: string },
    extraFilter?: FilterQuery<IMongoFile>,
  ) => Promise<IMongoFile | null>;
  updateFileCodeEnvRef: (data: {
    file_id: string;
    routeKey: string;
    ref: CodeEnvRef;
    legacyRef?: CodeEnvRef;
  }) => Promise<IMongoFile | null>;
  clearFileCodeEnvRefs: (data: ClearFileCodeEnvRefsParams) => Promise<boolean>;
  clearFileEmbeddings: (data: ClearFileEmbeddingsParams) => Promise<boolean>;
  isFileStorageClean: (data: FileStorageCleanupParams) => Promise<boolean>;
  addFileEmbeddedEntity: (data: {
    file_id: string;
    entityId: string;
  }) => Promise<IMongoFile | null>;
  recordFileWorkspaceImport: (data: WorkspaceImportRecord) => Promise<boolean>;
  adoptLegacySearchEmbeddings: (data: {
    files: LegacySearchFileRef[];
    agentId: string;
  }) => Promise<string[]>;
  updateFileUsage: (data: {
    file_id: string;
    inc?: number;
    user?: string;
    tenantId?: string | null;
  }) => Promise<IMongoFile | null>;
  deleteFile: (file_id: string) => Promise<IMongoFile | null>;
  deleteFiles: (
    file_ids: string[],
    user?: string,
    options?: DeleteFilesOptions,
  ) => Promise<DeleteFilesResult>;
  deleteFileByFilter: (filter: FilterQuery<IMongoFile>) => Promise<IMongoFile | null>;
  batchUpdateFiles: (
    updates: Array<{
      file_id: string;
      filepath: string;
      storageKey?: string;
      storageRegion?: string;
    }>,
  ) => Promise<void>;
  updateFilesUsage: (
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ) => Promise<IMongoFile[]>;
  extendFilesTTL: (
    fileIds: string[],
    hold: { renewMs: number; maxLifetimeMs: number },
    owner: { user: string; tenantId?: string | null },
  ) => Promise<number>;
  sweepOrphanedPreviews: (maxAgeMs?: number) => Promise<number>;
} {
  /** Hydrates only host-selected IDs; the caller applies its existing agent-file authorization. */
  async function getRunFileCandidates(
    fileIds: readonly string[],
    tenantId?: string | null,
  ): Promise<TFile[]> {
    if (fileIds.length === 0) {
      return [];
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const files = await File.find({
      file_id: { $in: fileIds },
      tenantId: tenantId ?? null,
    }).lean<PlainFileDocument[]>();
    return files.map(toRunFileCandidate);
  }

  async function findRunArtifactFile(scope: RunArtifactScope): Promise<RunArtifactFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const file = await File.findOne(
      runArtifactIdentityFilter(scope) as FilterQuery<IMongoFile>,
    ).lean<RunArtifactDocument>();
    return file == null ? null : serializeRunArtifact(file, scope);
  }

  async function listRunArtifacts(scope: RunArtifactRunScope): Promise<RunArtifactFile[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const files = await File.find(runArtifactFilter(scope) as FilterQuery<IMongoFile>)
      .sort({ createdAt: 1, file_id: 1 })
      .lean<RunArtifactDocument[]>();
    return files.map((file) => serializeRunArtifact(file));
  }

  async function claimRunArtifactFile(scope: RunArtifactScope): Promise<RunArtifactClaim> {
    const file = await findRunArtifactFile(scope);
    return file == null ? { file_id: runArtifactFileId(scope) } : { file_id: file.file_id, file };
  }

  /** Publishes one complete storage result. Retried writers cannot replace its bytes or grants. */
  async function publishRunArtifactFile(input: PublishRunArtifactInput): Promise<RunArtifactFile> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const { scope } = input;
    const filter = runArtifactIdentityFilter(scope) as FilterQuery<IMongoFile>;
    const insert = runArtifactInsert(input);
    try {
      const published = await File.findOneAndUpdate(
        filter,
        { $setOnInsert: insert },
        { upsert: true, new: true, runValidators: true, timestamps: false },
      ).lean<RunArtifactDocument>();
      if (published == null) {
        throw new Error('Run artifact publication did not produce a file');
      }
      return serializeRunArtifact(published, scope);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 11000) {
        const existing = await findRunArtifactFile(scope);
        if (existing != null) {
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Finds a file by its file_id with additional query options.
   * @param file_id - The unique identifier of the file
   * @param options - Query options for filtering, projection, etc.
   * @returns A promise that resolves to the file document or null
   */
  async function findFileById(
    file_id: string,
    options: Record<string, unknown> = {},
  ): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.findOne({ file_id, ...options }).lean<IMongoFile>();
  }

  /** Select fields for query projection - 0 to exclude, 1 to include */
  type SelectProjection = Record<string, 0 | 1>;

  /**
   * Retrieves files matching a given filter, sorted by the most recently updated.
   * @param filter - The filter criteria to apply
   * @param _sortOptions - Optional sort parameters
   * @param selectFields - Fields to include/exclude in the query results. Default excludes the 'text' field
   * @param limit - Optional max number of documents to return (newest first)
   * @returns A promise that resolves to an array of file documents
   */
  async function getFiles(
    filter: FilterQuery<IMongoFile>,
    _sortOptions?: Record<string, SortOrder> | null,
    selectFields?: string | Record<string, 0 | 1> | null | undefined,
    limit?: number | null,
  ): Promise<IMongoFile[] | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const sortOptions = { updatedAt: -1 as SortOrder, ..._sortOptions };
    const query = File.find(filter);
    if (selectFields != null) {
      query.select(selectFields);
    } else {
      query.select({ text: 0 });
    }
    if (limit != null && limit > 0) {
      query.limit(limit);
    }
    return await query.sort(sortOptions).lean<IMongoFile[]>();
  }
  async function getProjectFiles({
    fileIds,
    userId,
    tenantId,
    includeContent = false,
  }: ProjectFilesOptions): Promise<ProjectFileRecord[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const query = File.find(
      projectFilesFilter({ fileIds, userId, tenantId }) as FilterQuery<IMongoFile>,
    );
    if (includeContent) {
      query.select({});
    } else {
      query.select({ ...PROJECT_FILE_SELECT });
    }
    const files = (await query.lean<ProjectFileRecordSource[]>()) ?? [];
    return files.map(normalizeProjectFileRecord);
  }

  async function getAvailableProjectFiles(
    options: AvailableProjectFilesOptions,
  ): Promise<AvailableProjectFilesResult> {
    const { filter, limit } = availableProjectFilesQuery(options, (hex) => new Types.ObjectId(hex));

    const File = mongoose.models.File as Model<IMongoFile>;
    const files = await File.find(filter as FilterQuery<IMongoFile>)
      .select({ ...AVAILABLE_PROJECT_FILE_SELECT })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<AvailableProjectFileRecordSource[]>();

    let nextCursor: string | null = null;
    if (files.length > limit) {
      files.pop();
      const lastFile = files[files.length - 1];
      if (lastFile) {
        nextCursor = lastFile._id.toString();
      }
    }
    return { files: files.map(normalizeAvailableProjectFileRecord), nextCursor };
  }

  /**
   * Expired files the sweep may attempt right now, oldest deadline first.
   *
   * `deletionRetryAt` is the only thing holding a file back: one that keeps
   * failing is deferred on a growing backoff, and one that exhausts its
   * attempts is parked far enough out to stop crowding the batch. Without
   * it a permanently undeletable file sorts to the front of this bounded
   * batch on every pass and starves every file that expired after it.
   *
   * The deferral is deliberately a deadline rather than a flag, so nothing
   * here is ever excluded for good. File records are reused across content
   * lifecycles — a code-output row is repurposed for a repeated
   * `(filename, conversationId)`, keeping fields it was not asked to change
   * — so bookkeeping that permanently excluded a row would eventually
   * strand a *different* object than the one it was recorded against. A
   * deadline can only ever delay that; it cannot lose it.
   *
   * An absent field means "never attempted", so records written before it
   * existed remain eligible.
   */
  async function getExpiredFiles(
    limit = 100,
    { now = new Date() }: ExpiredFileQueryOptions = {},
  ): Promise<IMongoFile[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    return await File.find(expiredFilesFilter(now) as FilterQuery<IMongoFile>)
      .sort({ expiredAt: 1 })
      .limit(limit)
      .lean<IMongoFile[]>();
  }

  /**
   * Records one failed sweep deletion and returns the file's resulting
   * consecutive-failure count.
   *
   * The count comes back from the increment itself rather than being
   * re-derived from the caller's snapshot. Two nodes sweeping the same file
   * would otherwise each read the same value and each believe itself to be
   * the same attempt, pushing the stored count past the give-up cap while
   * both still think it is below — so the give-up would never be reported.
   * Returning it here gives every caller a distinct attempt number.
   */
  async function incrementFileDeletionAttempts(file_id: string): Promise<number> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const file = await File.findOneAndUpdate(
      { file_id },
      { $inc: { deletionAttempts: 1 } },
      /** `timestamps: false`: sweep bookkeeping is not a content write.
       *  `processCodeOutput` falls back to `updatedAt` as the writer-order
       *  stamp for records predating `metadata.sourceDispatchedAt`, so
       *  bumping it here would make a failed sweep look like a newer writer
       *  and a background harvest would drop its attachment. Same reasoning
       *  as `claimCodeFile`. */
      { new: true, projection: { deletionAttempts: 1 }, timestamps: false },
    ).lean<Pick<IMongoFile, 'deletionAttempts'> | null>();

    return file?.deletionAttempts ?? 0;
  }

  /**
   * Holds a file back from the sweep until `deletionRetryAt`.
   *
   * Written with `$max` so a deferral can only ever move later. A node that
   * computed a shorter backoff from a lower attempt count cannot pull the
   * file forward past a longer one another node already committed.
   */
  async function deferExpiredFile(file_id: string, deletionRetryAt: Date): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    await File.updateOne({ file_id }, { $max: { deletionRetryAt } }, { timestamps: false }).exec();
  }

  /**
   * Retrieves tool files (files that are embedded or have a fileIdentifier) from an array of file IDs.
   * Note: execute_code files are handled separately by getCodeGeneratedFiles.
   * @param fileIds - Array of file_id strings to search for
   * @param toolResourceSet - Optional filter for tool resources
   * @returns Files that match the criteria
   */
  async function getToolFilesByIds(
    fileIds: string[],
    toolResourceSet?: Set<EToolResources>,
    ownerScope?: FileOwnerScope,
  ): Promise<IMongoFile[]> {
    if (!fileIds || !fileIds.length || !toolResourceSet?.size) {
      return [];
    }

    try {
      const filter = toolFilesFilter(fileIds, toolResourceSet, ownerScope);

      // If no conditions to match, return empty
      if (filter == null) {
        return [];
      }

      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { updatedAt: -1 as SortOrder };

      const results = await getFiles(filter as FilterQuery<IMongoFile>, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      logger.error('[getToolFilesByIds] Error retrieving tool files:', error);
      throw new Error('Error retrieving tool files');
    }
  }

  /**
   * Retrieves files generated by code execution for a given conversation.
   * These files are stored locally with `metadata.codeEnvRef` for code env re-upload.
   *
   * Filtered by `file_id IN threadFileIds` (the file_ids referenced from
   * messages in the current thread's `files` arrays) rather than by
   * `messageId IN threadMessageIds` (the File record's own creator id).
   * This mirrors `getUserCodeFiles` and fixes the branched-conversation
   * case where:
   *   1. Sibling A creates `output.csv` via processCodeOutput → File
   *      record persists with `messageId = A`.
   *   2. Sibling N (a regeneration of A's parent) recreates `output.csv`.
   *      `claimCodeFile` is keyed by `(filename, conversationId, context)`
   *      and finds A's record; `processCodeOutput` deliberately preserves
   *      A's `messageId` to keep file→original-creator provenance intact.
   *   3. Turn N+1's user message has `parentMessageId = N` (sibling of A).
   *      `getThreadData` walks back from N: thread = [N, root]. A is
   *      NOT in that thread, so a `messageId IN [N, root]` filter
   *      excludes the file.
   * The message at N references the file via `messages.files = [...]`,
   * so `threadFileIds` (collected from that array during thread walk)
   * DOES include the file_id. Filtering by that key reaches the right
   * file regardless of which sibling first created it.
   *
   * @param conversationId - The conversation ID to search for
   * @param threadFileIds - Array of file_ids referenced by messages in
   *   the current thread (collected from `messages.files[].file_id`).
   *   While technically optional, this function returns empty if not
   *   provided — code-generated files must be filtered by thread to
   *   avoid pulling in files from other branches of a conversation.
   * @returns Files generated by code execution in the conversation,
   *   filtered to those referenced by the current thread.
   */
  async function getCodeGeneratedFiles(
    conversationId: string,
    threadFileIds?: string[],
    ownerScope?: FileOwnerScope,
  ): Promise<IMongoFile[]> {
    if (!conversationId) {
      return [];
    }

    /**
     * Return early if threadFileIds not provided — same rationale as
     * the messageIds-based predecessor: code-generated files must be
     * filtered by thread to ensure we only return files relevant to
     * the current conversation branch, not orphaned files from other
     * branches or deleted messages.
     */
    if (!threadFileIds || threadFileIds.length === 0) {
      return [];
    }

    try {
      const filter = codeGeneratedFilesFilter(conversationId, threadFileIds, ownerScope);

      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { createdAt: 1 as SortOrder };

      const results = await getFiles(filter as FilterQuery<IMongoFile>, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      logger.error('[getCodeGeneratedFiles] Error retrieving code generated files:', error);
      return [];
    }
  }

  /**
   * Retrieves conversation attachments that were accepted but never provisioned, so a
   * later turn can still queue them.
   *
   * Lazy provisioning defers the upload to the sandbox or vector store until a tool
   * actually runs. The other hydration queries only return files that already carry
   * the result of that work: `getToolFilesByIds` matches `embedded: true` for
   * file_search, and `getUserCodeFiles` requires an existing `codeEnvRef`. A file
   * whose tool was never called on its upload turn therefore satisfies neither and
   * disappears. This fills exactly that gap: attachments with no code reference and
   * no embedding.
   *
   * Kept separate from delivery hydration deliberately. These records are candidates
   * for provisioning only; feeding them back into the model's attachments would
   * re-send earlier uploads on every subsequent turn.
   *
   * Selection is per requested resource, not per file. A file embedded for an earlier
   * file_search agent still has no code reference, so a later execute_code agent must
   * see it; requiring both results to be absent would hide exactly that case.
   *
   * @param fileIds - Candidate file IDs from the current thread
   * @param ownerScope - Authenticated owner scope
   * @param resources - Which provisioning results the current agent needs
   * @returns Attachments still awaiting a result the current agent needs
   */
  async function getDeferredProvisionFiles(
    fileIds: string[],
    ownerScope: FileOwnerScope,
    resources: DeferredProvisionResources = {
      code: true,
      search: true,
    },
  ): Promise<IMongoFile[]> {
    if (!fileIds || fileIds.length === 0) {
      return [];
    }

    const filter = deferredProvisionFilesFilter(fileIds, ownerScope, resources);
    if (filter == null) {
      return [];
    }

    try {
      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { createdAt: 1 as SortOrder };

      const results = await getFiles(filter as FilterQuery<IMongoFile>, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      /* An empty list here is indistinguishable from nothing needing provisioning, so the
       * turn would build no provisioning state and let the tool run without the
       * attachment. The callback aborts on missing inputs precisely to avoid that, so a
       * read failure has to surface rather than be flattened into a benign answer. */
      logger.error('[getDeferredProvisionFiles] Error retrieving deferred files:', error);
      throw error;
    }
  }

  /**
   * Retrieves user-uploaded execute_code files (not code-generated) by their file IDs.
   * These are files with fileIdentifier metadata but context is NOT execute_code (e.g., agents or message_attachment).
   * File IDs should be collected from message.files arrays in the current thread.
   * @param fileIds - Array of file IDs to fetch (from message.files in the thread)
   * @param ownerScope - Authenticated owner scope used to constrain historical refs
   * @returns User-uploaded execute_code files
   */
  async function getUserCodeFiles(
    fileIds: string[],
    ownerScope: FileOwnerScope,
  ): Promise<IMongoFile[]> {
    if (!fileIds || fileIds.length === 0) {
      return [];
    }

    try {
      const filter = userCodeFilesFilter(fileIds, ownerScope);

      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { createdAt: 1 as SortOrder };

      const results = await getFiles(filter as FilterQuery<IMongoFile>, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      logger.error('[getUserCodeFiles] Error retrieving user code files:', error);
      return [];
    }
  }

  /**
   * Atomically claims a file_id for a code-execution output by compound key.
   * Uses $setOnInsert so concurrent calls for the same (filename, conversationId)
   * converge on a single record instead of creating duplicates.
   */
  async function claimCodeFile(data: CodeFileClaim): Promise<IMongoFile> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const { filter, insert } = codeFileClaim(data);
    let result: IMongoFile | null;
    try {
      result = await File.findOneAndUpdate(
        filter as FilterQuery<IMongoFile>,
        { $setOnInsert: insert },
        /** `timestamps: false`: a claim is an id reservation, not a content
         *  write — bumping `updatedAt` here would make the row look freshly
         *  written to the background harvest's out-of-order guard, which
         *  compares `updatedAt` against the harvest's start time. */
        { upsert: true, new: true, timestamps: false },
      ).lean<IMongoFile>();
    } catch (error) {
      rethrowCodeFileStorageConflict(error);
    }
    if (!result) {
      throw codeFileClaimFailure(data);
    }
    return result;
  }

  /**
   * Creates a new file with a TTL of 1 hour.
   * @param data - The file data to be created, must contain file_id
   * @param disableTTL - Whether to disable the TTL
   * @returns A promise that resolves to the created file document
   */
  async function createFile(
    data: Partial<IMongoFile> | CodeFileCommitData,
    disableTTL?: boolean,
  ): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const fileData = createFileData(data, disableTTL);

    const generatedOutput = data.context === FileContext.execute_code;
    try {
      return await File.findOneAndUpdate(
        createFileFilter(data, generatedOutput) as FilterQuery<IMongoFile>,
        {
          ...fileContentUpdate(fileData),
          $setOnInsert: createFileInsert(),
        },
        { new: true, upsert: true },
      ).lean<IMongoFile>();
    } catch (error) {
      if (generatedOutput) rethrowCodeFileStorageConflict(error);
      throw error;
    }
  }

  /**
   * Updates a file identified by file_id with new data and removes the TTL.
   *
   * `extraFilter` extends the by-id query with additional conditions
   * (e.g. `{ previewRevision: '<expected uuid>' }`). When provided, the
   * update is conditional — it commits only if the document still
   * matches the extra filter, returning `null` otherwise. Used by the
   * deferred-preview render to guard against an older render of the
   * same `file_id` overwriting a newer turn's record on cross-turn
   * filename reuse.
   *
   * Content timestamps advance only when the caller actually writes a
   * field. Clearing the upload TTL alone is bookkeeping: image reuse
   * calls this with nothing but the id on every turn, and consumers that
   * fingerprint content by `updatedAt` (Project resume compatibility)
   * would otherwise read a new version and reject an approved turn.
   *
   * @param data - The data to update, must contain file_id
   * @param extraFilter - Optional extra equality filter merged into the query.
   * @returns A promise that resolves to the updated file document, or
   *   null if the conditional filter excluded it (or the file was
   *   deleted).
   */
  async function updateFile(
    data: (Partial<IMongoFile> & { file_id: string }) | CodeFileCommitData,
    extraFilter?: FilterQuery<IMongoFile>,
  ): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const { file_id, ...update } = data;
    const updateOperation = {
      ...fileContentUpdate(update),
      $unset: { expiresAt: '' },
    };
    const query: FilterQuery<IMongoFile> = extraFilter ? { file_id, ...extraFilter } : { file_id };
    return File.findOneAndUpdate(query, updateOperation, {
      new: true,
      timestamps: Object.keys(update).length > 0,
    }).lean<IMongoFile>();
  }

  /** Background outputs commit only while their dispatch still owns the claimed filename. */
  async function commitCodeFile(
    data: CodeFileCommitData,
    sourceDispatchedAt?: number,
  ): Promise<boolean> {
    if (sourceDispatchedAt == null) {
      await createFile(data, true);
      return true;
    }
    const committed = await updateFile(
      data,
      codeFileCommitFilter(data, sourceDispatchedAt) as FilterQuery<IMongoFile>,
    );
    return committed != null;
  }

  /**
   * Records one code-environment route pointer without rewriting the rest of `metadata`.
   * Agents provisioning the same file to different deployments write concurrently, and a
   * whole-object `$set` built from each caller's pre-provisioning snapshot would drop the
   * sibling route that landed in between.
   *
   * @param data - The file, its route key, the pointer to store, and an optional legacy pointer
   * @returns A promise that resolves to the updated file document, or null when absent
   */
  async function updateFileCodeEnvRef(data: {
    file_id: string;
    routeKey: string;
    ref: CodeEnvRef;
    legacyRef?: CodeEnvRef;
  }): Promise<IMongoFile | null> {
    const update = fileCodeEnvRefUpdate(data);
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.findOneAndUpdate(
      { file_id: data.file_id },
      { $set: update, $unset: { expiresAt: '' } },
      { new: true },
    ).lean<IMongoFile>();
  }

  /** Confirms targeted routes are absent after reconciling deleted snapshots. */
  async function clearFileCodeEnvRefs(data: ClearFileCodeEnvRefsParams): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const query = fileOwnerTenantFilter(
      data.file_id,
      data.userId,
      data.tenantId,
    ) as FilterQuery<IMongoFile>;
    const matchesByPath = clearFileCodeEnvRefsMatches(data);
    const results = await Promise.allSettled(
      [...matchesByPath].map(async ([path, matches]) =>
        File.updateOne(
          { ...query, $or: matches },
          { $unset: { [path]: '' }, $set: { 'metadata.codeDestination': true } },
          { timestamps: false },
        ),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
    const stored = await File.findOne(query, {
      _id: 0,
      'metadata.codeEnvRef': 1,
      'metadata.codeEnvRefs': 1,
    }).lean<Pick<IMongoFile, 'metadata'>>();
    if (!stored) {
      return false;
    }
    return codeEnvRefsCleared(data, stored.metadata);
  }

  /** Clears only the embedding snapshot whose vector deletion was confirmed. */
  async function clearFileEmbeddings(data: ClearFileEmbeddingsParams): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const query = clearFileEmbeddingsFilter(data) as FilterQuery<IMongoFile>;
    const result = await File.updateOne(query, clearFileEmbeddingsUpdate(), {
      timestamps: false,
    });
    return result.matchedCount === 1;
  }

  /** Checks the final content/presence snapshot before removing primary storage. */
  async function isFileStorageClean(data: FileStorageCleanupParams): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const filter = fileStorageCleanFilter(data) as FilterQuery<IMongoFile>;
    if ((await File.exists(filter)) != null) return true;
    if (!allowsMissingFileRecord(data)) {
      return false;
    }
    return (
      (await File.exists(
        fileOwnerTenantFilter(data.file_id, data.userId, data.tenantId) as FilterQuery<IMongoFile>,
      )) == null
    );
  }

  /**
   * Records a workspace copy of a user's file and/or the digest of the stored bytes, without
   * rewriting sibling targets another turn wrote in between. A digest is kept even when the
   * copy fails, so a refused file is not hashed again every turn. The target key becomes a
   * dotted path, so only an opaque hex digest is accepted; the owner filter keeps a caller
   * from marking another user's record.
   *
   * @returns Whether a record matched.
   */
  async function recordFileWorkspaceImport(data: WorkspaceImportRecord): Promise<boolean> {
    const update = workspaceImportUpdate(data);
    if (update == null) {
      return false;
    }
    const { file_id, user, tenantId } = data;
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      { file_id, user, tenantId: tenantId ?? null },
      { $set: update },
      /** Bookkeeping, not a content change: project resource versions include `updatedAt`. */
      { timestamps: false },
    );
    return result.matchedCount > 0;
  }

  /**
   * Records that a file has been embedded into one vector namespace, without disturbing
   * the namespaces already recorded. Agents that share a file record, as a duplicate does
   * with its source, each need their own embedding.
   *
   * @param data - The file and the entity whose namespace now holds its vectors
   * @returns A promise that resolves to the updated file document, or null when absent
   */
  async function addFileEmbeddedEntity(data: {
    file_id: string;
    entityId: string;
  }): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.findOneAndUpdate(
      { file_id: data.file_id },
      fileEmbeddedEntityUpdate(data.entityId),
      { new: true },
    ).lean<IMongoFile>();
  }

  /**
   * Records an agent's namespace on embedded files whose vectors the caller has confirmed are
   * in it, keeping any namespaces already recorded. Each record is matched by its owner and
   * tenant as well as its `file_id`, which is not unique on its own.
   *
   * @param data - Verified file records, and the agent whose namespace holds their vectors
   * @returns The file ids that now record the agent's namespace
   */
  async function adoptLegacySearchEmbeddings(data: {
    files: LegacySearchFileRef[];
    agentId: string;
  }): Promise<string[]> {
    if (data.files.length === 0) {
      return [];
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    /* Each write settles on its own, so a committed one is reported even when a sibling
     * fails. */
    const settled = await Promise.allSettled(
      data.files.map((file) =>
        File.findOneAndUpdate(
          legacySearchEmbeddingFilter(file) as FilterQuery<IMongoFile>,
          { $addToSet: { 'metadata.embeddedEntities': data.agentId } },
          { projection: { file_id: 1 } },
        ).lean<Pick<IMongoFile, 'file_id'>>(),
      ),
    );
    const adopted: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error('[adoptLegacySearchEmbeddings] Failed to record a confirmed embedding', {
          file_id: data.files[index].file_id,
          error: (result.reason as Error)?.message,
        });
      } else if (result.value) {
        adopted.push(result.value.file_id);
      }
    });
    return adopted;
  }

  /**
   * Increments the usage of a file identified by file_id.
   * @param data - The data to update, must contain file_id and the increment value for usage
   * @returns A promise that resolves to the updated file document
   */
  async function updateFileUsage(data: {
    file_id: string;
    inc?: number;
    user?: string;
    tenantId?: string | null;
  }): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const { filter, update } = fileUsageUpdate(data);
    /** Usage and temporary-upload cleanup are bookkeeping, not content writes. */
    return File.findOneAndUpdate(filter as FilterQuery<IMongoFile>, update, {
      new: true,
      timestamps: false,
    }).lean<IMongoFile>();
  }

  /**
   * Removes deleted file ids from the owner's Chat Projects so a project never
   * keeps a dangling reference, bumping the revision of every project it changes.
   */
  async function detachFilesFromProjects(files: DetachedFile[]): Promise<void> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument> | undefined;
    if (!ChatProject || files.length === 0) {
      return;
    }
    try {
      await Promise.all(
        projectDetachWrites(files).map(({ filter, update }) =>
          ChatProject.updateMany(filter as FilterQuery<IChatProjectDocument>, update),
        ),
      );
    } catch (error) {
      logger.warn('[detachFilesFromProjects] Failed to detach deleted files from projects', error);
    }
  }

  /** Clears every project file reference of a user whose files were all deleted. */
  async function detachAllUserFilesFromProjects(user: string): Promise<void> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument> | undefined;
    if (!ChatProject) {
      return;
    }
    try {
      const { filter, update } = allProjectFilesDetachWrite(user);
      await ChatProject.updateMany(filter as FilterQuery<IChatProjectDocument>, update);
    } catch (error) {
      logger.warn('[detachAllUserFilesFromProjects] Failed to detach deleted files', error);
    }
  }

  /**
   * Deletes a file identified by file_id.
   * @param file_id - The unique identifier of the file to delete
   * @returns A promise that resolves to the deleted file document or null
   */
  async function deleteFile(file_id: string): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const deleted = await File.findOneAndDelete({ file_id }).lean<IMongoFile>();
    if (deleted) {
      await detachFilesFromProjects([deleted]);
    }
    return deleted;
  }

  /**
   * Deletes a file identified by a filter.
   * @param filter - The filter criteria to apply
   * @returns A promise that resolves to the deleted file document or null
   */
  async function deleteFileByFilter(filter: FilterQuery<IMongoFile>): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const deleted = await File.findOneAndDelete(filter).lean<IMongoFile>();
    if (deleted) {
      await detachFilesFromProjects([deleted]);
    }
    return deleted;
  }

  /**
   * Deletes multiple files identified by an array of file_ids.
   * @param file_ids - The unique identifiers of the files to delete
   * @param user - Optional user ID to filter by
   * @returns A promise that resolves to the result of the deletion operation
   */
  async function deleteFiles(
    file_ids: string[],
    user?: string,
    options?: DeleteFilesOptions,
  ): Promise<DeleteFilesResult> {
    const File = mongoose.models.File as Model<IMongoFile>;
    if (options) {
      if (new Set(file_ids).size === 0) {
        return { deletedCount: 0, deletedFileIds: [], failedFileIds: [] };
      }
      const scopes = fileDeletionScopes(file_ids, options);
      const deleteQuery = { $or: scopes.map(fileStorageCleanupFilter) } as FilterQuery<IMongoFile>;
      const candidates = await File.find(deleteQuery)
        .select({ _id: 1, file_id: 1, user: 1, tenantId: 1 })
        .lean<Pick<IMongoFile, '_id' | 'file_id' | 'user' | 'tenantId'>[]>();
      const result = await File.deleteMany({
        ...deleteQuery,
        _id: { $in: candidates.map((file) => file._id) },
      });
      const remaining = await File.find(
        fileDeletionRemainingFilter(scopes) as FilterQuery<IMongoFile>,
      )
        .select({ file_id: 1 })
        .lean<Pick<IMongoFile, 'file_id'>[]>();
      const remainingIds = new Set(remaining.map((file) => file.file_id));
      const { deletedFileIds, failedFileIds, detached } = fileDeletionOutcome(scopes, remainingIds);
      await detachFilesFromProjects(detached);
      return { deletedCount: result.deletedCount, deletedFileIds, failedFileIds };
    }
    if (user) {
      const result = await File.deleteMany({ user });
      await detachAllUserFilesFromProjects(user);
      return result;
    }
    const deleteQuery: FilterQuery<IMongoFile> = { file_id: { $in: file_ids } };
    const doomed = await File.find(deleteQuery)
      .select({ file_id: 1, user: 1, tenantId: 1 })
      .lean<IMongoFile[]>();
    const result = await File.deleteMany(deleteQuery);
    await detachFilesFromProjects(doomed);
    return result;
  }

  /**
   * Batch updates files with new signed URLs in MongoDB
   * @param updates - Array of updates in the format { file_id, filepath, storageKey?, storageRegion? }
   */
  async function batchUpdateFiles(
    updates: Array<{
      file_id: string;
      filepath: string;
      storageKey?: string;
      storageRegion?: string;
    }>,
  ): Promise<void> {
    if (!updates || updates.length === 0) {
      return;
    }

    const File = mongoose.models.File as Model<IMongoFile>;
    const bulkOperations = updates.map((update) => {
      const { filter, update: write } = batchFileUpdate(update);
      return {
        updateOne: {
          filter: filter as FilterQuery<IMongoFile>,
          update: write,
        },
      };
    });

    const result = await tenantSafeBulkWrite(File, bulkOperations, { timestamps: false });
    logger.info(`Updated ${result.modifiedCount} files with new S3 URLs`);
  }

  /**
   * Updates usage tracking for multiple files.
   * Processes files and optional fileIds, updating their usage count in the database.
   *
   * @param files - Array of file objects to process
   * @param fileIds - Optional array of file IDs to process
   * @returns Array of updated file documents (with null results filtered out)
   */
  async function updateFilesUsage(
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ): Promise<IMongoFile[]> {
    // Preserve the same owner scope for every deduped ID in this batch.
    const user = options?.user;
    const tenantId = options?.tenantId;
    const results = await Promise.all(
      distinctUsageIds(files, fileIds).map((file_id) =>
        updateFileUsage({ file_id, user, tenantId }),
      ),
    );
    return results.filter((result): result is IMongoFile => result != null);
  }

  /**
   * Widens the upload-window TTL of owned, still-temporary files to
   * `min(now + renewMs, createdAt + maxLifetimeMs)`.
   *
   * A renewable hold, not a release: unlike `updateFileUsage` this never
   * unsets `expiresAt`, so a file that is held but never actually sent is
   * still reaped once the hold lapses. Candidates are read first, then each
   * doc gets a guarded write — no aggregation-pipeline update, which Amazon
   * DocumentDB rejects. Four properties hold by construction, which is what
   * makes the write safe to drive from a client-supplied id list:
   * - capping the renewal at `createdAt + maxLifetimeMs` anchors it to an
   *   immutable ceiling, so repeated calls converge on a fixed deadline
   *   instead of walking a file's lifetime forward a window at a time;
   * - renewing from `now` up to that ceiling lets a queue that is still
   *   draining keep its attachments alive across successive runs, while an
   *   abandoned queue lapses a single `renewMs` after its last touch rather
   *   than surviving to the ceiling;
   * - the `expiresAt: { $lt: next }` write guard means a hold only ever
   *   widens, even against renewals landing between the read and the write;
   * - `expiresAt: { $exists: true }` in the read filter and the write guard
   *   means a file whose TTL was already cleared by a real send stays
   *   permanent. Re-adding `expiresAt` there would schedule a live file for
   *   deletion.
   *
   * `createdAt` is required rather than defaulted: without the anchor there
   * is no ceiling to enforce, so such a file is skipped instead of held.
   *
   * The owner scope is required, not optional: an unscoped call would hold
   * every user's matching file. A missing owner is a no-op, not a wide
   * update.
   *
   * @param fileIds - File IDs to hold
   * @param hold - `renewMs` granted from now, capped at `maxLifetimeMs` from upload
   * @param owner - Owner scope; mismatches leave the TTL unchanged
   * @returns Number of files whose hold was widened
   */
  async function extendFilesTTL(
    fileIds: string[],
    hold: { renewMs: number; maxLifetimeMs: number },
    owner: { user: string; tenantId?: string | null },
  ): Promise<number> {
    const filter = fileHoldFilter(fileIds, hold, owner);
    if (filter == null) {
      return 0;
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const renewUntil = Date.now() + hold.renewMs;
    const candidates = await File.find(filter as FilterQuery<IMongoFile>)
      .select({ _id: 1, expiresAt: 1, createdAt: 1 })
      .lean<Pick<IMongoFile, '_id' | 'expiresAt' | 'createdAt'>[]>();
    const holdOps = fileHoldWrites(candidates, hold, renewUntil).map(({ filter, update }) => ({
      updateOne: { filter: filter as FilterQuery<IMongoFile>, update },
    }));
    if (holdOps.length === 0) {
      return 0;
    }
    /** `timestamps: false`: a hold is TTL bookkeeping, not a content write.
     *  Bumping `updatedAt` would also make every re-touch count as a
     *  modification, hiding whether the deadline actually moved. */
    const result = await tenantSafeBulkWrite(File, holdOps, { timestamps: false });
    return result.modifiedCount ?? 0;
  }

  /**
   * Mark stale `status: 'pending'` file records as `'failed'` with
   * `previewError: 'orphaned'`. Recovers from the one case the
   * in-process deferred-preview render can't handle on its own: a
   * backend restart mid-render loses the in-memory promise, leaving
   * the record stuck pending forever.
   *
   * Cheap to run on boot — the `status` field is indexed and the typical
   * cutoff (5 min) bounds the candidate set to whatever was in flight at
   * the prior shutdown. The 60s render timeout means anything older
   * than a few minutes that's still pending is definitively orphaned.
   *
   * @param maxAgeMs - Cutoff in milliseconds; records whose `updatedAt`
   *   is older than `now - maxAgeMs` are marked failed. Defaults to 5
   *   minutes (well above the 60s render ceiling).
   * @returns Number of records updated.
   */
  async function sweepOrphanedPreviews(maxAgeMs: number = 5 * 60 * 1000): Promise<number> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const { cutoff, filter, update } = orphanedPreviewsSweep(maxAgeMs);
    const result = await File.updateMany(filter as FilterQuery<IMongoFile>, update);
    if (result.modifiedCount > 0) {
      logger.info(
        `[sweepOrphanedPreviews] Marked ${result.modifiedCount} stale 'pending' files as 'failed' (cutoff: ${cutoff.toISOString()})`,
      );
    }
    return result.modifiedCount ?? 0;
  }

  return {
    getRunFileCandidates,
    claimRunArtifactFile,
    publishRunArtifactFile,
    findRunArtifactFile,
    listRunArtifacts,
    findFileById,
    getFiles,
    getProjectFiles,
    getAvailableProjectFiles,
    getExpiredFiles,
    incrementFileDeletionAttempts,
    deferExpiredFile,
    getToolFilesByIds,
    getCodeGeneratedFiles,
    getUserCodeFiles,
    getDeferredProvisionFiles,
    claimCodeFile,
    commitCodeFile,
    createFile,
    updateFile,
    updateFileCodeEnvRef,
    clearFileCodeEnvRefs,
    addFileEmbeddedEntity,
    recordFileWorkspaceImport,
    clearFileEmbeddings,
    isFileStorageClean,
    adoptLegacySearchEmbeddings,
    updateFileUsage,
    deleteFile,
    deleteFiles,
    deleteFileByFilter,
    batchUpdateFiles,
    updateFilesUsage,
    extendFilesTTL,
    sweepOrphanedPreviews,
  };
}

export type FileMethods = ReturnType<typeof createFileMethods>;

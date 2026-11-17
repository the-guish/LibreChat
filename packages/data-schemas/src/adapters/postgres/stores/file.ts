/**
 * The PostgreSQL `FileStore` (`~/ports/file`) on the `files` table, through the collection
 * primitive, with the filters, updates and record shapes of `~/methods/fileRules` (the MongoDB
 * methods' own). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - **Typed storage** (§1.4): `metadata` is flattened (its declared children `runFile`,
 *   `codeEnvRef` and the flags are columns; `codeEnvRefs` and `workspaceImports` are `json`), so
 *   the route writes (`metadata.codeEnvRefs.<route>`, `metadata.workspaceImports.targets.<key>`)
 *   are subpath writes into `json` (tier 2, read-modify-write under the row lock, key order
 *   kept); `storageOperations.provisioning` and `metadata.embeddedEntities` are `text[]` (tier
 *   1). Every other write is tier 1 on the parent row.
 * - **Partial uniques**: one code output per filename, conversation and tenant
 *   (`context = 'execute_code'`), one run artifact per identity (`context = 'run_artifact'`);
 *   both are `NULLS NOT DISTINCT`, so the untenanted namespace is one. A duplicate key from the
 *   code-output index is a `FileStorageConflictError` (the claim and the guarded create lost to
 *   a fenced record); a publication that loses the race resolves the record already published.
 * - **Upserts** (`createFile`, `claimCodeFile`, `publishRunArtifactFile`) take the primitive's
 *   §3.4 path: the update first, then the filter's equality seed with the update applied.
 * - Chat project cleanup on deletes writes the `chatprojects` table through the primitive.
 */
import { FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type {
  DetachedFile,
  CodeFileClaim,
  PlainFileDocument,
  RunArtifactDocument,
  ProjectFileRecordSource,
  AvailableProjectFileRecordSource,
} from '~/methods/fileRules';
import type {
  IMongoFile,
  RunArtifactFile,
  RunArtifactScope,
  DeleteFilesResult,
  FileStorageCleanupParams,
} from '~/types/file';
import type { PgCollection, PgFilter, PgProjection, PgRecord, PgSort } from '../collection';
import type { PostgresStoreContext } from './context';
import type { SqlFragment } from '../query/sql';
import type { FileStore } from '~/ports/file';
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
} from '~/methods/fileRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { fileContentUpdate } from '~/methods/fileContent';
import { runStoreSql, storeWhere } from './context';
import { and, or, sql } from '../query/sql';
import logger from '~/config/winston';

/** A file record as the primitive reads it. */
type FileRow = PgRecord & IMongoFile;

/** The record type the port hands out (`IMongoFile`), from a lean record. */
const asFile = (record: PgRecord | null): IMongoFile | null => record as IMongoFile | null;
const asFiles = (records: PgRecord[]): IMongoFile[] => records as unknown as IMongoFile[];

/**
 * The cleanup snapshot's "no code environment reference left by route" condition, MongoDB's
 * `'metadata.codeEnvRefs': { $in: [null, {}] }`: the `json` column missing or null, or an empty
 * object. The translator refuses equality with an object, so it is hand-written.
 */
const NO_CODE_ENV_REFS: SqlFragment = sql`(t."metadata__codeEnvRefs" IS NULL OR t."metadata__codeEnvRefs"::jsonb = '{}'::jsonb)`;

function rethrowCodeFileStorageConflict(error: unknown): never {
  if (error instanceof StoreDuplicateKeyError) {
    throw new FileStorageConflictError();
  }
  throw error;
}

export function createPostgresFileStore(context: PostgresStoreContext): FileStore {
  const files = (): PgCollection<FileRow> => context.collections().collection<FileRow>('files');
  const projects = () => context.collections().collection('chatprojects');

  /**
   * The condition of a cleanup snapshot (`fileStorageCleanupFilter`, or without the deletion
   * claim for `isFileStorageClean`) on `files t`: its other conditions translated as the
   * primitive's (tenant-scoped), and {@link NO_CODE_ENV_REFS}.
   */
  function cleanupWhere(
    scope: FileStorageCleanupParams,
    deletionClaimAllowed: boolean,
    operation: string,
  ) {
    const filter = deletionClaimAllowed
      ? fileStorageCleanFilter(scope)
      : fileStorageCleanupFilter(scope);
    const { 'metadata.codeEnvRefs': codeEnvRefs, ...rest } = filter;
    if (codeEnvRefs === undefined) {
      throw new Error('A file cleanup snapshot must pin the code environment references');
    }
    return and([storeWhere(context, 'files', rest, { operation }), NO_CODE_ENV_REFS]);
  }

  async function findRunArtifactFile(scope: RunArtifactScope): Promise<RunArtifactFile | null> {
    const file = await files().findOne(runArtifactIdentityFilter(scope));
    return file == null
      ? null
      : serializeRunArtifact(file as unknown as RunArtifactDocument, scope);
  }

  async function getFiles(
    filter: PgFilter,
    sortOptions?: PgSort | null,
    selectFields?: PgProjection | null,
    limit?: number | null,
  ): Promise<IMongoFile[]> {
    const sort = { updatedAt: -1, ...sortOptions } as PgSort;
    return asFiles(
      await files().find(filter, {
        projection: selectFields ?? { text: 0 },
        sort,
        ...(limit != null && limit > 0 ? { limit } : {}),
      }),
    );
  }

  /** `getFiles` without `text`, in the order of `sort` after `updatedAt` newest first. */
  const hydrate = (filter: PgFilter, sort: PgSort) => getFiles(filter, sort, { text: 0 });

  async function createFile(
    data: Partial<IMongoFile> | Record<string, unknown>,
    disableTTL?: boolean,
  ): Promise<IMongoFile | null> {
    const fileData = createFileData(data, disableTTL);
    const generatedOutput = (data as { context?: string }).context === FileContext.execute_code;
    try {
      return asFile(
        await files().findOneAndUpdate(
          createFileFilter(data as Parameters<typeof createFileFilter>[0], generatedOutput),
          { ...fileContentUpdate(fileData), $setOnInsert: createFileInsert() },
          { returnDocument: 'after', upsert: true },
        ),
      );
    } catch (error) {
      if (generatedOutput) rethrowCodeFileStorageConflict(error);
      throw error;
    }
  }

  async function updateFile(
    data: { file_id: string } & Record<string, unknown>,
    extraFilter?: PgFilter,
  ): Promise<IMongoFile | null> {
    const { file_id, ...update } = data;
    return asFile(
      await files().findOneAndUpdate(
        extraFilter ? { file_id, ...extraFilter } : { file_id },
        { ...fileContentUpdate(update), $unset: { expiresAt: '' } },
        { returnDocument: 'after', timestamps: Object.keys(update).length > 0 },
      ),
    );
  }

  async function updateFileUsage(data: {
    file_id: string;
    inc?: number;
    user?: string;
    tenantId?: string | null;
  }): Promise<IMongoFile | null> {
    const { filter, update } = fileUsageUpdate(data);
    return asFile(
      await files().findOneAndUpdate(filter, update, {
        returnDocument: 'after',
        timestamps: false,
      }),
    );
  }

  async function detachFilesFromProjects(detached: DetachedFile[]): Promise<void> {
    if (detached.length === 0) {
      return;
    }
    try {
      await Promise.all(
        projectDetachWrites(detached).map(({ filter, update }) =>
          projects().updateMany(filter, update),
        ),
      );
    } catch (error) {
      logger.warn('[detachFilesFromProjects] Failed to detach deleted files from projects', error);
    }
  }

  async function detachAllUserFilesFromProjects(user: string): Promise<void> {
    try {
      const { filter, update } = allProjectFilesDetachWrite(user);
      await projects().updateMany(filter, update);
    } catch (error) {
      logger.warn('[detachAllUserFilesFromProjects] Failed to detach deleted files', error);
    }
  }

  const store: FileStore = {
    async getRunFileCandidates(fileIds, tenantId): Promise<TFile[]> {
      if (fileIds.length === 0) {
        return [];
      }
      const found = await files().find({ file_id: { $in: fileIds }, tenantId: tenantId ?? null });
      return found.map((file) => toRunFileCandidate(file as unknown as PlainFileDocument));
    },

    async claimRunArtifactFile(scope) {
      const file = await findRunArtifactFile(scope);
      return file == null ? { file_id: runArtifactFileId(scope) } : { file_id: file.file_id, file };
    },

    /** Publishes once: a duplicate key from the identity index resolves the stored artifact. */
    async publishRunArtifactFile(input) {
      const { scope } = input;
      const filter = runArtifactIdentityFilter(scope);
      const insert = runArtifactInsert(input);
      try {
        const published = await files().findOneAndUpdate(
          filter,
          { $setOnInsert: insert },
          { upsert: true, returnDocument: 'after', runValidators: true, timestamps: false },
        );
        if (published == null) {
          throw new Error('Run artifact publication did not produce a file');
        }
        return serializeRunArtifact(published as unknown as RunArtifactDocument, scope);
      } catch (error) {
        if (error instanceof StoreDuplicateKeyError) {
          const existing = await findRunArtifactFile(scope);
          if (existing != null) {
            return existing;
          }
        }
        throw error;
      }
    },

    findRunArtifactFile,

    async listRunArtifacts(scope) {
      const found = await files().find(runArtifactFilter(scope), {
        sort: { createdAt: 1, file_id: 1 },
      });
      return found.map((file) => serializeRunArtifact(file as unknown as RunArtifactDocument));
    },

    async findFileById(file_id, options = {}) {
      return asFile(await files().findOne({ file_id, ...options }));
    },

    getFiles: (filter, sortOptions, selectFields, limit) =>
      getFiles(filter, sortOptions, selectFields, limit),

    async getProjectFiles({ fileIds, userId, tenantId, includeContent = false }) {
      const found = await files().find(projectFilesFilter({ fileIds, userId, tenantId }), {
        projection: includeContent ? {} : { ...PROJECT_FILE_SELECT },
      });
      return found.map((file) => normalizeProjectFileRecord(file as ProjectFileRecordSource));
    },

    async getAvailableProjectFiles(options) {
      const { filter, limit } = availableProjectFilesQuery(options, (hex) => hex.toLowerCase());
      const found = (await files().find(filter, {
        projection: { ...AVAILABLE_PROJECT_FILE_SELECT },
        sort: { _id: -1 },
        limit: limit + 1,
      })) as unknown as AvailableProjectFileRecordSource[];
      let nextCursor: string | null = null;
      if (found.length > limit) {
        found.pop();
        const lastFile = found[found.length - 1];
        if (lastFile) {
          nextCursor = lastFile._id.toString();
        }
      }
      return { files: found.map(normalizeAvailableProjectFileRecord), nextCursor };
    },

    async getExpiredFiles(limit = 100, { now = new Date() } = {}) {
      return asFiles(
        await files().find(expiredFilesFilter(now), { sort: { expiredAt: 1 }, limit }),
      );
    },

    /** The count the increment itself produced, so concurrent sweeps get distinct attempts. */
    async incrementFileDeletionAttempts(file_id) {
      const file = await files().findOneAndUpdate(
        { file_id },
        { $inc: { deletionAttempts: 1 } },
        { returnDocument: 'after', projection: { deletionAttempts: 1 }, timestamps: false },
      );
      return file?.deletionAttempts ?? 0;
    },

    async deferExpiredFile(file_id, deletionRetryAt) {
      await files().updateOne({ file_id }, { $max: { deletionRetryAt } }, { timestamps: false });
    },

    async getToolFilesByIds(fileIds, toolResourceSet, ownerScope) {
      if (!fileIds || !fileIds.length || !toolResourceSet?.size) {
        return [];
      }
      try {
        const filter = toolFilesFilter(fileIds, toolResourceSet, ownerScope);
        if (filter == null) {
          return [];
        }
        return await hydrate(filter, { updatedAt: -1 });
      } catch (error) {
        logger.error('[getToolFilesByIds] Error retrieving tool files:', error);
        throw new Error('Error retrieving tool files');
      }
    },

    async getCodeGeneratedFiles(conversationId, threadFileIds, ownerScope) {
      if (!conversationId || !threadFileIds || threadFileIds.length === 0) {
        return [];
      }
      try {
        return await hydrate(codeGeneratedFilesFilter(conversationId, threadFileIds, ownerScope), {
          createdAt: 1,
        });
      } catch (error) {
        logger.error('[getCodeGeneratedFiles] Error retrieving code generated files:', error);
        return [];
      }
    },

    async getUserCodeFiles(fileIds, ownerScope) {
      if (!fileIds || fileIds.length === 0) {
        return [];
      }
      try {
        return await hydrate(userCodeFilesFilter(fileIds, ownerScope), { createdAt: 1 });
      } catch (error) {
        logger.error('[getUserCodeFiles] Error retrieving user code files:', error);
        return [];
      }
    },

    async getDeferredProvisionFiles(fileIds, ownerScope, resources = { code: true, search: true }) {
      if (!fileIds || fileIds.length === 0) {
        return [];
      }
      const filter = deferredProvisionFilesFilter(fileIds, ownerScope, resources);
      if (filter == null) {
        return [];
      }
      try {
        return await hydrate(filter, { createdAt: 1 });
      } catch (error) {
        logger.error('[getDeferredProvisionFiles] Error retrieving deferred files:', error);
        throw error;
      }
    },

    /** Concurrent claims converge: the losing upsert's insert hits the code-output index. */
    async claimCodeFile(data: CodeFileClaim) {
      const { filter, insert } = codeFileClaim(data);
      let result: IMongoFile | null;
      try {
        result = asFile(
          await files().findOneAndUpdate(
            filter,
            { $setOnInsert: insert },
            { upsert: true, returnDocument: 'after', timestamps: false },
          ),
        );
      } catch (error) {
        rethrowCodeFileStorageConflict(error);
      }
      if (!result) {
        throw codeFileClaimFailure(data);
      }
      return result;
    },

    async commitCodeFile(data, sourceDispatchedAt) {
      if (sourceDispatchedAt == null) {
        await createFile(data as Record<string, unknown>, true);
        return true;
      }
      const committed = await updateFile(
        data as { file_id: string } & Record<string, unknown>,
        codeFileCommitFilter(data, sourceDispatchedAt),
      );
      return committed != null;
    },

    createFile: (data, disableTTL) => createFile(data, disableTTL),

    updateFile: (data, extraFilter) =>
      updateFile(data as { file_id: string } & Record<string, unknown>, extraFilter),

    async updateFileCodeEnvRef(data) {
      const update = fileCodeEnvRefUpdate(data);
      return asFile(
        await files().findOneAndUpdate(
          { file_id: data.file_id },
          { $set: update, $unset: { expiresAt: '' } },
          { returnDocument: 'after' },
        ),
      );
    },

    async clearFileCodeEnvRefs(data) {
      const query = fileOwnerTenantFilter(data.file_id, data.userId, data.tenantId);
      const matchesByPath = clearFileCodeEnvRefsMatches(data);
      const results = await Promise.allSettled(
        [...matchesByPath].map(([path, matches]) =>
          files().updateOne(
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
      const stored = await files().findOne(query, {
        projection: { _id: 0, 'metadata.codeEnvRef': 1, 'metadata.codeEnvRefs': 1 },
      });
      if (!stored) {
        return false;
      }
      return codeEnvRefsCleared(data, stored.metadata);
    },

    async addFileEmbeddedEntity(data) {
      return asFile(
        await files().findOneAndUpdate(
          { file_id: data.file_id },
          fileEmbeddedEntityUpdate(data.entityId),
          { returnDocument: 'after' },
        ),
      );
    },

    async recordFileWorkspaceImport(data) {
      const update = workspaceImportUpdate(data);
      if (update == null) {
        return false;
      }
      const { file_id, user, tenantId } = data;
      const result = await files().updateOne(
        { file_id, user, tenantId: tenantId ?? null },
        { $set: update },
        { timestamps: false },
      );
      return result.matchedCount > 0;
    },

    async clearFileEmbeddings(data) {
      const result = await files().updateOne(
        clearFileEmbeddingsFilter(data),
        clearFileEmbeddingsUpdate(),
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },

    async isFileStorageClean(data) {
      const { rows } = await runStoreSql(
        context,
        sql`SELECT 1 AS "found" FROM files t WHERE ${cleanupWhere(data, true, 'exists')} LIMIT 1`,
      );
      if (rows.length > 0) return true;
      if (!allowsMissingFileRecord(data)) {
        return false;
      }
      return (
        (await files().exists(fileOwnerTenantFilter(data.file_id, data.userId, data.tenantId))) ==
        null
      );
    },

    async adoptLegacySearchEmbeddings(data) {
      if (data.files.length === 0) {
        return [];
      }
      const settled = await Promise.allSettled(
        data.files.map((file) =>
          files().findOneAndUpdate(
            legacySearchEmbeddingFilter(file),
            { $addToSet: { 'metadata.embeddedEntities': data.agentId } },
            { returnDocument: 'before', projection: { file_id: 1 } },
          ),
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
    },

    updateFileUsage,

    async updateFilesUsage(fileList, fileIds, options) {
      const user = options?.user;
      const tenantId = options?.tenantId;
      const results = await Promise.all(
        distinctUsageIds(fileList, fileIds).map((file_id) =>
          updateFileUsage({ file_id, user, tenantId }),
        ),
      );
      return results.filter((result): result is IMongoFile => result != null);
    },

    async batchUpdateFiles(updates) {
      if (!updates || updates.length === 0) {
        return;
      }
      const result = await files().bulk(
        updates.map((update) => {
          const { filter, update: write } = batchFileUpdate(update);
          return { updateOne: { filter, update: write } };
        }),
        { timestamps: false },
      );
      logger.info(`Updated ${result.modifiedCount} files with new S3 URLs`);
    },

    /** Reads the candidates, then widens each hold behind a guard that it only moves later. */
    async extendFilesTTL(fileIds, hold, owner) {
      const filter = fileHoldFilter(fileIds, hold, owner);
      if (filter == null) {
        return 0;
      }
      const renewUntil = Date.now() + hold.renewMs;
      const candidates = (await files().find(filter, {
        projection: { _id: 1, expiresAt: 1, createdAt: 1 },
      })) as unknown as Array<{ _id: string; expiresAt?: Date | null; createdAt?: Date | null }>;
      const holdOps = fileHoldWrites(candidates, hold, renewUntil).map(({ filter, update }) => ({
        updateOne: { filter, update },
      }));
      if (holdOps.length === 0) {
        return 0;
      }
      const result = await files().bulk(holdOps, { timestamps: false });
      return result.modifiedCount ?? 0;
    },

    async sweepOrphanedPreviews(maxAgeMs = 5 * 60 * 1000) {
      const { cutoff, filter, update } = orphanedPreviewsSweep(maxAgeMs);
      const result = await files().updateMany(filter, update);
      if (result.modifiedCount > 0) {
        logger.info(
          `[sweepOrphanedPreviews] Marked ${result.modifiedCount} stale 'pending' files as 'failed' (cutoff: ${cutoff.toISOString()})`,
        );
      }
      return result.modifiedCount ?? 0;
    },

    async deleteFile(file_id) {
      const deleted = asFile(await files().findOneAndDelete({ file_id }));
      if (deleted) {
        await detachFilesFromProjects([deleted]);
      }
      return deleted;
    },

    async deleteFileByFilter(filter) {
      const deleted = asFile(await files().findOneAndDelete(filter));
      if (deleted) {
        await detachFilesFromProjects([deleted]);
      }
      return deleted;
    },

    /**
     * With snapshots: the candidates still matching their snapshot are read, then deleted by
     * `_id` while they still match (one statement each), and the scoped records left standing
     * are the ones that were not deleted.
     */
    async deleteFiles(file_ids, user, options): Promise<DeleteFilesResult> {
      if (options) {
        if (new Set(file_ids).size === 0) {
          return { deletedCount: 0, deletedFileIds: [], failedFileIds: [] };
        }
        const scopes = fileDeletionScopes(file_ids, options);
        const result = await runStoreSql(
          context,
          sql`DELETE FROM files t WHERE ${or(scopes.map((scope) => cleanupWhere(scope, false, 'deleteMany')))}`,
        );
        const remaining = await files().find(fileDeletionRemainingFilter(scopes), {
          projection: { file_id: 1 },
        });
        const remainingIds = new Set(remaining.map((file) => file.file_id));
        const { deletedFileIds, failedFileIds, detached } = fileDeletionOutcome(
          scopes,
          remainingIds,
        );
        await detachFilesFromProjects(detached);
        return { deletedCount: result.rowCount, deletedFileIds, failedFileIds };
      }
      if (user) {
        const result = await files().deleteMany({ user });
        await detachAllUserFilesFromProjects(user);
        return result;
      }
      const deleteQuery = { file_id: { $in: file_ids } };
      const doomed = await files().find(deleteQuery, {
        projection: { file_id: 1, user: 1, tenantId: 1 },
      });
      const result = await files().deleteMany(deleteQuery);
      await detachFilesFromProjects(doomed as unknown as DetachedFile[]);
      return result;
    },
  };
  return store;
}

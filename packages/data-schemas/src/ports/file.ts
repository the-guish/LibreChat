/**
 * File store port: the records of stored files (uploads, code outputs, run artifacts, avatars)
 * and the bookkeeping hung on them — usage and upload expiry, code-environment and vector-store
 * provisioning results, workspace copies, the expiry sweep. The storage claims that fence that
 * provisioning are the separate `FileStorageStore`. Nothing here may import `mongoose`.
 * Signatures are copied from `FileMethods` (`~/methods/file`), verbatim but for the criteria,
 * order and projections of `findFileById`, `getFiles`, `updateFile` and `deleteFileByFilter`,
 * which the port states in the store query language (`./query`); `file.spec.ts` fails the
 * typecheck if the MongoDB methods stop satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`). Methods
 *   that take an explicit `tenantId` also match it as given. Without one, the owner-scoped
 *   hydration reads (`getToolFilesByIds`, `getCodeGeneratedFiles`, `getUserCodeFiles`,
 *   `getDeferredProvisionFiles`), `updateFileUsage`, `updateFilesUsage` and `extendFilesTTL`
 *   match the owner's files whatever their tenant; the others then match only records stored
 *   without one.
 * - An owner scope (`FileOwnerScope`, or a `user`/`userId`) limits the method to that user's
 *   files; another user's file reads as absent and is left unchanged. Where the scope is
 *   optional, leaving it out matches every owner. The methods that take a filter
 *   (`findFileById`'s conditions, `getFiles`, `updateFile`'s `extraFilter`,
 *   `deleteFileByFilter`) are scoped by it: without a `user` condition they match every owner.
 * - `file_id` is the caller-facing id; it is unique only together with owner and tenant.
 * - The hydration reads above leave out a file's extracted `text`.
 * - `updatedAt` advances on content writes (`createFile`, `updateFile` with a field to write,
 *   `commitCodeFile`, `updateFileCodeEnvRef`, `addFileEmbeddedEntity`,
 *   `adoptLegacySearchEmbeddings`, `sweepOrphanedPreviews`); the other writes leave it as it
 *   was (a published run artifact carries its publication time).
 * - Deleting a file also removes it from its owner's chat projects.
 *
 * Known leaks kept for now so callers stay unchanged: the records returned are `IMongoFile`,
 * which extends mongoose's `Document` and types `user` as an ObjectId, and `createFile` takes
 * a partial `IMongoFile`.
 */
import type { CodeEnvRef, EToolResources, TFile } from 'librechat-data-provider';
import type {
  IMongoFile,
  FileOwnerScope,
  RunArtifactFile,
  RunArtifactClaim,
  RunArtifactScope,
  DeleteFilesResult,
  ProjectFileRecord,
  CodeFileCommitData,
  DeleteFilesOptions,
  ProjectFilesOptions,
  LegacySearchFileRef,
  RunArtifactRunScope,
  WorkspaceImportRecord,
  ExpiredFileQueryOptions,
  PublishRunArtifactInput,
  FileStorageCleanupParams,
  ClearFileEmbeddingsParams,
  ClearFileCodeEnvRefsParams,
  AvailableProjectFilesResult,
  AvailableProjectFilesOptions,
} from '~/types/file';
import type { StoreFilter, StoreProjection, StoreSort } from './query';
import { listPortMethods } from './common';

export interface FileStore {
  /* --------------------------------------------------------------- run files */

  /**
   * The files with these ids in the tenant, as plain records with string ids, for the caller
   * to authorize; any owner.
   */
  getRunFileCandidates(fileIds: readonly string[], tenantId?: string | null): Promise<TFile[]>;
  /**
   * The id under which the run artifact of this scope is (or will be) published, derived from
   * the scope, with the published record when there is one. Throws for an incomplete scope.
   */
  claimRunArtifactFile(scope: RunArtifactScope): Promise<RunArtifactClaim>;
  /**
   * Publishes a stored file as the run artifact of its scope, once: a retried or concurrent
   * publish resolves the record already published, unchanged. Throws when the provenance does
   * not match the scope or the file is not durably stored.
   */
  publishRunArtifactFile(input: PublishRunArtifactInput): Promise<RunArtifactFile>;
  /**
   * The run artifact published for this scope, or `null`. Throws for an incomplete scope, or
   * when the artifact belongs to another producing agent.
   */
  findRunArtifactFile(scope: RunArtifactScope): Promise<RunArtifactFile | null>;
  /** The run artifacts of the run, oldest first. Throws for an incomplete scope. */
  listRunArtifacts(scope: RunArtifactRunScope): Promise<RunArtifactFile[]>;

  /* --------------------------------------------------------------- reads by criteria */

  /**
   * The first file with this `file_id` that also matches `options` (conditions added to the id
   * match; none by default), any owner unless they name one, or `null`. The whole record,
   * `text` included.
   */
  findFileById(file_id: string, options?: StoreFilter): Promise<IMongoFile | null>;
  /**
   * The files matching `filter`, ordered by `updatedAt` (newest first, unless `sortOptions`
   * gives it a direction) and then by the other keys of `sortOptions`, with the fields
   * `selectFields` selects (every field but `text` without one; `{}` selects the default
   * fields, `text` included), at most `limit` of them (a `limit` of `0` or less, or none, means
   * no limit). Resolves an array; the `null` in the type is never produced by the MongoDB store.
   */
  getFiles(
    filter: StoreFilter,
    sortOptions?: StoreSort | null,
    selectFields?: StoreProjection | null,
    limit?: number | null,
  ): Promise<IMongoFile[] | null>;

  /* --------------------------------------------------------------- project files */

  /**
   * The owner's searchable message attachments (embedded, or meant for search) among
   * `fileIds`, in the given tenant (untenanted without one); the whole record, `text`
   * included, with `includeContent`.
   */
  getProjectFiles(options: ProjectFilesOptions): Promise<ProjectFileRecord[]>;
  /**
   * A page of the owner's unexpired searchable message attachments a project may add, newest
   * first: not among `excludedFileIds`, and with `search` in the filename (any case). `limit`
   * defaults to 20 and must be 1–50 (else a `RangeError`); `cursor` is the previous page's
   * `nextCursor` (anything else throws `InvalidAvailableProjectFilesCursorError`).
   */
  getAvailableProjectFiles(
    options: AvailableProjectFilesOptions,
  ): Promise<AvailableProjectFilesResult>;

  /* --------------------------------------------------------------- expiry sweep */

  /**
   * Up to `limit` (100) files whose `expiredAt` has passed by `options.now` (now) and whose
   * deletion retry time is unset or has passed, earliest expiry first; any owner.
   */
  getExpiredFiles(limit?: number, options?: ExpiredFileQueryOptions): Promise<IMongoFile[]>;
  /** Counts one failed sweep deletion; resolves the new count (0 when the file is absent). */
  incrementFileDeletionAttempts(file_id: string): Promise<number>;
  /** Holds the file back from the sweep until `deletionRetryAt`; a hold only moves later. */
  deferExpiredFile(file_id: string, deletionRetryAt: Date): Promise<void>;

  /* --------------------------------------------------------------- hydration */

  /**
   * The files among `fileIds`, other than code outputs, that serve a requested tool resource:
   * agent context files with extracted text for `context`, embedded files for `file_search`.
   * Most recently updated first; empty when no such resource is requested. Throws on a read
   * failure.
   */
  getToolFilesByIds(
    fileIds: string[],
    toolResourceSet?: Set<EToolResources>,
    ownerScope?: FileOwnerScope,
  ): Promise<IMongoFile[]>;
  /**
   * The conversation's code outputs among `threadFileIds` (the files the current branch
   * references) that carry a code-environment reference or are meant for code, oldest first.
   * Empty without `threadFileIds`, or on a read failure.
   */
  getCodeGeneratedFiles(
    conversationId: string,
    threadFileIds?: string[],
    ownerScope?: FileOwnerScope,
  ): Promise<IMongoFile[]>;
  /**
   * The files among `fileIds`, other than code outputs, that carry a code-environment
   * reference or are meant for code, oldest first. Empty on a read failure.
   */
  getUserCodeFiles(fileIds: string[], ownerScope: FileOwnerScope): Promise<IMongoFile[]>;
  /**
   * The files among `fileIds`, other than code outputs, that still lack a provisioning result
   * the current agent needs, oldest first: with `code`, no code-environment reference usable on
   * `codeRouteKey` (`default`); with `search`, not embedded (or, for agent files, not embedded
   * in one of `searchNamespaces`). With `hydrateProvisioned` and a resource requested, every
   * such file. By default both resources are requested. Throws on a read failure, or for an
   * invalid route key.
   */
  getDeferredProvisionFiles(
    fileIds: string[],
    ownerScope: FileOwnerScope,
    resources?: {
      code?: boolean;
      search?: boolean;
      codeRouteKey?: string;
      searchNamespaces?: string[];
      hydrateProvisioned?: boolean;
    },
  ): Promise<IMongoFile[]>;

  /* --------------------------------------------------------------- code outputs */

  /**
   * The record of the conversation's code output named `filename` in the tenant, inserted
   * under `file_id` for `user` when there is none; concurrent claims converge on one record.
   * Throws `FileStorageConflictError` while a storage operation holds the record.
   */
  claimCodeFile(data: {
    filename: string;
    conversationId: string;
    file_id: string;
    user: string;
    tenantId?: string | null;
    sourceDispatchedAt?: number;
  }): Promise<IMongoFile>;
  /**
   * Stores a code output's record without an upload expiry, as `createFile` does; resolves
   * `true`. With `sourceDispatchedAt`, only
   * while the record is the same owner's, no storage operation holds it and no later dispatch
   * has written it, resolving whether it was stored.
   */
  commitCodeFile(data: CodeFileCommitData, sourceDispatchedAt?: number): Promise<boolean>;

  /* --------------------------------------------------------------- writes */

  /**
   * Creates the record with `data.file_id`, or writes `data` over it, expiring in an hour unless
   * `disableTTL`. A code output is written only for its owner while no storage operation
   * holds it, else `FileStorageConflictError`.
   */
  createFile(data: Partial<IMongoFile>, disableTTL?: boolean): Promise<IMongoFile | null>;
  /**
   * Writes the fields of `data` over the file `data.file_id` (`metadata` key by key, its
   * `embeddedEntities` only added to) and clears its upload expiry, only while the file also
   * matches `extraFilter` (no condition without one). Resolves the updated record, or `null`
   * when no file matched.
   */
  updateFile(
    data: Partial<IMongoFile> & { file_id: string },
    extraFilter?: StoreFilter,
  ): Promise<IMongoFile | null>;
  /**
   * Stores a code-environment reference for one route (and the legacy single reference, when
   * given), keeping the other routes, and clears the upload expiry. `null` when the file is
   * absent; throws for an invalid route key.
   */
  updateFileCodeEnvRef(data: {
    file_id: string;
    routeKey: string;
    ref: CodeEnvRef;
    legacyRef?: CodeEnvRef;
  }): Promise<IMongoFile | null>;
  /**
   * Removes the given routes' references where they still equal the given ones, marking the
   * file as meant for code. Resolves whether none of those routes (any route, with no `refs`)
   * still holds a reference; `false` when the file is absent.
   */
  clearFileCodeEnvRefs(data: ClearFileCodeEnvRefsParams): Promise<boolean>;
  /** Records that the file is embedded in the entity's vector namespace; clears its expiry. */
  addFileEmbeddedEntity(data: { file_id: string; entityId: string }): Promise<IMongoFile | null>;
  /**
   * Records a workspace copy of the file under its key (a hex digest, else a throw), its byte
   * digest, or both, keeping other copies. Resolves whether a record matched.
   */
  recordFileWorkspaceImport(data: WorkspaceImportRecord): Promise<boolean>;
  /**
   * Marks the file as no longer embedded (meant for search instead) while it still matches the
   * embedding snapshot whose vectors were deleted. Resolves whether it matched.
   */
  clearFileEmbeddings(data: ClearFileEmbeddingsParams): Promise<boolean>;
  /**
   * Whether the record still matches the cleanup snapshot with no provisioning result or
   * running provisioning left, so its stored bytes may be removed. With
   * `allowMissingFileRecord`, also `true` for a provider-hosted file that has no record.
   */
  isFileStorageClean(data: FileStorageCleanupParams): Promise<boolean>;
  /**
   * Records the agent's vector namespace on the given embedded agent files (each matched by
   * owner and tenant, untenanted without one). Resolves the ids recorded; one that fails is
   * left out.
   */
  adoptLegacySearchEmbeddings(data: {
    files: LegacySearchFileRef[];
    agentId: string;
  }): Promise<string[]>;
  /**
   * Adds `inc` (1) to the file's usage and clears its upload expiry and temporary id; with
   * `user`, only that owner's file. `null` when no file matched.
   */
  updateFileUsage(data: {
    file_id: string;
    inc?: number;
    user?: string;
    tenantId?: string | null;
  }): Promise<IMongoFile | null>;
  /**
   * {@link FileStore.updateFileUsage} once for each distinct id among `files`, then `fileIds`;
   * resolves the records it updated.
   */
  updateFilesUsage(
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ): Promise<IMongoFile[]>;
  /** Points each file at its new path (and storage key and region, when given). */
  batchUpdateFiles(
    updates: Array<{
      file_id: string;
      filepath: string;
      storageKey?: string;
      storageRegion?: string;
    }>,
  ): Promise<void>;
  /**
   * Moves the upload expiry of the owner's still-expiring files to `now + renewMs`, capped at
   * `maxLifetimeMs` after upload; it never moves earlier, and a file without an expiry keeps
   * none. Resolves how many moved; `0` without an owner.
   */
  extendFilesTTL(
    fileIds: string[],
    hold: { renewMs: number; maxLifetimeMs: number },
    owner: { user: string; tenantId?: string | null },
  ): Promise<number>;
  /**
   * Marks pending previews not updated within `maxAgeMs` (5 minutes) as failed, orphaned by a
   * restart; resolves how many.
   */
  sweepOrphanedPreviews(maxAgeMs?: number): Promise<number>;

  /* --------------------------------------------------------------- deletes */

  /** Deletes the file; resolves the deleted record, or `null`. */
  deleteFile(file_id: string): Promise<IMongoFile | null>;
  /** Deletes the first file matching `filter`; resolves the deleted record, or `null`. */
  deleteFileByFilter(filter: StoreFilter): Promise<IMongoFile | null>;
  /**
   * With `options`, deletes each listed file only while it still matches its snapshot in
   * `options.files` (a listed file without one throws), resolving which were deleted and
   * which were not. Otherwise, with `user`, deletes every file of that user (`file_ids` is
   * then not consulted); else deletes the listed files, any owner.
   */
  deleteFiles(
    file_ids: string[],
    user?: string,
    options?: DeleteFilesOptions,
  ): Promise<DeleteFilesResult>;
}

/** Every method of {@link FileStore}, for adapters and conformance checks. */
export const FILE_STORE_METHODS: ReadonlyArray<keyof FileStore> = listPortMethods<FileStore>({
  getRunFileCandidates: true,
  claimRunArtifactFile: true,
  publishRunArtifactFile: true,
  findRunArtifactFile: true,
  listRunArtifacts: true,
  findFileById: true,
  getFiles: true,
  getProjectFiles: true,
  getAvailableProjectFiles: true,
  getExpiredFiles: true,
  incrementFileDeletionAttempts: true,
  deferExpiredFile: true,
  getToolFilesByIds: true,
  getCodeGeneratedFiles: true,
  getUserCodeFiles: true,
  getDeferredProvisionFiles: true,
  claimCodeFile: true,
  commitCodeFile: true,
  createFile: true,
  updateFile: true,
  updateFileCodeEnvRef: true,
  clearFileCodeEnvRefs: true,
  addFileEmbeddedEntity: true,
  recordFileWorkspaceImport: true,
  clearFileEmbeddings: true,
  isFileStorageClean: true,
  adoptLegacySearchEmbeddings: true,
  updateFileUsage: true,
  updateFilesUsage: true,
  batchUpdateFiles: true,
  extendFilesTTL: true,
  sweepOrphanedPreviews: true,
  deleteFile: true,
  deleteFileByFilter: true,
  deleteFiles: true,
});

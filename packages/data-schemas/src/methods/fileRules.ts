/**
 * The file store's database-neutral rules (`FileStore`, `~/ports/file`), shared by every backend:
 * the MongoDB methods (`./file`) and the PostgreSQL store (`adapters/postgres/stores/file.ts`).
 * The record shapes the project reads hand out, the project file cursor, the storage conflict
 * error, the run artifact identity (filters, derived id, publication checks and insert), and the
 * filters and updates of the reads and guarded writes, in the store query language. Nothing here
 * may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'crypto';
import { EToolResources, FileContext, FileSources, getCodeEnvRefs } from 'librechat-data-provider';
import type {
  TFile,
  CodeEnvRef,
  TFileWorkspaceImport,
  TFileWorkspaceImports,
} from 'librechat-data-provider';
import type {
  IMongoFile,
  FileOwnerScope,
  RunArtifactFile,
  RunArtifactScope,
  DeleteFilesOptions,
  ProjectFileRecord,
  RunArtifactRunScope,
  WorkspaceImportRecord,
  PublishRunArtifactInput,
  FileStorageCleanupParams,
  ClearFileEmbeddingsParams,
  ClearFileCodeEnvRefsParams,
  AvailableProjectFileRecord,
  AvailableProjectFilesOptions,
} from '~/types/file';
import { escapeRegExp } from '~/utils/string';

/** A filter or update in the store query language. */
export type FileQuery = Record<string, unknown>;

export const DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT = 20;
export const MAX_AVAILABLE_PROJECT_FILES_LIMIT = 50;

/** The fields `getAvailableProjectFiles` reads of each file. */
export type AvailableProjectFileRecordSource = Pick<
  IMongoFile,
  | '_id'
  | 'file_id'
  | 'filename'
  | 'filepath'
  | 'object'
  | 'type'
  | 'bytes'
  | 'usage'
  | 'embedded'
  | 'metadata'
  | 'context'
  | 'user'
  | 'tenantId'
>;

export function normalizeAvailableProjectFileRecord(
  file: AvailableProjectFileRecordSource,
): AvailableProjectFileRecord {
  return {
    _id: file._id.toString(),
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    object: file.object,
    type: file.type,
    bytes: file.bytes,
    usage: file.usage,
    ...(file.embedded !== undefined ? { embedded: file.embedded } : {}),
    ...(file.metadata?.searchDestination !== undefined ||
    file.metadata?.routingMimeType !== undefined
      ? {
          metadata: {
            ...(file.metadata.searchDestination !== undefined
              ? { searchDestination: file.metadata.searchDestination }
              : {}),
            ...(file.metadata.routingMimeType !== undefined
              ? { routingMimeType: file.metadata.routingMimeType }
              : {}),
          },
        }
      : {}),
    ...(file.context !== undefined ? { context: file.context } : {}),
    user: file.user.toString(),
    ...(file.tenantId !== undefined ? { tenantId: file.tenantId } : {}),
  };
}

/** The fields `getProjectFiles` reads of each file. */
export type ProjectFileRecordSource = Pick<
  IMongoFile,
  | '_id'
  | 'file_id'
  | 'filename'
  | 'filepath'
  | 'object'
  | 'type'
  | 'bytes'
  | 'usage'
  | 'embedded'
  | 'metadata'
  | 'source'
  | 'storageKey'
  | 'storageRegion'
  | 'context'
  | 'expiredAt'
  | 'user'
  | 'tenantId'
  | 'createdAt'
  | 'updatedAt'
  | 'previewRevision'
  | 'status'
  | 'text'
>;

export function normalizeProjectFileRecord(file: ProjectFileRecordSource): ProjectFileRecord {
  return {
    _id: file._id.toString(),
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    object: file.object,
    type: file.type,
    bytes: file.bytes,
    usage: file.usage,
    ...(file.embedded !== undefined ? { embedded: file.embedded } : {}),
    ...(file.metadata?.searchDestination !== undefined ||
    file.metadata?.routingMimeType !== undefined
      ? {
          metadata: {
            ...(file.metadata.searchDestination !== undefined
              ? { searchDestination: file.metadata.searchDestination }
              : {}),
            ...(file.metadata.routingMimeType !== undefined
              ? { routingMimeType: file.metadata.routingMimeType }
              : {}),
          },
        }
      : {}),
    ...(file.source !== undefined ? { source: file.source } : {}),
    ...(file.storageKey !== undefined ? { storageKey: file.storageKey } : {}),
    ...(file.storageRegion !== undefined ? { storageRegion: file.storageRegion } : {}),
    ...(file.context !== undefined ? { context: file.context } : {}),
    ...(file.expiredAt !== undefined ? { expiredAt: file.expiredAt } : {}),
    user: file.user.toString(),
    ...(file.tenantId !== undefined ? { tenantId: file.tenantId } : {}),
    ...(file.createdAt !== undefined ? { createdAt: file.createdAt } : {}),
    ...(file.updatedAt !== undefined ? { updatedAt: file.updatedAt } : {}),
    ...(file.previewRevision !== undefined ? { previewRevision: file.previewRevision } : {}),
    ...(file.status !== undefined ? { status: file.status } : {}),
    ...(file.text !== undefined ? { text: file.text } : {}),
  };
}

export class InvalidAvailableProjectFilesCursorError extends Error {
  constructor() {
    super('Invalid project file cursor');
    this.name = 'InvalidAvailableProjectFilesCursorError';
  }
}

/** A 24-character id string: hex digits only (what `ObjectId.isValid` accepts at that length). */
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

export function parseAvailableProjectFilesCursor(cursor?: string | null): string | null {
  if (cursor == null || cursor === '') {
    return null;
  }
  if (cursor.length !== 24 || !OBJECT_ID_HEX.test(cursor)) {
    throw new InvalidAvailableProjectFilesCursorError();
  }
  return cursor;
}

export class FileStorageConflictError extends Error {
  readonly code: string = 'FILE_STORAGE_CONFLICT';

  constructor() {
    super('The file has a conflicting storage operation');
    this.name = 'FileStorageConflictError';
  }
}

/** No storage operation holds the record: no deletion pending or running, no provisioning. */
export function codeFileStorageFilter(): FileQuery {
  return {
    'storageOperations.deletionPending': { $ne: true },
    'storageOperations.deleting': { $exists: false },
    'storageOperations.provisioning.0': { $exists: false },
  };
}

export function assertValidCodeEnvironmentRouteKey(routeKey: string): void {
  if (routeKey.length === 0 || routeKey.includes('.') || routeKey.startsWith('$')) {
    throw new Error(`Invalid code environment route key "${routeKey}"`);
  }
}

export function withOwnerScope<T extends FileQuery>(
  filter: T,
  ownerScope?: FileOwnerScope,
): T & FileQuery {
  if (!ownerScope) {
    return filter;
  }

  const scopedFilter: T & FileQuery = {
    ...filter,
    user: ownerScope.userId,
  };
  if (ownerScope.tenantId) {
    (scopedFilter as FileQuery).tenantId = ownerScope.tenantId;
  }
  return scopedFilter;
}

/** Re-provisioned copies keep their parent row and erasure retry anchor. */
export function fileStorageCleanupFilter(data: FileStorageCleanupParams): FileQuery {
  return {
    file_id: data.file_id,
    user: data.userId,
    $and: [{ tenantId: data.tenantId ?? null }],
    updatedAt: data.updatedAt ?? { $exists: false },
    'metadata.codeEnvRef': null,
    'metadata.codeEnvRefs': { $in: [null, {}] },
    'storageOperations.provisioning.0': { $exists: false },
    'storageOperations.deleting': { $exists: false },
    ...(data.source === FileSources.vectordb
      ? {
          embedded: data.embedded ?? { $ne: true },
          'metadata.embeddedEntities': data.embeddedEntities ?? null,
        }
      : { embedded: { $ne: true } }),
  };
}

/** The file, its owner and its tenant (none: untenanted), as the snapshot writes scope them. */
export function fileOwnerTenantFilter(
  file_id: string,
  userId: string,
  tenantId: string | null | undefined,
): FileQuery {
  /* Tenant middleware adds its own predicate; it must not replace the snapshot scope. */
  return { file_id, user: userId, $and: [{ tenantId: tenantId ?? null }] };
}

/** A stored file as a lean read returns it, with its `user` as stored. */
export type PlainFileDocument = Omit<TFile, 'user' | '_id'> & {
  user: IMongoFile['user'];
  _id?: IMongoFile['_id'];
};

/** A stored run artifact as a lean read returns it. */
export type RunArtifactDocument = Omit<RunArtifactFile, 'user' | '_id'> & PlainFileDocument;

/** A stored file as `getRunFileCandidates` hands it out: string ids, `embedded` a boolean. */
export function toRunFileCandidate({ user, _id, ...file }: PlainFileDocument): TFile {
  return {
    ...file,
    user: String(user),
    embedded: file.embedded === true,
    ...(_id == null ? {} : { _id: String(_id) }),
  };
}

export function runArtifactFilter(scope: RunArtifactRunScope): FileQuery {
  const required = [scope.userId, scope.conversationId, scope.runId];
  if (required.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error('A complete run artifact owner scope is required');
  }
  if (scope.tenantId != null && scope.tenantId.trim().length === 0) {
    throw new Error('An empty run artifact tenant is invalid');
  }
  return {
    user: scope.userId,
    tenantId: scope.tenantId ?? null,
    conversationId: scope.conversationId,
    context: FileContext.run_artifact,
    'metadata.runFile.runId': scope.runId,
  };
}

export function runArtifactIdentityFilter(scope: RunArtifactScope): FileQuery {
  const filter = runArtifactFilter(scope);
  if (
    [scope.executionId, scope.agentId, scope.sourceFileId].some(
      (value) => typeof value !== 'string' || value.trim().length === 0,
    )
  ) {
    throw new Error('A complete run artifact execution scope is required');
  }
  return {
    ...filter,
    'metadata.runFile.executionId': scope.executionId,
    'metadata.runFile.agentId': scope.agentId,
    'metadata.runFile.sourceFileId': scope.sourceFileId,
  };
}

/** A versioned, scoped UUID reserves no incomplete file document or downloadable bytes. */
export function runArtifactFileId(scope: RunArtifactScope): string {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'librechat-run-artifact:v1',
        scope.userId,
        scope.tenantId ?? null,
        scope.conversationId,
        scope.runId,
        scope.executionId,
        scope.agentId,
        scope.sourceFileId,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function serializeRunArtifact(
  file: RunArtifactDocument,
  scope?: RunArtifactScope,
): RunArtifactFile {
  if (scope != null && file.metadata.runFile.agentId !== scope.agentId) {
    throw new Error('The run artifact belongs to a different producing agent');
  }
  const { _id, user, ...fields } = file;
  return { ...fields, user: user.toString(), ...(_id == null ? {} : { _id: String(_id) }) };
}

/**
 * The record a run artifact publication inserts, at `now`. Throws when the provenance does not
 * match the scope, or the file is not durably stored.
 */
export function runArtifactInsert({ scope, file, provenance }: PublishRunArtifactInput): FileQuery {
  if (
    provenance.runId !== scope.runId ||
    provenance.executionId !== scope.executionId ||
    provenance.agentId !== scope.agentId ||
    provenance.sourceFileId !== scope.sourceFileId ||
    !Number.isFinite(Date.parse(provenance.publishedAt))
  ) {
    throw new Error('Run artifact provenance does not match its publication scope');
  }
  if (
    !file.filepath ||
    !file.filename ||
    !file.type ||
    file.source === FileSources.execute_code ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0
  ) {
    throw new Error('A durable stored file is required to publish a run artifact');
  }
  const now = new Date();
  return {
    filename: file.filename,
    filepath: file.filepath,
    bytes: file.bytes,
    type: file.type,
    storageKey: file.storageKey,
    storageRegion: file.storageRegion,
    text: file.text,
    textFormat: file.textFormat,
    status: file.status,
    previewError: file.previewError,
    previewRevision: file.previewRevision,
    width: file.width,
    height: file.height,
    messageId: file.messageId,
    expiredAt: file.expiredAt,
    file_id: runArtifactFileId(scope),
    user: scope.userId,
    tenantId: scope.tenantId ?? undefined,
    conversationId: scope.conversationId,
    context: FileContext.run_artifact,
    object: 'file',
    source: file.source ?? FileSources.local,
    embedded: false,
    embeddingOwnersComplete: true,
    embeddingOwnersTrackedAt: new Date(),
    usage: 1,
    llmDeliveryPath: file.llmDeliveryPath ?? 'none',
    metadata: {
      ...file.metadata,
      // The source is a private execution object. Consumers must provision the
      // immutable durable copy, never reuse that potentially mutable source.
      codeEnvRef: undefined,
      codeEnvRefs: undefined,
      embeddedEntities: undefined,
      destinationChosen: false,
      runFile: provenance,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** The tenant a project read is scoped to: the given one, or the untenanted files. */
function projectTenant(tenantId: string | null | undefined): string | null {
  // Mongo's null predicate matches explicit null and legacy missing tenant fields.
  return tenantId != null && tenantId !== '' ? tenantId : null;
}

/** The owner's searchable message attachments among `fileIds` in the project's tenant. */
export function projectFilesFilter(options: {
  fileIds: string[];
  userId: string;
  tenantId?: string | null;
}): FileQuery {
  return {
    file_id: { $in: options.fileIds },
    user: options.userId,
    $or: [{ embedded: true }, { 'metadata.searchDestination': true }],
    context: FileContext.message_attachment,
    tenantId: projectTenant(options.tenantId),
  };
}

/** The fields `getProjectFiles` reads without `includeContent`. */
export const PROJECT_FILE_SELECT = {
  _id: 1,
  file_id: 1,
  filename: 1,
  filepath: 1,
  object: 1,
  type: 1,
  bytes: 1,
  usage: 1,
  embedded: 1,
  'metadata.searchDestination': 1,
  'metadata.routingMimeType': 1,
  source: 1,
  storageKey: 1,
  storageRegion: 1,
  context: 1,
  expiredAt: 1,
  user: 1,
  tenantId: 1,
  createdAt: 1,
  updatedAt: 1,
  previewRevision: 1,
  status: 1,
} as const;

/** The fields `getAvailableProjectFiles` reads. */
export const AVAILABLE_PROJECT_FILE_SELECT = {
  _id: 1,
  file_id: 1,
  filename: 1,
  filepath: 1,
  object: 1,
  type: 1,
  bytes: 1,
  usage: 1,
  embedded: 1,
  'metadata.searchDestination': 1,
  'metadata.routingMimeType': 1,
  context: 1,
  user: 1,
  tenantId: 1,
} as const;

/**
 * The filter of a page of `getAvailableProjectFiles` (`toId` casts the cursor to the backend's
 * id value), and the validated limit. Throws a `RangeError` for a limit outside 1..50 and
 * `InvalidAvailableProjectFilesCursorError` for a malformed cursor.
 */
export function availableProjectFilesQuery(
  {
    userId,
    tenantId,
    excludedFileIds = [],
    limit = DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT,
    cursor,
    search,
    now = new Date(),
  }: AvailableProjectFilesOptions,
  toId: (hex: string) => unknown,
): { filter: FileQuery; limit: number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AVAILABLE_PROJECT_FILES_LIMIT) {
    throw new RangeError('Invalid project file limit');
  }

  const decodedCursor = parseAvailableProjectFilesCursor(cursor);
  const filters: FileQuery[] = [
    {
      user: userId,
      tenantId: projectTenant(tenantId),
      $or: [{ embedded: true }, { 'metadata.searchDestination': true }],
      context: FileContext.message_attachment,
      $and: [{ $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }] }],
    },
  ];
  if (excludedFileIds.length > 0) {
    filters[0].file_id = { $nin: excludedFileIds };
  }
  const normalizedSearch = search?.trim();

  if (normalizedSearch) {
    filters.push({
      filename: { $regex: escapeRegExp(normalizedSearch), $options: 'i' },
    });
  }
  if (decodedCursor) {
    filters.push({ _id: { $lt: toId(decodedCursor) } });
  }
  return { filter: filters.length === 1 ? filters[0] : { $and: filters }, limit };
}

/** The files whose expiry passed by `now` and whose deletion retry time is unset or passed. */
export function expiredFilesFilter(now: Date): FileQuery {
  return {
    expiredAt: { $ne: null, $lte: now },
    $or: [{ deletionRetryAt: null }, { deletionRetryAt: { $lte: now } }],
  };
}

/**
 * The filter of `getToolFilesByIds`: the files among `fileIds`, other than code outputs, that
 * serve a requested resource; `null` when no requested resource is served by files.
 */
export function toolFilesFilter(
  fileIds: string[],
  toolResourceSet: Set<EToolResources>,
  ownerScope?: FileOwnerScope,
): FileQuery | null {
  const orConditions: FileQuery[] = [];

  if (toolResourceSet.has(EToolResources.context)) {
    orConditions.push({ text: { $exists: true, $ne: null }, context: FileContext.agents });
  }
  if (toolResourceSet.has(EToolResources.file_search)) {
    orConditions.push({ embedded: true });
  }

  // If no conditions to match, return empty
  if (orConditions.length === 0) {
    return null;
  }

  return withOwnerScope(
    {
      file_id: { $in: fileIds },
      context: { $ne: FileContext.execute_code },
      $or: orConditions,
    },
    ownerScope,
  );
}

/** A code-environment reference, or a file meant for code. */
const CODE_FILE_CONDITIONS = (): FileQuery[] => [
  { 'metadata.codeEnvRef': { $exists: true } },
  { 'metadata.codeEnvRefs': { $exists: true } },
  { 'metadata.codeDestination': true },
];

/** The filter of `getCodeGeneratedFiles`: the conversation's code outputs among `threadFileIds`. */
export function codeGeneratedFilesFilter(
  conversationId: string,
  threadFileIds: string[],
  ownerScope?: FileOwnerScope,
): FileQuery {
  return withOwnerScope(
    {
      conversationId,
      context: FileContext.execute_code,
      file_id: { $in: threadFileIds },
      $or: CODE_FILE_CONDITIONS(),
    },
    ownerScope,
  );
}

/** The filter of `getUserCodeFiles`: uploads among `fileIds` meant for code. */
export function userCodeFilesFilter(fileIds: string[], ownerScope: FileOwnerScope): FileQuery {
  return withOwnerScope(
    {
      file_id: { $in: fileIds },
      context: { $ne: FileContext.execute_code },
      $or: CODE_FILE_CONDITIONS(),
    },
    ownerScope,
  );
}

/** What `getDeferredProvisionFiles` is asked for. */
export interface DeferredProvisionResources {
  code?: boolean;
  search?: boolean;
  codeRouteKey?: string;
  searchNamespaces?: string[];
  /** Set when no other query hydrates already-provisioned files this turn. */
  hydrateProvisioned?: boolean;
}

/**
 * The filter of `getDeferredProvisionFiles`, or `null` when no requested resource can be
 * missing. Throws for an invalid route key.
 */
export function deferredProvisionFilesFilter(
  fileIds: string[],
  ownerScope: FileOwnerScope,
  resources: DeferredProvisionResources,
): FileQuery | null {
  const missingConditions: FileQuery[] = [];
  /* When no other query hydrates this turn's files, every eligible record has to be
   * loaded, not only the unprovisioned ones: priming adds the provisioned ones to the
   * tool resources, and the code probe screens a default-route session for liveness.
   * Left behind, a file the previous turn provisioned successfully is the one that
   * goes missing, while one that failed is retried. This holds for search as much as
   * for code: an attachment embedded on an earlier turn is hydrated by nothing else,
   * so the next search runs with no reference to it. */
  const hydrateEverything =
    resources.hydrateProvisioned === true && (resources.code === true || resources.search === true);
  if (resources.code && !hydrateEverything) {
    /* A reference for another deployment does not make the file usable here, and with
     * resendFiles off nothing downstream re-reads the record to notice, so eligibility
     * is judged against the route this turn will actually execute on. The legacy
     * pointer counts only when it resolves to that same route, mirroring how
     * mergeCodeEnvRef keys it: executionRouteKey, then executionProfile, then default. */
    const routeKey = resources.codeRouteKey ?? 'default';
    assertValidCodeEnvironmentRouteKey(routeKey);
    const usableForRoute: FileQuery[] = [
      { [`metadata.codeEnvRefs.${routeKey}`]: { $exists: true } },
      { 'metadata.codeEnvRef.executionRouteKey': routeKey },
      {
        'metadata.codeEnvRef': { $exists: true },
        'metadata.codeEnvRef.executionRouteKey': { $exists: false },
        'metadata.codeEnvRef.executionProfile': routeKey,
      },
    ];
    if (routeKey === 'default') {
      usableForRoute.push({
        'metadata.codeEnvRef': { $exists: true },
        'metadata.codeEnvRef.executionRouteKey': { $exists: false },
        'metadata.codeEnvRef.executionProfile': { $in: [null, 'default'] },
      });
    }
    missingConditions.push({ $nor: usableForRoute });
  }
  if (resources.search && !hydrateEverything) {
    /* The record-wide flag only says the file was embedded somewhere, so for a record
     * whose vectors live in an agent namespace it cannot answer whether the namespace
     * this turn searches has them. Membership is not known here, so a record missing
     * from any candidate namespace is loaded and judged later, where it is. */
    const namespaces = resources.searchNamespaces ?? [];
    if (namespaces.length === 0) {
      missingConditions.push({ embedded: { $ne: true } });
    } else {
      missingConditions.push({
        $or: [
          { context: { $ne: FileContext.agents }, embedded: { $ne: true } },
          ...namespaces.map((namespace) => ({
            context: FileContext.agents,
            'metadata.embeddedEntities': { $ne: namespace },
          })),
        ],
      });
    }
  }
  if (!hydrateEverything && missingConditions.length === 0) {
    return null;
  }

  return withOwnerScope(
    {
      file_id: { $in: fileIds },
      context: { $ne: FileContext.execute_code },
      ...(hydrateEverything ? {} : { $or: missingConditions }),
    },
    ownerScope,
  );
}

/** What `claimCodeFile` is given. */
export interface CodeFileClaim {
  filename: string;
  conversationId: string;
  file_id: string;
  user: string;
  tenantId?: string | null;
  sourceDispatchedAt?: number;
}

/** The filter and the `$setOnInsert` of a code-output claim. */
export function codeFileClaim(data: CodeFileClaim): { filter: FileQuery; insert: FileQuery } {
  const tenantFilter = data.tenantId ? { tenantId: data.tenantId } : { tenantId: null };
  const insert = {
    embeddingOwnersComplete: true,
    embeddingOwnersTrackedAt: new Date(),
    file_id: data.file_id,
    user: data.user,
    ...(data.tenantId ? { tenantId: data.tenantId } : {}),
    ...(data.sourceDispatchedAt != null
      ? { metadata: { sourceDispatchedAt: data.sourceDispatchedAt } }
      : {}),
  };
  return {
    filter: {
      filename: data.filename,
      conversationId: data.conversationId,
      context: FileContext.execute_code,
      ...tenantFilter,
      ...codeFileStorageFilter(),
    },
    insert,
  };
}

/** The error of a failed claim upsert. */
export function codeFileClaimFailure(data: CodeFileClaim): Error {
  return new Error(
    `[claimCodeFile] Failed to claim file "${data.filename}" for conversation ${data.conversationId}`,
  );
}

/** The data `createFile` writes: `data`, expiring in an hour unless `disableTTL`. */
export function createFileData<T extends object>(
  data: T,
  disableTTL?: boolean,
): T & { expiresAt?: Date } {
  const fileData: T & { expiresAt?: Date } = {
    ...data,
    expiresAt: new Date(Date.now() + 3600 * 1000),
  };

  if (disableTTL) {
    delete fileData.expiresAt;
  }
  return fileData;
}

/**
 * The filter of `createFile`: the id, and for a code output (`generatedOutput`) the owner's
 * record no storage operation holds.
 */
export function createFileFilter(
  data: { file_id?: string; user?: unknown; tenantId?: string | null },
  generatedOutput: boolean,
): FileQuery {
  return {
    file_id: data.file_id,
    ...(generatedOutput
      ? {
          ...codeFileStorageFilter(),
          user: data.user,
          tenantId: data.tenantId ?? null,
        }
      : {}),
  };
}

/** The `$setOnInsert` of `createFile`'s upsert. */
export function createFileInsert(): FileQuery {
  return { embeddingOwnersComplete: true, embeddingOwnersTrackedAt: new Date() };
}

/** The guard of a dispatch-stamped `commitCodeFile`: the owner's unfenced, not newer record. */
export function codeFileCommitFilter(
  data: { user: unknown; tenantId?: string | null },
  sourceDispatchedAt: number,
): FileQuery {
  return {
    ...codeFileStorageFilter(),
    user: data.user,
    tenantId: data.tenantId ?? null,
    $or: [
      { 'metadata.sourceDispatchedAt': { $exists: false } },
      { 'metadata.sourceDispatchedAt': { $lte: sourceDispatchedAt } },
    ],
  };
}

/** The `$set` of `updateFileCodeEnvRef`. Throws for an invalid route key. */
export function fileCodeEnvRefUpdate(data: {
  routeKey: string;
  ref: CodeEnvRef;
  legacyRef?: CodeEnvRef;
}): Record<string, CodeEnvRef> {
  const { routeKey, ref, legacyRef } = data;
  /* Route keys become dotted update paths, so a key carrying `.` or a leading `$` would
   * write somewhere other than the intended entry. They come from server config, which
   * makes a malformed one a configuration error worth surfacing. */
  assertValidCodeEnvironmentRouteKey(routeKey);
  const update: Record<string, CodeEnvRef> = {
    [`metadata.codeEnvRefs.${routeKey}`]: ref,
  };
  if (legacyRef) {
    update['metadata.codeEnvRef'] = legacyRef;
  }
  return update;
}

/**
 * The guarded writes of `clearFileCodeEnvRefs`: per reference path, the conditions under which
 * the stored reference still equals one of the given ones, field by field. Throws for an
 * invalid route key.
 */
export function clearFileCodeEnvRefsMatches(
  data: ClearFileCodeEnvRefsParams,
): Map<string, FileQuery[]> {
  /* Compare contract fields individually: BSON object equality depends on field order. */
  const matchesRef = (path: string, ref: CodeEnvRef): FileQuery => {
    const fields = {
      kind: ref.kind,
      id: ref.id,
      storage_session_id: ref.storage_session_id,
      file_id: ref.file_id,
      executionProfile: ref.executionProfile,
      executionRouteKey: ref.executionRouteKey,
      provisionedAt: ref.provisionedAt,
      sandboxFilename: ref.sandboxFilename,
      version: 'version' in ref ? ref.version : undefined,
    };
    const match: FileQuery = {};
    for (const [field, value] of Object.entries(fields)) {
      match[`${path}.${field}`] =
        value === undefined ? { $exists: false } : { $eq: value, $exists: true };
    }
    return match;
  };
  const matchesByPath = new Map<string, FileQuery[]>();
  const addMatch = (path: string, ref: CodeEnvRef): void => {
    const matches = matchesByPath.get(path) ?? [];
    matches.push(matchesRef(path, ref));
    matchesByPath.set(path, matches);
  };
  for (const { routeKey, ref } of data.refs) {
    assertValidCodeEnvironmentRouteKey(routeKey);
    addMatch(`metadata.codeEnvRefs.${routeKey}`, ref);
    if ((ref.executionRouteKey ?? ref.executionProfile ?? 'default') === routeKey) {
      addMatch('metadata.codeEnvRef', ref);
    }
  }
  return matchesByPath;
}

/** Whether none of the given routes (any route, with no `refs`) still holds a reference. */
export function codeEnvRefsCleared(
  data: ClearFileCodeEnvRefsParams,
  metadata: IMongoFile['metadata'],
): boolean {
  const remaining = getCodeEnvRefs(metadata);
  if (data.refs.length === 0) {
    return remaining.length === 0;
  }
  const routes = new Set(data.refs.map(({ routeKey }) => routeKey));
  return !remaining.some(([routeKey]) => routes.has(routeKey));
}

/** The filter of `clearFileEmbeddings`: the record still matching the deleted snapshot. */
export function clearFileEmbeddingsFilter(data: ClearFileEmbeddingsParams): FileQuery {
  const start = data.ownershipTrackingStart == null ? NaN : Date.parse(data.ownershipTrackingStart);
  const now = new Date();
  const ownership =
    Number.isFinite(start) && start <= now.getTime()
      ? [
          {
            embedded: true,
            embeddingOwnersComplete: true,
            embeddingOwnersTrackedAt: { $gte: new Date(start), $lte: now },
            'metadata.embeddedEntities': data.embeddedEntities ?? null,
          },
        ]
      : [];
  return {
    file_id: data.file_id,
    user: data.userId,
    $and: [{ tenantId: data.tenantId ?? null }],
    updatedAt: data.updatedAt ?? { $exists: false },
    $or: [...ownership, { embedded: false, 'metadata.embeddedEntities': { $exists: false } }],
  };
}

/** The update of `clearFileEmbeddings`. */
export function clearFileEmbeddingsUpdate(): FileQuery {
  return {
    $set: { embedded: false, 'metadata.searchDestination': true },
    $unset: { 'metadata.embeddedEntities': '' },
  };
}

/** The filter of `isFileStorageClean`'s first check: the snapshot, deletion claims allowed. */
export function fileStorageCleanFilter(data: FileStorageCleanupParams): FileQuery {
  const filter = fileStorageCleanupFilter(data);
  delete filter['storageOperations.deleting'];
  return filter;
}

/** Whether `isFileStorageClean` may accept a missing record for this file. */
export function allowsMissingFileRecord(data: FileStorageCleanupParams): boolean {
  return (
    data.allowMissingFileRecord === true &&
    (data.source === FileSources.openai || data.source === FileSources.azure)
  );
}

/**
 * The `$set` of `recordFileWorkspaceImport`, or `null` when there is nothing to record. Throws
 * for a copy key that is not a hex digest.
 */
export function workspaceImportUpdate({
  copy,
  digest,
}: WorkspaceImportRecord): Record<
  string,
  TFileWorkspaceImport | NonNullable<TFileWorkspaceImports['digest']>
> | null {
  if (copy != null && !/^[a-f0-9]{32,64}$/.test(copy.key)) {
    throw new Error('Workspace import keys must be hex digests');
  }
  const update: Record<
    string,
    TFileWorkspaceImport | NonNullable<TFileWorkspaceImports['digest']>
  > = {};
  if (copy != null) {
    update[`metadata.workspaceImports.targets.${copy.key}`] = copy.target;
  }
  if (digest != null) {
    update['metadata.workspaceImports.digest'] = digest;
  }
  return Object.keys(update).length === 0 ? null : update;
}

/** The update of `addFileEmbeddedEntity`. */
export function fileEmbeddedEntityUpdate(entityId: string): FileQuery {
  return {
    $set: { embedded: true },
    $addToSet: { 'metadata.embeddedEntities': entityId },
    $unset: { expiresAt: '' },
  };
}

/** The filter of one `adoptLegacySearchEmbeddings` write: the owner's embedded agent file. */
export function legacySearchEmbeddingFilter(file: {
  file_id: string;
  user: unknown;
  tenantId?: string | null;
}): FileQuery {
  /* An untenanted record is matched as untenanted: omitting the predicate would let a
   * same-id record under a tenant match instead. */
  return {
    file_id: file.file_id,
    user: file.user,
    tenantId: file.tenantId ?? null,
    context: FileContext.agents,
    embedded: true,
  };
}

/** The filter and update of `updateFileUsage`. */
export function fileUsageUpdate(data: {
  file_id: string;
  inc?: number;
  user?: string;
  tenantId?: string | null;
}): { filter: FileQuery; update: FileQuery } {
  const { file_id, inc = 1, user, tenantId } = data;
  // Owner scoping is fail-closed: mismatches leave usage and TTL metadata unchanged.
  return {
    filter: user ? withOwnerScope({ file_id }, { userId: user, tenantId }) : { file_id },
    update: {
      $inc: { usage: inc },
      $unset: { expiresAt: '', temp_file_id: '' },
    },
  };
}

/** The distinct ids `updateFilesUsage` updates, in order: those of `files`, then `fileIds`. */
export function distinctUsageIds(files: Array<{ file_id: string }>, fileIds?: string[]): string[] {
  const seen = new Set<string>();
  for (const { file_id } of files) {
    seen.add(file_id);
  }
  for (const file_id of fileIds ?? []) {
    seen.add(file_id);
  }
  return [...seen];
}

/** A deleted file's owner scope, for detaching it from its owner's chat projects. */
export interface DetachedFile {
  file_id: string;
  user: { toString(): string };
  tenantId?: string | null;
}

/** The chat project writes detaching deleted files: per owner and tenant, filter and update. */
export function projectDetachWrites(
  files: DetachedFile[],
): Array<{ filter: FileQuery; update: FileQuery }> {
  const idsByScope = new Map<
    string,
    { user: string; tenantId: string | null; fileIds: string[] }
  >();
  for (const file of files) {
    const user = file.user.toString();
    const tenantId = file.tenantId ?? null;
    const key = JSON.stringify([user, tenantId]);
    const scope = idsByScope.get(key);
    if (scope) {
      scope.fileIds.push(file.file_id);
    } else {
      idsByScope.set(key, { user, tenantId, fileIds: [file.file_id] });
    }
  }
  return [...idsByScope.values()].map(({ user, tenantId, fileIds }) => ({
    filter: { user, $and: [{ tenantId }], file_ids: { $in: fileIds } },
    update: { $pull: { file_ids: { $in: fileIds } }, $inc: { contextRevision: 1 } },
  }));
}

/** The chat project write clearing every file reference of a user whose files all went. */
export function allProjectFilesDetachWrite(user: string): { filter: FileQuery; update: FileQuery } {
  return {
    filter: { user, 'file_ids.0': { $exists: true } },
    update: { $set: { file_ids: [] }, $inc: { contextRevision: 1 } },
  };
}

/** One file of a snapshot-guarded `deleteFiles`, with the scope its deletion is checked against. */
export type FileDeletionScope = FileStorageCleanupParams & { userId: string };

/** The snapshot scopes of a guarded `deleteFiles`; throws for a listed file without one. */
export function fileDeletionScopes(
  file_ids: string[],
  options: DeleteFilesOptions,
): FileDeletionScope[] {
  const ids = new Set(file_ids);
  const snapshots = new Map(options.files.map((file) => [file.file_id, file]));
  return [...ids].map((id) => {
    const file = snapshots.get(id);
    if (!file) throw new Error('Missing file deletion snapshot');
    return {
      file_id: id,
      userId: file.user?.toString() ?? options.userId,
      tenantId: file.tenantId,
      updatedAt: file.updatedAt,
      source: file.source,
      embedded: file.embedded,
      embeddedEntities: file.metadata?.embeddedEntities,
    };
  });
}

/** The filter of the records still standing after a guarded delete, one per scope. */
export function fileDeletionRemainingFilter(scopes: FileDeletionScope[]): FileQuery {
  return {
    $or: scopes.map((scope) => ({
      file_id: scope.file_id,
      user: scope.userId,
      $and: [{ tenantId: scope.tenantId ?? null }],
    })),
  };
}

/** The outcome of a guarded delete, given which scoped records still stand. */
export function fileDeletionOutcome(
  scopes: FileDeletionScope[],
  remainingIds: Set<string>,
): { deletedFileIds: string[]; failedFileIds: string[]; detached: DetachedFile[] } {
  const deletedFileIds: string[] = [];
  const failedFileIds: string[] = [];
  const detached: DetachedFile[] = [];
  for (const scope of scopes) {
    if (remainingIds.has(scope.file_id)) {
      failedFileIds.push(scope.file_id);
    } else {
      deletedFileIds.push(scope.file_id);
      detached.push({ file_id: scope.file_id, user: scope.userId, tenantId: scope.tenantId });
    }
  }
  return { deletedFileIds, failedFileIds, detached };
}

/** One write of `batchUpdateFiles`. */
export function batchFileUpdate(update: {
  file_id: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
}): { filter: FileQuery; update: FileQuery } {
  return {
    filter: { file_id: update.file_id },
    update: {
      $set: {
        filepath: update.filepath,
        ...(update.storageKey ? { storageKey: update.storageKey } : {}),
        ...(update.storageRegion ? { storageRegion: update.storageRegion } : {}),
      },
    },
  };
}

/** The candidates `extendFilesTTL` reads, or `null` when the call is a no-op. */
export function fileHoldFilter(
  fileIds: string[],
  hold: { renewMs: number; maxLifetimeMs: number },
  owner: { user: string; tenantId?: string | null },
): FileQuery | null {
  const renewMs = hold?.renewMs;
  const maxLifetimeMs = hold?.maxLifetimeMs;
  if (fileIds.length === 0 || !owner?.user || !(renewMs > 0) || !(maxLifetimeMs > 0)) {
    return null;
  }
  return withOwnerScope(
    {
      file_id: { $in: [...new Set(fileIds)] },
      expiresAt: { $exists: true },
      createdAt: { $exists: true },
    },
    { userId: owner.user, tenantId: owner.tenantId },
  );
}

/**
 * The guarded writes of `extendFilesTTL` for the candidates read: each file whose expiry is
 * still before `min(now + renewMs, createdAt + maxLifetimeMs)` moves to it, only while it is.
 */
export function fileHoldWrites<Id>(
  candidates: Array<{ _id: Id; expiresAt?: Date | null; createdAt?: Date | null }>,
  hold: { renewMs: number; maxLifetimeMs: number },
  renewUntil: number,
): Array<{ filter: FileQuery; update: FileQuery }> {
  return candidates.flatMap((file) => {
    if (!file.createdAt || !file.expiresAt) {
      return [];
    }
    const next = new Date(Math.min(renewUntil, file.createdAt.getTime() + hold.maxLifetimeMs));
    if (file.expiresAt.getTime() >= next.getTime()) {
      return [];
    }
    return [
      {
        filter: { _id: file._id, expiresAt: { $exists: true, $lt: next } },
        update: { $set: { expiresAt: next } },
      },
    ];
  });
}

/** The filter and update of `sweepOrphanedPreviews`, with the cutoff it used. */
export function orphanedPreviewsSweep(maxAgeMs: number): {
  cutoff: Date;
  filter: FileQuery;
  update: FileQuery;
} {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return {
    cutoff,
    filter: { status: 'pending', updatedAt: { $lt: cutoff } },
    update: { $set: { status: 'failed', previewError: 'orphaned' } },
  };
}

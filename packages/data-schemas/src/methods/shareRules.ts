/**
 * The database-neutral rules of the shared link store, shared by the MongoDB methods (`./share`)
 * and the PostgreSQL store: the coded `ShareServiceError`, the anonymized public view (message,
 * file and content sanitization, the share-scoped file route), the branch selection (the level of
 * a target, the walk of a stored target to its branch's tail), the file snapshot built from the
 * owner's streamable files and its delivery-path enrichment, the keyset cursor of the owner list,
 * and the five composite methods (`getSharedMessages`, `getSharedLinks`, `createSharedLink`,
 * `updateSharedLink`, `backfillSharedLinkFiles`) written once on the storage steps each backend
 * supplies ({@link ShareStorageSteps}). Nothing here may import `mongoose` or touch a model.
 */
import { nanoid } from 'nanoid';
import {
  Tools,
  Constants,
  ContentTypes,
  FileSources,
  isConfiguredSender,
} from 'librechat-data-provider';
import type { SharedLinkContentPreflight, GetSharedMessagesOptions } from '~/types/share';
import type * as t from '~/types';
import {
  sanitizeUIResourceContent,
  stripMessageUIResourceMarkers,
} from '~/utils/stripUIResourceMarkers';
import { activeExpirationFilter } from '~/utils/retention';
import { isValidObjectIdString } from '~/utils/objectId';
import logger from '~/config/winston';

/** A filter, an update or a sort in the query language both backends speak. */
type Query = Record<string, unknown>;

export class ShareServiceError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ShareServiceError';
    this.code = code;
  }
}

const EXPECTED_SHARE_REJECTION_CODES = new Set(['TARGET_MESSAGE_NOT_FOUND', 'NO_MESSAGES']);

/** What orders racing creates: the creation time, then the record id. */
export type ShareOrder = Pick<t.ISharedLink, 'createdAt'> & { _id?: unknown };

const isEarlierShare = (candidate: ShareOrder, subject: ShareOrder): boolean => {
  const candidateTime = candidate.createdAt?.getTime() ?? 0;
  const subjectTime = subject.createdAt?.getTime() ?? 0;
  if (candidateTime !== subjectTime) {
    return candidateTime < subjectTime;
  }
  return String(candidate._id) < String(subject._id);
};

function memoizedAnonymizeId(prefix: string) {
  const memo = new Map<string, string>();
  return (id: string) => {
    if (!memo.has(id)) {
      memo.set(id, `${prefix}_${nanoid()}`);
    }
    return memo.get(id) as string;
  };
}

/**
 * Storage- and identity-internal fields that must never be exposed through a
 * public shared link. Everything else on a file/attachment — including the
 * `filepath`/`preview` render URLs, dimensions, and tool-call payloads such as
 * `toolCallId` and search results — is render data the shared view needs, so it
 * is preserved. (`storageKey` is the raw object key and is dropped; `filepath`
 * is the URL the share renderer actually loads, so it is kept.)
 */
const SENSITIVE_SHARED_FILE_FIELDS = new Set([
  '_id',
  '__v',
  'user',
  'tenantId',
  'storageRegion',
  'storageKey',
  'temp_file_id',
  'message',
  'source',
  'filterSource',
  'context',
  'embedded',
  'usage',
  'metadata',
]);

/**
 * Strip storage/identity-internal fields from a file or attachment while keeping
 * render-relevant data (including tool-call payloads keyed by tool name).
 */
function sanitizeSharedFile(value: unknown): t.SharedFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const result: t.SharedFile = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (!SENSITIVE_SHARED_FILE_FIELDS.has(key)) {
      result[key] = fieldValue;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function sanitizeSharedFiles(files: unknown): t.SharedFile[] | undefined {
  if (!Array.isArray(files)) {
    return undefined;
  }

  const sanitized = files
    .map(sanitizeSharedFile)
    .filter((file): file is t.SharedFile => file != null);

  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeSharedAttachments(attachments: unknown): t.SharedFile[] | undefined {
  const sanitized = sanitizeSharedFiles(attachments)?.filter(
    (attachment) => attachment.type !== Tools.ui_resources,
  );
  return sanitized && sanitized.length > 0 ? sanitized : undefined;
}

/**
 * Sources backed by a durable stored object that the share-scoped routes can
 * stream with only `storageKey`/`filepath` + the request. Sources requiring
 * owner-specific credentials (openai/azure assistants, execute_code, vectordb,
 * OCR/parser pipelines) are skipped — those files degrade to a 404 in the share
 * view. Text-source files are eligible because the share route serves their
 * database-backed extracted text instead of the deleted Multer temp path.
 */
const SNAPSHOT_STREAMABLE_SOURCES = new Set<string>([
  FileSources.local,
  FileSources.s3,
  FileSources.cloudfront,
  FileSources.azure_blob,
  FileSources.firebase,
  FileSources.text,
]);

function isLlmDeliveryPath(
  value: unknown,
): value is NonNullable<t.SharedFileSnapshot['llmDeliveryPath']> {
  return value === 'provider' || value === 'text' || value === 'none';
}

/** Collect `file_id`s from a message's `files`/`attachments` array into `target`. */
function collectFileIds(items: unknown, target: Set<string>): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (item && typeof item === 'object') {
      const fileId = (item as { file_id?: unknown }).file_id;
      if (typeof fileId === 'string' && fileId) {
        target.add(fileId);
      }
    }
  }
}

type SteerLikePart = { type?: unknown; files?: unknown };

function isSteerPartWithFiles(part: unknown): part is SteerLikePart {
  return (
    part != null &&
    typeof part === 'object' &&
    (part as SteerLikePart).type === ContentTypes.STEER &&
    (part as SteerLikePart).files !== undefined
  );
}

/** Collect `file_id`s carried by steer parts inside a message's content array. */
function collectSteerFileIds(content: unknown, target: Set<string>): void {
  if (!Array.isArray(content)) {
    return;
  }
  for (const part of content) {
    if (isSteerPartWithFiles(part)) {
      collectFileIds(part.files, target);
    }
  }
}

/** A file record with the fields a snapshot takes from it. */
export interface ShareFileRecord {
  file_id: string;
  source?: string;
  storageKey?: string;
  filepath?: string;
  type?: string;
  filename?: string;
  bytes?: number;
  width?: number;
  height?: number;
  model?: string;
  llmDeliveryPath?: unknown;
  previewRevision?: string;
  metadata?: { sourceDispatchedAt?: number };
  tenantId?: string;
}

/** The fields of a file record a snapshot reads, as a projection both backends speak. */
export const SHARE_FILE_SNAPSHOT_FIELDS =
  'file_id source storageKey filepath type filename bytes width height model llmDeliveryPath previewRevision metadata.sourceDispatchedAt tenantId';

/**
 * The storage the composite shared link methods run on. Each backend supplies these steps with
 * its own reads and writes; the rules above decide what to read, what to show and what to write.
 * Every step is scoped to the tenant of the current context, as the store is.
 */
export interface ShareStorageSteps {
  /** The owner's files among `fileIds`, with {@link SHARE_FILE_SNAPSHOT_FIELDS}. */
  readOwnerFiles(fileIds: string[], ownerId: string): Promise<ShareFileRecord[]>;
  /**
   * The active link with the record id `shareObjectId` when given, otherwise with the share id,
   * without `__v`, its messages read by reference (in the link's order, missing ones dropped)
   * with the fields of the client message projection plus the private text tokens.
   */
  readViewedShare(
    shareId: string,
    shareObjectId?: string,
  ): Promise<(t.ISharedLink & { messages: t.IMessage[] }) | null>;
  /** The active link with the share id, its messages read by reference without `_id`, `__v`, `user`. */
  readBackfillShare(shareId: string): Promise<(t.ISharedLink & { messages: t.IMessage[] }) | null>;
  /**
   * Stores `fileSnapshots` on the link matching `key` while it has none and has not opted out
   * (`snapshotFiles` not `false`), leaving `updatedAt` as it is; whether it wrote.
   */
  writeSnapshotsIfAbsent(
    key: ShareSnapshotKey,
    fileSnapshots: t.SharedFileSnapshot[],
  ): Promise<boolean>;
  /** The snapshot state of the link matching `key`. */
  readSnapshotState(
    key: ShareSnapshotKey,
  ): Promise<Pick<t.ISharedLink, 'fileSnapshots' | 'snapshotFiles'> | null>;
  /**
   * Replaces the link's snapshot with `fileSnapshots` while it still equals `expected` and the
   * link has not opted out, leaving `updatedAt` as it is.
   */
  writeEnrichedSnapshots(
    id: unknown,
    expected: t.SharedFileSnapshot[],
    fileSnapshots: t.SharedFileSnapshot[],
  ): Promise<void>;
  /** The user's active link for the conversation (and target, when given), or `null`. */
  findActiveShare(key: ShareKey): Promise<unknown>;
  /** The user's messages of the conversation, private text tokens included, oldest first. */
  readConversationMessages(conversationId: string, user: string): Promise<t.IMessage[]>;
  /** The user's conversation, or `null`. */
  readConversation(conversationId: string, user: string): Promise<{ title?: string } | null>;
  /** Inserts a new link and resolves its record id and creation time. */
  insertShare(link: ShareInsert): Promise<ShareOrder & { _id: unknown }>;
  /** The record ids and creation times of the user's other active links for the key. */
  listActiveRivals(key: ShareKey, excludeId: unknown): Promise<ShareOrder[]>;
  /** Deletes the link with the record id. */
  deleteShare(id: unknown): Promise<void>;
  /** The user's link with the share id (expired or not), without `_id`, `__v` and `user`. */
  readOwnShare(shareId: string, user: string): Promise<t.ISharedLink | null>;
  /**
   * Applies `update` ({@link buildShareRepublishUpdate}; `$set.messages` holds the message
   * records, whose ids the link stores) to the user's link with the share id, validated, and
   * resolves it updated, or `null` when it is gone.
   */
  writeOwnShare(shareId: string, user: string, update: Query): Promise<t.ISharedLink | null>;
  /** The conversation search for the user's conversations (it throws when unavailable). */
  searchConversations(
    search: string,
    user: string,
  ): Promise<{ hits?: Array<Record<string, unknown>> } | null | undefined>;
  /** Up to `limit` links matching `filter` in `sort` order, without `__v` and `user`. */
  findLinksPage(
    filter: Query,
    sort: Record<string, 1 | -1>,
    limit: number,
  ): Promise<t.ISharedLink[]>;
  /** The id value a record id string compares as in a filter. */
  toId(id: string): unknown;
}

/** Which link a snapshot write addresses: its record id, or its share id. */
export type ShareSnapshotKey = { _id: unknown } | { shareId: string };

/** The user's links for a conversation (and a target, when given). */
export interface ShareKey {
  conversationId: string;
  user: string;
  targetMessageId?: string;
}

/** A new link, as `createSharedLink` stores it (`messages` holds the message records). */
export interface ShareInsert {
  shareId: string;
  conversationId: string;
  messages: t.IMessage[];
  title: string;
  user: string;
  snapshotFiles: boolean;
  targetMessageId?: string;
  expiredAt?: Date;
  fileSnapshots?: t.SharedFileSnapshot[];
}

/**
 * Build the per-share file snapshot from the messages being shared. Captures only
 * the metadata the share-scoped routes need to stream each file; references the
 * original stored object (no byte copy). The lookup is scoped to the sharing
 * user's own files so a message referencing another user's `file_id` can never
 * widen access to it. Preview text/status is intentionally NOT embedded — it is
 * read live from the file record so snapshots stay small and never go stale.
 */
async function buildFileSnapshots(
  steps: Pick<ShareStorageSteps, 'readOwnerFiles'>,
  messages: t.IMessage[],
  ownerId?: string,
): Promise<t.SharedFileSnapshot[]> {
  if (!ownerId) {
    return [];
  }

  const fileIds = new Set<string>();
  for (const message of messages) {
    collectFileIds(message.files, fileIds);
    collectFileIds(message.attachments, fileIds);
    collectSteerFileIds(message.content, fileIds);
  }

  return readFileSnapshots(steps, fileIds, ownerId);
}

async function readFileSnapshots(
  steps: Pick<ShareStorageSteps, 'readOwnerFiles'>,
  fileIds: Set<string>,
  ownerId: string,
): Promise<t.SharedFileSnapshot[]> {
  if (fileIds.size === 0) {
    return [];
  }

  const files = await steps.readOwnerFiles(Array.from(fileIds), ownerId);

  const snapshots: t.SharedFileSnapshot[] = [];
  for (const file of files) {
    const source = file.source ?? FileSources.local;
    if (!SNAPSHOT_STREAMABLE_SOURCES.has(source)) {
      continue;
    }
    snapshots.push({
      file_id: file.file_id,
      source,
      storageKey: file.storageKey,
      filepath: file.filepath,
      type: file.type,
      filename: file.filename,
      bytes: file.bytes,
      width: file.width,
      height: file.height,
      model: file.model,
      llmDeliveryPath: isLlmDeliveryPath(file.llmDeliveryPath) ? file.llmDeliveryPath : 'provider',
      previewRevision: file.previewRevision,
      sourceDispatchedAt: file.metadata?.sourceDispatchedAt,
      tenantId: file.tenantId,
    });
  }
  return snapshots;
}

type SharedLinksCursor = { primary: string | null; id: string };

/**
 * The list cursor carries the sort value *and* the `_id` that broke its tie, base64
 * encoded so callers treat it as opaque. Older plain-value cursors decode to null and
 * fall back to the single-field boundary they were issued under.
 */
function decodeSharedLinksCursor(pageParam: Date | string): SharedLinksCursor | null {
  if (typeof pageParam !== 'string') {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(pageParam, 'base64').toString());
    const hasPrimary = typeof decoded?.primary === 'string' || decoded?.primary === null;
    if (hasPrimary && isValidObjectIdString(decoded?.id)) {
      return decoded as SharedLinksCursor;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Clauses that resume exactly after the boundary row. `title` is optional on a share,
 * and BSON orders null/missing before every string, so a titleless boundary cannot be
 * expressed as a comparison against `''`: ascending would skip the remaining titleless
 * rows and descending would re-admit all of them.
 */
function buildSharedLinksCursorClauses(
  cursor: SharedLinksCursor,
  sortBy: string,
  descending: boolean,
  toId: (id: string) => unknown,
): Query[] {
  const op = descending ? '$lt' : '$gt';
  const boundaryId = { [op]: toId(cursor.id) };

  if (cursor.primary === null) {
    /* Descending puts the titleless rows last, so only their own tail remains;
       ascending puts them first, so every titled row still follows. */
    return descending
      ? [{ [sortBy]: null, _id: boundaryId }]
      : [{ [sortBy]: null, _id: boundaryId }, { [sortBy]: { $ne: null } }];
  }

  const primaryValue = sortBy === 'createdAt' ? new Date(cursor.primary) : cursor.primary;
  const clauses: Query[] = [
    { [sortBy]: { [op]: primaryValue } },
    { [sortBy]: primaryValue, _id: boundaryId },
  ];

  /* `$lt`/`$gt` are type-bracketed: compared against a string they never match a
     missing field. Descending sorts those rows after every title, so they need a
     clause of their own or the page after the last title comes back empty. */
  if (descending && typeof primaryValue === 'string') {
    clauses.push({ [sortBy]: null });
  }

  return clauses;
}

function encodeSharedLinksCursor(link: t.ISharedLink, sortBy: string): string {
  const value = link[sortBy as keyof t.ISharedLink];
  let primary: string | null = null;
  if (value instanceof Date) {
    primary = value.toISOString();
  } else if (value != null) {
    primary = String(value);
  }
  const composite: SharedLinksCursor = { primary, id: String(link._id) };
  return Buffer.from(JSON.stringify(composite)).toString('base64');
}

/**
 * Whether this message shows a label rather than a model-derived name.
 *
 * The public header renders each message's stored `sender`, which froze at whatever the
 * sender chain produced when it was written, so the messages — not the conversation's
 * current settings — decide whether a link may reveal a model. A label cleared after the
 * responses were written, or one that lives in config this package never reads, both
 * answer correctly here.
 */
function showsConfiguredSender(message: t.IMessage): boolean {
  return isConfiguredSender({
    sender: message.sender,
    endpoint: message.endpoint,
    model: message.model,
    isCreatedByUser: message.isCreatedByUser,
  });
}

/**
 * Commit a lazy snapshot backfill only while the link still has none. An owner can
 * republish the same shareId while a viewer's first read is in flight, and an
 * unconditional write would restore the snapshot that republish just replaced,
 * re-authorizing the stable URL of a file they removed. The stored snapshot wins any
 * race; `timestamps: false` keeps a migration from looking like a publication, since
 * `updatedAt` is the revision a viewer's fork request is validated against.
 */
async function persistBackfilledSnapshots(
  steps: Pick<ShareStorageSteps, 'writeSnapshotsIfAbsent' | 'readSnapshotState'>,
  key: ShareSnapshotKey,
  fileSnapshots: t.SharedFileSnapshot[],
): Promise<t.SharedFileSnapshot[]> {
  if (await steps.writeSnapshotsIfAbsent(key, fileSnapshots)) {
    return fileSnapshots;
  }

  const current = await steps.readSnapshotState(key);
  if (!current || current.snapshotFiles === false) {
    return [];
  }
  return current.fileSnapshots ?? [];
}

function snapshotMatchesCurrentVersion(
  snapshot: t.SharedFileSnapshot,
  current: t.SharedFileSnapshot,
): boolean {
  const revisionChanged = (snapshot.previewRevision ?? null) !== (current.previewRevision ?? null);
  const sourceGenerationChanged =
    snapshot.sourceDispatchedAt != null &&
    snapshot.sourceDispatchedAt !== (current.sourceDispatchedAt ?? null);
  const bytesChanged =
    snapshot.bytes != null && current.bytes != null && snapshot.bytes !== current.bytes;
  return !revisionChanged && !sourceGenerationChanged && !bytesChanged;
}

/**
 * Add the delivery marker introduced after file snapshots shipped without changing
 * what an existing link authorizes. Each marker is copied only when the live file
 * still passes the same revision checks as the public file route. The caller persists
 * after public-projection preflight with the full prior snapshot as a compare-and-set
 * guard. A legacy file with no explicit marker used provider delivery, which remains
 * the compatible fallback.
 */
async function enrichSnapshotDeliveryPaths(
  steps: Pick<ShareStorageSteps, 'readOwnerFiles'>,
  share: t.ISharedLink & { messages: t.IMessage[] },
): Promise<{ snapshots: t.SharedFileSnapshot[]; changed: boolean }> {
  const existing = share.fileSnapshots ?? [];
  const missingIds = new Set(
    existing
      .filter((snapshot) => snapshot.llmDeliveryPath === undefined)
      .map((snapshot) => snapshot.file_id),
  );
  if (missingIds.size === 0 || share._id == null || !share.user) {
    return { snapshots: existing, changed: false };
  }

  const currentById = new Map(
    (await readFileSnapshots(steps, missingIds, share.user)).map((snapshot) => [
      snapshot.file_id,
      snapshot,
    ]),
  );
  let changed = false;
  const enriched = existing.map((snapshot) => {
    if (snapshot.llmDeliveryPath !== undefined) {
      return snapshot;
    }
    const current = currentById.get(snapshot.file_id);
    changed = true;
    if (current == null || !snapshotMatchesCurrentVersion(snapshot, current)) {
      return { ...snapshot, llmDeliveryPath: null };
    }
    return { ...snapshot, llmDeliveryPath: current.llmDeliveryPath ?? ('provider' as const) };
  });
  if (!changed) {
    return { snapshots: existing, changed: false };
  }
  return { snapshots: enriched, changed: true };
}

/** Share-scoped file route that serves a snapshotted file independent of owner ACL. */
function shareFileRoute(shareId: string, fileId: string): string {
  return `/api/share/${shareId}/files/${encodeURIComponent(fileId)}`;
}

/**
 * Point a snapshotted file's render URLs at the share-scoped route so viewers load
 * it through the authorized share path (and the owner's storage path is not leaked).
 */
function applyShareFileRoute(
  file: t.SharedFile,
  shareId: string,
  snapshotIds: Set<string>,
  textSourceIds?: Set<string>,
  deliveryPathById?: ReadonlyMap<string, t.SharedFileSnapshot['llmDeliveryPath']>,
): t.SharedFile {
  const fileId = file.file_id;
  if (typeof fileId === 'string' && snapshotIds.has(fileId)) {
    const route = shareFileRoute(shareId, fileId);
    const next: t.SharedFile = {
      ...file,
      filepath: route,
      // General storage sources stay private, but `text` is a render semantic:
      // clients must preview the database-backed payload as text, not the original MIME.
      ...(textSourceIds?.has(fileId) && { source: FileSources.text }),
      ...(deliveryPathById?.get(fileId) != null && {
        llmDeliveryPath: deliveryPathById.get(fileId),
      }),
    };
    for (const key of ['preview', 'uri', 'url'] as const) {
      if (file[key] !== undefined) {
        next[key] = route;
      }
    }
    return next;
  }
  // Not snapshotted (e.g. a non-streamable source on an included link): neutralize
  // the render URLs so the owner's original path can't be loaded through the share.
  const next: t.SharedFile = { ...file };
  for (const key of ['filepath', 'preview', 'uri', 'url'] as const) {
    delete next[key];
  }
  return next;
}

/**
 * Steer parts persisted inline in `message.content` carry the same user file
 * refs as a message's top-level `files`, so they follow the identical share
 * policy: dropped entirely when files are excluded from the link, sanitized and
 * rewritten to the share-scoped route (with anonymized ids) when included.
 * Returns the original array untouched when no steer part carries files.
 */
export function anonymizeSharedContent(
  content: unknown[] | undefined,
  params: {
    newConvoId: string;
    newMessageId: string;
    shareId: string;
    snapshotIds: Set<string>;
    textSourceIds?: Set<string>;
    deliveryPathById?: ReadonlyMap<string, t.SharedFileSnapshot['llmDeliveryPath']>;
    includeFiles: boolean;
    sanitizeUIResourceMarkers?: boolean;
  },
): unknown[] | undefined {
  if (!Array.isArray(content)) {
    return content;
  }

  let result: unknown[] | null = null;
  const sanitized = sanitizeUIResourceContent(content, params.sanitizeUIResourceMarkers === true);
  if (sanitized !== content) {
    result = sanitized as unknown[];
  }

  for (let i = 0; i < content.length; i++) {
    const part = result?.[i] ?? content[i];
    if (!isSteerPartWithFiles(part)) {
      continue;
    }
    const { files: rawFiles, ...rest } = part as Record<string, unknown>;
    const files = params.includeFiles
      ? sanitizeSharedFiles(rawFiles)?.map((file) =>
          applyShareFileRoute(
            {
              ...file,
              ...(file.conversationId !== undefined && { conversationId: params.newConvoId }),
              ...(file.messageId !== undefined && { messageId: params.newMessageId }),
            },
            params.shareId,
            params.snapshotIds,
            params.textSourceIds,
            params.deliveryPathById,
          ),
        )
      : undefined;
    result ??= [...content];
    result[i] = files ? { ...rest, files } : rest;
  }
  return result ?? content;
}

/**
 * Only surface a model name when it is an (already-anonymized) assistant id;
 * otherwise omit it so the underlying provider/model is not disclosed.
 */
function anonymizeSharedModel(
  model: string | undefined,
  anonymizeAssistantId: (id: string) => string,
): string | undefined {
  if (!model?.startsWith('asst_')) {
    return undefined;
  }
  return anonymizeAssistantId(model);
}

/**
 * Build the public, anonymized view of shared messages. An allowlist of
 * render-relevant fields keeps internal message fields (endpoint,
 * conversationSignature, clientId, plugin(s), metadata, etc.) out of the
 * payload, while user files and tool-call attachments are sanitized field by
 * field so render data (uploaded files, `toolCallId`, search results, generated
 * outputs) is preserved without leaking storage internals.
 */
function anonymizeMessages(
  messages: t.IMessage[],
  newConvoId: string,
  shareId: string,
  snapshotIds: Set<string>,
  textSourceIds: Set<string>,
  deliveryPathById: ReadonlyMap<string, t.SharedFileSnapshot['llmDeliveryPath']>,
  includeFiles: boolean,
  anonymizeMessageId: (id: string) => string,
  anonymizeAssistantId: (id: string) => string,
): { messages: t.SharedMessage[]; hasConfiguredSender: boolean } {
  if (!Array.isArray(messages)) {
    return { messages: [], hasConfiguredSender: false };
  }

  /** Collected in this pass rather than a second one over the same array: shared
   *  transcripts can be long and this is their visible loading path. */
  let hasConfiguredSender = false;
  const idMap = new Map<string, string>();
  const shared = messages.map((message) => {
    hasConfiguredSender = hasConfiguredSender || showsConfiguredSender(message);
    const newMessageId = anonymizeMessageId(message.messageId);
    idMap.set(message.messageId, newMessageId);

    // When files are not shared for this link, omit files/attachments entirely so
    // viewers can't load them through the owner's original (e.g. static) paths.
    const attachments = includeFiles
      ? sanitizeSharedAttachments(message.attachments)?.map((attachment) =>
          applyShareFileRoute(
            {
              ...attachment,
              messageId: newMessageId,
              conversationId: newConvoId,
            },
            shareId,
            snapshotIds,
            textSourceIds,
            deliveryPathById,
          ),
        )
      : undefined;
    // Persisted file records can carry the original conversation/message ids;
    // rewrite them to the anonymized ids so shared files don't expose them.
    const files = includeFiles
      ? sanitizeSharedFiles(message.files)?.map((file) =>
          applyShareFileRoute(
            {
              ...file,
              ...(file.conversationId !== undefined && { conversationId: newConvoId }),
              ...(file.messageId !== undefined && { messageId: newMessageId }),
            },
            shareId,
            snapshotIds,
            textSourceIds,
            deliveryPathById,
          ),
        )
      : undefined;
    const model = anonymizeSharedModel(message.model, anonymizeAssistantId);

    return {
      messageId: newMessageId,
      parentMessageId:
        idMap.get(message.parentMessageId || '') ||
        anonymizeMessageId(message.parentMessageId || ''),
      conversationId: newConvoId,
      sender: message.sender,
      text:
        message.isCreatedByUser === false
          ? stripMessageUIResourceMarkers(message.text, message.error)
          : message.text,
      content: anonymizeSharedContent(message.content, {
        newConvoId,
        newMessageId,
        shareId,
        snapshotIds,
        textSourceIds,
        deliveryPathById,
        includeFiles,
        sanitizeUIResourceMarkers: message.isCreatedByUser !== true,
      }),
      ...(message.iconURL && { iconURL: message.iconURL }),
      ...(model && { model }),
      isCreatedByUser: message.isCreatedByUser,
      ...(typeof message.isUserSubmitted === 'boolean' && {
        isUserSubmitted: message.isUserSubmitted,
      }),
      ...(Array.isArray(message.userSubmittedPaths) && {
        userSubmittedPaths: message.userSubmittedPaths,
      }),
      ...(Array.isArray(message.userSubmittedMessageFieldPaths) && {
        userSubmittedMessageFieldPaths: message.userSubmittedMessageFieldPaths,
      }),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      tokenCount: message.tokenCount,
      unfinished: message.unfinished,
      error: message.error,
      finish_reason: message.finish_reason,
      ...(message.manualSkills && { manualSkills: message.manualSkills }),
      ...(message.alwaysAppliedSkills && { alwaysAppliedSkills: message.alwaysAppliedSkills }),
      ...(message.quotes && { quotes: message.quotes }),
      ...(message.reasoningOverride && { reasoningOverride: message.reasoningOverride }),
      ...(files && { files }),
      ...(attachments && { attachments }),
    };
  });

  return { messages: shared, hasConfiguredSender };
}

/**
 * An update omits the target when the share dialog cannot resolve the conversation's own
 * branch tail, which is every update started from the conversation list rather than the
 * open pane. The stored target is the tail as of the last publish, so reusing it verbatim
 * would republish the identical snapshot and silently drop the turns added since.
 *
 * Walking forward to the newest descendant is the same move an update from the open pane
 * already makes by sending the live tail, so both entry points now publish the newer turns.
 * Note `getMessagesUpToTarget` bounds the snapshot by the target's *level*, not by a single
 * path, so this widens the shared depth; it stays bounded by the branch's own tail rather
 * than clearing the target, which would drop the bound entirely.
 *
 * A regeneration or edit replaces the target with a *sibling* rather than a child, so the
 * turns that follow hang off the replacement. Descendants alone would leave the walk parked
 * on the obsolete branch and publish none of them, so a childless target hops once to the
 * newest sibling that the conversation actually continued under.
 */
function advanceTargetToBranchTail(messages: t.IMessage[], targetMessageId: string): string {
  const messagesById = new Map<string, t.IMessage>();
  const childrenByParent = new Map<string, t.IMessage[]>();
  for (const message of messages) {
    messagesById.set(message.messageId, message);
    const parentMessageId = message.parentMessageId;
    if (!parentMessageId) {
      continue;
    }
    const siblings = childrenByParent.get(parentMessageId);
    if (siblings) {
      siblings.push(message);
      continue;
    }
    childrenByParent.set(parentMessageId, [message]);
  }

  const newestOf = (candidates: t.IMessage[]): t.IMessage | undefined => {
    let newest: t.IMessage | undefined;
    for (const candidate of candidates) {
      const candidateTime = candidate.createdAt?.getTime() ?? 0;
      const newestTime = newest?.createdAt?.getTime() ?? 0;
      if (!newest || candidateTime > newestTime) {
        newest = candidate;
      }
    }
    return newest;
  };

  const replacementFor = (messageId: string): t.IMessage | undefined => {
    const node = messagesById.get(messageId);
    const parentMessageId = node?.parentMessageId;
    if (!parentMessageId) {
      return undefined;
    }
    /* Only a sibling created after this one can be its replacement. An older sibling
       that happens to have follow-ups is the branch this one was regenerated away
       from, and resuming there would publish turns the target deliberately excluded. */
    const nodeTime = node?.createdAt?.getTime() ?? 0;
    const continued = (childrenByParent.get(parentMessageId) ?? []).filter(
      (sibling) =>
        sibling.messageId !== messageId &&
        childrenByParent.has(sibling.messageId) &&
        (sibling.createdAt?.getTime() ?? 0) > nodeTime,
    );
    return newestOf(continued);
  };

  /** The regenerated message is not always the stored target: regenerating an answer
   * further up leaves the whole stored branch childless while the conversation carries
   * on under the replacement. Climb until a level offers one, so the walk resumes at
   * the closest point where the branch actually diverged. */
  const findBranchReplacement = (): t.IMessage | undefined => {
    const climbed = new Set<string>();
    let node: string | undefined = targetMessageId;
    while (node && !climbed.has(node)) {
      climbed.add(node);
      const replacement = replacementFor(node);
      if (replacement) {
        return replacement;
      }
      node = messagesById.get(node)?.parentMessageId ?? undefined;
    }
    return undefined;
  };

  let current = targetMessageId;
  const visited = new Set([current]);
  for (;;) {
    const children = childrenByParent.get(current);
    let next: t.IMessage | undefined;
    if (children?.length) {
      next = newestOf(children);
    } else if (current === targetMessageId) {
      next = findBranchReplacement();
    }

    if (!next?.messageId || visited.has(next.messageId)) {
      return current;
    }
    visited.add(next.messageId);
    current = next.messageId;
  }
}

/**
 * Filter messages up to and including the target message (branch-specific)
 * Similar to getMessagesUpToTargetLevel from fork utilities
 */
function getMessagesUpToTarget(messages: t.IMessage[], targetMessageId: string): t.IMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  // If only one message and it's the target, return it
  if (messages.length === 1 && messages[0]?.messageId === targetMessageId) {
    return messages;
  }

  // Create a map of parentMessageId to children messages
  const parentToChildrenMap = new Map<string, t.IMessage[]>();
  for (const message of messages) {
    const parentId = message.parentMessageId || Constants.NO_PARENT;
    if (!parentToChildrenMap.has(parentId)) {
      parentToChildrenMap.set(parentId, []);
    }
    parentToChildrenMap.get(parentId)?.push(message);
  }

  // Find the target message
  const targetMessage = messages.find((msg) => msg.messageId === targetMessageId);
  if (!targetMessage) {
    // Fail closed: a stale or malformed target must never widen the share from a
    // selected branch/level to the entire conversation.
    return [];
  }

  const visited = new Set<string>();
  const rootMessages = parentToChildrenMap.get(Constants.NO_PARENT) || [];
  let currentLevel = rootMessages.length > 0 ? [...rootMessages] : [targetMessage];
  const results = new Set<t.IMessage>(currentLevel);
  let targetFound = currentLevel.some((msg) => msg.messageId === targetMessageId);

  // Check if the target message is at the root level
  if (
    currentLevel.some((msg) => msg.messageId === targetMessageId) &&
    targetMessage.parentMessageId === Constants.NO_PARENT
  ) {
    return Array.from(results);
  }

  // Iterate level by level until the target is found
  while (!targetFound && currentLevel.length > 0) {
    const nextLevel: t.IMessage[] = [];
    for (const node of currentLevel) {
      if (visited.has(node.messageId)) {
        continue;
      }
      visited.add(node.messageId);
      const children = parentToChildrenMap.get(node.messageId) || [];
      for (const child of children) {
        if (visited.has(child.messageId)) {
          continue;
        }
        nextLevel.push(child);
        results.add(child);
        if (child.messageId === targetMessageId) {
          targetFound = true;
        }
      }
    }
    currentLevel = nextLevel;
  }

  // Fail closed: an orphaned target (an import or a partial delete broke its parent
  // chain) is never reached from the roots, and returning the levels accumulated on
  // the way would publish the whole conversation instead of the selected branch.
  if (!targetFound) {
    return [];
  }

  return Array.from(results);
}

/**
 * The republish update of `updateSharedLink`: the current messages (as records; a backend stores
 * their ids), the owner, the file choice, the resolved target and expiry, with the expiry cleared
 * on `null` and a prior snapshot cleared when snapshotting is off.
 */
export function buildShareRepublishUpdate(input: {
  messages: t.IMessage[];
  user: string;
  snapshotFiles: boolean;
  targetMessageId?: string;
  expiredAt?: Date | null;
  fileSnapshots: t.SharedFileSnapshot[];
}): Query {
  const { messages, user, snapshotFiles, targetMessageId, expiredAt, fileSnapshots } = input;
  const hasNewExpiration = expiredAt instanceof Date;
  // Clear any prior snapshot when snapshotting is off so a disabled-feature
  // update can't keep serving stale file ids that the update dropped.
  const unset = {
    ...(expiredAt === null ? { expiredAt: 1 } : {}),
    ...(snapshotFiles ? {} : { fileSnapshots: 1 }),
  };
  return {
    $set: {
      messages,
      user,
      snapshotFiles,
      ...(targetMessageId && { targetMessageId }),
      ...(hasNewExpiration && { expiredAt }),
      ...(snapshotFiles && { fileSnapshots }),
    },
    ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
  };
}

/** The composite shared link methods, written once on {@link ShareStorageSteps}. */
export interface ShareProtocol {
  getSharedMessages(
    shareId: string,
    shareObjectId?: string,
    options?: GetSharedMessagesOptions,
  ): Promise<t.SharedMessagesResult | null>;
  getSharedLinks(
    user: string,
    pageParam?: Date | string,
    pageSize?: number,
    sortBy?: string,
    sortDirection?: string,
    search?: string,
  ): Promise<t.SharedLinksResult>;
  createSharedLink(
    user: string,
    conversationId: string,
    targetMessageId?: string,
    expiredAt?: Date,
    snapshotFiles?: boolean,
    preflight?: SharedLinkContentPreflight,
  ): Promise<t.CreateShareResult>;
  updateSharedLink(
    user: string,
    shareId: string,
    targetMessageId?: string,
    expiredAt?: Date | null,
    snapshotFiles?: boolean,
    preflight?: SharedLinkContentPreflight,
    beforePublish?: () => void | Promise<void>,
  ): Promise<t.UpdateShareResult>;
  backfillSharedLinkFiles(
    shareId: string,
    fileId?: string,
  ): Promise<t.SharedFileSnapshot | t.SharedFileSnapshot[] | null>;
}

export function createShareProtocol(steps: ShareStorageSteps): ShareProtocol {
  /**
   * `createSharedLink` checks for an existing share and inserts in two round trips, so two
   * concurrent creates can both clear the check. Re-reading after the insert closes that:
   * every racer that sees an earlier rival retracts its own document, and since they all
   * evaluate the same total order (createdAt, then `_id`), exactly one survives.
   */
  async function findOlderActiveShare(created: ShareOrder, key: ShareKey): Promise<boolean> {
    const rivals = await steps.listActiveRivals(key, created._id);
    return rivals.some((rival) => isEarlierShare(rival, created));
  }

  /**
   * Get shared messages for a share link
   */
  async function getSharedMessages(
    shareId: string,
    shareObjectId?: string,
    options?: GetSharedMessagesOptions,
  ): Promise<t.SharedMessagesResult | null> {
    let preflightFailed = false;
    try {
      const share = await steps.readViewedShare(shareId, shareObjectId);

      if (!share?.conversationId) {
        return null;
      }

      /** Filtered messages based on targetMessageId if present (branch-specific sharing) */
      let messagesToShare: t.IMessage[] = share.messages;
      if (share.targetMessageId) {
        messagesToShare = getMessagesUpToTarget(share.messages, share.targetMessageId);
      }

      // Keep anonymous ids consistent within a response without retaining a
      // process-global map. Global maps let viewers correlate the same private
      // conversation/assistant across distinct links and grow without bounds.
      const anonymizeConvoId = memoizedAnonymizeId('convo');
      const anonymizeAssistantId = memoizedAnonymizeId('a');
      const memoizedMessageId = memoizedAnonymizeId('msg');
      const anonymizeMessageId = (id: string) =>
        !id || id === Constants.NO_PARENT ? Constants.NO_PARENT : memoizedMessageId(id);
      const newConvoId = anonymizeConvoId(share.conversationId);
      const resolvedShareId = share.shareId || shareId;

      /**
       * Files are included only when the admin feature is enabled (options) AND the
       * link's own choice wasn't opted out (`snapshotFiles === false`). When
       * excluded, files/attachments are stripped from the payload so nothing leaks
       * through the owner's original paths. Legacy links (no per-link choice and no
       * snapshot yet) are backfilled here so their first view rewrites correctly.
       */
      const adminEnabled = options?.snapshotFiles !== false;
      const perLinkEnabled = share.snapshotFiles !== false;
      const includeFiles = adminEnabled && perLinkEnabled;
      let fileSnapshots = share.fileSnapshots;
      const originalFileSnapshots = share.fileSnapshots;
      let shouldPersistEnrichedDeliveryPaths = false;
      const shouldPersistFileSnapshots =
        includeFiles && fileSnapshots === undefined && share._id != null;
      if (shouldPersistFileSnapshots) {
        fileSnapshots = await buildFileSnapshots(steps, messagesToShare, share.user);
      } else if (includeFiles && fileSnapshots !== undefined) {
        const enriched = await enrichSnapshotDeliveryPaths(steps, share);
        fileSnapshots = enriched.snapshots;
        shouldPersistEnrichedDeliveryPaths = enriched.changed;
      }

      const snapshotIds = includeFiles
        ? new Set<string>((fileSnapshots ?? []).map((snapshot) => snapshot.file_id))
        : new Set<string>();
      const textSourceIds = includeFiles
        ? new Set<string>(
            (fileSnapshots ?? [])
              .filter((snapshot) => snapshot.source === FileSources.text)
              .map((snapshot) => snapshot.file_id),
          )
        : new Set<string>();
      const deliveryPathById = includeFiles
        ? new Map(
            (fileSnapshots ?? []).flatMap((snapshot) =>
              snapshot.llmDeliveryPath == null
                ? []
                : [[snapshot.file_id, snapshot.llmDeliveryPath] as const],
            ),
          )
        : new Map<string, t.SharedFileSnapshot['llmDeliveryPath']>();
      /** The share view has no conversation in scope, so whether this link may reveal a
       *  model travels in the payload — read off the very messages being returned. */
      const { messages, hasConfiguredSender } = anonymizeMessages(
        messagesToShare,
        newConvoId,
        resolvedShareId,
        snapshotIds,
        textSourceIds,
        deliveryPathById,
        includeFiles,
        anonymizeMessageId,
        anonymizeAssistantId,
      );
      const result: t.SharedMessagesResult = {
        shareId: resolvedShareId,
        title: share.title,
        ...(hasConfiguredSender ? { hasConfiguredSender: true } : {}),
        createdAt: share.createdAt,
        updatedAt: share.updatedAt,
        conversationId: newConvoId,
        messages,
      };

      try {
        await options?.preflight?.(result, { canonicalMessages: messagesToShare });
      } catch (error) {
        preflightFailed = true;
        throw error;
      }

      if (shouldPersistFileSnapshots) {
        await persistBackfilledSnapshots(steps, { _id: share._id }, fileSnapshots ?? []);
      } else if (
        shouldPersistEnrichedDeliveryPaths &&
        share._id != null &&
        originalFileSnapshots !== undefined
      ) {
        await steps.writeEnrichedSnapshots(share._id, originalFileSnapshots, fileSnapshots ?? []);
      }

      return result;
    } catch (error) {
      if (preflightFailed) {
        throw error;
      }
      logger.error('[getSharedMessages] Error getting share link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        shareId,
      });
      throw new ShareServiceError('Error getting share link', 'SHARE_FETCH_ERROR');
    }
  }

  /**
   * Get shared links for a specific user with pagination and search
   */
  async function getSharedLinks(
    user: string,
    pageParam?: Date | string,
    pageSize: number = 10,
    sortBy: string = 'createdAt',
    sortDirection: string = 'desc',
    search?: string,
  ): Promise<t.SharedLinksResult> {
    try {
      const query: Query = {
        user,
        ...activeExpirationFilter(),
      };

      if (pageParam) {
        const op = sortDirection === 'desc' ? '$lt' : '$gt';
        const cursor = decodeSharedLinksCursor(pageParam);
        if (cursor) {
          /* Titles repeat and createdAt can collide, so a single-field boundary drops
             every row that ties with the last one on the previous page. `_id` breaks
             the tie. Nested under `$and` because the expiration filter owns `$or`. */
          query.$and = [
            {
              $or: buildSharedLinksCursorClauses(
                cursor,
                sortBy,
                sortDirection === 'desc',
                steps.toId,
              ),
            },
          ];
        } else {
          query[sortBy] = { [op]: pageParam };
        }
      }

      if (search && search.trim()) {
        try {
          const searchResults = await steps.searchConversations(search, user);

          if (!searchResults?.hits?.length) {
            return {
              links: [],
              nextCursor: undefined,
              hasNextPage: false,
            };
          }

          const conversationIds = searchResults.hits.map((hit) => hit.conversationId);
          query['conversationId'] = { $in: conversationIds };
        } catch (searchError) {
          logger.error('[getSharedLinks] Meilisearch error', {
            error: searchError instanceof Error ? searchError.message : 'Unknown error',
            user,
          });
          return {
            links: [],
            nextCursor: undefined,
            hasNextPage: false,
          };
        }
      }

      const sort: Record<string, 1 | -1> = {};
      sort[sortBy] = sortDirection === 'desc' ? -1 : 1;
      sort._id = sort[sortBy];

      const sharedLinks = await steps.findLinksPage(query, sort, pageSize + 1);

      const hasNextPage = sharedLinks.length > pageSize;
      const links = sharedLinks.slice(0, pageSize);

      const nextCursor = hasNextPage
        ? encodeSharedLinksCursor(links[links.length - 1], sortBy)
        : undefined;

      return {
        links: links.map((link) => ({
          shareId: link.shareId || '',
          title: link?.title || 'Untitled',
          createdAt: link.createdAt || new Date(),
          conversationId: link.conversationId,
        })),
        nextCursor,
        hasNextPage,
      };
    } catch (error) {
      logger.error('[getSharedLinks] Error getting shares', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
      });
      throw new ShareServiceError('Error getting shares', 'SHARES_FETCH_ERROR');
    }
  }

  /**
   * Create a new shared link for a conversation
   */
  async function createSharedLink(
    user: string,
    conversationId: string,
    targetMessageId?: string,
    expiredAt?: Date,
    snapshotFiles: boolean = true,
    preflight?: SharedLinkContentPreflight,
  ): Promise<t.CreateShareResult> {
    if (!user || !conversationId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }
    let preflightFailed = false;
    try {
      const [existingShare, conversationMessages] = await Promise.all([
        steps.findActiveShare({ conversationId, user, targetMessageId }),
        steps.readConversationMessages(conversationId, user),
      ]);

      if (existingShare) {
        logger.error('[createSharedLink] Share already exists', {
          user,
          conversationId,
          targetMessageId,
        });
        throw new ShareServiceError('Share already exists', 'SHARE_EXISTS');
      }

      const conversation = await steps.readConversation(conversationId, user);

      // Check if user owns the conversation
      if (!conversation) {
        throw new ShareServiceError(
          'Conversation not found or access denied',
          'CONVERSATION_NOT_FOUND',
        );
      }

      // Check if there are any messages to share
      if (!conversationMessages || conversationMessages.length === 0) {
        throw new ShareServiceError('No messages to share', 'NO_MESSAGES');
      }

      if (
        targetMessageId &&
        !conversationMessages.some((message) => message.messageId === targetMessageId)
      ) {
        throw new ShareServiceError('Target message not found', 'TARGET_MESSAGE_NOT_FOUND');
      }

      const title = conversation.title || 'Untitled';

      const messagesToShare = targetMessageId
        ? getMessagesUpToTarget(conversationMessages, targetMessageId)
        : conversationMessages;
      try {
        await preflight?.({ title, messages: messagesToShare });
      } catch (error) {
        preflightFailed = true;
        throw error;
      }
      const fileSnapshots = snapshotFiles
        ? await buildFileSnapshots(steps, messagesToShare, user)
        : [];

      const shareId = nanoid();
      const created = await steps.insertShare({
        shareId,
        conversationId,
        messages: conversationMessages,
        title,
        user,
        snapshotFiles,
        ...(targetMessageId && { targetMessageId }),
        ...(expiredAt && { expiredAt }),
        ...(snapshotFiles && { fileSnapshots }),
      });

      const supersededBy = await findOlderActiveShare(created, {
        conversationId,
        user,
        targetMessageId,
      });
      if (supersededBy) {
        await steps.deleteShare(created._id);
        logger.warn('[createSharedLink] Concurrent create lost to an earlier share', {
          user,
          conversationId,
          targetMessageId,
        });
        throw new ShareServiceError('Share already exists', 'SHARE_EXISTS');
      }

      return { _id: String(created._id), shareId, conversationId, targetMessageId };
    } catch (error) {
      if (preflightFailed) {
        throw error;
      }
      if (error instanceof ShareServiceError) {
        throw error;
      }
      logger.error('[createSharedLink] Error creating shared link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        conversationId,
        targetMessageId,
      });
      throw new ShareServiceError('Error creating shared link', 'SHARE_CREATE_ERROR');
    }
  }

  /**
   * Update a shared link with new messages
   */
  async function updateSharedLink(
    user: string,
    shareId: string,
    targetMessageId?: string,
    expiredAt?: Date | null,
    snapshotFiles: boolean = true,
    preflight?: SharedLinkContentPreflight,
    beforePublish?: () => void | Promise<void>,
  ): Promise<t.UpdateShareResult> {
    if (!user || !shareId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    let preflightFailed = false;
    try {
      const share = await steps.readOwnShare(shareId, user);

      if (!share) {
        throw new ShareServiceError('Share not found', 'SHARE_NOT_FOUND');
      }

      const updatedMessages = await steps.readConversationMessages(share.conversationId, user);

      if (updatedMessages.length === 0) {
        throw new ShareServiceError('No messages to share', 'NO_MESSAGES');
      }

      const storedTargetMessageId = targetMessageId ?? share.targetMessageId;
      if (
        storedTargetMessageId &&
        !updatedMessages.some((message) => message.messageId === storedTargetMessageId)
      ) {
        throw new ShareServiceError('Target message not found', 'TARGET_MESSAGE_NOT_FOUND');
      }
      const resolvedTargetMessageId =
        targetMessageId ??
        (storedTargetMessageId
          ? advanceTargetToBranchTail(updatedMessages, storedTargetMessageId)
          : undefined);
      const messagesToShare = resolvedTargetMessageId
        ? getMessagesUpToTarget(updatedMessages, resolvedTargetMessageId)
        : updatedMessages;
      try {
        await preflight?.({
          title: share.title || 'Untitled',
          messages: messagesToShare,
        });
      } catch (error) {
        preflightFailed = true;
        throw error;
      }
      const fileSnapshots = snapshotFiles
        ? await buildFileSnapshots(steps, messagesToShare, user)
        : [];
      const update = buildShareRepublishUpdate({
        messages: updatedMessages,
        user,
        snapshotFiles,
        targetMessageId: resolvedTargetMessageId,
        expiredAt,
        fileSnapshots,
      });

      await beforePublish?.();

      const updatedShare = await steps.writeOwnShare(shareId, user, update);

      if (!updatedShare) {
        throw new ShareServiceError('Share update failed', 'SHARE_UPDATE_ERROR');
      }

      return {
        _id: updatedShare._id?.toString(),
        shareId,
        conversationId: updatedShare.conversationId,
        targetMessageId: updatedShare.targetMessageId,
      };
    } catch (error) {
      if (preflightFailed) {
        throw error;
      }
      if (!(error instanceof ShareServiceError && EXPECTED_SHARE_REJECTION_CODES.has(error.code))) {
        logger.error('[updateSharedLink] Error updating shared link', {
          error: error instanceof Error ? error.message : 'Unknown error',
          user,
          shareId,
        });
      }
      throw new ShareServiceError(
        error instanceof ShareServiceError ? error.message : 'Error updating shared link',
        error instanceof ShareServiceError ? error.code : 'SHARE_UPDATE_ERROR',
      );
    }
  }

  /**
   * Lazily build and persist the file snapshot for a legacy shared link that
   * predates the feature. Mirrors the lazy migration done for legacy ACL grants.
   * Returns the requested entry (or the full snapshot when no fileId is given).
   */
  async function backfillSharedLinkFiles(
    shareId: string,
    fileId?: string,
  ): Promise<t.SharedFileSnapshot | t.SharedFileSnapshot[] | null> {
    try {
      const share = await steps.readBackfillShare(shareId);

      if (!share) {
        return null;
      }

      let messages: t.IMessage[] = share.messages ?? [];
      if (share.targetMessageId) {
        messages = getMessagesUpToTarget(messages, share.targetMessageId);
      }

      const fileSnapshots = await persistBackfilledSnapshots(
        steps,
        { shareId },
        await buildFileSnapshots(steps, messages, share.user),
      );

      if (fileId) {
        return fileSnapshots.find((snapshot) => snapshot.file_id === fileId) ?? null;
      }
      return fileSnapshots;
    } catch (error) {
      logger.error('[backfillSharedLinkFiles] Error backfilling file snapshots', {
        error: error instanceof Error ? error.message : 'Unknown error',
        shareId,
      });
      return null;
    }
  }

  return {
    getSharedMessages,
    getSharedLinks,
    createSharedLink,
    updateSharedLink,
    backfillSharedLinkFiles,
  };
}

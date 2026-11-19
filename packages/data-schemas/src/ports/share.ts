/**
 * Shared link store port: the public, read-only snapshots of a conversation that a user
 * publishes under a share id, with the file snapshots their viewers may load. Nothing here may
 * import `mongoose`. Signatures are copied verbatim from `ShareMethods` (`~/methods/share`);
 * `share.spec.ts` fails the typecheck if the two drift.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`).
 * - `user` is the owner's id as a string; an owner-scoped method never sees another user's
 *   link. Viewer reads (`getSharedMessages`, `getSharedLinkFile`, `backfillSharedLinkFiles`)
 *   are keyed by the share alone.
 * - A link whose `expiredAt` has passed reads as absent, except where a method says it is
 *   matched regardless (an update or delete by the owner).
 * - Failures throw an error carrying a stable `code` (`INVALID_PARAMS`, `SHARE_EXISTS`,
 *   `CONVERSATION_NOT_FOUND`, `NO_MESSAGES`, `TARGET_MESSAGE_NOT_FOUND`, `SHARE_NOT_FOUND`,
 *   `SHARE_FETCH_ERROR`, …); an error thrown by a preflight is rethrown unchanged.
 *
 * A link snapshots its conversation's messages when it is created or updated: later turns
 * appear only after an update. With a target message, only the branch up to that message's
 * level is shared. Shared messages are anonymized: conversation, message and assistant ids
 * are replaced per response, and internal fields are left out.
 *
 * The record-level methods (last group) are the reads and writes of the shared-link ACL layer
 * (`packages/api` shared-links, the share routes): one query each, on the link as stored, and
 * unlike the owner methods above they rethrow the database's error unchanged rather than a coded
 * one.
 *
 * Known leaks kept for now so callers stay unchanged: the preflights receive `IMessage`
 * records (which extend mongoose's `Document`), and `getSharedLinks` takes its sort field as
 * a free string (callers pass `createdAt` or `title`).
 */
import type {
  GetShareLinkResult,
  CreateShareResult,
  UpdateShareResult,
  DeleteShareResult,
  SharedFileSnapshot,
  SharedLinksResult,
  SharedLinkRecord,
  SharedMessagesResult,
  DeleteAllSharesResult,
  SharedLinkOwnerCriteria,
  GetSharedMessagesOptions,
  SharedLinkContentPreflight,
} from '~/types';
import type { DeleteCount, IdLike } from './common';
import { listPortMethods } from './common';

export interface SharedLinkStore {
  /* ---------------------------------------------------------------- owner reads */

  /**
   * The user's most recently updated active link for the conversation (`success: false` and
   * `shareId: null` when there is none).
   */
  getSharedLink(user: string, conversationId: string): Promise<GetShareLinkResult>;
  /**
   * A page of the user's active links (10 by default), sorted by `sortBy` (`createdAt` by
   * default, or `title`) in `sortDirection` (`desc` by default), ties broken by record id.
   * `pageParam` is the `nextCursor` of the previous page (an opaque string; a plain
   * sort value is still accepted). `search` keeps the links whose conversation matches it in
   * the conversation search index; a search failure reads as an empty page.
   */
  getSharedLinks(
    user: string,
    pageParam?: Date | string,
    pageSize?: number,
    sortBy?: string,
    sortDirection?: string,
    search?: string,
  ): Promise<SharedLinksResult>;

  /* ---------------------------------------------------------------- owner writes */

  /**
   * Publishes the user's conversation under a new share id, up to `targetMessageId` when
   * given, expiring at `expiredAt` when given. Throws `SHARE_EXISTS` when the user already has
   * an active link for the same conversation and target (also when a concurrent create won),
   * `CONVERSATION_NOT_FOUND`, `NO_MESSAGES` or `TARGET_MESSAGE_NOT_FOUND`. With
   * `snapshotFiles` (the default) the referenced files the owner still holds, from storage a
   * viewer can stream, are snapshotted for the link. `preflight` sees the title and messages to publish first.
   */
  createSharedLink(
    user: string,
    conversationId: string,
    targetMessageId?: string,
    expiredAt?: Date,
    snapshotFiles?: boolean,
    preflight?: SharedLinkContentPreflight,
  ): Promise<CreateShareResult>;
  /**
   * Republishes the user's link (expired or not) with the conversation's current messages.
   * Without `targetMessageId`, a stored target advances to its branch's newest message.
   * `expiredAt` sets a new expiry, `null` clears it, `undefined` keeps it. Without
   * `snapshotFiles` the link's file snapshot is removed. `preflight` sees the content to
   * publish, and `beforePublish` runs right before the write. Throws `SHARE_NOT_FOUND`,
   * `NO_MESSAGES` or `TARGET_MESSAGE_NOT_FOUND`.
   */
  updateSharedLink(
    user: string,
    shareId: string,
    targetMessageId?: string,
    expiredAt?: Date | null,
    snapshotFiles?: boolean,
    preflight?: SharedLinkContentPreflight,
    beforePublish?: () => void | Promise<void>,
  ): Promise<UpdateShareResult>;
  /** Deletes the user's link (expired or not); `null` when the user has no such link. */
  deleteSharedLink(user: string, shareId: string): Promise<DeleteShareResult | null>;
  /** Deletes every link of the user (expired or not), resolving the deleted links' ids. */
  deleteAllSharedLinks(user: string): Promise<DeleteAllSharesResult & { deletedIds: string[] }>;
  /**
   * Deletes every link of the user for the conversation (expired or not), resolving the
   * deleted links' ids.
   */
  deleteConvoSharedLink(
    user: string,
    conversationId: string,
  ): Promise<DeleteAllSharesResult & { deletedIds: string[] }>;

  /* ---------------------------------------------------------------- viewer reads */

  /**
   * The anonymized public view of an active link, by its share id or, when given, by the
   * record id `shareObjectId` (the `_id` the owner results carry); `null` when absent.
   * Files are included unless `options.snapshotFiles` is `false` or the link opted out; their
   * render URLs then point at the share-scoped file route. A link that predates file
   * snapshots gets one built and stored on its first read, after `options.preflight` passed.
   */
  getSharedMessages(
    shareId: string,
    shareObjectId?: string,
    options?: GetSharedMessagesOptions,
  ): Promise<SharedMessagesResult | null>;
  /**
   * The snapshot of one file of an active link. `hasSnapshots` is `false` for a link that
   * predates file snapshots (the caller may backfill it); `optedOut` is the link's choice not
   * to share files (the caller must not).
   */
  getSharedLinkFile(
    shareId: string,
    fileId: string,
  ): Promise<{ file: SharedFileSnapshot | null; hasSnapshots: boolean; optedOut: boolean }>;
  /**
   * Builds and stores the file snapshot of an active link that has none yet; a snapshot stored
   * meanwhile wins, and a link that opted out keeps none (resolving an empty one). Resolves the
   * entry for `fileId`, or the whole snapshot without it; `null` when the link or the entry is
   * absent, or on failure.
   */
  backfillSharedLinkFiles(
    shareId: string,
    fileId?: string,
  ): Promise<SharedFileSnapshot | SharedFileSnapshot[] | null>;

  /* ---------------------------------------------------------------- record-level reads and writes */

  /**
   * The active link with the share id, as stored (legacy fields such as `isPublic` included), in
   * the tenant of the current context; `null` when absent.
   */
  findActiveSharedLinkRecord(shareId: string): Promise<SharedLinkRecord | null>;
  /** The link with the record id, expired or not, as stored; `null` when absent. */
  getSharedLinkRecord(id: IdLike): Promise<SharedLinkRecord | null>;
  /**
   * The record id and owner of the link with the record id, expired or not; `null` when absent.
   * Rejects when `id` is not an id the store could have generated.
   */
  getSharedLinkOwner(id: IdLike): Promise<Pick<SharedLinkRecord, '_id' | 'user'> | null>;
  /**
   * The record id and conversation of the user's link with the share id, expired or not; `null`
   * when the user has no such link.
   */
  getOwnSharedLinkConversation(
    user: string,
    shareId: string,
  ): Promise<Pick<SharedLinkRecord, '_id' | 'conversationId'> | null>;
  /**
   * The record ids of the owner's links (expired or not): every link of `user`, or only those of
   * `conversationId` when the criteria carry that key.
   */
  listSharedLinkRecordIds(criteria: SharedLinkOwnerCriteria): Promise<IdLike[]>;
  /** Deletes the user's link with the share id (expired or not), resolving it as stored. */
  takeOwnSharedLinkRecord(user: string, shareId: string): Promise<SharedLinkRecord | null>;
  /** Deletes the link with the record id. */
  deleteSharedLinkRecord(id: IdLike): Promise<DeleteCount>;
  /** Deletes the owner's links (expired or not), with the criteria of `listSharedLinkRecordIds`. */
  deleteSharedLinkRecords(criteria: SharedLinkOwnerCriteria): Promise<DeleteCount>;
  /**
   * Removes the legacy `isPublic` flag from the link with the record id (the id value the store
   * handed out), once the grants that replace it exist. Not scoped to a tenant: the link is
   * addressed by its id alone.
   */
  clearLegacySharedLinkVisibility(id: IdLike): Promise<void>;
}

/** Every method of {@link SharedLinkStore}, for adapters and conformance checks. */
export const SHARED_LINK_STORE_METHODS: ReadonlyArray<keyof SharedLinkStore> =
  listPortMethods<SharedLinkStore>({
    getSharedLink: true,
    getSharedLinks: true,
    createSharedLink: true,
    updateSharedLink: true,
    deleteSharedLink: true,
    deleteAllSharedLinks: true,
    deleteConvoSharedLink: true,
    getSharedMessages: true,
    getSharedLinkFile: true,
    backfillSharedLinkFiles: true,
    findActiveSharedLinkRecord: true,
    getSharedLinkRecord: true,
    getSharedLinkOwner: true,
    getOwnSharedLinkConversation: true,
    listSharedLinkRecordIds: true,
    takeOwnSharedLinkRecord: true,
    deleteSharedLinkRecord: true,
    deleteSharedLinkRecords: true,
    clearLegacySharedLinkVisibility: true,
  });

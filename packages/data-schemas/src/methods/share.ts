import { Types } from 'mongoose';
import type { FilterQuery, Model } from 'mongoose';
import type { SharedLinkContentPreflight, GetSharedMessagesOptions } from '~/types/share';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import type { DeleteCount, IdLike } from '~/ports/common';
import type { ShareStorageSteps } from './shareRules';
import type * as t from '~/types';
import { SHARE_FILE_SNAPSHOT_FIELDS, ShareServiceError, createShareProtocol } from './shareRules';
import { activeExpirationFilter } from '~/utils/retention';
import { MEILI_SEARCH_LIMIT } from '~/common/search';
import { CLIENT_MESSAGE_SELECT } from './message';
import logger from '~/config/winston';

export type {
  SharedMessagesPreflight,
  GetSharedMessagesOptions,
  SharedLinkContentSnapshot,
  SharedLinkContentPreflight,
} from '~/types/share';
export { anonymizeSharedContent } from './shareRules';

/** Factory function that takes mongoose instance and returns the methods */
export function createShareMethods(mongoose: typeof import('mongoose')): {
  getSharedLink: (user: string, conversationId: string) => Promise<t.GetShareLinkResult>;
  getSharedLinks: (
    user: string,
    pageParam?: Date | string,
    pageSize?: number,
    sortBy?: string,
    sortDirection?: string,
    search?: string,
  ) => Promise<t.SharedLinksResult>;
  createSharedLink: (
    user: string,
    conversationId: string,
    targetMessageId?: string,
    expiredAt?: Date,
    snapshotFiles?: boolean,
    preflight?: SharedLinkContentPreflight,
  ) => Promise<t.CreateShareResult>;
  updateSharedLink: (
    user: string,
    shareId: string,
    targetMessageId?: string,
    expiredAt?: Date | null,
    snapshotFiles?: boolean,
    preflight?: SharedLinkContentPreflight,
    beforePublish?: () => void | Promise<void>,
  ) => Promise<t.UpdateShareResult>;
  deleteSharedLink: (user: string, shareId: string) => Promise<t.DeleteShareResult | null>;
  getSharedMessages: (
    shareId: string,
    shareObjectId?: string,
    options?: GetSharedMessagesOptions,
  ) => Promise<t.SharedMessagesResult | null>;
  getSharedLinkFile: (
    shareId: string,
    fileId: string,
  ) => Promise<{ file: t.SharedFileSnapshot | null; hasSnapshots: boolean; optedOut: boolean }>;
  backfillSharedLinkFiles: (
    shareId: string,
    fileId?: string,
  ) => Promise<t.SharedFileSnapshot | t.SharedFileSnapshot[] | null>;
  deleteAllSharedLinks: (
    user: string,
  ) => Promise<t.DeleteAllSharesResult & { deletedIds: string[] }>;
  deleteConvoSharedLink: (
    user: string,
    conversationId: string,
  ) => Promise<t.DeleteAllSharesResult & { deletedIds: string[] }>;
  findActiveSharedLinkRecord: (shareId: string) => Promise<t.SharedLinkRecord | null>;
  getSharedLinkRecord: (id: IdLike) => Promise<t.SharedLinkRecord | null>;
  getSharedLinkOwner: (id: IdLike) => Promise<Pick<t.SharedLinkRecord, '_id' | 'user'> | null>;
  getOwnSharedLinkConversation: (
    user: string,
    shareId: string,
  ) => Promise<Pick<t.SharedLinkRecord, '_id' | 'conversationId'> | null>;
  listSharedLinkRecordIds: (criteria: t.SharedLinkOwnerCriteria) => Promise<IdLike[]>;
  takeOwnSharedLinkRecord: (user: string, shareId: string) => Promise<t.SharedLinkRecord | null>;
  deleteSharedLinkRecord: (id: IdLike) => Promise<DeleteCount>;
  deleteSharedLinkRecords: (criteria: t.SharedLinkOwnerCriteria) => Promise<DeleteCount>;
  clearLegacySharedLinkVisibility: (id: IdLike) => Promise<void>;
} {
  /**
   * The storage of the composite methods (`./shareRules`): the queries these methods ran before
   * the rules moved out, in the same order, with the same options.
   */
  const steps: ShareStorageSteps = {
    readOwnerFiles: (fileIds, ownerId) => {
      const File = mongoose.models.File as Model<t.IMongoFile>;
      return File.find({ file_id: { $in: fileIds }, user: ownerId })
        .select(SHARE_FILE_SNAPSHOT_FIELDS)
        .lean();
    },
    readViewedShare: async (shareId, shareObjectId) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const query = shareObjectId
        ? SharedLink.findOne({ _id: shareObjectId, ...activeExpirationFilter<t.ISharedLink>() })
        : SharedLink.findOne({ shareId, ...activeExpirationFilter<t.ISharedLink>() });

      return (await query
        .populate({
          path: 'messages',
          select: `${CLIENT_MESSAGE_SELECT.replace(' -privateTextTokens', '')} +privateTextTokens`,
        })
        .select('-__v')
        .lean()) as (t.ISharedLink & { messages: t.IMessage[] }) | null;
    },
    readBackfillShare: async (shareId) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return (await SharedLink.findOne({
        shareId,
        ...activeExpirationFilter<t.ISharedLink>(),
      })
        .populate({ path: 'messages', select: '-_id -__v -user' })
        .lean()) as (t.ISharedLink & { messages: t.IMessage[] }) | null;
    },
    writeSnapshotsIfAbsent: async (key, fileSnapshots) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const result = await SharedLink.updateOne(
        {
          ...(key as FilterQuery<t.ISharedLink>),
          fileSnapshots: { $exists: false },
          snapshotFiles: { $ne: false },
        },
        { $set: { fileSnapshots } },
        { timestamps: false },
      );
      return result.modifiedCount > 0;
    },
    readSnapshotState: (key) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return SharedLink.findOne(key as FilterQuery<t.ISharedLink>)
        .select('fileSnapshots snapshotFiles')
        .lean();
    },
    writeEnrichedSnapshots: async (id, expected, fileSnapshots) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      await SharedLink.updateOne(
        {
          _id: id,
          fileSnapshots: expected,
          snapshotFiles: { $ne: false },
        } as FilterQuery<t.ISharedLink>,
        { $set: { fileSnapshots } },
        { timestamps: false },
      );
    },
    findActiveShare: ({ conversationId, user, targetMessageId }) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return SharedLink.findOne({
        conversationId,
        user,
        ...activeExpirationFilter<t.ISharedLink>(),
        ...(targetMessageId && { targetMessageId }),
      })
        .select('-_id -__v -user')
        .lean() as Promise<t.ISharedLink | null>;
    },
    readConversationMessages: async (conversationId, user) => {
      const Message = mongoose.models.Message as SchemaWithMeiliMethods;
      return (await Message.find({ conversationId, user })
        .select('+privateTextTokens')
        .sort({ createdAt: 1 })
        .lean()) as unknown as t.IMessage[];
    },
    readConversation: async (conversationId, user) => {
      const Conversation = mongoose.models.Conversation as SchemaWithMeiliMethods;
      return (await Conversation.findOne({ conversationId, user }).lean()) as {
        title?: string;
      } | null;
    },
    insertShare: (link) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return SharedLink.create(link);
    },
    listActiveRivals: async ({ conversationId, user, targetMessageId }, excludeId) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return (await SharedLink.find({
        conversationId,
        user,
        _id: { $ne: excludeId },
        ...activeExpirationFilter<t.ISharedLink>(),
        ...(targetMessageId && { targetMessageId }),
      })
        .select('_id createdAt')
        .lean()) as Array<Pick<t.ISharedLink, '_id' | 'createdAt'>>;
    },
    deleteShare: async (id) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      await SharedLink.deleteOne({ _id: id } as FilterQuery<t.ISharedLink>);
    },
    readOwnShare: async (shareId, user) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return (await SharedLink.findOne({ shareId, user })
        .select('-_id -__v -user')
        .lean()) as t.ISharedLink | null;
    },
    writeOwnShare: async (shareId, user, update) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return (await SharedLink.findOneAndUpdate({ shareId, user }, update, {
        new: true,
        upsert: false,
        runValidators: true,
      }).lean()) as t.ISharedLink | null;
    },
    searchConversations: (search, user) => {
      const Conversation = mongoose.models.Conversation as SchemaWithMeiliMethods;
      return Conversation.meiliSearch(search, {
        filter: `user = "${user}"`,
        limit: MEILI_SEARCH_LIMIT,
        attributesToRetrieve: ['conversationId'],
      });
    },
    findLinksPage: (filter, sort, limit) => {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      return SharedLink.find(filter as FilterQuery<t.ISharedLink>)
        .sort(sort)
        .limit(limit)
        .select('-__v -user')
        .lean();
    },
    toId: (id) => new Types.ObjectId(id),
  };
  const {
    getSharedMessages,
    getSharedLinks,
    createSharedLink,
    updateSharedLink,
    backfillSharedLinkFiles,
  } = createShareProtocol(steps);

  /**
   * Delete all shared links for a user
   */
  async function deleteAllSharedLinks(
    user: string,
  ): Promise<t.DeleteAllSharesResult & { deletedIds: string[] }> {
    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const links = await SharedLink.find({ user }).select('_id').lean();
      const ids = links.map((l) => l._id.toString());
      const result = await SharedLink.deleteMany({ user });
      return {
        message: 'All shared links deleted successfully',
        deletedCount: result.deletedCount,
        deletedIds: ids,
      };
    } catch (error) {
      logger.error('[deleteAllSharedLinks] Error deleting shared links', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
      });
      throw new ShareServiceError('Error deleting shared links', 'BULK_DELETE_ERROR');
    }
  }

  /**
   * Delete shared links by conversation ID
   */
  async function deleteConvoSharedLink(
    user: string,
    conversationId: string,
  ): Promise<t.DeleteAllSharesResult & { deletedIds: string[] }> {
    if (!user || !conversationId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const links = await SharedLink.find({ user, conversationId }).select('_id').lean();
      const ids = links.map((l) => l._id.toString());
      const result = await SharedLink.deleteMany({ user, conversationId });
      return {
        message: 'Shared links deleted successfully',
        deletedCount: result.deletedCount,
        deletedIds: ids,
      };
    } catch (error) {
      logger.error('[deleteConvoSharedLink] Error deleting shared links', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        conversationId,
      });
      throw new ShareServiceError('Error deleting shared links', 'SHARE_DELETE_ERROR');
    }
  }

  /**
   * Get a shared link for a conversation
   */
  async function getSharedLink(
    user: string,
    conversationId: string,
  ): Promise<t.GetShareLinkResult> {
    if (!user || !conversationId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const share = (await SharedLink.findOne({
        conversationId,
        user,
        ...activeExpirationFilter<t.ISharedLink>(),
      })
        .select('shareId targetMessageId snapshotFiles _id')
        .sort({ updatedAt: -1 })
        .lean()) as {
        shareId?: string;
        targetMessageId?: string;
        snapshotFiles?: boolean;
        _id?: import('mongoose').Types.ObjectId;
      } | null;

      if (!share) {
        return { shareId: null, success: false };
      }

      return {
        _id: share._id?.toString(),
        shareId: share.shareId || null,
        targetMessageId: share.targetMessageId,
        snapshotFiles: share.snapshotFiles,
        success: true,
      };
    } catch (error) {
      logger.error('[getSharedLink] Error getting shared link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        conversationId,
      });
      throw new ShareServiceError('Error getting shared link', 'SHARE_FETCH_ERROR');
    }
  }

  /**
   * Delete a shared link
   */
  async function deleteSharedLink(
    user: string,
    shareId: string,
  ): Promise<t.DeleteShareResult | null> {
    if (!user || !shareId) {
      throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
    }

    try {
      const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
      const result = await SharedLink.findOneAndDelete({ shareId, user }).lean();

      if (!result) {
        return null;
      }

      return {
        _id: result._id?.toString(),
        success: true,
        shareId,
        message: 'Share deleted successfully',
      };
    } catch (error) {
      logger.error('[deleteSharedLink] Error deleting shared link', {
        error: error instanceof Error ? error.message : 'Unknown error',
        user,
        shareId,
      });
      throw new ShareServiceError('Error deleting shared link', 'SHARE_DELETE_ERROR');
    }
  }

  /**
   * Resolve a single file snapshot entry for a shared link, used by the
   * share-scoped file routes to authorize a file without the owner's ACL.
   * `hasSnapshots` distinguishes a legacy share (field absent → caller may
   * backfill) from an ordinary miss (field present but file not in it → 404,
   * no rebuild). `optedOut` is the per-link "share files" choice — when true the
   * route must 404 and never backfill, so an opted-out link can't expose files.
   */
  async function getSharedLinkFile(
    shareId: string,
    fileId: string,
  ): Promise<{ file: t.SharedFileSnapshot | null; hasSnapshots: boolean; optedOut: boolean }> {
    const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
    const share = (await SharedLink.findOne({
      shareId,
      ...activeExpirationFilter<t.ISharedLink>(),
    })
      .select('fileSnapshots snapshotFiles')
      .lean()) as Pick<t.ISharedLink, 'fileSnapshots' | 'snapshotFiles'> | null;

    if (!share) {
      return { file: null, hasSnapshots: false, optedOut: false };
    }

    const hasSnapshots = share.fileSnapshots !== undefined;
    const optedOut = share.snapshotFiles === false;
    const file = share.fileSnapshots?.find((snapshot) => snapshot.file_id === fileId) ?? null;
    return { file, hasSnapshots, optedOut };
  }

  /*
   * Record-level reads and writes for the shared-link ACL layer (`packages/api` shared-links):
   * each is one query, run as given, and rethrows the database's error unchanged.
   */

  /** The criteria of an owner's links: `user`, and `conversationId` when the key is present. */
  const ownerFilter = (criteria: t.SharedLinkOwnerCriteria): FilterQuery<t.ISharedLink> =>
    'conversationId' in criteria
      ? { user: criteria.user, conversationId: criteria.conversationId }
      : { user: criteria.user };

  /** The active (unexpired) link with the share id, as stored, legacy fields included. */
  async function findActiveSharedLinkRecord(shareId: string): Promise<t.SharedLinkRecord | null> {
    const SharedLink = mongoose.models.SharedLink as Model<t.SharedLinkRecord>;
    return (await SharedLink.findOne({
      shareId,
      ...activeExpirationFilter<t.SharedLinkRecord>(),
    }).lean()) as t.SharedLinkRecord | null;
  }

  /** The link with the record id (expired or not), as stored, legacy fields included. */
  async function getSharedLinkRecord(id: IdLike): Promise<t.SharedLinkRecord | null> {
    const SharedLink = mongoose.models.SharedLink as Model<t.SharedLinkRecord>;
    return (await SharedLink.findById(id).lean()) as t.SharedLinkRecord | null;
  }

  /** The owner of the link with the record id (expired or not). */
  async function getSharedLinkOwner(
    id: IdLike,
  ): Promise<Pick<t.SharedLinkRecord, '_id' | 'user'> | null> {
    const SharedLink = mongoose.models.SharedLink as Model<t.SharedLinkRecord>;
    return (await SharedLink.findById(id, 'user').lean()) as Pick<
      t.SharedLinkRecord,
      '_id' | 'user'
    > | null;
  }

  /** The conversation of the user's link with the share id (expired or not). */
  async function getOwnSharedLinkConversation(
    user: string,
    shareId: string,
  ): Promise<Pick<t.SharedLinkRecord, '_id' | 'conversationId'> | null> {
    const SharedLink = mongoose.models.SharedLink as Model<t.SharedLinkRecord>;
    return (await SharedLink.findOne({ shareId, user }, 'conversationId').lean()) as Pick<
      t.SharedLinkRecord,
      '_id' | 'conversationId'
    > | null;
  }

  /** The record ids of the owner's links (expired or not). */
  async function listSharedLinkRecordIds(criteria: t.SharedLinkOwnerCriteria): Promise<IdLike[]> {
    const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
    const links = await SharedLink.find(ownerFilter(criteria)).select('_id').lean();
    return links.map((link) => link._id as Types.ObjectId);
  }

  /** Deletes the user's link with the share id (expired or not) and resolves it as stored. */
  async function takeOwnSharedLinkRecord(
    user: string,
    shareId: string,
  ): Promise<t.SharedLinkRecord | null> {
    const SharedLink = mongoose.models.SharedLink as Model<t.SharedLinkRecord>;
    return (await SharedLink.findOneAndDelete({
      shareId,
      user,
    }).lean()) as t.SharedLinkRecord | null;
  }

  /** Deletes the link with the record id. */
  async function deleteSharedLinkRecord(id: IdLike): Promise<DeleteCount> {
    const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
    return SharedLink.deleteOne({ _id: id } as FilterQuery<t.ISharedLink>);
  }

  /** Deletes the owner's links (expired or not). */
  async function deleteSharedLinkRecords(
    criteria: t.SharedLinkOwnerCriteria,
  ): Promise<DeleteCount> {
    const SharedLink = mongoose.models.SharedLink as Model<t.ISharedLink>;
    return SharedLink.deleteMany(ownerFilter(criteria));
  }

  /**
   * Removes the legacy `isPublic` flag from the link with the record id, once its grants exist.
   * The flag is outside the schema, so the write goes to the `sharedlinks` collection directly
   * (no schema casting, no middleware): the id must be the stored id value.
   */
  async function clearLegacySharedLinkVisibility(id: IdLike): Promise<void> {
    await mongoose.connection
      .db!.collection('sharedlinks')
      .updateOne({ _id: id as Types.ObjectId }, { $unset: { isPublic: 1 } });
  }

  // Return all methods
  return {
    getSharedLink,
    getSharedLinks,
    createSharedLink,
    updateSharedLink,
    deleteSharedLink,
    getSharedMessages,
    getSharedLinkFile,
    backfillSharedLinkFiles,
    deleteAllSharedLinks,
    deleteConvoSharedLink,
    findActiveSharedLinkRecord,
    getSharedLinkRecord,
    getSharedLinkOwner,
    getOwnSharedLinkConversation,
    listSharedLinkRecordIds,
    takeOwnSharedLinkRecord,
    deleteSharedLinkRecord,
    deleteSharedLinkRecords,
    clearLegacySharedLinkVisibility,
  };
}

export type ShareMethods = ReturnType<typeof createShareMethods>;

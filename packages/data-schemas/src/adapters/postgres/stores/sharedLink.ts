/**
 * The PostgreSQL `SharedLinkStore` (`~/ports/share`) on the `sharedlinks` table, through the
 * collection primitive. The composite methods (`getSharedMessages`, `getSharedLinks`,
 * `createSharedLink`, `updateSharedLink`, `backfillSharedLinkFiles`) are the rules of
 * `~/methods/shareRules` on the storage steps below; the others are one primitive operation each.
 * Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Typed storage (docs/postgres-port/PHASE4.md §1.4): `fileSnapshots` is the child table
 * `sharedlinks__fileSnapshots` (absent versus empty kept by its shape column: a link that predates
 * snapshots has none, an opted-out or empty one `[]`), `messages` an `lc_object_id[]` column, and
 * the legacy `isPublic` flag lives in `_extra` (D7): document-mode reads return it as MongoDB's
 * lean reads do, and `clearLegacySharedLinkVisibility` unsets it through the raw collection, by the
 * link's id alone (no tenant), as MongoDB writes it through the driver.
 *
 * - The public view reads the link's messages by reference (MongoDB's `populate`): one read of
 *   the messages table by the stored ids, scoped to the active tenant as the populate query is,
 *   handed back in the link's order with missing messages dropped.
 * - The snapshot enrichment is a compare-and-set on the stored snapshot, a condition the query
 *   language cannot state (equality of a subdocument array with a value): the link's row is
 *   locked, its snapshot re-read in the next statement and compared by value (mongoose casts the
 *   filter value through the subdocument schema, so MongoDB compares it whatever key order it was
 *   written in), then written in the same transaction.
 * - Creates of one user's links for one conversation insert under a transaction-level advisory
 *   lock on the pair, so the rules' post-insert rival check (MongoDB's way of resolving racing
 *   creates) always keeps exactly one: the later insert sees the earlier one committed and an
 *   earlier `createdAt` (ids break a tie within a millisecond).
 * - The owner list's conversation search (MeiliSearch, D4) comes with I3: until then a search
 *   fails as a MongoDB deployment without MeiliSearch does, and the rules read it as an empty page.
 */
import { sql } from 'kysely';
import type { ShareStorageSteps, ShareFileRecord, ShareSnapshotKey } from '~/methods/shareRules';
import type { PgFilter, PgRecord } from '../collection';
import type { PostgresStoreContext } from './context';
import type { SharedLinkStore } from '~/ports/share';
import type * as t from '~/types';
import {
  SHARE_FILE_SNAPSHOT_FIELDS,
  ShareServiceError,
  createShareProtocol,
} from '~/methods/shareRules';
import { activeExpirationFilter } from '~/utils/retention';
import { CLIENT_MESSAGE_SELECT } from '~/ports/message';
import { SearchNotConfiguredError } from '../search';
import { MEILI_SEARCH_LIMIT } from '~/common/search';
import { runStoreSql, storeWhere } from './context';
import { valuesEqual } from '../evaluator';
import logger from '~/config/winston';

type LinkRow = t.SharedLinkRecord & PgRecord;
type LinkWithMessages = t.ISharedLink & { messages: t.IMessage[] };

/** The public view's message fields (the client projection plus the private text tokens), and `_id`. */
const VIEWED_MESSAGE_PROJECTION = `${CLIENT_MESSAGE_SELECT.replace('-_id ', '').replace(
  ' -privateTextTokens',
  '',
)} +privateTextTokens`;
/** The backfill's message fields (all but `__v` and `user`), and `_id`. */
const BACKFILL_MESSAGE_PROJECTION = '-__v -user';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]';

/** `value` with every object's keys in one order and `undefined` members dropped. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      result[key] = canonical(value[key]);
    }
  }
  return result;
}

/** The criteria of an owner's links: `user`, and `conversationId` when the key is present. */
const ownerFilter = (criteria: t.SharedLinkOwnerCriteria): PgFilter =>
  'conversationId' in criteria
    ? { user: criteria.user, conversationId: criteria.conversationId }
    : { user: criteria.user };

const idsOf = (messages: ReadonlyArray<{ _id?: unknown }>): string[] =>
  messages.map((message) => String(message._id));

export function createPostgresSharedLinkStore(context: PostgresStoreContext): SharedLinkStore {
  const links = () => context.collections().collection<LinkRow>('sharedlinks');
  const messages = () => context.collections().collection('messages');

  /** The messages with the link's stored ids, in the link's order, without `_id`. */
  async function readLinkedMessages(
    link: LinkRow,
    projection: string,
    keepId: boolean,
  ): Promise<t.IMessage[]> {
    const ids = ((link.messages as unknown[] | undefined) ?? []).map(String);
    if (ids.length === 0) {
      return [];
    }
    const found = await messages().find({ _id: { $in: ids } }, { projection });
    const byId = new Map(found.map((message) => [String(message._id), message]));
    const ordered: t.IMessage[] = [];
    for (const id of ids) {
      const message = byId.get(id);
      if (message == null) {
        continue;
      }
      if (keepId) {
        ordered.push(message as unknown as t.IMessage);
        continue;
      }
      const { _id: _omitted, ...rest } = message;
      ordered.push(rest as unknown as t.IMessage);
    }
    return ordered;
  }

  const steps: ShareStorageSteps = {
    async readOwnerFiles(fileIds, ownerId) {
      return (await context
        .collections()
        .collection('files')
        .find(
          { file_id: { $in: fileIds }, user: ownerId },
          { projection: SHARE_FILE_SNAPSHOT_FIELDS },
        )) as unknown as ShareFileRecord[];
    },

    async readViewedShare(shareId, shareObjectId) {
      const filter = shareObjectId
        ? { _id: shareObjectId, ...activeExpirationFilter() }
        : { shareId, ...activeExpirationFilter() };
      const link = await links().findOne(filter, { projection: '-__v' });
      if (!link) {
        return null;
      }
      return {
        ...link,
        messages: await readLinkedMessages(link, VIEWED_MESSAGE_PROJECTION, false),
      } as unknown as LinkWithMessages;
    },

    async readBackfillShare(shareId) {
      const link = await links().findOne({ shareId, ...activeExpirationFilter() });
      if (!link) {
        return null;
      }
      return {
        ...link,
        messages: await readLinkedMessages(link, BACKFILL_MESSAGE_PROJECTION, false),
      } as unknown as LinkWithMessages;
    },

    async writeSnapshotsIfAbsent(key, fileSnapshots) {
      const result = await links().updateOne(
        { ...key, fileSnapshots: { $exists: false }, snapshotFiles: { $ne: false } },
        { $set: { fileSnapshots } },
        { timestamps: false },
      );
      return result.modifiedCount > 0;
    },

    async readSnapshotState(key: ShareSnapshotKey) {
      return (await links().findOne(key, {
        projection: 'fileSnapshots snapshotFiles',
      })) as Pick<t.ISharedLink, 'fileSnapshots' | 'snapshotFiles'> | null;
    },

    async writeEnrichedSnapshots(id, expected, fileSnapshots) {
      const linkId = String(id);
      await context.transactions.transaction(async (tx) => {
        const locked = await runStoreSql(
          context,
          sql`SELECT t._id FROM sharedlinks t WHERE ${storeWhere(context, 'sharedlinks', {
            _id: linkId,
            snapshotFiles: { $ne: false },
          })} FOR UPDATE`,
          tx,
        );
        if (locked.rows.length === 0) {
          return;
        }
        const current = await links().findOne({ _id: linkId }, { projection: 'fileSnapshots', tx });
        if (
          current?.fileSnapshots === undefined ||
          !valuesEqual(canonical(current.fileSnapshots), canonical(expected))
        ) {
          return;
        }
        await links().updateOne(
          { _id: linkId, snapshotFiles: { $ne: false } },
          { $set: { fileSnapshots } },
          { timestamps: false, tx },
        );
      });
    },

    async findActiveShare({ conversationId, user, targetMessageId }) {
      return links().findOne(
        {
          conversationId,
          user,
          ...activeExpirationFilter(),
          ...(targetMessageId && { targetMessageId }),
        },
        { projection: '-_id -__v -user' },
      );
    },

    async readConversationMessages(conversationId, user) {
      return (await messages().find(
        { conversationId, user },
        { projection: '+privateTextTokens', sort: { createdAt: 1 } },
      )) as unknown as t.IMessage[];
    },

    async readConversation(conversationId, user) {
      return (await context
        .collections()
        .collection('conversations')
        .findOne({ conversationId, user })) as { title?: string } | null;
    },

    async insertShare(link) {
      /**
       * Inserts of one user's links for one conversation are serialized (a transaction-level
       * advisory lock on the pair), so a later insert always carries a later `createdAt` (or,
       * within the same millisecond, a later id) and sees every earlier one committed: of racing
       * creates, the rules' rival check then keeps exactly the first.
       */
      const created = await context.transactions.transaction(async (tx) => {
        await runStoreSql(
          context,
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`librechat:sharedlinks:${JSON.stringify(
            [link.user, link.conversationId],
          )}`}, 0))`,
          tx,
        );
        return links().insertOne({ ...link, messages: idsOf(link.messages) }, { tx });
      });
      return { _id: created._id, createdAt: created.createdAt as Date | undefined };
    },

    async listActiveRivals({ conversationId, user, targetMessageId }, excludeId) {
      return (await links().find(
        {
          conversationId,
          user,
          _id: { $ne: excludeId },
          ...activeExpirationFilter(),
          ...(targetMessageId && { targetMessageId }),
        },
        { projection: '_id createdAt' },
      )) as Array<Pick<t.ISharedLink, 'createdAt'> & { _id: unknown }>;
    },

    async deleteShare(id) {
      await links().deleteOne({ _id: id });
    },

    async readOwnShare(shareId, user) {
      return (await links().findOne(
        { shareId, user },
        { projection: '-_id -__v -user' },
      )) as t.ISharedLink | null;
    },

    async writeOwnShare(shareId, user, update) {
      const set = update.$set as { messages?: t.IMessage[] } & Record<string, unknown>;
      const stored = {
        ...update,
        $set: { ...set, ...(set.messages && { messages: idsOf(set.messages) }) },
      };
      return (await links().findOneAndUpdate({ shareId, user }, stored, {
        returnDocument: 'after',
        runValidators: true,
      })) as t.ISharedLink | null;
    },

    async searchConversations(search, user) {
      /** The conversation search on MeiliSearch (`../search`), as MongoDB's; it throws while
       * MeiliSearch is not configured, which the rules read as an empty page. */
      const searchIndex = context.search;
      if (!searchIndex?.configured()) {
        throw new SearchNotConfiguredError();
      }
      return searchIndex.search('conversations', search, {
        filter: `user = "${user}"`,
        limit: MEILI_SEARCH_LIMIT,
        attributesToRetrieve: ['conversationId'],
      });
    },

    async findLinksPage(filter, sort, limit) {
      return (await links().find(filter, {
        sort,
        limit,
        projection: '-__v -user',
      })) as t.ISharedLink[];
    },

    toId: (id) => id,
  };
  const protocol = createShareProtocol(steps);

  const store: SharedLinkStore = {
    ...protocol,

    async getSharedLink(user, conversationId) {
      if (!user || !conversationId) {
        throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
      }
      try {
        const share = await links().findOne(
          { conversationId, user, ...activeExpirationFilter() },
          { projection: 'shareId targetMessageId snapshotFiles _id', sort: { updatedAt: -1 } },
        );
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
    },

    async deleteSharedLink(user, shareId) {
      if (!user || !shareId) {
        throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
      }
      try {
        const result = await links().findOneAndDelete({ shareId, user });
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
    },

    async deleteAllSharedLinks(user) {
      try {
        const found = await links().find({ user }, { projection: '_id' });
        const ids = found.map((link) => String(link._id));
        const result = await links().deleteMany({ user });
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
    },

    async deleteConvoSharedLink(user, conversationId) {
      if (!user || !conversationId) {
        throw new ShareServiceError('Missing required parameters', 'INVALID_PARAMS');
      }
      try {
        const found = await links().find({ user, conversationId }, { projection: '_id' });
        const ids = found.map((link) => String(link._id));
        const result = await links().deleteMany({ user, conversationId });
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
    },

    async getSharedLinkFile(shareId, fileId) {
      const share = await links().findOne(
        { shareId, ...activeExpirationFilter() },
        { projection: 'fileSnapshots snapshotFiles' },
      );
      if (!share) {
        return { file: null, hasSnapshots: false, optedOut: false };
      }
      const hasSnapshots = share.fileSnapshots !== undefined;
      const optedOut = share.snapshotFiles === false;
      const file = share.fileSnapshots?.find((snapshot) => snapshot.file_id === fileId) ?? null;
      return { file, hasSnapshots, optedOut };
    },

    async findActiveSharedLinkRecord(shareId) {
      return links().findOne({ shareId, ...activeExpirationFilter() });
    },

    async getSharedLinkRecord(id) {
      return links().findOne({ _id: id });
    },

    async getSharedLinkOwner(id) {
      return links().findOne({ _id: id }, { projection: 'user' });
    },

    async getOwnSharedLinkConversation(user, shareId) {
      return links().findOne({ shareId, user }, { projection: 'conversationId' });
    },

    async listSharedLinkRecordIds(criteria) {
      const found = await links().find(ownerFilter(criteria), { projection: '_id' });
      return found.map((link) => String(link._id));
    },

    async takeOwnSharedLinkRecord(user, shareId) {
      return links().findOneAndDelete({ shareId, user });
    },

    async deleteSharedLinkRecord(id) {
      return links().deleteOne({ _id: id });
    },

    async deleteSharedLinkRecords(criteria) {
      return links().deleteMany(ownerFilter(criteria));
    },

    async clearLegacySharedLinkVisibility(id) {
      await context
        .collections()
        .raw('sharedlinks')
        .updateOne({ _id: id }, { $unset: { isPublic: 1 } });
    },
  };
  return store;
}

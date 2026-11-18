/**
 * The PostgreSQL `ConversationStore` (`~/ports/conversation`) on the `conversations` table,
 * through the collection primitive, with the shared rules of `~/methods/conversationRules`
 * (filters, updates, validation, record shapes, the sidebar's paging plan) and
 * `~/methods/chatProjectRules` (a project's statistics). Also the conversation module's four
 * domain functions, `saveConvo`, `bulkSaveConvos`, `deleteConvos` and `searchConversation`,
 * written once on the store's steps (`~/methods/saveConvo` and its siblings), as on MongoDB.
 * Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Typed storage (docs/postgres-port/PHASE4.md §1.4): `codeWorkspaces` is a child table (its
 * `$elemMatch`, `$size: 0` and `$in: [null]` conditions are `EXISTS` and the element count);
 * `messages`, `tags`, `files` and `toolApprovalAllows` are `T[]` columns; `laneGit` and the other
 * single subdocuments are flattened columns. The subagent threads and the agent event actor are
 * in `./conversationActor`, the helpers shared with it in `./conversationSupport`.
 *
 * Hand-written SQL (through `storeWhere`/`runStoreSql`):
 * - `getConvoLaneContext`: the thread and its visible root in one statement (a `LEFT JOIN
 *   LATERAL` narrowed to the same owner, tenant and visibility, as the MongoDB `$lookup`), so the
 *   epoch cannot move between two reads;
 * - `addConvoToolApprovalAllows`: the bound on the union of the stored names and the new ones
 *   (MongoDB's `$expr` with `$setUnion`) checked on the row it locks, then the `$addToSet`;
 * - `countConvosByUser`: `GROUP BY "user"`; and the journal metrics in `./conversationActor`.
 *
 * Guarded writes the query language cannot state compare on the locked row
 * (`writeCheckedConversation`): `replaceConvoCodeEnvironmentDecision` compares the stored
 * workspaces (a subdocument array) with the expected ones by value.
 *
 * Paging: the sidebar (`getConvosByCursor`) is the primitive's `find` with the shared filter,
 * sort and cursor plan (`updatedAt` desc then `_id` by default); `archiveAllConvos` walks keyset
 * pages of 500 on `_id`; nothing holds a cursor across awaits.
 *
 * Other collections a conversation write carries along are reached directly (an adapter may read
 * any table): the messages (their ids, a forced retention stamp, the message-file facet, a
 * deletion's message cleanup and subagent content), the shared links, the bookmark counts, the
 * remembered tool approvals, the chat projects and the trigger deliveries protecting a receipt.
 * The queued turns and trigger delivery results a deletion retires come from the composition
 * (`ConversationFactoryDeps`), as on MongoDB. The title search (MeiliSearch) comes with I3.
 */
import { sql } from 'kysely';
import { isForcedTemporaryRetention } from 'librechat-data-provider';
import type { ConversationDomainFunctions, ConversationFactoryDeps } from '~/compose/types';
import type { ConvoBulkUpsertResult, IConversation, UserRecordCount } from '~/types';
import type { ConversationMethods } from '~/methods/conversation';
import type { DeleteConvosDeps } from '~/methods/deleteConvos';
import type { PgBulkOperation, PgRecord } from '../collection';
import type { ConversationStore } from '~/ports/conversation';
import type { ConversationRow } from './conversationSupport';
import type { PostgresStoreContext } from './context';
import {
  laneGitFences,
  laneGitReport,
  laneGitViewOf,
  laneContextOf,
  convoListSort,
  replyStampOf,
  convoPageSize,
  convoListOrder,
  sameLaneFilter,
  nextConvoCursor,
  convoWriteFilter,
  queriedConvoPage,
  replyStampUpdate,
  CONVO_LIST_FIELDS,
  unsetExpiryFilter,
  toDeletionTargets,
  convoCursorFilter,
  archiveSweepFilter,
  messageFileFilter,
  sharedLinksAllowed,
  convoWriteOperation,
  replyStampCasFilter,
  DEFAULT_CONVO_PAGE_SIZE,
  UNREAD_STATE_PROJECTION,
  DELETION_TARGET_FIELDS,
  convoListFacetFilters,
  convoFilesFacetFilter,
  CONVO_BY_ID_PROJECTIONS,
  LANE_GIT_WRITE_ATTEMPTS,
  toolApprovalAllowNames,
  humanConversationFilter,
  threadTenantFilter,
  codeEnvironmentReplacement,
  REPLY_STAMP_STATE_PROJECTION,
  ARCHIVE_CONVERSATION_BATCH_SIZE,
  LAST_RESPONSE_STAMP_PROJECTION,
  PROJECT_DISCOVERY_MAX_ATTEMPTS,
  undecidedCodeEnvironmentFilter,
  visibleConversationRetentionFilter,
  searchHitConversationIds,
  convoSearchParams,
} from '~/methods/conversationRules';
import {
  conversationTables,
  decrementTagCounts,
  matchesStoredState,
  createChatProjectStats,
  writeCheckedConversation,
  prepareSubagentContentDeletion,
} from './conversationSupport';
import { activeExpirationFilter, createFallbackRetentionDate } from '~/utils/retention';
import { createPostgresConversationActorMethods } from './conversationActor';
import { resolveTenantScope, sanitizeTenantMutation } from '~/tenant/policy';
import { createTempChatExpirationDate } from '~/utils/tempChatRetention';
import { createSearchConversation } from '~/methods/searchConversation';
import { createBulkSaveConvos } from '~/methods/bulkSaveConvos';
import { createDeleteConvos } from '~/methods/deleteConvos';
import { isValidObjectIdString } from '~/utils/objectId';
import { createSaveConvo } from '~/methods/saveConvo';
import { SearchNotConfiguredError } from '../search';
import { runStoreSql, storeWhere } from './context';
import logger from '~/config/winston';

/** The PostgreSQL conversation module: the store plus the domain functions written on it. */
export type PostgresConversationModule = ConversationStore & ConversationDomainFunctions;

/** A stored attachment epoch as the lane context reads it (absent when never moved). */
const epochOf = (epoch: number | null): { codeAttachmentEpoch?: number } =>
  epoch == null ? {} : { codeAttachmentEpoch: Number(epoch) };

/** The conversation's lean record as the port types it. */
const asConversation = (record: PgRecord | null): IConversation | null =>
  record as IConversation | null;

export function createPostgresConversationStore(
  context: PostgresStoreContext,
  deps: Partial<ConversationFactoryDeps> = {},
): PostgresConversationModule {
  const tables = conversationTables(context);
  const conversations = () => tables.conversations();
  const projects = createChatProjectStats(tables);
  const visible = () => visibleConversationRetentionFilter();
  const human = () => humanConversationFilter();

  /**
   * Stamps a real assistant reply with a strictly increasing server value by compare-and-set:
   * concurrent writers that read the same state retry against the winner (see the MongoDB
   * method). Only a successful write supplies a stamp.
   */
  async function stampReplyWithCas(
    filter: Record<string, unknown>,
    responseMessageId: string,
    projection: Record<string, 1>,
  ): Promise<{ stamp: Date; conversation: Partial<IConversation> } | null> {
    const replyFilter = { ...filter, isTemporary: { $ne: true } };
    for (;;) {
      const current = await conversations().findOne(replyFilter, {
        projection: { lastResponseAt: 1, updatedAt: 1 },
      });
      if (!current) {
        return null;
      }
      const stamp = replyStampOf(current);
      const stamped = await conversations().findOneAndUpdate(
        replyStampCasFilter(replyFilter, current),
        replyStampUpdate(stamp, responseMessageId),
        { returnDocument: 'after', projection, timestamps: false },
      );
      if (stamped) {
        return { stamp, conversation: stamped };
      }
    }
  }

  /** Flags the conversations of a page with an active shared link; never fails the page. */
  async function attachSharedFlags(user: string, listed: IConversation[]): Promise<void> {
    if (listed.length === 0 || !sharedLinksAllowed()) {
      return;
    }
    try {
      const shares = await tables.sharedLinks().find(
        {
          user,
          conversationId: { $in: listed.map((convo) => convo.conversationId) },
          ...activeExpirationFilter(),
        },
        { projection: 'conversationId' },
      );
      const shared = new Set(shares.map((share) => share.conversationId));
      for (const convo of listed) {
        convo.isShared = shared.has(convo.conversationId);
      }
    } catch (error) {
      logger.error('[attachSharedFlags] Error resolving shared conversations', error);
    }
  }

  /** The conversations with a file on any of the user's messages. */
  async function getMessageFileConversationIds(user: string): Promise<string[]> {
    return (await tables.messages().distinct('conversationId', messageFileFilter(user))).filter(
      (conversationId): conversationId is string => typeof conversationId === 'string',
    );
  }

  /** The conversations the user is actively sharing; `null` while sharing is switched off. */
  async function getSharedConversationIds(user: string): Promise<string[] | null> {
    if (!sharedLinksAllowed()) {
      return null;
    }
    const sharedIds = await tables
      .sharedLinks()
      .distinct('conversationId', { user, ...activeExpirationFilter() });
    return sharedIds.filter(
      (conversationId): conversationId is string => typeof conversationId === 'string',
    );
  }

  async function discoverProjectIds(filter: Record<string, unknown>): Promise<string[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PROJECT_DISCOVERY_MAX_ATTEMPTS; attempt++) {
      try {
        const currentProjectIds = await conversations().distinct('chatProjectId', filter);
        return currentProjectIds.filter((projectId): projectId is string => Boolean(projectId));
      } catch (error) {
        lastError = error;
        logger.error(
          '[archiveAllConvos] Conversations archived but project discovery failed',
          error,
        );
      }
    }
    throw lastError;
  }

  const getConvo: ConversationStore['getConvo'] = async (user, conversationId) => {
    try {
      return asConversation(await conversations().findOne({ user, conversationId }));
    } catch (error) {
      logger.error('[getConvo] Error getting single conversation', error);
      throw new Error('Error getting single conversation');
    }
  };

  /** The non-conversation work `deleteConvos` carries along, on the PostgreSQL tables. */
  const getDeleteConvosDeps = (): DeleteConvosDeps => ({
    hasConvoMessages: async (user, conversationId) =>
      (await tables.messages().exists({ user, conversationId })) != null,
    deleteConvoMessages: async (user, conversationIds) => {
      await prepareSubagentContentDeletion(tables, user, conversationIds);
      const result = await tables
        .messages()
        .deleteMany({ conversationId: { $in: conversationIds }, user });
      return { acknowledged: result.acknowledged, deletedCount: result.deletedCount };
    },
    prepareSubagentContentDeletion: (user, conversationIds) =>
      prepareSubagentContentDeletion(tables, user, conversationIds),
    decrementTagCounts: (user, tags) => decrementTagCounts(tables, user, tags),
    deleteToolApprovalGrants: async (user, conversationIds) => {
      await tables
        .toolApprovalGrants()
        .deleteMany({ user, conversationId: { $in: conversationIds } });
    },
    ...(deps.deleteAgentQueuedTurns && {
      deleteAgentQueuedTurns: async (user, targets) => {
        await deps.deleteAgentQueuedTurns?.(user, targets);
      },
    }),
    ...(deps.prepareAgentTriggerConversationResultErasure && {
      prepareAgentTriggerConversationResultErasure: async (user, conversationIds) => {
        await deps.prepareAgentTriggerConversationResultErasure?.(user, conversationIds);
      },
    }),
    ...(deps.eraseAgentTriggerDeliveryConversationResults && {
      eraseAgentTriggerDeliveryConversationResults: async (user, conversationIds) => {
        await deps.eraseAgentTriggerDeliveryConversationResults?.(user, conversationIds);
      },
    }),
  });

  const store: ConversationStore = {
    ...createPostgresConversationActorMethods(context, tables),

    /* ---------------------------------------------------------------------------- reads */

    getConvo,

    async getConvoTitle(user, conversationId) {
      try {
        const convo = await getConvo(user, conversationId);
        if (convo && !convo.title) {
          return null;
        }
        return convo?.title || 'New Chat';
      } catch (error) {
        logger.error('[getConvoTitle] Error getting conversation title', error);
        throw new Error('Error getting conversation title');
      }
    },

    async getConvoTitleState(user, conversationId) {
      return conversations().findOne(
        { user, conversationId },
        { projection: 'title titleSetByUser titleRevision -_id' },
      );
    },

    async getConvoOwnership(user, conversationId, tenantId) {
      try {
        const tenantFilter =
          tenantId === undefined ? {} : threadTenantFilter(tenantId ?? undefined);
        return await conversations().findOne(
          { user, conversationId, ...tenantFilter, ...activeExpirationFilter() },
          { projection: 'user tenantId subagentThread' },
        );
      } catch (error) {
        logger.error('[getConvoOwnership] Error checking conversation ownership', error);
        throw new Error('Error checking conversation ownership');
      }
    },

    async getConvoRetention(user, conversationId) {
      try {
        return await conversations().findOne(
          { user, conversationId },
          { projection: 'expiredAt isTemporary' },
        );
      } catch (error) {
        logger.error('[getConvoRetention] Error getting conversation retention fields', error);
        throw new Error('Error getting conversation retention fields');
      }
    },

    async getConvoFiles(conversationId) {
      try {
        return (
          (await conversations().findOne({ conversationId }, { projection: 'files' }))?.files ?? []
        );
      } catch (error) {
        logger.error('[getConvoFiles] Error getting conversation files', error);
        throw new Error('Error getting conversation files');
      }
    },

    async getConvosByCursor(user, options = {}) {
      const {
        cursor,
        limit = DEFAULT_CONVO_PAGE_SIZE,
        search,
        sortBy = 'updatedAt',
        sortDirection = 'desc',
        hasFiles,
        sharedOnly,
      } = options;
      const pageSize = convoPageSize(limit);
      const filters = convoListFacetFilters(user, options);
      const [messageFileIds, activeShares] = await Promise.all([
        hasFiles === true ? getMessageFileConversationIds(user) : null,
        sharedOnly === true ? getSharedConversationIds(user) : null,
      ]);
      if (hasFiles === true) {
        filters.push(convoFilesFacetFilter(messageFileIds));
      }
      let sharedIds: Set<string> | null = null;
      if (sharedOnly === true) {
        if (activeShares == null || activeShares.length === 0) {
          return { conversations: [], nextCursor: null };
        }
        sharedIds = new Set(activeShares);
        filters.push({ conversationId: { $in: activeShares } });
      }
      filters.push(visible());
      filters.push(human());

      if (search) {
        /** The title search and the message search on MeiliSearch (`../search`), as MongoDB. */
        try {
          const searchIndex = context.search;
          if (!searchIndex?.configured()) {
            throw new SearchNotConfiguredError();
          }
          const searchParams = convoSearchParams(user);
          const [convoResults, messageHits] = await Promise.all([
            searchIndex.search('conversations', search, searchParams),
            searchIndex.search('messages', search, searchParams).then(
              (results) => (Array.isArray(results.hits) ? results.hits : []),
              (error) => {
                logger.error(
                  '[getConvosByCursor] Message search failed, using title matches only',
                  error,
                );
                return [];
              },
            ),
          ]);
          const matchingIds = searchHitConversationIds(convoResults.hits ?? [], messageHits);
          if (!matchingIds.length) {
            return { conversations: [], nextCursor: null };
          }
          filters.push({ conversationId: { $in: matchingIds } });
        } catch (error) {
          logger.error('[getConvosByCursor] Error during meiliSearch', error);
          throw new Error('Error during meiliSearch');
        }
      }

      const order = convoListOrder(sortBy, sortDirection);
      if (cursor) {
        const cursorFilter = convoCursorFilter(
          cursor,
          order,
          (id) => id.toLowerCase(),
          isValidObjectIdString,
        );
        if (cursorFilter) {
          filters.push(cursorFilter);
        } else {
          logger.warn('[getConvosByCursor] Invalid cursor format, starting from beginning');
        }
      }

      try {
        const convos = (await conversations().find(
          filters.length === 1 ? filters[0] : { $and: filters },
          { projection: CONVO_LIST_FIELDS, sort: convoListSort(order), limit: pageSize + 1 },
        )) as IConversation[];

        let nextCursor: string | null = null;
        if (convos.length > pageSize) {
          convos.pop();
          nextCursor = nextConvoCursor(convos[convos.length - 1], order);
        }
        for (const convo of convos) {
          convo.codeDecisionListed = true;
        }
        if (sharedIds != null) {
          for (const convo of convos) {
            convo.isShared = sharedIds.has(convo.conversationId);
          }
        } else {
          await attachSharedFlags(user, convos);
        }
        return { conversations: convos, nextCursor };
      } catch (error) {
        logger.error('[getConvosByCursor] Error getting conversations', error);
        throw new Error('Error getting conversations');
      }
    },

    async getConvosQueried(user, convoIds, cursor = null, limit = 25) {
      try {
        if (!convoIds?.length) {
          return { conversations: [], nextCursor: null, convoMap: {} };
        }
        const results = (await conversations().find({
          $and: [
            { user, conversationId: { $in: convoIds.map((convo) => convo.conversationId) } },
            visible(),
            human(),
          ],
        })) as IConversation[];
        const { conversations: limited, nextCursor } = queriedConvoPage(results, cursor, limit);
        await attachSharedFlags(user, limited);
        const convoMap: Record<string, unknown> = {};
        limited.forEach((convo) => {
          convoMap[convo.conversationId] = convo;
        });
        return { conversations: limited, nextCursor, convoMap };
      } catch (error) {
        logger.error('[getConvosQueried] Error getting conversations', error);
        throw new Error('Error fetching conversations');
      }
    },

    /* ------------------------------------------------------------ single-field writes */

    async setConvoPinned(user, conversationId, pinned) {
      try {
        return asConversation(
          await conversations().findOneAndUpdate(
            { conversationId, user },
            { $set: { pinned } },
            { returnDocument: 'after', timestamps: false },
          ),
        );
      } catch (error) {
        logger.error('[setConvoPinned] Error updating pinned state', error);
        throw new Error('Error updating pinned state');
      }
    },

    async appendConvoMessageReference(user, conversationId, messageId) {
      if (!isValidObjectIdString(messageId)) {
        logger.warn('[appendConvoMessageReference] Ignoring an unusable message id');
        return null;
      }
      try {
        return asConversation(
          await conversations().findOneAndUpdate(
            { conversationId, user },
            { $addToSet: { messages: messageId.toLowerCase() } },
            { returnDocument: 'after', timestamps: false },
          ),
        );
      } catch (error) {
        logger.error('[appendConvoMessageReference] Error appending the message reference', error);
        throw new Error('Error appending the message reference');
      }
    },

    async markConvoSeen(user, conversationId, observedResponseAt) {
      try {
        const filter: Record<string, unknown> = { conversationId, user };
        if (observedResponseAt) {
          filter.lastResponseAt = { $lte: observedResponseAt };
        }
        /* Never earlier than the reply being acknowledged (see the MongoDB method). */
        const now = new Date();
        const lastSeenAt =
          observedResponseAt && observedResponseAt > now ? observedResponseAt : now;
        const result = await conversations().updateOne(
          filter,
          { $set: { lastSeenAt }, $unset: { isMarkedUnread: '' } },
          { timestamps: false },
        );
        /* Matched, not modified: a retried acknowledgement still succeeds. */
        return { modified: result.matchedCount > 0 };
      } catch (error) {
        logger.error('[markConvoSeen] Error marking conversation seen', error);
        throw new Error('Error marking conversation seen');
      }
    },

    async markConvoUnread(user, conversationId) {
      try {
        const options = {
          timestamps: false,
          returnDocument: 'after' as const,
          projection: UNREAD_STATE_PROJECTION,
        };
        const report = (stamped: ConversationRow) => ({
          modified: true,
          lastResponseAt: stamped.lastResponseAt,
          lastResponseMessageId: stamped.lastResponseMessageId,
          lastResponseIsManual: stamped.lastResponseIsManual === true,
          isMarkedUnread: stamped.isMarkedUnread,
        });
        const stamped = await conversations().findOneAndUpdate(
          {
            conversationId,
            user,
            $or: [{ lastResponseAt: null }, { lastResponseAt: { $exists: false } }],
          },
          {
            $set: { lastResponseAt: new Date(), lastResponseIsManual: true, isMarkedUnread: true },
            $unset: { lastSeenAt: '', lastResponseMessageId: '' },
          },
          options,
        );
        if (stamped) {
          return report(stamped);
        }
        const cleared = await conversations().findOneAndUpdate(
          { conversationId, user },
          { $set: { isMarkedUnread: true }, $unset: { lastSeenAt: '' } },
          options,
        );
        return cleared ? report(cleared) : { modified: false };
      } catch (error) {
        logger.error('[markConvoUnread] Error marking conversation unread', error);
        throw new Error('Error marking conversation unread');
      }
    },

    async stampConvoLastResponse(user, conversationId, responseMessageId) {
      try {
        const stamped = await stampReplyWithCas(
          { conversationId, user },
          responseMessageId,
          LAST_RESPONSE_STAMP_PROJECTION,
        );
        /* The workspace sorts on the project's `lastConversationAt`, so the project moves too. */
        if (stamped?.conversation.chatProjectId) {
          try {
            await projects.recordChatProjectLastConversation(
              user,
              stamped.conversation.chatProjectId,
              stamped.conversation as IConversation,
            );
          } catch (error) {
            logger.error('[stampConvoLastResponse] Failed to update project activity', error);
          }
        }
        return stamped
          ? {
              lastResponseAt: stamped.stamp,
              lastResponseMessageId: responseMessageId,
              ...(stamped.conversation.updatedAt
                ? { updatedAt: stamped.conversation.updatedAt }
                : {}),
            }
          : null;
      } catch (error) {
        logger.error('[stampConvoLastResponse] Error stamping conversation reply', error);
        throw new Error('Error stamping conversation reply');
      }
    },

    async archiveAllConvos(user) {
      const projectIds = new Set<string>();
      /** One stamp for the whole sweep (see the MongoDB method). */
      const archivedAt = new Date();
      let archivedCount = 0;
      let attemptedArchiveWrite = false;
      try {
        const filter = archiveSweepFilter(user);
        const snapshotBoundary = await conversations().findOne(filter, {
          projection: { _id: 1 },
          sort: { _id: -1 },
        });
        if (!snapshotBoundary) {
          return { archivedCount: 0 };
        }
        const boundary = String(snapshotBoundary._id);
        let lastConversationId: string | null = null;
        for (;;) {
          const idRange: Record<string, string> = lastConversationId
            ? { $gt: lastConversationId, $lte: boundary }
            : { $lte: boundary };
          const page = await conversations().find(
            { ...filter, _id: idRange },
            {
              projection: { _id: 1, chatProjectId: 1 },
              sort: { _id: 1 },
              limit: ARCHIVE_CONVERSATION_BATCH_SIZE,
            },
          );
          if (page.length === 0) {
            break;
          }
          const conversationIds: string[] = [];
          for (const conversation of page) {
            conversationIds.push(String(conversation._id));
            if (conversation.chatProjectId) {
              projectIds.add(conversation.chatProjectId);
            }
          }
          lastConversationId = conversationIds[conversationIds.length - 1];
          attemptedArchiveWrite = true;
          const result = await conversations().updateMany(
            { ...filter, _id: { $in: conversationIds } },
            { $set: { isArchived: true, archivedAt } },
            { timestamps: false },
          );
          archivedCount += result.modifiedCount;
          if (result.modifiedCount > 0) {
            for (const projectId of await discoverProjectIds({
              _id: { $in: conversationIds },
              user,
            })) {
              projectIds.add(projectId);
            }
          }
        }
        return { archivedCount };
      } catch (error) {
        logger.error('[archiveAllConvos] Error archiving conversations', error);
        throw error;
      } finally {
        /** Best-effort, as on MongoDB: the committed batches are archived already. */
        if (attemptedArchiveWrite) {
          try {
            for (const projectId of await discoverProjectIds({
              user,
              isArchived: true,
              archivedAt,
            })) {
              projectIds.add(projectId);
            }
          } catch (error) {
            logger.error(
              '[archiveAllConvos] Conversations archived but project recovery failed',
              error,
            );
          }
        }
        if (attemptedArchiveWrite && projectIds.size > 0) {
          try {
            await projects.refreshChatProjectsStats(user, projectIds);
          } catch (error) {
            logger.error(
              '[archiveAllConvos] Conversations archived but stats refresh failed',
              error,
            );
          }
        }
      }
    },

    async stampForcedRetention({ userId, interfaceConfig }, { conversationId, messageIds = [] }) {
      if (!userId || !isForcedTemporaryRetention(interfaceConfig?.retentionMode)) {
        return;
      }
      const stored = await conversations().findOne(
        { conversationId, user: userId },
        { projection: { _id: 1, isTemporary: 1, expiredAt: 1, tags: 1 } },
      );
      if (!stored) {
        return;
      }
      const id = String(stored._id);
      let expiredAt = stored.expiredAt ?? null;
      if (expiredAt == null) {
        try {
          expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error(
            '[stampForcedRetention] Error creating temporary chat expiration date:',
            err,
          );
          expiredAt = createFallbackRetentionDate();
        }
      }
      let stampedDeadline = stored.expiredAt != null;
      if (stored.isTemporary !== true) {
        /** Conditional on the transition, so concurrent stamps release the bookmark counts
         * once; the released tags are cleared with it. */
        const converted = await conversations().updateOne(
          { _id: id, isTemporary: { $ne: true } },
          { $set: { isTemporary: true, expiredAt, tags: [] } },
          { timestamps: false },
        );
        stampedDeadline ||= converted.modifiedCount > 0;
        if (converted.modifiedCount > 0 && stored.tags?.length) {
          await decrementTagCounts(tables, userId, stored.tags);
        }
      } else if (stored.expiredAt == null) {
        const stamped = await conversations().updateOne(
          { _id: id, expiredAt: null },
          { $set: { expiredAt } },
          { timestamps: false },
        );
        stampedDeadline = stamped.modifiedCount > 0;
      }
      if (messageIds.length === 0) {
        return;
      }
      if (!stampedDeadline) {
        /** A concurrent stamp set the deadline first; its messages share that one. */
        const current = await conversations().findOne(
          { _id: id },
          { projection: { expiredAt: 1 } },
        );
        expiredAt = current?.expiredAt ?? expiredAt;
      }
      await tables
        .messages()
        .updateMany(
          { user: userId, conversationId, messageId: { $in: messageIds } },
          { $set: { isTemporary: true, expiredAt } },
          { timestamps: false },
        );
    },

    async addConvoToolApprovalAllows({ user, conversationId, toolNames, max }) {
      const names = toolApprovalAllowNames(toolNames, max);
      if (names == null) {
        return false;
      }
      /** The bound on the union of the stored names and the new ones (MongoDB's `$expr` with
       * `$setUnion`), checked on the row it locks (the recheck after a wait re-evaluates it on
       * the row's latest version), then the `$addToSet` on that row in the same transaction. */
      return context.transactions.transaction(async (tx) => {
        const { rows } = await runStoreSql<{ _id: string }>(
          context,
          sql`SELECT t._id FROM conversations t WHERE ${storeWhere(context, 'conversations', {
            user,
            conversationId,
          })} AND cardinality(ARRAY(SELECT DISTINCT n FROM unnest(coalesce(t."toolApprovalAllows", '{}'::text[]) || ${sql.val(
            names,
          )}::text[]) AS n)) <= ${sql.val(max)} LIMIT 1 FOR UPDATE`,
          tx,
        );
        const id = rows[0]?._id;
        if (id === undefined) {
          return false;
        }
        const result = await conversations().updateOne(
          { _id: id },
          { $addToSet: { toolApprovalAllows: { $each: names } } },
          { timestamps: false, tx },
        );
        return result.matchedCount === 1;
      });
    },

    /* ----------------------------------------------------------------- code environment */

    async getConvoCodeEnvironmentDecision(user, conversationId) {
      return conversations().findOne(
        { user, conversationId },
        {
          projection: 'conversationId codeEnvironmentMode codeWorkspaces +codeEnvironmentRevision',
        },
      );
    },

    async readAdmittedConvoCodeEnvironmentDecision(user, conversationId) {
      const admitted = await conversations().findOneAndUpdate(
        { user, conversationId },
        { $inc: { codeEnvironmentRevision: 1 } },
        {
          returnDocument: 'after',
          timestamps: false,
          projection: 'conversationId codeEnvironmentMode codeWorkspaces +codeAttachmentEpoch',
          /** Bookkeeping: no search write (MongoDB's `withoutMeiliIndexing`). */
          writeHooks: false,
        },
      );
      return admitted == null
        ? admitted
        : { ...admitted, codeAttachmentEpoch: admitted.codeAttachmentEpoch ?? 0 };
    },

    async replaceConvoCodeEnvironmentDecision(params) {
      try {
        const { filter, update } = codeEnvironmentReplacement(params);
        /** The stored workspaces (a subdocument array) are compared with the expected ones by
         * value on the locked row; the rest of the condition is the primitive's. */
        const { codeWorkspaces: expectedWorkspaces, ...columns } = filter;
        return asConversation(
          await writeCheckedConversation(context, {
            filter: columns,
            projection: { codeWorkspaces: 1 },
            check: (record) => matchesStoredState(record, { codeWorkspaces: expectedWorkspaces }),
            write: (id, tx) =>
              conversations().findOneAndUpdate({ ...columns, _id: id }, update, {
                returnDocument: 'after',
                timestamps: false,
                tx,
              }),
          }),
        );
      } catch (error) {
        logger.error('[replaceConvoCodeEnvironmentDecision] Error moving code environment', error);
        throw new Error('Error moving code environment');
      }
    },

    /* ------------------------------------------------------------------------- lane git */

    async reserveConvoLaneGitSeq(user, conversationId) {
      const reserved = await conversations().findOneAndUpdate(
        { user, conversationId, ...activeExpirationFilter() },
        { $inc: { laneGitSeq: 1 } },
        {
          returnDocument: 'after',
          timestamps: false,
          projection: 'laneGitSeq',
          /** Bookkeeping: no search write (MongoDB's `withoutMeiliIndexing`). */
          writeHooks: false,
        },
      );
      return reserved?.laneGitSeq ?? null;
    },

    async getConvoLaneContext(user, conversationId) {
      /** The thread and its visible root in one statement, so the epoch cannot move between two
       * reads. The root is narrowed to the same owner, tenant and visibility as the thread (the
       * MongoDB `$lookup` is narrowed the same way), so a root outside them reads as absent. */
      const { rows } = await runStoreSql<{
        _id: string;
        rootConversationId: string | null;
        epoch: number | null;
        rootEpoch: number | null;
        rootFound: boolean | null;
      }>(
        context,
        sql`SELECT t._id, t."subagentThread__rootConversationId" AS "rootConversationId",
            t."codeAttachmentEpoch" AS "epoch", r."codeAttachmentEpoch" AS "rootEpoch",
            r._id IS NOT NULL AS "rootFound"
          FROM conversations t
          LEFT JOIN LATERAL (
            SELECT r._id, r."codeAttachmentEpoch" FROM conversations r
            WHERE r."conversationId" = t."subagentThread__rootConversationId"
              AND r."user" = ${sql.val(user)}
              AND r."tenantId" IS NOT DISTINCT FROM t."tenantId"
              AND (r."expiredAt" IS NULL OR r."expiredAt" > ${sql.val(new Date())})
            ORDER BY r._id LIMIT 1
          ) r ON true
          WHERE ${storeWhere(context, 'conversations', {
            user,
            conversationId,
            ...activeExpirationFilter(),
          })}
          ORDER BY t._id LIMIT 1`,
      );
      const row = rows[0];
      if (row == null) return null;
      /** The lineage is immutable, so it is read by the row's id in a second statement. */
      const thread = await conversations().findOne(
        { _id: row._id },
        { projection: 'subagentThread' },
      );
      return laneContextOf(
        conversationId,
        {
          subagentThread: thread?.subagentThread ?? null,
          ...epochOf(row.epoch),
        },
        row.rootFound ? epochOf(row.rootEpoch) : undefined,
      );
    },

    async setConvoLaneGit({ user, conversationId, laneGit, repo, pullRequest, seq, workspace }) {
      const fences = laneGitFences(seq, workspace);
      const write = async (
        lane: Record<string, unknown> | null,
        update: Record<string, unknown>,
      ): Promise<boolean> => {
        const result = await conversations().updateOne(
          {
            user,
            conversationId,
            ...activeExpirationFilter(),
            $and: lane == null ? fences : [...fences, lane],
          },
          update,
          { timestamps: false },
        );
        return result.modifiedCount === 1;
      };
      const replaced = laneGitReport({ laneGit, repo, pullRequest, seq });
      if (pullRequest != null) return write(null, { $set: { laneGit: replaced } });
      /** A report without a link keeps the one already recorded while the lane is still on that
       * branch and repository, and drops it otherwise (see the MongoDB method). */
      const sameLane = sameLaneFilter(laneGit, repo);
      for (let attempt = 0; attempt < LANE_GIT_WRITE_ATTEMPTS; attempt++) {
        const kept = await write(sameLane, {
          $set: {
            'laneGit.branch': laneGit.branch,
            'laneGit.head': laneGit.head,
            'laneGit.seq': seq,
          },
        });
        if (kept) return true;
        if (await write({ $nor: [sameLane] }, { $set: { laneGit: replaced } })) return true;
      }
      return false;
    },

    async getConvoLaneGit(user, conversationId) {
      const stored = await conversations().findOne(
        { user, conversationId, ...activeExpirationFilter() },
        { projection: 'laneGit' },
      );
      return stored?.laneGit == null ? null : laneGitViewOf(stored.laneGit);
    },

    async getConvosLaneGit(user, conversationIds) {
      if (conversationIds.length === 0) return [];
      const stored = await conversations().find(
        {
          user,
          conversationId: { $in: conversationIds },
          laneGit: { $exists: true, $ne: null },
          ...activeExpirationFilter(),
        },
        { projection: 'conversationId laneGit' },
      );
      return stored.flatMap(({ conversationId, laneGit }) =>
        laneGit == null || conversationId == null
          ? []
          : [{ conversationId, laneGit: laneGitViewOf(laneGit) }],
      );
    },

    /* --------------------------------------------------------------- command line scripts */

    async countConvosByUser(): Promise<UserRecordCount[]> {
      const { rows } = await runStoreSql<{ user: string | null; count: string | number }>(
        context,
        sql`SELECT t."user" AS "user", count(*) AS "count" FROM conversations t WHERE ${storeWhere(
          context,
          'conversations',
          {},
        )} GROUP BY t."user"`,
      );
      return rows.map(({ user, count }) => ({
        user: user == null ? null : user,
        count: Number(count),
      }));
    },

    async createConvoRecord(record) {
      await conversations().insertOne(record);
    },

    /* -------------------------------------------------------------------- saveConvo steps */

    async getConvoMessageIds(user, conversationId) {
      const messages = await tables
        .messages()
        .find({ conversationId, user }, { projection: '_id', sort: { createdAt: 1, _id: 1 } });
      return messages.map((message) => String(message._id));
    },

    async isOwnedChatProject(user, chatProjectId) {
      if (!isValidObjectIdString(chatProjectId)) {
        return false;
      }
      return (
        (await tables.chatProjects().exists({ _id: chatProjectId.toLowerCase(), user })) != null
      );
    },

    async writeConvo(input) {
      const filter = convoWriteFilter(input);
      const operation = convoWriteOperation(input);
      const timestamps = input.timestamps;
      if (!input.upsert) {
        const conversation = await conversations().findOneAndUpdate(filter, operation, {
          returnDocument: 'after',
          timestamps,
        });
        return conversation == null
          ? null
          : { conversation: conversation as IConversation, inserted: false };
      }
      /** The upsert and the read of what it wrote run in one transaction, so the read is the
       * post-image. A matched record is found again by the key the write leaves it on. */
      return context.transactions.transaction(async (tx) => {
        const result = await conversations().updateOne(filter, operation, {
          upsert: true,
          timestamps,
          tx,
          /** The search write hook, as MongoDB's `findOneAndUpdate` runs it (I3). */
          writeHooks: true,
        });
        const key =
          result.upsertedId != null
            ? { _id: result.upsertedId }
            : {
                conversationId:
                  typeof input.set.conversationId === 'string'
                    ? input.set.conversationId
                    : input.conversationId,
                user: typeof input.set.user === 'string' ? input.set.user : input.user,
              };
        const conversation = await conversations().findOne(key, { tx });
        return conversation == null
          ? null
          : { conversation: conversation as IConversation, inserted: result.upsertedId != null };
      });
    },

    async convoExists(user, conversationId) {
      return (await conversations().exists({ conversationId, user })) != null;
    },

    async seedConvoCodeEnvironmentDecision(input) {
      const result = await conversations().updateOne(
        undecidedCodeEnvironmentFilter(input.conversationId, input.user),
        { $set: input.decision },
        { timestamps: false },
      );
      return result.modifiedCount > 0;
    },

    async setConvoExpiryIfUnset(input) {
      const result = await conversations().updateOne(
        unsetExpiryFilter(input),
        { $set: { expiredAt: input.expiredAt } },
        { timestamps: false },
      );
      return result.modifiedCount > 0;
    },

    async stampConvoReply(input) {
      const stamped = await stampReplyWithCas(
        { conversationId: input.conversationId, user: input.user },
        input.responseMessageId,
        REPLY_STAMP_STATE_PROJECTION,
      );
      return stamped ? { lastResponseAt: stamped.stamp, state: stamped.conversation } : null;
    },

    async backfillConvoIsTemporary(input) {
      const result = await conversations().updateOne(
        { conversationId: input.conversationId, user: input.user, isTemporary: { $in: [null] } },
        { $set: { isTemporary: false } },
        input.touchUpdatedAt ? {} : { timestamps: false },
      );
      return result.modifiedCount > 0;
    },

    async refreshChatProjectStats(user, chatProjectId) {
      await projects.refreshChatProjectStats(user, chatProjectId);
    },

    recordChatProjectLastConversation: projects.recordChatProjectLastConversation,

    /* ----------------------------------------------------------------- deleteConvos steps */

    async listConvosForDeletion(user, selector) {
      const filter =
        'conversationIds' in selector
          ? { conversationId: { $in: selector.conversationIds }, user }
          : { user };
      return toDeletionTargets(
        (await conversations().find(filter, {
          projection: DELETION_TARGET_FIELDS,
        })) as unknown as Parameters<typeof toDeletionTargets>[0],
      );
    },

    async listSubagentDescendantsForDeletion(user, rootConversationId) {
      return toDeletionTargets(
        (await conversations().find(
          { user, 'subagentThread.rootConversationId': rootConversationId },
          { projection: DELETION_TARGET_FIELDS },
        )) as unknown as Parameters<typeof toDeletionTargets>[0],
      );
    },

    async listSubagentChildrenForDeletion(user, parentConversationIds) {
      return toDeletionTargets(
        (await conversations().find(
          { user, 'subagentThread.parentConversationId': { $in: parentConversationIds } },
          { projection: DELETION_TARGET_FIELDS },
        )) as unknown as Parameters<typeof toDeletionTargets>[0],
      );
    },

    async deleteConvoRecords(user, conversationIds) {
      const result = await conversations().deleteMany({
        user,
        conversationId: { $in: conversationIds },
      });
      return { acknowledged: result.acknowledged, deletedCount: result.deletedCount };
    },

    /* ---------------------------------------------------------------- bulkSaveConvos steps */

    async listConvoProjectAssignments(pairs) {
      if (pairs.length === 0) {
        return [];
      }
      const existing = await conversations().find(
        { $or: pairs },
        { projection: 'user conversationId chatProjectId' },
      );
      return existing.map(({ user, conversationId, chatProjectId }) => ({
        user: user as string,
        conversationId,
        ...(chatProjectId !== undefined && { chatProjectId }),
      }));
    },

    /** `tenantId` is stripped from every payload (MongoDB's `tenantSafeBulkWrite`); the
     * primitive scopes every row to the tenant in context. */
    async bulkUpsertConvos(upserts): Promise<ConvoBulkUpsertResult> {
      const scope = resolveTenantScope('bulkWrite on Conversation');
      const operations: PgBulkOperation[] = [];
      for (const { user, conversationId, set, setOnInsert } of upserts) {
        const { update, emptied } = sanitizeTenantMutation(
          scope,
          { $set: set, $setOnInsert: setOnInsert },
          'strip',
        );
        if (!emptied) {
          operations.push({
            updateOne: { filter: { conversationId, user }, update, upsert: true },
          });
        }
      }
      if (operations.length === 0) {
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }
      const result = await conversations().bulk(operations, { timestamps: false });
      return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
      };
    },

    /* ------------------------------------------------------------ searchConversation steps */

    async getConvoByIdAcrossUsers(conversationId, projection) {
      const fields = CONVO_BY_ID_PROJECTIONS[projection];
      return asConversation(
        await conversations().findOne(
          { conversationId },
          fields == null ? {} : { projection: fields },
        ),
      );
    },
  };

  /** The chat-project ownership `bulkSaveConvos` checks, in one batched read. */
  async function listOwnedChatProjectIds(
    pairs: Array<{ user: string; chatProjectId: string }>,
  ): Promise<Array<{ user: string; chatProjectId: string }>> {
    const candidates = pairs.filter(({ chatProjectId }) => isValidObjectIdString(chatProjectId));
    if (candidates.length === 0) {
      return [];
    }
    const owned = await tables.chatProjects().find(
      {
        $or: candidates.map(({ user, chatProjectId }) => ({
          _id: chatProjectId.toLowerCase(),
          user,
        })),
      },
      { projection: '_id user' },
    );
    return owned.map((project) => ({
      user: project.user as string,
      chatProjectId: String(project._id),
    }));
  }

  /** Written once on the steps above, sharing this instance, as on MongoDB. */
  const saveConvo: ConversationMethods['saveConvo'] = createSaveConvo(store);
  const deleteConvos: ConversationMethods['deleteConvos'] = createDeleteConvos(
    store,
    getDeleteConvosDeps,
  );
  const bulkSaveConvos: ConversationMethods['bulkSaveConvos'] = createBulkSaveConvos(store, {
    listOwnedChatProjectIds,
  });
  const searchConversation: ConversationMethods['searchConversation'] =
    createSearchConversation(store);

  return { ...store, saveConvo, deleteConvos, bulkSaveConvos, searchConversation };
}

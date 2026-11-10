/**
 * `saveConvo`, written once on the database-neutral "saveConvo steps" of the conversation store.
 *
 * Every rule of a save lives here: which fields a save may write, retention, the archive
 * compare-and-set, the follow-up fills and the project statistics. Storage goes only through
 * the steps, so any adapter that implements them gets the same `saveConvo`. Nothing here may
 * import `mongoose` or touch a model.
 *
 * {@link SaveConvoStore} repeats the step signatures of `ConversationStore` (`~/ports/conversation`)
 * instead of picking them, because that port imports `~/methods/conversation`, which builds its
 * `saveConvo` from this module. `saveConvo.spec.ts` beside this file fails the typecheck if the
 * two drift.
 */
import {
  RetentionMode,
  isForcedTemporaryRetention,
  UNSEEN_REPLY_WATERMARK,
} from 'librechat-data-provider';
import type {
  AppConfig,
  IConversation,
  ConvoCodeEnvironmentDecision,
  ConvoReplyStampState,
  ConvoWrite,
  ConvoWriteResult,
} from '~/types';
import { LANE_PRIVATE_FIELDS, stripActorCheckpointFields, stripFields } from './conversationFields';
import { createChatExpirationDate, createTempChatExpirationDate } from '~/utils/tempChatRetention';
import { createFallbackRetentionDate } from '~/utils/retention';
import logger from '~/config/winston';

/** The conversation-store operations `saveConvo` is written on; signatures as in the port. */
export interface SaveConvoStore {
  getConvo(user: string, conversationId: string): Promise<IConversation | null>;
  getConvoMessageIds(user: string, conversationId: string): Promise<string[]>;
  isOwnedChatProject(user: string, chatProjectId: string): Promise<boolean>;
  writeConvo(input: ConvoWrite): Promise<ConvoWriteResult | null>;
  convoExists(user: string, conversationId: string): Promise<boolean>;
  seedConvoCodeEnvironmentDecision(input: {
    user: string;
    conversationId: string;
    decision: ConvoCodeEnvironmentDecision;
  }): Promise<boolean>;
  setConvoExpiryIfUnset(input: {
    user: string;
    conversationId: string;
    isTemporary: boolean;
    expiredAt: Date;
  }): Promise<boolean>;
  stampConvoReply(input: {
    user: string;
    conversationId: string;
    responseMessageId: string;
  }): Promise<{ lastResponseAt: Date; state: ConvoReplyStampState } | null>;
  backfillConvoIsTemporary(input: {
    user: string;
    conversationId: string;
    touchUpdatedAt: boolean;
  }): Promise<boolean>;
  refreshChatProjectStats(user: string, chatProjectId: string): Promise<void>;
  recordChatProjectLastConversation(
    user: string,
    chatProjectId: string,
    conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  ): Promise<void>;
}

/**
 * The signature of `ConversationMethods['saveConvo']`, with message ids typed structurally so
 * this module need not name the MongoDB id type. Assignable to the method's declared type.
 */
export type SaveConvo = (
  ctx: {
    userId: string;
    isTemporary?: boolean;
    expiredAt?: Date;
    interfaceConfig?: AppConfig['interfaceConfig'];
  },
  data: { conversationId: string; newConversationId?: string; [key: string]: unknown },
  metadata?: {
    context?: string;
    unsetFields?: Record<string, number>;
    noUpsert?: boolean;
    createdAtOnInsert?: Date;
    preserveUpdatedAt?: boolean;
    titleSource?: 'manual' | 'generated';
    initialAgentId?: string | null;
    /** String ids or id objects (stringified for the store). */
    appendMessageIds?: Array<string | { toHexString(): string }>;
    stampReply?: boolean;
    replyMessageId?: string;
  },
) => Promise<IConversation | { message: string } | null>;

/** Titles a generated title may replace (`null` also matches a missing title). */
const PLACEHOLDER_TITLES: Array<string | null> = [null, '', 'New Chat'];

/** Copies one field of a reply stamp; an absent value removes the field, as the stamp did. */
function assignStampField<K extends keyof ConvoReplyStampState>(
  conversation: IConversation,
  key: K,
  value: ConvoReplyStampState[K],
): void {
  if (value === undefined) {
    delete conversation[key];
  } else {
    conversation[key] = value as IConversation[K];
  }
}

/** Builds `saveConvo` on `store`, which it shares: pass the steps of one instance. */
export function createSaveConvo(store: SaveConvoStore): SaveConvo {
  return async function saveConvo(
    { userId, isTemporary, expiredAt, interfaceConfig },
    { conversationId, newConversationId, ...convo },
    metadata,
  ) {
    try {
      if (metadata?.context) {
        logger.debug(`[saveConvo] ${metadata.context}`);
      }

      const appendMessageIds = metadata?.appendMessageIds?.map((id) => String(id));
      const update: Record<string, unknown> = { ...convo, user: userId };
      delete update.isTemporary;
      delete update.expiredAt;
      /* Read-state fields are server-owned. A stale marker must never be reintroduced by a
       * metadata save after a real reply cleared it. */
      delete update.lastResponseIsManual;
      delete update.isMarkedUnread;
      delete update.lastResponseAt;
      delete update.lastResponseMessageId;
      delete update.initial_agent_id;
      delete update.titleSetByUser;
      delete update.titleRevision;
      if (metadata?.titleSource === 'manual') {
        update.titleSetByUser = true;
      }
      /* Remembered tool approvals are granted only by a validated resume. */
      delete update.toolApprovalAllows;
      stripFields(update, LANE_PRIVATE_FIELDS);
      /** Ordinary saves may seed a decision, but only an explicit move may replace it. */
      const decisionOnInsert = {
        ...(convo.codeEnvironmentMode != null && {
          codeEnvironmentMode: convo.codeEnvironmentMode,
        }),
        ...(convo.codeWorkspaces != null && { codeWorkspaces: convo.codeWorkspaces }),
      } as ConvoCodeEnvironmentDecision;
      delete update.codeEnvironmentRevision;
      delete update.codeEnvironmentMode;
      delete update.codeWorkspaces;
      stripActorCheckpointFields(update);
      if (appendMessageIds == null) {
        update.messages = await store.getConvoMessageIds(userId, conversationId);
      } else {
        delete update.messages;
      }
      const unsetFields: Record<string, number> = { ...(metadata?.unsetFields ?? {}) };
      delete unsetFields.lastResponseIsManual;
      delete unsetFields.isMarkedUnread;
      delete unsetFields.lastResponseMessageId;
      delete unsetFields.lastResponseAt;
      delete unsetFields.initial_agent_id;
      delete unsetFields.titleSetByUser;
      delete unsetFields.titleRevision;
      delete unsetFields.toolApprovalAllows;
      stripFields(unsetFields, LANE_PRIVATE_FIELDS);
      delete unsetFields.codeEnvironmentRevision;
      delete unsetFields.codeEnvironmentMode;
      delete unsetFields.codeWorkspaces;
      stripActorCheckpointFields(unsetFields);
      let chatProjectIdOnInsert: string | undefined;
      // Turn saves may seed a new conversation, never move or detach an existing one.
      const candidate = update.chatProjectId;
      delete update.chatProjectId;
      delete unsetFields.chatProjectId;
      if (metadata?.noUpsert !== true && typeof candidate === 'string') {
        if (await store.isOwnedChatProject(userId, candidate)) {
          chatProjectIdOnInsert = candidate;
        }
      }
      const unsetKeys = Object.keys(unsetFields);

      if (newConversationId) {
        update.conversationId = newConversationId;
      }

      let retentionOnInsert: { expiredAt: Date; isTemporary: false } | undefined;
      const forcedTemporary = isForcedTemporaryRetention(interfaceConfig?.retentionMode);
      if (expiredAt instanceof Date && !Number.isNaN(expiredAt.getTime())) {
        if (forcedTemporary) {
          update.isTemporary = true;
        } else if (typeof isTemporary === 'boolean') {
          update.isTemporary = isTemporary;
        }
        update.expiredAt = expiredAt;
      } else if (forcedTemporary) {
        update.isTemporary = true;
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (interfaceConfig?.retentionMode === RetentionMode.ALL) {
        if (typeof isTemporary === 'boolean') {
          update.isTemporary = isTemporary;
        }
        if (
          typeof isTemporary === 'boolean' ||
          interfaceConfig.generalChatRetention === undefined
        ) {
          try {
            update.expiredAt = createChatExpirationDate(interfaceConfig, isTemporary);
          } catch (err) {
            logger.error('Error creating chat expiration date:', err);
            logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
            update.expiredAt = createFallbackRetentionDate();
          }
        } else {
          try {
            retentionOnInsert = {
              expiredAt: createChatExpirationDate(interfaceConfig, false),
              isTemporary: false,
            };
          } catch (err) {
            logger.error('Error creating chat expiration date:', err);
            logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
            retentionOnInsert = {
              expiredAt: createFallbackRetentionDate(),
              isTemporary: false,
            };
          }
        }
      } else if (isTemporary === true) {
        update.isTemporary = true;
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (isTemporary === false) {
        update.isTemporary = false;
        update.expiredAt = null;
      }

      const createdAtOnInsert =
        metadata?.createdAtOnInsert instanceof Date &&
        !Number.isNaN(metadata.createdAtOnInsert.getTime())
          ? metadata.createdAtOnInsert
          : undefined;
      /**
       * Metadata-only edits (pinning) must not read as activity: the sidebar orders
       * chats by `updatedAt`, so bumping it would hoist an untouched chat to Today.
       */
      const preserveUpdatedAt = metadata?.preserveUpdatedAt === true;
      const updatesArchiveState = typeof update.isArchived === 'boolean';
      if (!preserveUpdatedAt && (createdAtOnInsert || updatesArchiveState)) {
        update.updatedAt = new Date();
      }

      /** These saves carry their own `updatedAt` (or must keep it), so the store stamps neither. */
      const timestamps = !(updatesArchiveState || createdAtOnInsert || preserveUpdatedAt);

      const canUpsert = metadata?.noUpsert !== true && metadata?.titleSource !== 'generated';
      const initialAgentId =
        canUpsert &&
        typeof metadata?.initialAgentId === 'string' &&
        metadata.initialAgentId.trim() !== ''
          ? metadata.initialAgentId
          : null;

      /** A generated title only lands while the user has not titled the chat themselves. */
      const titleGuard: ConvoWrite['when'] =
        metadata?.titleSource === 'generated'
          ? { titleSetByUser: false, titleIn: PLACEHOLDER_TITLES }
          : undefined;
      const matchesTitleGuard = (conversation: IConversation) =>
        titleGuard == null ||
        (conversation.titleSetByUser !== true &&
          PLACEHOLDER_TITLES.includes(conversation.title ?? null));

      const buildWrite = (
        setFields: Record<string, unknown>,
        upsert: boolean,
        when?: ConvoWrite['when'],
      ): ConvoWrite => {
        let set = setFields;
        let max: ConvoWrite['max'];
        const unset: string[] = [];
        /* Two responses can persist concurrently, and the older one can reach the write last.
         * `max` keeps whichever stamp is later. */
        if (setFields.lastResponseAt instanceof Date) {
          const { lastResponseAt, ...withoutReplyStamp } = setFields;
          set = {
            ...withoutReplyStamp,
            isMarkedUnread: false,
            lastSeenAt: new Date(UNSEEN_REPLY_WATERMARK),
          };
          max = { lastResponseAt };
          unset.push('lastResponseIsManual');
        }
        unset.push(...unsetKeys);
        const createdAtForInsert = updatesArchiveState
          ? (createdAtOnInsert ??
            (!preserveUpdatedAt && update.updatedAt instanceof Date ? update.updatedAt : undefined))
          : createdAtOnInsert;
        return {
          user: userId,
          conversationId,
          ...(when != null && { when }),
          set,
          ...(unset.length > 0 && { unset }),
          setOnInsert: {
            initial_agent_id: initialAgentId,
            ...decisionOnInsert,
            ...retentionOnInsert,
            ...(chatProjectIdOnInsert ? { chatProjectId: chatProjectIdOnInsert } : {}),
            ...(createdAtForInsert ? { createdAt: createdAtForInsert } : {}),
          },
          ...(metadata?.titleSource === 'manual' && { increment: { titleRevision: 1 } }),
          ...(max != null && { max }),
          ...(appendMessageIds != null && appendMessageIds.length > 0 && { appendMessageIds }),
          upsert,
          timestamps,
        };
      };

      /** The conversation as the save's own conditions see it, or `null`. */
      const readMatching = async (): Promise<IConversation | null> => {
        const current = await store.getConvo(userId, conversationId);
        return current != null && matchesTitleGuard(current) ? current : null;
      };

      let written: ConvoWriteResult | null;
      if (update.isArchived === true) {
        /** DocumentDB documents no support for pipeline-form updates on any engine
         * version (`misc/documentdb/documentdb-compat.md`), so the stamp is applied
         * by compare-and-set instead of `$cond`. Matching on the flag is what keeps
         * it atomic: only the write that finds the chat unarchived stamps it, so a
         * duplicate or retried archive cannot move `archivedAt`, and an unarchive
         * that lands first is re-stamped rather than left bare. */
        const withoutStamp = { ...update };
        delete withoutStamp.archivedAt;
        const stamped = { ...withoutStamp, archivedAt: update.archivedAt ?? new Date() };

        const runArchiveWrites = async () =>
          (await store.writeConvo(
            buildWrite(stamped, false, { ...titleGuard, isArchived: false }),
          )) ??
          store.writeConvo(buildWrite(withoutStamp, false, { ...titleGuard, isArchived: true }));

        written = await runArchiveWrites();
        /** Both conditional writes miss when the flag flips between them: the chat was
         * already archived when the first ran and unarchived again before the second.
         * That is a live conversation, so confirm it is really gone before letting the
         * route answer 404, and retry the pair when it is not. */
        for (let attempt = 0; !written && attempt < 2; attempt++) {
          const exists =
            titleGuard == null
              ? await store.convoExists(userId, conversationId)
              : (await readMatching()) != null;
          if (!exists) {
            break;
          }
          written = await runArchiveWrites();
        }
        if (!written && canUpsert) {
          written = await store.writeConvo(buildWrite(stamped, true));
        }
        if (!written) {
          /** Alternating archive and unarchive requests can split every attempt, so
           * exhausting the retries still proves nothing about whether the chat exists.
           * Answer with its actual current state rather than reporting it missing. */
          const current = await readMatching();
          if (current) {
            written = { conversation: current, inserted: false };
          }
        }
      } else {
        written = await store.writeConvo(
          buildWrite(
            updatesArchiveState ? { ...update, archivedAt: null } : update,
            canUpsert,
            titleGuard,
          ),
        );
      }

      if (!written) {
        logger.debug('[saveConvo] Conversation not found, skipping update');
        return null;
      }
      const { conversation, inserted } = written;
      const target = { user: userId, conversationId: conversation.conversationId };

      /** `setOnInsert` only reaches a chat this save creates, yet a chat whose earlier turns never
       * involved a code-capable agent holds no decision either: without this fill its first
       * workspace choice is dropped and the next turn starts undecided again. The step repeats
       * that absence, so a concurrent writer that decided first keeps its decision and a chat that
       * already holds one is never touched. Only a whole decision seeds a row, never bare
       * selections. */
      if (
        decisionOnInsert.codeEnvironmentMode != null &&
        conversation.codeEnvironmentMode == null &&
        (conversation.codeWorkspaces?.length ?? 0) === 0
      ) {
        if (
          await store.seedConvoCodeEnvironmentDecision({ ...target, decision: decisionOnInsert })
        ) {
          Object.assign(conversation, decisionOnInsert);
        }
      }

      /** Reuse the saved row's chat type when callers omit it, preserving existing deadlines. */
      if (
        interfaceConfig?.retentionMode === RetentionMode.ALL &&
        interfaceConfig.generalChatRetention !== undefined &&
        typeof isTemporary !== 'boolean' &&
        conversation.expiredAt == null
      ) {
        const storedTemporary = conversation.isTemporary === true;
        const deadline = createChatExpirationDate(interfaceConfig, storedTemporary);
        if (
          await store.setConvoExpiryIfUnset({
            ...target,
            isTemporary: storedTemporary,
            expiredAt: deadline,
          })
        ) {
          conversation.expiredAt = deadline;
        }
      }

      /* Advance the version and reset catch-up atomically. The database CAS orders
       * concurrent replies even when their application hosts disagree about wall-clock time. */
      let replyStampApplied = false;
      if (metadata?.stampReply === true) {
        const responseMessageId = metadata.replyMessageId;
        if (typeof responseMessageId === 'string' && responseMessageId.length > 0) {
          try {
            const stamped = await store.stampConvoReply({ ...target, responseMessageId });
            if (stamped) {
              /* The caller hands this document to the client as the turn's conversation, and the
               * seen acknowledgement is bound to the stamp it carries. */
              replyStampApplied = true;
              conversation.lastResponseAt = stamped.lastResponseAt;
              assignStampField(
                conversation,
                'lastResponseMessageId',
                stamped.state.lastResponseMessageId,
              );
              assignStampField(
                conversation,
                'lastResponseIsManual',
                stamped.state.lastResponseIsManual,
              );
              assignStampField(conversation, 'isMarkedUnread', stamped.state.isMarkedUnread);
              assignStampField(conversation, 'lastSeenAt', stamped.state.lastSeenAt);
              if (stamped.state.updatedAt) {
                conversation.updatedAt = stamped.state.updatedAt;
              }
            }
          } catch (error) {
            logger.error('[saveConvo] Failed to stamp persisted reply', error);
          }
        }
      }

      /* The step writes only while no chat type is stored, which is every case a stored
         `isTemporary: true` does not rule out. */
      if (
        interfaceConfig?.retentionMode === RetentionMode.ALL &&
        typeof isTemporary !== 'boolean' &&
        conversation.isTemporary !== true
      ) {
        /* This backfill runs after the main write, so it needs the same timestamp
           suppression: otherwise the first pin or archive of a legacy chat under
           `RetentionMode.ALL` bumps `updatedAt` here and lands in Today anyway.
           A reply stamp is the same case for a different reason: the CAS above set `updatedAt`
           to the stamp deliberately, and an away tab that has never cached this conversation
           reads the two disagreeing as a metadata-only promotion, withholding the reply's
           chime and desktop notification. */
        await store.backfillConvoIsTemporary({
          ...target,
          touchUpdatedAt: !(preserveUpdatedAt || replyStampApplied),
        });
        conversation.isTemporary = false;
      }

      /* The conversation and its reply stamp are durable by now, and the caller hands this
         document to the client as the turn's conversation. Project statistics are maintenance
         on a different collection: letting one of their failures reach the catch below would
         answer a successful save with an error, dropping the stamp from the terminal event and
         presenting a reply the user already watched arrive as unread on the next refresh. */
      try {
        if (conversation.chatProjectId) {
          const isRetentionVisibilityUpdate =
            typeof update.isTemporary === 'boolean' ||
            Object.prototype.hasOwnProperty.call(convo, 'expiredAt') ||
            Object.prototype.hasOwnProperty.call(unsetFields, 'isTemporary') ||
            Object.prototype.hasOwnProperty.call(unsetFields, 'expiredAt');
          /**
           * Saving a conversation that is itself archived or retention-hidden (e.g.
           * renaming or title generation on an archived project chat) must recompute
           * stats rather than take the incremental fast path, otherwise the project's
           * lastConversationAt/Id would point at a chat the project workspace hides.
           */
          const isConversationHidden =
            conversation.isArchived === true ||
            conversation.isTemporary === true ||
            (conversation.expiredAt != null &&
              new Date(conversation.expiredAt).getTime() <= Date.now());
          const shouldRefreshProjectStats =
            inserted ||
            typeof update.isArchived === 'boolean' ||
            Object.prototype.hasOwnProperty.call(unsetFields, 'isArchived') ||
            isRetentionVisibilityUpdate ||
            isConversationHidden;

          if (shouldRefreshProjectStats) {
            await store.refreshChatProjectStats(userId, conversation.chatProjectId);
          } else if (!preserveUpdatedAt) {
            await store.recordChatProjectLastConversation(
              userId,
              conversation.chatProjectId,
              conversation,
            );
          }
        }
      } catch (error) {
        logger.error('[saveConvo] Failed to maintain project statistics', error);
      }

      return conversation;
    } catch (error) {
      logger.error('[saveConvo] Error saving conversation', error);
      if (metadata?.context) {
        logger.info(`[saveConvo] ${metadata.context}`);
      }
      return { message: 'Error saving conversation' };
    }
  };
}

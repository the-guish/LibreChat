import type { DeleteResult, FilterQuery, InsertManyOptions, Model, Types } from 'mongoose';
import type { UserSubmittedMessageFieldPath } from 'librechat-data-provider';
import type { SearchParams } from 'meilisearch';
import type {
  AppConfig,
  IConversation,
  IMessage,
  SubagentTaskResultClaim,
  BackgroundToolResultClaim,
  SubagentThreadViewMessageRecord,
  ParentSubagentTaskRecord,
  ConversationTraceRefs,
  PrivateTextWrite,
  PrivateTextRead,
  UserRecordCount,
} from '~/types';
import type {
  MessageProvenance,
  ProjectedSubagentThreadViewMessage,
  SteplessToolCallFallback,
  StoredSubagentControlReceipt,
  SubagentControlReplay,
  UpdateToolCallResultInput,
  WithNullSentinels,
} from './messageRules';
import type {
  MessagePage,
  MessagePageOptions,
  MessageSearchHit,
  MessageSearchInput,
  MessageSearchResult,
} from '~/ports/message';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import type { ISubagentContentChunk } from '~/models/subagentContent';
import {
  ATTACHMENT_MERGE_CAS_ATTEMPTS,
  MAX_PROVENANCE_CAS_ATTEMPTS,
  MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH,
  MAX_SUBAGENT_CONTROL_RECEIPT_CAS_ATTEMPTS,
  NO_BOUND_APPS,
  SERVER_AUTHORED_SAMPLED_RESPONSE,
  SUBAGENT_ACTIVITY_PROJECTION_SOURCE_BYTE_LIMIT,
  SUBAGENT_ACTIVITY_SOURCE_CANDIDATE_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT,
  SUBAGENT_RESULT_PROJECTION,
  SUBAGENT_TERMINAL_STATUSES,
  SUBAGENT_TRANSCRIPT_PAGE_LIMIT,
  SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT,
  SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
  SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT,
  UUID_REGEX,
  backgroundClaimOutcome,
  backgroundClaimSourceFilter,
  backgroundClaimStampUpdate,
  backgroundClaimWriteFilter,
  backgroundClaimsReleased,
  backgroundTaskHandleFilter,
  buildBulkSaveMessageOperation,
  buildInsertOnlyMessageUpdate,
  buildMessageSaveUpdate,
  findBranchReasoningOverride,
  findSteplessToolCallFallback,
  finishMessagePage,
  getMissingProvenanceFilter,
  getProvenanceSnapshotFilter,
  isDuplicateKeyError,
  isSubagentTaskMessageId,
  isWholeMessageScope,
  mergeMessageProvenance,
  mergeSubagentTaskRecords,
  mergeToolCallAttachments,
  messagePageFilter,
  messagePageProjection,
  normalizeBackgroundToolResultClaim,
  normalizeUserSubmittedMessageFieldPaths,
  normalizeUserSubmittedPaths,
  parseTraceOrderKey,
  persistedPrivateTextFilter,
  planBackgroundClaimConfirmation,
  planBackgroundClaimRelease,
  planBackgroundToolResultClaim,
  planPermanentChatTypeBackfill,
  planRetentionDeadlineBackfill,
  planToolCallSettlement,
  prepareMessageSave,
  privateMessageTextsFilter,
  pruneProjectedThreadViewMessage,
  publicSubagentControlReceipt,
  readBackgroundToolHandle,
  retainSubagentControlReceipts,
  sampledTraceDestinationFilter,
  sanitizeMessageUpdate,
  settleToolCallContent,
  subagentContentDeletionFence,
  subagentContentDeletionScopes,
  subagentControlReceiptIdentity,
  subagentResultClaimable,
  subagentTaskSourceLimit,
  toConversationTraceRefs,
  toSubagentControlReplay,
  toUpdatedMessageFields,
  traceRange,
  traceTenantScope,
  validateSubagentControlReceiptRead,
  validateSubagentControlReplay,
  validateSubagentResultClaim,
} from './messageRules';
import { fitBoundAppSnapshots, hasBoundAppSnapshots } from './appSnapshots';
import { prepareSubagentContentDeletion } from './subagentContent';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { activeExpirationFilter } from '~/utils/retention';
import logger from '~/config/winston';

/** Declared in `~/types` (shared with the message store port); re-exported here unchanged. */
export type {
  SubagentTaskResultClaim,
  BackgroundToolResultRecord,
  BackgroundToolResultClaim,
  SubagentThreadViewMessageRecord,
  ParentSubagentTaskRecord,
  SampledTraceMessage,
  ConversationTraceRefs,
  PrivateTextWrite,
  PrivateTextRead,
} from '~/types';

/** Moved to the shared rules (`./messageRules`); re-exported here unchanged. */
export {
  SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT,
  SUBAGENT_TRANSCRIPT_PAGE_LIMIT,
  SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
} from './messageRules';
export type { ProjectedSubagentThreadViewMessage } from './messageRules';

async function findOneAndMergeMessageProvenance(
  Message: Model<IMessage>,
  identity: FilterQuery<IMessage>,
  update: Record<string, unknown>,
  userSubmittedPaths: readonly string[],
  userSubmittedMessageFieldPaths: readonly UserSubmittedMessageFieldPath[],
  options: {
    upsert: boolean;
    stampModelOutputOnInsert?: boolean;
    unsetContextMeta?: boolean;
    unsetPrivateText?: boolean;
    retentionOnInsert?: { expiredAt: Date; isTemporary: false };
    prepareAppUpdate?: (
      current: Record<string, unknown> | null,
      update: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    timestamps?: boolean;
    privateMessagePaths?: string;
    onWrite?: (inserted: boolean, id: unknown) => void;
  },
) {
  const safeUpdate = sanitizeMessageUpdate(update);
  const preservesStoredIsUserSubmitted = !Object.prototype.hasOwnProperty.call(
    safeUpdate,
    'isUserSubmitted',
  );

  /** A small optimistic loop keeps the merge atomic while using only classic update operators. */
  for (let attempt = 0; attempt < MAX_PROVENANCE_CAS_ATTEMPTS; attempt += 1) {
    const current = await Message.findOne(identity)
      .select(
        options.prepareAppUpdate
          ? (options.privateMessagePaths ?? '')
          : {
              isUserSubmitted: 1,
              userSubmittedPaths: 1,
              userSubmittedMessageFieldPaths: 1,
              _id: 0,
            },
      )
      .lean<
        | (MessageProvenance & {
            _id?: Types.ObjectId;
            attachments?: unknown[];
            content?: unknown[];
            __v?: number;
          })
        | null
      >();
    if (current == null && !options.upsert) {
      return null;
    }

    const provenance = mergeMessageProvenance(
      current,
      userSubmittedPaths,
      userSubmittedMessageFieldPaths,
      options.stampModelOutputOnInsert,
      typeof safeUpdate.isUserSubmitted === 'boolean' ? safeUpdate.isUserSubmitted : undefined,
      preservesStoredIsUserSubmitted,
    );
    const filter = {
      ...identity,
      ...(current == null ? getMissingProvenanceFilter() : getProvenanceSnapshotFilter(current)),
      ...(options.prepareAppUpdate &&
        (current != null
          ? {
              _id: current._id,
              __v: current.__v ?? null,
            }
          : { _id: new Message.base.Types.ObjectId() })),
    };
    const admittedUpdate = options.prepareAppUpdate
      ? await options.prepareAppUpdate(current, { ...safeUpdate, ...provenance })
      : { ...safeUpdate, ...provenance };

    try {
      const message = await Message.findOneAndUpdate(
        filter,
        {
          $set: admittedUpdate,
          $inc: { __v: 1 },
          ...(current == null &&
            options.retentionOnInsert != null && { $setOnInsert: options.retentionOnInsert }),
          ...((options.unsetContextMeta || options.unsetPrivateText) && {
            $unset: {
              ...(options.unsetContextMeta && { contextMeta: 1 }),
              ...(options.unsetPrivateText && {
                privateText: 1,
                privacyRevision: 1,
                ...(update.privateTextTokens === undefined && { privateTextTokens: 1 }),
              }),
            },
          }),
        },
        { upsert: options.upsert && current == null, new: true, timestamps: options.timestamps },
      );
      if (message != null) {
        options.onWrite?.(current == null, message._id);
        return message;
      }
    } catch (err) {
      if (!isDuplicateKeyError(err) || !options.upsert) {
        throw err;
      }
    }
  }

  throw new Error('Message provenance write contention exceeded its retry bound.');
}

/**
 * Exclusion projection for message reads that feed the chat client (the
 * conversation GET and shared-link reads). Every excluded field is either
 * server-internal (ids, replay signatures, legacy summarization state) or a
 * web_search SERP vertical no citation marker or UI can address: markers
 * resolve `search|image|news|video|ref|file` through organic/images/
 * topStories/videos/references (all kept — `news` markers read topStories,
 * never the `news` collection). The JSON export mirrors this cache, so
 * fields removed here also leave user exports.
 */
/** Declared in the message store port, which names it for every store; re-exported unchanged. */
export { CLIENT_MESSAGE_SELECT } from '~/ports/message';

interface MessageQueryOptions {
  limit?: number;
  sort?: Record<string, 1 | -1> | false;
}

export interface MessageMethods {
  getPersistedPrivateTextId(
    input: Parameters<MessageMethods['hasPersistedPrivateText']>[0],
  ): Promise<string | null>;
  hasPersistedPrivateText(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageId: string;
    privacyRevision: string;
    text: string;
  }): Promise<boolean>;
  getPrivateMessageTexts(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageIds: readonly string[];
  }): Promise<PrivateTextRead[]>;
  saveMessage(
    ctx: {
      userId: string;
      isTemporary?: boolean;
      expiredAt?: Date;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    params: Omit<Partial<IMessage>, 'contextMeta'> & {
      newMessageId?: string;
      contextMeta?: IMessage['contextMeta'] | null;
    },
    metadata?: { context?: string; privateText?: PrivateTextWrite; insertOnly?: boolean },
  ): Promise<IMessage | null | undefined>;
  /**
   * Reads the references a trace viewer needs for one of the user's
   * conversations: when it began and which responses were sampled into traces.
   */
  getConversationTraceRefs(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    /** Only this response, when it is a sampled one. */
    messageId?: string;
    /** The newest response to include, by the `orderKey` a previous read returned for it. */
    through?: { messageId: string; orderKey: string };
    /** The most responses to return, newest first from `through`; all of them when absent. */
    limit?: number;
  }): Promise<ConversationTraceRefs>;
  /**
   * Whether any of the user's responses in the conversation was sampled into a
   * trace that one of `destinationIds` can hold. A response with no recorded
   * destinations predates the record and counts for every destination.
   */
  hasSampledTraceMessage(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    destinationIds: string[];
  }): Promise<boolean>;
  recordSubagentTaskControlReceipt(input: {
    userId: string;
    conversationId: string;
    taskId: string;
    tenantId?: string;
    receipt: NonNullable<NonNullable<IMessage['subagentTask']>['controlReceipts']>[number];
  }): Promise<boolean | 'unchanged' | 'conflict'>;
  getSubagentTaskControlReceipt(input: {
    userId: string;
    conversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
    activeOnly?: boolean;
  }): Promise<NonNullable<NonNullable<IMessage['subagentTask']>['controlReceipts']>[number] | null>;
  getSubagentTaskControlReplay(input: {
    userId: string;
    parentConversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
  }): Promise<{
    receipt: NonNullable<NonNullable<IMessage['subagentTask']>['controlReceipts']>[number];
    task: {
      taskId: string;
      threadId: string;
      subagentType: string;
      status: NonNullable<IMessage['subagentTask']>['status'];
      resultAvailable: boolean;
      resultClaimed: boolean;
      pendingControls: number;
      createdAt: Date;
      updatedAt: Date;
    };
  } | null>;
  bulkSaveMessages(
    messages: Array<Partial<IMessage>>,
    overrideTimestamp?: boolean,
    provenance?: { privateTextTokens: ReadonlyMap<string, readonly string[]> },
  ): Promise<unknown>;
  updateToolCallResult(params: {
    userId: string;
    messageId: string;
    conversationId: string;
    toolCallId: string;
    stepId?: string;
    agentId?: string;
    output?: string;
    attachments?: unknown[];
    markBackgrounded?: boolean;
    backgroundTask?: {
      taskId: string;
      toolName: string;
      status: 'completed' | 'error';
      cancelled?: true;
      settledAt: Date;
      completionWakeup?: true;
      completionReceipt?: true;
      resultClaim?: {
        kind: 'manual' | 'wakeup';
        claimId: string;
        claimedAt: Date;
        generationId?: string;
        receiptReconciled?: true;
      };
    };
  }): Promise<{ matched: boolean; unfinished: boolean }>;
  claimBackgroundToolResults(params: {
    userId: string;
    conversationId: string;
    /** Optional on recovery polls after the process-local task registry was lost. */
    messageId?: string;
    taskId: string;
    agentId?: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
    /** Physical receipt-batch identity, independent of its logical request. */
    batchId?: string;
    /** Response generation that owns this manual result delivery. */
    generationId?: string;
    /** Manual owner-process takeover after automatic delivery was retired. */
    allowUnfinished?: boolean;
    limit?: number;
    /** Includes JSON escaping, delimiters, and empty result fields. */
    maxMetadataChars?: number;
  }): Promise<BackgroundToolResultClaim>;
  confirmBackgroundToolResultClaim(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    taskId: string;
    claimId: string;
  }): Promise<boolean>;
  releaseBackgroundToolResultClaims(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    /** Omit to release every sibling owned by this exact batch claim. */
    taskIds?: string[];
    /** Receipt-backed results can precede the message projection. */
    allowMissingMessage?: true;
    /** Manual rollback must not erase a committed receipt handoff. */
    onlyIfUnreconciled?: true;
    batchId?: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean>;
  updateMessage(
    userId: string,
    message: Partial<IMessage> & { newMessageId?: string },
    metadata?: { context?: string },
  ): Promise<Partial<IMessage>>;
  claimSubagentTaskResult(params: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<SubagentTaskResultClaim>;
  releaseSubagentTaskResultClaim(params: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean>;
  getMessages(
    filter: FilterQuery<IMessage>,
    select?: string,
    options?: MessageQueryOptions,
  ): Promise<IMessage[]>;
  getMessagesForSubagentThreadView(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    selectedTaskId?: string;
    beforeMessageId?: string;
    limit: number;
    textCodePointLimit: number;
  }): Promise<SubagentThreadViewMessageRecord[]>;
  listSubagentTasksForThreads(input: {
    user: string;
    conversationIds: string[];
    tenantId?: string;
    limitPerThread: number;
  }): Promise<ParentSubagentTaskRecord[]>;
  getMessage(params: { user: string; messageId: string }): Promise<IMessage | null>;
  getBranchReasoningOverride(params: {
    user: string;
    conversationId: string;
    parentMessageId: string;
  }): Promise<IMessage['reasoningOverride'] | null>;
  getMessagesByCursor(
    filter: FilterQuery<IMessage>,
    options?: {
      sortField?: string;
      sortOrder?: 1 | -1;
      limit?: number;
      cursor?: string | null;
      select?: string;
    },
  ): Promise<{ messages: IMessage[]; nextCursor: string | null }>;
  searchMessages(
    query: string,
    searchOptions: SearchParams,
    hydrate?: boolean,
  ): Promise<Awaited<ReturnType<SchemaWithMeiliMethods['meiliSearch']>>>;
  getMessagesPage(filter: FilterQuery<IMessage>, options: MessagePageOptions): Promise<MessagePage>;
  searchUserMessages(input: MessageSearchInput): Promise<MessageSearchResult>;
  deleteMessages(filter: FilterQuery<IMessage>): Promise<DeleteResult>;
  countMessagesByUser(): Promise<UserRecordCount[]>;
  insertMessageRecords(records: Array<Record<string, unknown>>): Promise<void>;
}

export interface MessageDependencies {
  /** Read from deployment config, never from a message/request or a principal override. */
  getMCPAppMessageBudget?: () => Promise<number | undefined>;
}

export function createMessageMethods(
  mongoose: typeof import('mongoose'),
  deps: MessageDependencies = {},
): MessageMethods {
  /** The API constructs method adapters before it necessarily registers every model. */
  function privateMessagePaths(): string {
    const Message = mongoose.models.Message as Model<IMessage>;
    return Object.entries(Message.schema.paths)
      .filter(([, path]) => path.options.select === false)
      .map(([name]) => `+${name}`)
      .join(' ');
  }

  async function prepareAppUpdate(
    update: Record<string, unknown>,
    current: Record<string, unknown> | null,
    unsetContextMeta = false,
    retentionOnInsert?: { expiredAt: Date; isTemporary: false },
  ): Promise<Record<string, unknown>> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const safeUpdate = sanitizeMessageUpdate(update);
    // Omission retains the attachments of THIS fenced row; null/[] explicitly clears them.
    const attachments = Object.prototype.hasOwnProperty.call(safeUpdate, 'attachments')
      ? safeUpdate.attachments
      : current?.attachments;
    if (!hasBoundAppSnapshots(attachments)) return safeUpdate;
    const maxBytes = await deps.getMCPAppMessageBudget?.();
    const admitted = fitBoundAppSnapshots(
      attachments as unknown[],
      (candidateAttachments) => {
        const fields = {
          ...current,
          ...(current == null ? retentionOnInsert : {}),
          ...safeUpdate,
          attachments: candidateAttachments,
          ...(unsetContextMeta ? { contextMeta: undefined } : {}),
          createdAt: current?.createdAt ?? safeUpdate.createdAt ?? new Date(),
          updatedAt: new Date(),
          __v: (Number(current?.__v) || 0) + 1,
        };
        const next = new Message(fields).toObject({ depopulate: true, minimize: false });
        // Keep unknown fields already stored by a newer producer, even if this schema drops them.
        const candidate = { ...current, ...next };
        if (unsetContextMeta) delete candidate.contextMeta;
        return mongoose.mongo.BSON.calculateObjectSize(candidate);
      },
      maxBytes,
    );
    if (admitted !== attachments) {
      logger.warn('[saveMessage] Optional MCP App documents exceeded the message BSON budget');
    }
    return admitted === attachments ? safeUpdate : { ...safeUpdate, attachments: admitted };
  }

  /** One admission owner for save, edit, record and import. No size heuristics or stale closures. */
  async function writeMessage(
    identity: FilterQuery<IMessage>,
    input: Record<string, unknown>,
    options: {
      upsert: boolean;
      stampModelOutputOnInsert?: boolean;
      unsetContextMeta?: boolean;
      retentionOnInsert?: { expiredAt: Date; isTemporary: false };
      unsetPrivateText?: boolean;
      timestamps?: boolean;
      onWrite?: (inserted: boolean, id: unknown) => void;
    },
  ): Promise<IMessage | null> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const update = sanitizeMessageUpdate(input);
    const paths = normalizeUserSubmittedPaths(update.userSubmittedPaths);
    const fields = normalizeUserSubmittedMessageFieldPaths(update.userSubmittedMessageFieldPaths);
    delete update.userSubmittedPaths;
    delete update.userSubmittedMessageFieldPaths;
    if (!hasBoundAppSnapshots(update.attachments) && paths.length === 0 && fields.length === 0) {
      try {
        // Preserve the single-write common path. If an App row is excluded, its existing
        // unique (messageId, user, tenantId) index rejects the upsert; budget that row below.
        const fast = await Message.findOneAndUpdate(
          { ...identity, ...NO_BOUND_APPS },
          buildMessageSaveUpdate(update, {
            stampModelOutputOnInsert: options.stampModelOutputOnInsert ?? false,
            unsetContextMeta: options.unsetContextMeta ?? false,
            retentionOnInsert: options.retentionOnInsert,
            unsetPrivateText: options.unsetPrivateText,
          }),
          {
            upsert: options.upsert,
            new: true,
            timestamps: options.timestamps,
            includeResultMetadata: true,
          },
        );
        if (fast.value) {
          options.onWrite?.(fast.lastErrorObject?.updatedExisting === false, fast.value._id);
          return fast.value;
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
    return findOneAndMergeMessageProvenance(Message, identity, update, paths, fields, {
      ...options,
      privateMessagePaths: privateMessagePaths(),
      prepareAppUpdate: (current, sanitized) =>
        prepareAppUpdate(sanitized, current, options.unsetContextMeta, options.retentionOnInsert),
    });
  }

  /**
   * Saves a message in the database.
   */
  async function saveMessage(
    {
      userId,
      isTemporary,
      expiredAt,
      interfaceConfig,
    }: {
      userId: string;
      isTemporary?: boolean;
      expiredAt?: Date;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    params: Omit<Partial<IMessage>, 'contextMeta'> & {
      newMessageId?: string;
      /** `null` unsets a previously stored value; omission leaves it in place. */
      contextMeta?: IMessage['contextMeta'] | null;
    },
    metadata?: { context?: string; privateText?: PrivateTextWrite; insertOnly?: boolean },
  ) {
    if (!userId) {
      throw new Error('User not authenticated');
    }

    const conversationId = params.conversationId as string | undefined;
    if (!conversationId || !UUID_REGEX.test(conversationId)) {
      logger.warn(
        `Invalid conversation ID: ${conversationId} (context: ${metadata?.context ?? 'n/a'})`,
      );
      return;
    }

    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const prepared = prepareMessageSave(
        { userId, isTemporary, expiredAt, interfaceConfig },
        params,
        metadata,
      );
      if (metadata?.insertOnly === true) {
        const existingOrInserted = await Message.findOneAndUpdate(
          { messageId: params.messageId, user: userId },
          buildInsertOnlyMessageUpdate(prepared, metadata),
          { upsert: true, new: true, timestamps: false },
        );
        return existingOrInserted?.toObject();
      }
      const message = await writeMessage(
        { messageId: params.messageId, user: userId },
        {
          ...prepared.update,
          userSubmittedPaths: prepared.userSubmittedPaths,
          userSubmittedMessageFieldPaths: prepared.userSubmittedMessageFieldPaths,
        },
        {
          upsert: true,
          stampModelOutputOnInsert: prepared.stampModelOutputOnInsert,
          unsetContextMeta: prepared.unsetContextMeta,
          retentionOnInsert: prepared.retentionOnInsert,
          unsetPrivateText: prepared.unsetPrivateText,
        },
      );

      if (message == null) {
        return message;
      }

      /** Reuse the saved row's chat type when callers omit it, preserving existing deadlines. */
      const backfill = planRetentionDeadlineBackfill(
        { userId, isTemporary, expiredAt, interfaceConfig },
        message,
      );
      if (backfill != null) {
        const result = await Message.updateOne(backfill.filter, backfill.update, {
          timestamps: false,
        });
        if (result.modifiedCount > 0) {
          message.expiredAt = backfill.deadline;
        }
      }

      const permanent = planPermanentChatTypeBackfill(
        { userId, isTemporary, expiredAt, interfaceConfig },
        message,
      );
      if (permanent != null) {
        await Message.updateOne(permanent.filter, permanent.update);
        message.isTemporary = false;
      }

      return message.toObject();
    } catch (err: unknown) {
      logger.error('Error saving message:', err);
      logger.info(`---\`saveMessage\` context: ${metadata?.context}`);

      const mongoErr = err as { code?: number; message?: string };
      if (mongoErr.code === 11000 && mongoErr.message?.includes('duplicate key error')) {
        logger.warn(`Duplicate messageId detected: ${params.messageId}. Continuing execution.`);

        try {
          const Message = mongoose.models.Message as Model<IMessage>;
          const existingMessage = await Message.findOne({
            messageId: params.messageId,
            user: userId,
          });

          if (existingMessage) {
            return existingMessage.toObject();
          }

          return undefined;
        } catch (findError) {
          logger.warn(
            `Could not retrieve existing message with ID ${params.messageId}: ${(findError as Error).message}`,
          );
          return undefined;
        }
      }

      throw err;
    }
  }

  /**
   * Saves multiple messages in bulk.
   */
  async function bulkSaveMessages(
    messages: Array<Record<string, unknown>>,
    overrideTimestamp = false,
    provenance?: { privateTextTokens: ReadonlyMap<string, readonly string[]> },
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const bulkOps = messages.map((message) =>
        buildBulkSaveMessageOperation(message, overrideTimestamp, provenance),
      );
      // Keep no-App imports batched. The atomic predicate makes a race with App attachment
      // creation collide on the unique key, at which point only that row uses guarded admission.
      const guarded: typeof bulkOps = [];
      const ordinary = bulkOps.filter((op) => {
        if (hasBoundAppSnapshots(op.updateOne.update.$set.attachments)) {
          guarded.push(op);
          return false;
        }
        return true;
      });
      let result:
        | {
            matchedCount: number;
            modifiedCount: number;
            upsertedCount: number;
            upsertedIds: Record<number, unknown>;
          }
        | undefined;
      const repaired = {
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedIds: {} as Record<number, unknown>,
      };
      if (ordinary.length) {
        try {
          result = await tenantSafeBulkWrite(
            Message,
            ordinary.map((op) => ({
              updateOne: {
                ...op.updateOne,
                filter: { ...op.updateOne.filter, ...NO_BOUND_APPS },
              },
            })),
            { ordered: false },
          );
        } catch (error) {
          const failure = error as {
            writeErrors?: Array<{ code: number; index: number }>;
            result?: typeof result;
          };
          if (
            !failure.writeErrors?.length ||
            failure.writeErrors.some((item) => item.code !== 11000)
          )
            throw error;
          result = failure.result;
          for (const { index } of failure.writeErrors) guarded.push(ordinary[index]);
        }
      }
      // Ordinary imports stay batched; exceptional App rows are admitted one at a time.
      for (const op of guarded) {
        await writeMessage(op.updateOne.filter, op.updateOne.update.$set, {
          upsert: true,
          unsetPrivateText: true,
          timestamps: !overrideTimestamp,
          onWrite: (inserted, id) => {
            if (inserted) {
              repaired.upsertedCount++;
              repaired.upsertedIds[bulkOps.indexOf(op)] = id;
            } else {
              repaired.matchedCount++;
              repaired.modifiedCount++;
            }
          },
        });
      }
      if (!guarded.length) return result;
      const upsertedIds: Record<number, unknown> = { ...repaired.upsertedIds };
      for (const [index, id] of Object.entries(result?.upsertedIds ?? {})) {
        upsertedIds[bulkOps.indexOf(ordinary[Number(index)])] = id;
      }
      return {
        insertedCount: 0,
        deletedCount: 0,
        insertedIds: {},
        upsertedIds,
        matchedCount: (result?.matchedCount ?? 0) + repaired.matchedCount,
        modifiedCount: (result?.modifiedCount ?? 0) + repaired.modifiedCount,
        upsertedCount: (result?.upsertedCount ?? 0) + repaired.upsertedCount,
      };
    } catch (err) {
      logger.error('Error saving messages in bulk:', err);
      throw err;
    }
  }

  /**
   * Patches a persisted tool_call content part in place and appends attachments,
   * for results that settle after the turn's message was finalized (background
   * tool calls). Atomic single update so two tasks completing concurrently on
   * the same message cannot lose each other's attachments, and IDEMPOTENT
   * (attachments dedupe by `file_id ?? filepath`, scoped to this tool call so
   * sibling calls sharing a filename keep their own entries) so it can be
   * re-applied to heal a later full-row save that reverted the patch.
   *
   * Returns `matched: false` when the message row does not exist yet (the
   * dispatch turn has not finalized) and surfaces `unfinished` when the
   * matched row is a mid-turn partial save (client disconnect) — the eventual
   * finalize will overwrite the patch with in-memory content, so callers
   * should keep re-applying until a finalized row is patched.
   */
  async function updateToolCallResult(
    input: UpdateToolCallResultInput,
  ): Promise<{ matched: boolean; unfinished: boolean }> {
    const exact = await settleToolCallResult(input, input.stepId);
    if (exact.matched || input.stepId == null) {
      return exact;
    }
    /** A turn resumed after an approval pause persists the tool calls it made
     * before the pause without their step ids, so an exact step match can never
     * land and the settled result would be given up. On a finished row, fall back
     * to the one part with this call id (and agent scope) that has no stored step.
     * An unfinished row may not hold the real part yet, and more than one
     * candidate means a repeated provider id: both stay unmatched rather than
     * patching the wrong part. */
    const fallback = await getSteplessToolCallFallback(input);
    if (fallback == null) {
      return exact;
    }
    return settleToolCallResult(input, null, fallback);
  }

  async function getSteplessToolCallFallback(
    input: UpdateToolCallResultInput,
  ): Promise<SteplessToolCallFallback | undefined> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const row = await Message.findOne({
      messageId: input.messageId,
      user: input.userId,
      conversationId: input.conversationId,
    })
      .select({ content: 1, unfinished: 1 })
      .lean<Pick<IMessage, 'content' | 'unfinished'> | null>();
    return findSteplessToolCallFallback(row, input);
  }

  async function settleToolCallResult(
    input: UpdateToolCallResultInput,
    /** A step id to match exactly, `null` to match a part with no stored step,
     * or `undefined` to ignore steps. */
    stepMatch: string | null | undefined,
    fallback?: SteplessToolCallFallback,
  ): Promise<{ matched: boolean; unfinished: boolean }> {
    const plan = planToolCallSettlement(input, stepMatch, fallback);
    if (plan == null) {
      return { matched: false, unfinished: false };
    }
    const { messageFilter, settleUpdate, settlePatch, incomingAttachments } = plan;
    const settleOptions = {
      new: true,
      projection: { unfinished: 1 },
      ...(plan.arrayFilters != null ? { arrayFilters: plan.arrayFilters } : {}),
    };
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      /** A supplied claim is stamped BEFORE the settle write, on parts that
       * carry none (`resultClaim: null` also admits a stored null, as the old
       * `$ifNull` did). Ordering is what keeps the split safe: until the settle
       * write lands, the part is not terminal, so a concurrent wakeup or manual
       * poll sees `not_ready` and stands down; the old single pipeline wrote
       * claim and receipt atomically, and a claim-after-settle order would
       * instead expose a claimable terminal part that lets a second consumer
       * deliver the same result. A crash between the writes is healed by the
       * settle retry, whose claim write no-ops against its own stamp. */
      if (plan.claimStamp != null) {
        await Message.updateOne(messageFilter, plan.claimStamp.update, {
          arrayFilters: plan.claimStamp.arrayFilters,
        });
      }
      if (!plan.mergingAttachments) {
        const fast = await Message.findOneAndUpdate(
          { ...messageFilter, ...NO_BOUND_APPS },
          settleUpdate,
          settleOptions,
        ).lean<{ unfinished?: boolean } | null>();
        if (fast) return { matched: true, unfinished: fast.unfinished === true };
        // Either absent, or a bound-App row needs an exact candidate even for tiny results.
      }
      /** Classic `$pull` and `$push` conflict on the same field. Keep merge and
       * part patch in one update; ordinary attachments retain the preexisting
       * array compare-and-swap. For bound Apps, a large array in BOTH the filter
       * and update exceeds MongoDB's 16 MiB command limit even when the resulting
       * document fits. Use the small `__v` fence instead: every save with
       * attachments and every background settle increments it. A lost fence is
       * re-read and re-budgeted before retrying the combined write. */
      const incomingApp = hasBoundAppSnapshots(incomingAttachments);
      for (let attempt = 0; attempt < ATTACHMENT_MERGE_CAS_ATTEMPTS; attempt += 1) {
        const row = await Message.findOne(messageFilter)
          .select(incomingApp ? privateMessagePaths() : { _id: 1, attachments: 1, __v: 1 })
          .lean<
            | (Record<string, unknown> & {
                _id: Types.ObjectId;
                attachments?: unknown[];
                __v?: number;
              })
            | null
          >();
        if (row == null) {
          return { matched: false, unfinished: false };
        }
        const hasApps = incomingApp || hasBoundAppSnapshots(row.attachments);
        /** Avoid materializing the whole message for ordinary file attachments. */
        const current =
          hasApps && !incomingApp
            ? await Message.findOne({
                ...messageFilter,
                _id: row._id,
                __v: row.__v ?? null,
              })
                .select(privateMessagePaths())
                .lean<
                  | (Record<string, unknown> & { _id: Types.ObjectId; attachments?: unknown[] })
                  | null
                >()
            : row;
        if (current == null) continue;
        const merged = mergeToolCallAttachments(current.attachments, incomingAttachments, input);
        let admitted = merged;
        if (hasApps) {
          const nextContent = settleToolCallContent(current.content, input);
          admitted = (
            await prepareAppUpdate({ attachments: merged, content: nextContent }, current)
          ).attachments as unknown[];
        }
        const result = await Message.findOneAndUpdate(
          {
            ...messageFilter,
            _id: current._id,
            ...(hasApps
              ? { __v: current.__v ?? null }
              : { attachments: current.attachments == null ? null : current.attachments }),
          },
          {
            ...settleUpdate,
            $set: { ...settlePatch, attachments: admitted },
          },
          settleOptions,
        ).lean<{ unfinished?: boolean } | null>();
        if (result != null) {
          return { matched: true, unfinished: result.unfinished === true };
        }
      }
      /** Losing every fence round means concurrent writers kept advancing the
       * array — the document exists and is healthy, so persistence must stay
       * retryable ABOVE this bounded loop. The settle retry treats an
       * unmatched result as retry-then-heal-later; a throw would land on
       * ambiguous-failure handling that can retire the completion outright,
       * losing a completed tool result to mere attachment contention. */
      logger.warn(
        `[updateToolCallResult] Attachment merge for tool call ${input.toolCallId} lost ` +
          `${ATTACHMENT_MERGE_CAS_ATTEMPTS} fence rounds; leaving the retry to the caller`,
      );
      return { matched: false, unfinished: false };
    } catch (err) {
      logger.error('Error updating tool call result:', err);
      throw err;
    }
  }

  /** Atomically elects manual polling or one automatic continuation. Wakeups
   * also claim a bounded set of already-settled siblings from the same parent
   * response, avoiding one paid continuation per concurrently completed tool. */
  async function claimBackgroundToolResults(
    input: Parameters<MessageMethods['claimBackgroundToolResults']>[0],
  ): Promise<BackgroundToolResultClaim> {
    const request = normalizeBackgroundToolResultClaim(input);
    const { taskId, agentId } = request;
    const Message = mongoose.models.Message as Model<IMessage>;
    const row = await Message.findOne(backgroundClaimSourceFilter(request))
      .select({ content: 1, unfinished: 1, messageId: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .lean<IMessage | null>();
    if (row == null) {
      if (request.requestedMessageId == null) {
        const handleRow = await Message.findOne(backgroundTaskHandleFilter(request))
          .select({ content: 1 })
          .sort({ createdAt: -1, _id: -1 })
          .lean<IMessage | null>();
        const toolName =
          handleRow == null ? undefined : readBackgroundToolHandle(handleRow, taskId, agentId);
        if (toolName != null) {
          return { status: 'outcome_unknown', toolName };
        }
      }
      return { status: 'not_found' };
    }
    const plan = planBackgroundToolResultClaim(row, request);
    if ('outcome' in plan) {
      return plan.outcome;
    }
    const { write } = plan;
    const claimFilter: FilterQuery<IMessage> = {
      ...backgroundClaimWriteFilter(request, write),
      ...(agentId != null
        ? {
            $expr: {
              $anyElementTrue: {
                $map: {
                  input: { $ifNull: ['$content', []] },
                  as: 'candidate',
                  in: {
                    $and: [
                      { $eq: ['$$candidate.tool_call.backgroundTask.taskId', taskId] },
                      {
                        $in: [
                          {
                            $ifNull: [
                              {
                                $ifNull: ['$$candidate.agentId', '$$candidate.tool_call.agentId'],
                              },
                              null,
                            ],
                          },
                          [null, agentId],
                        ],
                      },
                    ],
                  },
                },
              },
            },
          }
        : {}),
    };
    const stamp = backgroundClaimStampUpdate(request, write);
    const updated = write.replaying
      ? await Message.findOne(claimFilter).select({ content: 1 }).lean<IMessage | null>()
      : await Message.findOneAndUpdate(
          claimFilter,
          /** Stamps the claim onto every part this pass admitted. The filtered
           * positional operator selects those parts by predicate, so the write
           * touches only them instead of re-emitting the whole content array, and
           * needs no read-modify-write. Amazon DocumentDB rejects the
           * aggregation-pipeline form this replaces. */
          stamp.update,
          {
            new: true,
            projection: { content: 1 },
            arrayFilters: stamp.arrayFilters,
          },
        ).lean<IMessage | null>();
    return backgroundClaimOutcome(updated, request, write);
  }

  /** Manual ownership is committed only after receipt arbitration completes. */
  async function confirmBackgroundToolResultClaim(
    input: Parameters<MessageMethods['confirmBackgroundToolResultClaim']>[0],
  ): Promise<boolean> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const plan = planBackgroundClaimConfirmation(input);
    try {
      const confirmed = await Message.updateOne(plan.filter, plan.update, {
        arrayFilters: plan.arrayFilters,
      });
      return confirmed.matchedCount === 1;
    } catch (error) {
      // A lost write reply is not an uncommitted handoff. Read only the exact
      // manual claim, never manufacture success from another claimant.
      const committed = await Message.exists(plan.committedFilter);
      if (committed != null) return true;
      throw error;
    }
  }

  async function releaseBackgroundToolResultClaims(
    input: Parameters<MessageMethods['releaseBackgroundToolResultClaims']>[0],
  ): Promise<boolean> {
    const plan = planBackgroundClaimRelease(input);
    if (plan == null) {
      return true;
    }
    const { userId, conversationId, messageId, allowMissingMessage } = input;
    const Message = mongoose.models.Message as Model<IMessage>;
    /** Drops the claim stamp from every content part this claimant owns. The
     * filtered positional operator addresses those parts by predicate in one
     * atomic write, so no read-modify-write and no rewrite of untouched parts;
     * Amazon DocumentDB rejects the aggregation-pipeline form this replaces.
     * The filter requires a `content` array because the filtered positional
     * operator errors on a row without one, where the old pipeline's
     * `$ifNull` no-op'd — a legacy row with no array simply has no claims. */
    const updated = await Message.findOneAndUpdate(plan.filter, plan.update, {
      new: true,
      projection: { content: 1 },
      arrayFilters: plan.arrayFilters,
    }).lean<IMessage | null>();
    if (updated == null) {
      const arraylessRow = await Message.exists({
        user: userId,
        conversationId,
        messageId,
        content: { $not: { $type: 'array' } },
      });
      if (arraylessRow != null) return true;
      return (
        allowMissingMessage === true &&
        (await Message.exists({ user: userId, conversationId, messageId })) == null
      );
    }
    return backgroundClaimsReleased(updated, input);
  }

  /**
   * Updates a message and returns sanitized fields.
   */
  async function updateMessage(
    userId: string,
    message: { messageId: string; [key: string]: unknown },
    metadata?: { context?: string },
  ) {
    try {
      const { messageId, ...update } = message;
      delete update.privateText;
      delete update.privacyRevision;
      delete update.privateTextTokens;
      const updatedMessage = await writeMessage({ messageId, user: userId }, update, {
        upsert: false,
        unsetPrivateText: Object.prototype.hasOwnProperty.call(update, 'text'),
      });

      if (!updatedMessage) {
        throw new Error('Message not found or user not authorized.');
      }

      return toUpdatedMessageFields(updatedMessage);
    } catch (err) {
      logger.error('Error updating message:', err);
      if (metadata?.context) {
        logger.info(`---\`updateMessage\` context: ${metadata.context}`);
      }
      throw err;
    }
  }

  /**
   * Atomically records one bounded parent-to-child control receipt on the
   * durable task input. Terminal receipt states are monotonic, and accepted
   * receipts are retained ahead of older terminal history when the bound fills.
   */
  async function recordSubagentTaskControlReceipt(
    input: Parameters<MessageMethods['recordSubagentTaskControlReceipt']>[0],
  ): Promise<boolean | 'unchanged' | 'conflict'> {
    const identity = subagentControlReceiptIdentity(input);
    const Message = mongoose.models.Message as Model<IMessage>;
    /** Amazon DocumentDB does not support aggregation-pipeline updates. Use a
     * bounded optimistic compare-and-swap: the read is small, the write uses
     * only plain operators, and concurrent writers retry rather than overwrite. */
    for (let attempt = 0; attempt < MAX_SUBAGENT_CONTROL_RECEIPT_CAS_ATTEMPTS; attempt += 1) {
      const currentMessage = await Message.findOne(identity)
        .select({ 'subagentTask.controlReceipts': 1, _id: 0 })
        .lean<Pick<IMessage, 'subagentTask'> | null>();
      if (currentMessage == null) return false;
      const current = currentMessage.subagentTask?.controlReceipts ?? [];
      const retained = retainSubagentControlReceipts(current, input.receipt);
      if (retained.status === 'conflict') return 'conflict';
      if (retained.status === 'unchanged') return 'unchanged';
      if (retained.status === 'capacity') return false;
      const next = retained.receipts;
      const currentFilter =
        currentMessage.subagentTask?.controlReceipts == null
          ? { 'subagentTask.controlReceipts': { $exists: false } }
          : { 'subagentTask.controlReceipts': current };
      const updated = await Message.findOneAndUpdate(
        { ...identity, ...currentFilter },
        { $set: { 'subagentTask.controlReceipts': next } },
        { new: false, projection: { messageId: 1 } },
      ).lean<{ messageId: string } | null>();
      if (updated != null) return true;
    }
    throw new Error('Subagent control receipt write contention exceeded its retry bound.');
  }

  /** Reads one bounded authoritative receipt by its exact durable task identity.
   * The stored projection is already capped, and no task/runtime metadata leaves
   * this method. Authorization remains part of the Mongo identity. */
  async function getSubagentTaskControlReceipt({
    userId,
    conversationId,
    taskId,
    invocationId,
    tenantId,
    activeOnly = false,
  }: {
    userId: string;
    conversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
    activeOnly?: boolean;
  }): Promise<StoredSubagentControlReceipt | null> {
    validateSubagentControlReceiptRead({ userId, conversationId, taskId, invocationId });
    const Message = mongoose.models.Message as Model<IMessage>;
    const input = await Message.findOne({
      ...(activeOnly ? activeExpirationFilter<IMessage>() : {}),
      user: userId,
      conversationId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      messageId: `${taskId}:user`,
      'subagentTask.controlReceipts.invocationId': invocationId,
    })
      .select({ 'subagentTask.controlReceipts': 1, _id: 0 })
      .lean<Pick<IMessage, 'subagentTask'> | null>();
    /** Reservations are a server-private at-most-once fence, not proof that a
     * control was applied. Public HTTP callers retry through the owning store. */
    return publicSubagentControlReceipt(input?.subagentTask?.controlReceipts, invocationId);
  }

  /** Resolves one authoritative receipt after its live owner disappears. The
   * child conversation must still belong to the caller's parent thread, so a
   * task id learned in another chat cannot cross orchestration scopes. */
  async function getSubagentTaskControlReplay({
    userId,
    parentConversationId,
    taskId,
    invocationId,
    tenantId,
  }: {
    userId: string;
    parentConversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
  }): Promise<SubagentControlReplay | null> {
    validateSubagentControlReplay({ userId, parentConversationId, taskId, invocationId });
    const Message = mongoose.models.Message as Model<IMessage>;
    const input = await Message.findOne({
      user: userId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      messageId: `${taskId}:user`,
      'subagentTask.controlReceipts.invocationId': invocationId,
    })
      .select({
        conversationId: 1,
        createdAt: 1,
        updatedAt: 1,
        'subagentTask.status': 1,
        'subagentTask.controlReceipts': 1,
        _id: 0,
      })
      .lean<Pick<IMessage, 'conversationId' | 'createdAt' | 'updatedAt' | 'subagentTask'> | null>();
    const receipt = input?.subagentTask?.controlReceipts?.find(
      (candidate) => candidate.invocationId === invocationId,
    );
    const status = input?.subagentTask?.status;
    if (
      input == null ||
      receipt == null ||
      status == null ||
      input.createdAt == null ||
      input.updatedAt == null
    ) {
      return null;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversationQuery = Conversation.findOne({
      user: userId,
      conversationId: input.conversationId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      'subagentThread.parentConversationId': parentConversationId,
      ...activeExpirationFilter<IConversation>(),
    })
      .select({ 'subagentThread.subagentType': 1, _id: 0 })
      .lean<Pick<IConversation, 'subagentThread'> | null>();
    const terminalQuery = Message.findOne({
      user: userId,
      conversationId: input.conversationId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      messageId: `${taskId}:assistant`,
      'subagentTask.status': { $in: SUBAGENT_TERMINAL_STATUSES },
    })
      .select({ updatedAt: 1, 'subagentTask.status': 1, 'subagentTask.resultClaim': 1, _id: 0 })
      .lean<Pick<IMessage, 'updatedAt' | 'subagentTask'> | null>();
    const [conversation, terminal] = await Promise.all([conversationQuery, terminalQuery]);
    return toSubagentControlReplay(
      taskId,
      invocationId,
      input,
      conversation?.subagentThread?.subagentType,
      terminal,
    );
  }

  /** Atomically assigns one durable terminal child result to either its
   * explicit poller or one idempotent automatic wakeup delivery. */
  async function claimSubagentTaskResult({
    userId,
    conversationId,
    taskId,
    kind,
    claimId,
  }: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<SubagentTaskResultClaim> {
    validateSubagentResultClaim(
      { conversationId, taskId, kind, claimId },
      'Invalid subagent task result claim',
    );
    const Message = mongoose.models.Message as Model<IMessage>;
    const messageId = `${taskId}:assistant`;
    const claim = {
      kind,
      claimId,
      claimedAt: new Date(),
    };
    const projection = { ...SUBAGENT_RESULT_PROJECTION };
    const acquired = await Message.findOneAndUpdate(
      {
        user: userId,
        conversationId,
        messageId,
        'subagentTask.status': { $in: SUBAGENT_TERMINAL_STATUSES },
        ...subagentResultClaimable(kind, claimId),
      },
      { $set: { 'subagentTask.resultClaim': claim } },
      { new: true, projection },
    ).lean<IMessage | null>();
    if (acquired != null) {
      return { status: 'acquired', message: acquired };
    }
    const existing = await Message.findOne({
      user: userId,
      conversationId,
      messageId,
      'subagentTask.status': { $in: SUBAGENT_TERMINAL_STATUSES },
    })
      .select(projection)
      .lean<IMessage | null>();
    return existing == null ? { status: 'not_found' } : { status: 'claimed', message: existing };
  }

  /** Releases only the exact consumer assignment. This is used when a
   * pre-admission automatic continuation is definitively rejected, allowing a
   * later manual poll (or the same delivery retry) to claim the durable result. */
  async function releaseSubagentTaskResultClaim({
    userId,
    conversationId,
    taskId,
    kind,
    claimId,
  }: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean> {
    validateSubagentResultClaim(
      { conversationId, taskId, kind, claimId },
      'Invalid subagent task result claim release',
    );
    const Message = mongoose.models.Message as Model<IMessage>;
    const result = await Message.updateOne(
      {
        user: userId,
        conversationId,
        messageId: `${taskId}:assistant`,
        'subagentTask.resultClaim.kind': kind,
        'subagentTask.resultClaim.claimId': claimId,
      },
      { $unset: { 'subagentTask.resultClaim': 1 } },
    );
    return result.modifiedCount === 1;
  }

  /**
   * Retrieves messages from the database.
   */
  async function getMessages(
    filter: FilterQuery<IMessage>,
    select?: string,
    options: MessageQueryOptions = {},
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const query = Message.find(filter);
      if (select) {
        query.select(select);
      }
      if (options.sort !== false) {
        query.sort(options.sort ?? { createdAt: 1 });
      }
      if (options.limit != null && options.limit > 0) {
        query.limit(options.limit);
      }

      return await query.lean<IMessage[]>();
    } catch (err) {
      logger.error('Error getting messages:', err);
      throw err;
    }
  }

  /**
   * Reads the fixed public child-thread projection and truncates text inside
   * MongoDB so oversized persisted messages are never materialized by the API.
   */
  async function getMessagesForSubagentThreadView(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    selectedTaskId?: string;
    beforeMessageId?: string;
    limit: number;
    textCodePointLimit: number;
  }): Promise<SubagentThreadViewMessageRecord[]> {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const transcriptJsonBytes = {
        $strLenBytes: {
          $convert: {
            input: '$subagentTranscript.messagesJson',
            to: 'string',
            onError: '',
            onNull: '',
          },
        },
      };
      const transcriptIsString = {
        $eq: [{ $type: '$subagentTranscript.messagesJson' }, 'string'],
      };
      const activityProjectionJsonBytes = {
        $strLenBytes: {
          $convert: {
            input: '$subagentActivityProjection.activityJson',
            to: 'string',
            onError: '',
            onNull: '',
          },
        },
      };
      const activityProjectionIsString = {
        $eq: [{ $type: '$subagentActivityProjection.activityJson' }, 'string'],
      };
      const activityProjectionAvailable = {
        $and: [
          { $in: ['$subagentActivityProjection.version', [1, 2]] },
          {
            $eq: ['$messageId', { $concat: ['$subagentActivityProjection.taskId', ':assistant'] }],
          },
          '$_subagentActivityProjectionSourceIsString',
          {
            $lte: [
              '$_subagentActivityProjectionSourceBytes',
              SUBAGENT_ACTIVITY_PROJECTION_SOURCE_BYTE_LIMIT,
            ],
          },
        ],
      };
      const transcriptAvailable = {
        $and: [
          '$_subagentTranscriptSourceIsString',
          { $eq: ['$messageId', { $concat: ['$subagentTranscript.taskId', ':assistant'] }] },
          {
            $lte: ['$_subagentTranscriptSourceBytes', SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT],
          },
        ],
      };
      // Legacy reprojection is optional: retain the usable projection until the
      // API validates the current input boundary against the bounded transcript.
      const legacySteeringTranscriptAvailable = {
        $and: [
          { $eq: ['$subagentActivityProjection.version', 1] },
          {
            $cond: [
              transcriptAvailable,
              {
                $gte: [
                  { $indexOfBytes: ['$subagentTranscript.messagesJson', '"source":"steer"'] },
                  0,
                ],
              },
              false,
            ],
          },
        ],
      };
      const boundedString = (path: string, codePointLimit: number) => ({
        $substrCP: [
          {
            $cond: [{ $eq: [{ $type: path }, 'string'] }, path, ''],
          },
          0,
          codePointLimit,
        ],
      });
      const stringProjectionTruncated = (path: string, codePointLimit: number) => ({
        $gt: [
          {
            $strLenCP: {
              $cond: [{ $eq: [{ $type: path }, 'string'] }, path, ''],
            },
          },
          codePointLimit,
        ],
      });
      const boundedStringArray = (path: string) => ({
        $map: {
          input: {
            $slice: [
              { $cond: [{ $isArray: path }, path, []] },
              SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
            ],
          },
          as: 'value',
          in: boundedString('$$value', SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT),
        },
      });
      const boundedControlReceipt = {
        invocationId: boundedString(
          '$$receipt.invocationId',
          SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT,
        ),
        controlId: {
          $cond: [
            { $eq: [{ $type: '$$receipt.controlId' }, 'string'] },
            boundedString('$$receipt.controlId', SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT),
            null,
          ],
        },
        action: '$$receipt.action',
        status: '$$receipt.status',
        createdAt: '$$receipt.createdAt',
        updatedAt: '$$receipt.updatedAt',
        boundary: '$$receipt.boundary',
        reason: {
          $cond: [
            { $eq: [{ $type: '$$receipt.reason' }, 'string'] },
            boundedString('$$receipt.reason', SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT),
            null,
          ],
        },
        message: {
          $cond: [
            { $eq: [{ $type: '$$receipt.message' }, 'string'] },
            boundedString('$$receipt.message', MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH),
            null,
          ],
        },
        messageTruncated: {
          $or: [
            { $eq: ['$$receipt.messageTruncated', true] },
            stringProjectionTruncated('$$receipt.message', MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH),
          ],
        },
      };
      const boundedSubagentTask = {
        $cond: [
          { $eq: [{ $type: '$subagentTask' }, 'object'] },
          {
            status: '$subagentTask.status',
            controlReceipts: {
              $let: {
                vars: {
                  visible: {
                    $filter: {
                      input: {
                        $cond: [
                          { $isArray: '$subagentTask.controlReceipts' },
                          '$subagentTask.controlReceipts',
                          [],
                        ],
                      },
                      as: 'receipt',
                      cond: { $ne: ['$$receipt.status', 'reserved'] },
                    },
                  },
                },
                in: {
                  $let: {
                    vars: {
                      accepted: {
                        $slice: [
                          {
                            $filter: {
                              input: '$$visible',
                              as: 'receipt',
                              cond: { $eq: ['$$receipt.status', 'accepted'] },
                            },
                          },
                          SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
                        ],
                      },
                      terminal: {
                        $filter: {
                          input: '$$visible',
                          as: 'receipt',
                          cond: { $ne: ['$$receipt.status', 'accepted'] },
                        },
                      },
                    },
                    in: {
                      $map: {
                        input: {
                          $concatArrays: [
                            '$$accepted',
                            {
                              $let: {
                                vars: {
                                  allowance: {
                                    $subtract: [
                                      SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
                                      { $size: '$$accepted' },
                                    ],
                                  },
                                },
                                in: {
                                  $cond: [
                                    { $gt: ['$$allowance', 0] },
                                    { $slice: ['$$terminal', { $multiply: [-1, '$$allowance'] }] },
                                    [],
                                  ],
                                },
                              },
                            },
                          ],
                        },
                        as: 'receipt',
                        in: boundedControlReceipt,
                      },
                    },
                  },
                },
              },
            },
            controlReceiptsProjectionTruncated: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: {
                        $cond: [
                          { $isArray: '$subagentTask.controlReceipts' },
                          '$subagentTask.controlReceipts',
                          [],
                        ],
                      },
                      as: 'receipt',
                      cond: { $ne: ['$$receipt.status', 'reserved'] },
                    },
                  },
                },
                SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
              ],
            },
          },
          null,
        ],
      };
      /** Mixed-typed content metadata must be type-gated before projection, or a
       *  malformed part could tunnel arbitrarily large values past the byte cap
       *  through a passthrough field. `$type`-based checks stay DocumentDB-safe. */
      const boundedNumber = (path: string) => ({
        $cond: [{ $in: [{ $type: path }, ['int', 'long', 'double', 'decimal']] }, path, null],
      });
      const boundedBoolean = (path: string) => ({
        $cond: [{ $eq: [{ $type: path }, 'bool'] }, path, null],
      });
      const boundedEnum = (path: string, allowed: string[]) => ({
        $cond: [{ $in: [path, allowed] }, path, null],
      });
      /** Estimated serialized bytes for one already-clipped activity item; the
       *  constants cover the non-string JSON envelope per item type. This is a
       *  BSON-transfer budget: `$strLenBytes` measures exactly what MongoDB
       *  ships to the API. JSON escaping can expand strings after transfer,
       *  which the API bounds precisely — `boundActivity` in
       *  `packages/api/src/agents/activity.ts` re-fits the same array to 64KB
       *  of `JSON.stringify` output before anything reaches a response. */
      const activityItemBytes = (item: string) => ({
        $switch: {
          branches: [
            {
              case: { $eq: [`${item}.type`, 'writing'] },
              then: { $add: [{ $strLenBytes: `${item}.text` }, 64] },
            },
            {
              case: { $eq: [`${item}.type`, 'activity_label'] },
              then: {
                $add: [
                  { $strLenBytes: `${item}.label` },
                  {
                    $reduce: {
                      input: {
                        $concatArrays: [
                          {
                            $cond: [{ $isArray: `${item}.toolCallIds` }, `${item}.toolCallIds`, []],
                          },
                          { $cond: [{ $isArray: `${item}.agentIds` }, `${item}.agentIds`, []] },
                        ],
                      },
                      initialValue: 0,
                      in: { $add: ['$$value', { $strLenBytes: '$$this' }, 8] },
                    },
                  },
                  512,
                ],
              },
            },
            {
              case: { $eq: [`${item}.type`, 'tool'] },
              then: {
                $add: [
                  { $strLenBytes: `${item}.input` },
                  { $strLenBytes: `${item}.output` },
                  { $strLenBytes: `${item}.name` },
                  { $strLenBytes: `${item}.toolCallId` },
                  192,
                ],
              },
            },
          ],
          default: 32,
        },
      });
      /** Newest-first fit into the aggregate budget, so raising per-item limits
       *  cannot multiply into megabytes per row before the API's own trims run. */
      const budgetedActivity = (clipped: Record<string, unknown>) => ({
        $reverseArray: {
          $let: {
            vars: {
              fitted: {
                $reduce: {
                  input: { $reverseArray: clipped },
                  initialValue: { items: [] as never[], bytes: 0, done: false },
                  in: {
                    $let: {
                      vars: { size: activityItemBytes('$$this') },
                      in: {
                        $cond: [
                          {
                            $or: [
                              '$$value.done',
                              {
                                $gt: [
                                  { $add: ['$$value.bytes', '$$size'] },
                                  SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT,
                                ],
                              },
                            ],
                          },
                          /* The retained timeline must be a contiguous newest
                             suffix: once one entry does not fit, older entries
                             are not allowed to fill the gap around it. */
                          { items: '$$value.items', bytes: '$$value.bytes', done: true },
                          {
                            items: { $concatArrays: ['$$value.items', ['$$this']] },
                            bytes: { $add: ['$$value.bytes', '$$size'] },
                            done: false,
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            in: '$$fitted.items',
          },
        },
      });
      const activityBytesOverBudget = (clipped: Record<string, unknown>) => ({
        $gt: [
          {
            $reduce: {
              input: clipped,
              initialValue: 0,
              in: { $add: ['$$value', activityItemBytes('$$this')] },
            },
          },
          SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT,
        ],
      });
      const clippedActivityContent = {
        $filter: {
          input: {
            $map: {
              input: {
                $slice: [
                  { $cond: [{ $isArray: '$content' }, '$content', []] },
                  -SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
                ],
              },
              as: 'part',
              in: {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ['$$part.type', 'text'] },
                      then: {
                        type: 'writing',
                        text: boundedString(
                          '$$part.text',
                          SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT,
                        ),
                        textTruncated: stringProjectionTruncated(
                          '$$part.text',
                          SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT,
                        ),
                      },
                    },
                    {
                      case: { $in: ['$$part.type', ['think', 'reasoning']] },
                      then: { type: 'reasoning' },
                    },
                    {
                      case: { $eq: ['$$part.type', 'activity_label'] },
                      then: {
                        type: 'activity_label',
                        label: boundedString(
                          '$$part.activity_label',
                          SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
                        ),
                        labelType: boundedEnum('$$part.activity_label_type', ['phase']),
                        toolCallIds: boundedStringArray('$$part.tool_call_ids'),
                        activityStartIndex: boundedNumber('$$part.activity_start_index'),
                        activityEndIndex: boundedNumber('$$part.activity_end_index'),
                        activityCount: boundedNumber('$$part.activity_count'),
                        agentIds: boundedStringArray('$$part.agent_ids'),
                        status: boundedEnum('$$part.status', ['ok', 'partial', 'failed']),
                        pending: boundedBoolean('$$part.pending'),
                        labelTruncated: {
                          $or: [
                            stringProjectionTruncated(
                              '$$part.activity_label',
                              SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
                            ),
                            {
                              $gt: [
                                {
                                  $size: {
                                    $cond: [
                                      { $isArray: '$$part.tool_call_ids' },
                                      '$$part.tool_call_ids',
                                      [],
                                    ],
                                  },
                                },
                                SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
                              ],
                            },
                            {
                              $gt: [
                                {
                                  $size: {
                                    $cond: [
                                      { $isArray: '$$part.agent_ids' },
                                      '$$part.agent_ids',
                                      [],
                                    ],
                                  },
                                },
                                SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
                              ],
                            },
                          ],
                        },
                      },
                    },
                    {
                      case: { $eq: ['$$part.type', 'tool_call'] },
                      then: {
                        type: 'tool',
                        toolCallId: boundedString(
                          '$$part.tool_call.id',
                          SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
                        ),
                        name: boundedString(
                          '$$part.tool_call.name',
                          SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
                        ),
                        input: boundedString(
                          '$$part.tool_call.args',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
                        ),
                        output: boundedString(
                          '$$part.tool_call.output',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
                        ),
                        progress: boundedNumber('$$part.tool_call.progress'),
                        runStepStatus: boundedEnum('$$part.tool_call.runStepStatus', [
                          'running',
                          'completed',
                          'failed',
                          'cancelled',
                        ]),
                        inputValidationError: boundedBoolean(
                          '$$part.tool_call.inputValidationError',
                        ),
                        inputTruncated: stringProjectionTruncated(
                          '$$part.tool_call.args',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
                        ),
                        outputTruncated: stringProjectionTruncated(
                          '$$part.tool_call.output',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
                        ),
                      },
                    },
                  ],
                  default: null,
                },
              },
            },
          },
          as: 'activity',
          cond: { $ne: ['$$activity', null] },
        },
      };
      const boundedActivityContent = budgetedActivity(clippedActivityContent);
      type ActivitySourceProjection = WithNullSentinels<
        Pick<
          SubagentThreadViewMessageRecord,
          | 'messageId'
          | 'subagentTranscript'
          | 'subagentActivityProjectionJson'
          | 'subagentActivityProjectionTruncated'
        >,
        | 'subagentTranscript'
        | 'subagentActivityProjectionJson'
        | 'subagentActivityProjectionTruncated'
      >;
      const boundedMessageProjection = {
        _id: 0,
        messageId: 1,
        parentMessageId: 1,
        isCreatedByUser: 1,
        text: {
          $substrCP: [{ $ifNull: ['$text', ''] }, 0, input.textCodePointLimit],
        },
        textProjectionTruncated: {
          $gt: [{ $strLenCP: { $ifNull: ['$text', ''] } }, input.textCodePointLimit],
        },
        createdAt: 1,
        error: 1,
        unfinished: 1,
        contentRecoveryAvailable: {
          $and: [
            { $eq: [{ $ifNull: ['$subagentContent.version', 0] }, 1] },
            { $ne: [{ $ifNull: ['$subagentContent.deleted', false] }, true] },
          ],
        },
        subagentTranscriptProjectionTruncated: {
          $cond: [{ $ne: [{ $type: '$subagentTranscript.messagesJson' }, 'missing'] }, true, null],
        },
        subagentActivity: boundedActivityContent,
        subagentActivityProjectionTruncated: {
          $or: [
            {
              $gt: [
                {
                  $size: { $cond: [{ $isArray: '$content' }, '$content', []] },
                },
                SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
              ],
            },
            activityBytesOverBudget(clippedActivityContent),
          ],
        },
        subagentTask: boundedSubagentTask,
        subagentTriggerProjection: {
          $cond: [
            { $eq: ['$subagentTriggerProjection.version', 1] },
            {
              version: 1,
              eventType: boundedString(
                '$subagentTriggerProjection.eventType',
                SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
              ),
              sourceType: boundedString(
                '$subagentTriggerProjection.sourceType',
                SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
              ),
              occurredAt: '$subagentTriggerProjection.occurredAt',
              expectedActionToolName: {
                $cond: [
                  {
                    $eq: [{ $type: '$subagentTriggerProjection.expectedActionToolName' }, 'string'],
                  },
                  boundedString(
                    '$subagentTriggerProjection.expectedActionToolName',
                    SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
                  ),
                  null,
                ],
              },
            },
            null,
          ],
        },
      };
      const sourceMetadataProjection = {
        _subagentTranscriptSourceBytes: transcriptJsonBytes,
        _subagentTranscriptSourceIsString: transcriptIsString,
        _subagentActivityProjectionSourceBytes: activityProjectionJsonBytes,
        _subagentActivityProjectionSourceIsString: activityProjectionIsString,
      };
      const activitySourcePayload = {
        subagentActivityProjectionJson: {
          $cond: [activityProjectionAvailable, '$subagentActivityProjection.activityJson', null],
        },
        subagentActivityProjectionTruncated: {
          $cond: [activityProjectionAvailable, '$subagentActivityProjection.truncated', null],
        },
        subagentTranscript: {
          $cond: [
            {
              $and: [
                transcriptAvailable,
                {
                  $or: [
                    { $eq: [activityProjectionAvailable, false] },
                    legacySteeringTranscriptAvailable,
                  ],
                },
              ],
            },
            {
              taskId: '$subagentTranscript.taskId',
              mode: '$subagentTranscript.mode',
              messagesJson: '$subagentTranscript.messagesJson',
            },
            null,
          ],
        },
      };
      const activitySourceProjection = {
        _id: 0,
        messageId: 1,
        ...activitySourcePayload,
      };
      const baseMatch = {
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null
          ? { tenantId: { $exists: false } }
          : { tenantId: input.tenantId }),
      };
      const anchor =
        input.beforeMessageId == null
          ? null
          : await Message.findOne({ ...baseMatch, messageId: input.beforeMessageId })
              .select('_id createdAt')
              .lean<Pick<IMessage, '_id' | 'createdAt'>>();
      if (input.beforeMessageId != null && anchor == null) return [];
      const pageMatch =
        anchor == null
          ? baseMatch
          : {
              ...baseMatch,
              $or: [
                { createdAt: { $lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, _id: { $lte: anchor._id } },
              ],
            };
      /** Keep rows as independent MongoDB results. A `$facet` would combine the
       * complete page into one BSON document and could exceed MongoDB's 16 MiB
       * document limit before the API applies its smaller public byte budget. */
      const messagesPromise = Message.aggregate<ProjectedSubagentThreadViewMessage>([
        { $match: pageMatch },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: input.limit },
        { $project: boundedMessageProjection },
      ]);
      const recentSourcesPromise = Message.aggregate<ActivitySourceProjection>([
        { $match: pageMatch },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: SUBAGENT_ACTIVITY_SOURCE_CANDIDATE_LIMIT },
        {
          $match: {
            ...(input.selectedTaskId == null
              ? {}
              : { messageId: { $ne: `${input.selectedTaskId}:assistant` } }),
            $or: [
              { 'subagentActivityProjection.activityJson': { $exists: true } },
              { 'subagentTranscript.messagesJson': { $exists: true } },
            ],
          },
        },
        { $addFields: sourceMetadataProjection },
        {
          $match: {
            $expr: {
              $or: [
                {
                  $and: [
                    activityProjectionAvailable,
                    {
                      $eq: [
                        '$messageId',
                        { $concat: ['$subagentActivityProjection.taskId', ':assistant'] },
                      ],
                    },
                  ],
                },
                {
                  $and: [
                    transcriptAvailable,
                    {
                      $eq: [
                        '$messageId',
                        { $concat: ['$subagentTranscript.taskId', ':assistant'] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
        { $limit: SUBAGENT_TRANSCRIPT_PAGE_LIMIT - (input.selectedTaskId == null ? 0 : 1) },
        { $project: activitySourceProjection },
      ]);
      /** One read replaces the unsupported `$facet` while keeping its guarantee:
       * the bounded message fields and the source payload for each selected row
       * come from the same document version, so a transcript persisted between
       * two separate reads can never yield a message without its source. Rows
       * stay independent results, so no combined document approaches the 16 MiB
       * limit the surrounding reads already avoid. Only operators Amazon
       * DocumentDB accepts are used. */
      const selectedProjectionPromise =
        input.selectedTaskId == null
          ? Promise.resolve({
              selectedMessages: [] as ProjectedSubagentThreadViewMessage[],
              selectedSources: [] as ActivitySourceProjection[],
            })
          : Message.aggregate<
              ProjectedSubagentThreadViewMessage & {
                _selectedSource: ActivitySourceProjection | null;
              }
            >([
              {
                $match: {
                  ...baseMatch,
                  messageId: {
                    $in: [`${input.selectedTaskId}:user`, `${input.selectedTaskId}:assistant`],
                  },
                },
              },
              { $limit: 2 },
              { $addFields: sourceMetadataProjection },
              {
                $project: {
                  ...boundedMessageProjection,
                  _selectedSource: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$messageId', `${input.selectedTaskId}:assistant`] },
                          {
                            $or: [
                              {
                                $and: [
                                  {
                                    $eq: [
                                      '$subagentActivityProjection.taskId',
                                      input.selectedTaskId,
                                    ],
                                  },
                                  activityProjectionAvailable,
                                ],
                              },
                              {
                                $and: [
                                  { $eq: ['$subagentTranscript.taskId', input.selectedTaskId] },
                                  transcriptAvailable,
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      { messageId: '$messageId', ...activitySourcePayload },
                      null,
                    ],
                  },
                },
              },
            ]).then((rows) => {
              const selectedSources: ActivitySourceProjection[] = [];
              const selectedMessages = rows.map(({ _selectedSource, ...message }) => {
                if (_selectedSource != null) {
                  selectedSources.push(_selectedSource);
                }
                return message;
              });
              return { selectedMessages, selectedSources };
            });
      const [messages, recentSources, selectedProjection] = await Promise.all([
        messagesPromise,
        recentSourcesPromise,
        selectedProjectionPromise,
      ]);
      const sourcesByMessageId = new Map(
        [...selectedProjection.selectedSources, ...recentSources].map((record) => [
          record.messageId,
          record,
        ]),
      );
      /** The page rows come from an independent concurrent read; for the
       * selected task, the single-snapshot pair is authoritative — a page
       * duplicate can predate the source read and claim a transcript that
       * `selectedSources` does not carry. Replace duplicates in place (keeping
       * page order) instead of discarding the snapshot version. */
      const selectedByMessageId = new Map(
        selectedProjection.selectedMessages.map((message) => [message.messageId, message]),
      );
      for (let index = 0; index < messages.length; index += 1) {
        const snapshot = selectedByMessageId.get(messages[index].messageId);
        if (snapshot != null) {
          messages[index] = snapshot;
          selectedByMessageId.delete(snapshot.messageId);
        }
      }
      for (const message of selectedByMessageId.values()) {
        messages.push(message);
      }
      return messages.map((row) => {
        const message = pruneProjectedThreadViewMessage(row);
        const source = sourcesByMessageId.get(message.messageId);
        if (source == null) return message;
        const projected = { ...message };
        if (source.subagentActivityProjectionJson != null) {
          delete projected.subagentTranscriptProjectionTruncated;
          return {
            ...projected,
            subagentActivityProjectionJson: source.subagentActivityProjectionJson,
            ...(source.subagentTranscript == null
              ? {}
              : { subagentTranscript: source.subagentTranscript }),
            ...(source.subagentActivityProjectionTruncated === true
              ? { subagentActivityProjectionTruncated: true }
              : {}),
          };
        }
        if (source.subagentTranscript == null) return message;
        delete projected.subagentTranscriptProjectionTruncated;
        return { ...projected, subagentTranscript: source.subagentTranscript };
      });
    } catch (err) {
      logger.error('Error getting bounded subagent thread messages:', err);
      throw err;
    }
  }

  /** Returns newest bounded task outcomes for every selected child in two
   * constant-size batch reads. The first read guarantees one latest task per
   * child; the second caps recent source rows before any grouping accumulator.
   * This avoids both N+1 reads and newer top-N accumulators that DocumentDB 5
   * does not support. */
  async function listSubagentTasksForThreads(input: {
    user: string;
    conversationIds: string[];
    tenantId?: string;
    limitPerThread: number;
  }): Promise<ParentSubagentTaskRecord[]> {
    if (input.conversationIds.length === 0) {
      return [];
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const match = {
      user: input.user,
      conversationId: { $in: input.conversationIds },
      ...(input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId }),
      messageId: { $regex: /:(user|assistant)$/ },
    };
    const taskProjection = {
      messageId: '$messageId',
      createdAt: '$createdAt',
      occurrenceId: '$_id',
      statusDerived: {
        $eq: [{ $ifNull: ['$subagentTask.status', null] }, null],
      },
      status: {
        $ifNull: [
          '$subagentTask.status',
          {
            $cond: [
              { $regexMatch: { input: '$messageId', regex: /:assistant$/ } },
              {
                $cond: [
                  { $eq: ['$error', true] },
                  'error',
                  { $cond: [{ $eq: ['$unfinished', true] }, 'cancelled', 'completed'] },
                ],
              },
              'running',
            ],
          },
        ],
      },
    };
    const sourceLimit = subagentTaskSourceLimit(input);
    type AggregateRecord = ParentSubagentTaskRecord & { sourceRows?: number };
    const [latestRecords, recentRecords] = await Promise.all([
      Message.aggregate<ParentSubagentTaskRecord>([
        { $match: match },
        { $sort: { conversationId: 1, createdAt: -1, _id: -1 } },
        { $group: { _id: '$conversationId', task: { $first: taskProjection } } },
        { $project: { _id: 0, conversationId: '$_id', tasks: ['$task'] } },
        { $sort: { conversationId: 1 } },
      ]),
      Message.aggregate<AggregateRecord>([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: sourceLimit + 1 },
        {
          $addFields: {
            _subagentIsAssistant: { $regexMatch: { input: '$messageId', regex: /:assistant$/ } },
            _subagentTaskId: {
              $substrBytes: [
                '$messageId',
                0,
                {
                  $subtract: [
                    { $strLenBytes: '$messageId' },
                    {
                      $cond: [
                        { $regexMatch: { input: '$messageId', regex: /:assistant$/ } },
                        10,
                        5,
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          $sort: {
            conversationId: 1,
            _subagentTaskId: 1,
            _subagentIsAssistant: -1,
            createdAt: -1,
            _id: -1,
          },
        },
        {
          $group: {
            _id: { conversationId: '$conversationId', taskId: '$_subagentTaskId' },
            task: { $first: taskProjection },
            sourceRows: { $sum: 1 },
          },
        },
        {
          $sort: {
            '_id.conversationId': 1,
            'task.createdAt': -1,
            'task.occurrenceId': -1,
            '_id.taskId': 1,
          },
        },
        {
          $group: {
            _id: '$_id.conversationId',
            tasks: { $push: '$task' },
            sourceRows: { $sum: '$sourceRows' },
          },
        },
        {
          $project: {
            _id: 0,
            conversationId: '$_id',
            tasks: { $slice: ['$tasks', input.limitPerThread] },
            sourceRows: 1,
          },
        },
        { $sort: { conversationId: 1 } },
      ]),
    ]);
    return mergeSubagentTaskRecords(
      latestRecords,
      recentRecords,
      sourceLimit,
      input.limitPerThread,
    );
  }

  async function getConversationTraceRefs({
    user,
    conversationId,
    tenantId,
    messageId,
    through,
    limit,
  }: {
    user: string;
    conversationId: string;
    tenantId?: string;
    messageId?: string;
    through?: { messageId: string; orderKey: string };
    limit?: number;
  }): Promise<ConversationTraceRefs> {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const scope = { user, conversationId, ...traceTenantScope(tenantId) };
      const anchor = through != null ? parseTraceOrderKey(through.orderKey) : undefined;
      const range = traceRange(
        anchor != null
          ? { createdAt: anchor.createdAt, id: new mongoose.Types.ObjectId(anchor.id) }
          : undefined,
      );
      const query = Message.find({
        ...scope,
        ...SERVER_AUTHORED_SAMPLED_RESPONSE,
        ...(messageId != null ? { messageId } : {}),
        ...range,
      }).select('_id messageId createdAt langfuseDestinationIds langfuseRunId');
      const bounded = limit != null;
      /** `_id` breaks ties between responses saved in the same millisecond, so every page
       *  request rebuilds the same turn order its cursor was positioned in. */
      const sorted = bounded
        ? query.sort({ createdAt: -1, _id: -1 }).limit(limit)
        : query.sort({ createdAt: 1, _id: 1 });
      const [first, rows] = await Promise.all([
        Message.findOne(scope)
          .select('createdAt -_id')
          .sort({ createdAt: 1 })
          .lean<Pick<IMessage, 'createdAt'>>(),
        through != null && anchor == null
          ? []
          : sorted.lean<
              Array<
                Pick<
                  IMessage,
                  'messageId' | 'createdAt' | 'langfuseDestinationIds' | 'langfuseRunId'
                > & { _id: Types.ObjectId }
              >
            >(),
      ]);
      const sampled = bounded ? rows.reverse() : rows;
      return toConversationTraceRefs(first?.createdAt, sampled, through);
    } catch (err) {
      logger.error('Error getting conversation trace references:', err);
      throw err;
    }
  }

  async function hasSampledTraceMessage({
    user,
    conversationId,
    tenantId,
    destinationIds,
  }: {
    user: string;
    conversationId: string;
    tenantId?: string;
    destinationIds: string[];
  }): Promise<boolean> {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const match = await Message.findOne({
        user,
        conversationId,
        ...traceTenantScope(tenantId),
        ...SERVER_AUTHORED_SAMPLED_RESPONSE,
        ...sampledTraceDestinationFilter(destinationIds),
      })
        .select('_id')
        .lean();
      return match != null;
    } catch (err) {
      logger.error('Error checking for a sampled trace message:', err);
      throw err;
    }
  }

  /**
   * The reasoning level a branch runs at: the override on the nearest user message at or above
   * `parentMessageId` that carries one, or `null` when none does. One read of the conversation's
   * links and levels, projected to those fields; the walk itself is in memory.
   */
  async function getBranchReasoningOverride({
    user,
    conversationId,
    parentMessageId,
  }: {
    user: string;
    conversationId: string;
    parentMessageId: string;
  }): Promise<IMessage['reasoningOverride'] | null> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const rows = await Message.find(
      { user, conversationId },
      { _id: 0, messageId: 1, parentMessageId: 1, isCreatedByUser: 1, reasoningOverride: 1 },
    ).lean<
      Pick<IMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser' | 'reasoningOverride'>[]
    >();
    return findBranchReasoningOverride(rows, parentMessageId);
  }

  /**
   * Retrieves a single message from the database.
   */
  async function getMessage({ user, messageId }: { user: string; messageId: string }) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      return await Message.findOne({ user, messageId }).lean<IMessage>();
    } catch (err) {
      logger.error('Error getting message:', err);
      throw err;
    }
  }

  /** How many messages each user owns, over every message (`user-stats`). */
  async function countMessagesByUser(): Promise<UserRecordCount[]> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const rows = await Message.aggregate<{ _id: unknown; count: number }>([
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]);
    return rows.map(({ _id, count }) => ({ user: _id == null ? null : String(_id), count }));
  }

  /**
   * Inserts the records as given, their `createdAt`/`updatedAt` included (no timestamps are set),
   * outside `saveMessage`'s rules (`create-error-convo` seeds a gallery with it). Rejects on the
   * first record that cannot be stored.
   */
  async function insertMessageRecords(records: Array<Record<string, unknown>>): Promise<void> {
    const Message = mongoose.models.Message as Model<IMessage>;
    /** `insertMany` honors `timestamps` (as `save` does), though mongoose's types omit it. */
    const options: InsertManyOptions & { timestamps: boolean } = { timestamps: false };
    await Message.insertMany(records, options);
  }

  /**
   * Deletes messages from the database.
   */
  async function deleteMessages(filter: FilterQuery<IMessage>) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      if (typeof filter.messageId === 'string' && !isSubagentTaskMessageId(filter.messageId)) {
        return await Message.deleteMany(filter);
      }
      const wholeScope = isWholeMessageScope(filter);
      const contentSources = wholeScope
        ? []
        : await Message.find({
            $and: [filter, { subagentContent: { $exists: true } }],
          })
            .select('user tenantId conversationId messageId')
            .lean<IMessage[]>();
      const SubagentContent = mongoose.models.SubagentContent as
        | Model<ISubagentContentChunk>
        | undefined;
      if (SubagentContent != null) {
        if (wholeScope) {
          await prepareSubagentContentDeletion(mongoose, filter);
          return await Message.deleteMany(filter);
        }
        const contentScopes = subagentContentDeletionScopes(contentSources);
        if (contentScopes.length > 0) {
          /** Revoke the task before cleanup, including appends already admitted.
           * Retain both markers until payload deletion succeeds so retries rediscover them. */
          const fence = subagentContentDeletionFence(contentScopes);
          await Message.updateMany(fence.filter, fence.update);
          await SubagentContent.deleteMany({ $or: contentScopes });
        }
      }
      return await Message.deleteMany(filter);
    } catch (err) {
      logger.error('Error deleting messages:', err);
      throw err;
    }
  }

  /**
   * Retrieves paginated messages with custom sorting and cursor support.
   */
  async function getMessagesByCursor(
    filter: FilterQuery<IMessage>,
    options: {
      sortField?: string;
      sortOrder?: 1 | -1;
      limit?: number;
      cursor?: string | null;
      /** Projection for the page, e.g. `CLIENT_MESSAGE_SELECT` for client-facing reads. */
      select?: string;
    } = {},
  ) {
    const Message = mongoose.models.Message as Model<IMessage>;
    const { sortField = 'createdAt', sortOrder = -1, limit = 25, cursor, select } = options;
    const queryFilter: FilterQuery<IMessage> = messagePageFilter(
      filter,
      sortField,
      sortOrder,
      cursor,
      (hex) => new mongoose.Types.ObjectId(hex),
    );
    const query = Message.find(queryFilter);
    /** The cursor needs `_id`, so an `-_id` projection is applied after it is read. */
    const { projection, omitId } = messagePageProjection(select);
    if (projection != null) {
      query.select(projection);
    }
    /** `_id` makes the order total, so a page boundary inside a run of equal sort values is stable. */
    const messages = await query
      .sort({ [sortField]: sortOrder, _id: sortOrder })
      .limit(limit + 1)
      .lean<IMessage[]>();
    return finishMessagePage(messages, limit, sortField, omitId);
  }

  /**
   * Performs a MeiliSearch query on the Message collection.
   * Requires the meilisearch plugin to be registered on the Message model.
   */
  async function searchMessages(
    query: string,
    searchOptions: SearchParams,
    hydrate?: boolean,
  ): Promise<Awaited<ReturnType<SchemaWithMeiliMethods['meiliSearch']>>> {
    const Message = mongoose.models.Message as SchemaWithMeiliMethods;
    if (typeof Message.meiliSearch !== 'function') {
      throw new Error('MeiliSearch plugin not registered on Message model');
    }
    return Message.meiliSearch(query, searchOptions, hydrate);
  }

  /**
   * One page of a keyset-paged read in the port's terms (`MessagePageOptions`): exactly
   * {@link getMessagesByCursor} with `sort.field`/`sort.order` as its `sortField`/`sortOrder`
   * and `after` as its cursor, so it issues and accepts the same `<sortValue>|<ObjectId hex>`
   * cursors (and the legacy bare sort values).
   */
  async function getMessagesPage(
    filter: FilterQuery<IMessage>,
    options: MessagePageOptions,
  ): Promise<MessagePage> {
    return getMessagesByCursor(filter, {
      sortField: options.sort.field,
      sortOrder: options.sort.order,
      limit: options.limit,
      cursor: options.after,
      select: options.select,
    });
  }

  /**
   * The user-scoped MeiliSearch query of the messages route in the port's terms: exactly
   * {@link searchMessages} with the filter `user = "<user>"` (quotes and backslashes in the
   * user id escaped, which no stored user id contains) and `limit`, resolving its hits.
   */
  async function searchUserMessages({
    user,
    text,
    limit,
    hydrate,
  }: MessageSearchInput): Promise<MessageSearchResult> {
    const escapedUser = user.replace(/[\\"]/g, '\\$&');
    const response = await searchMessages(
      text,
      { filter: `user = "${escapedUser}"`, limit },
      hydrate,
    );
    return { hits: response.hits as MessageSearchHit[] };
  }

  async function getPersistedPrivateTextId(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageId: string;
    privacyRevision: string;
    text: string;
  }): Promise<string | null> {
    const filter = persistedPrivateTextFilter(input);
    if (filter == null) {
      return null;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const stored = await Message.exists(filter);
    return stored == null ? null : String(stored._id);
  }

  async function hasPersistedPrivateText(
    input: Parameters<MessageMethods['hasPersistedPrivateText']>[0],
  ): Promise<boolean> {
    return (await getPersistedPrivateTextId(input)) != null;
  }

  async function getPrivateMessageTexts(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageIds: readonly string[];
  }): Promise<PrivateTextRead[]> {
    const filter = privateMessageTextsFilter(input);
    if (filter == null) {
      return [];
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    return Message.find(filter)
      .select('messageId text privacyRevision +privateText')
      .limit(50)
      .lean<PrivateTextRead[]>();
  }

  return {
    hasPersistedPrivateText,
    getPersistedPrivateTextId,
    getPrivateMessageTexts,
    saveMessage,
    bulkSaveMessages,
    updateToolCallResult,
    claimBackgroundToolResults,
    confirmBackgroundToolResultClaim,
    releaseBackgroundToolResultClaims,
    updateMessage,
    recordSubagentTaskControlReceipt,
    getSubagentTaskControlReceipt,
    getSubagentTaskControlReplay,
    claimSubagentTaskResult,
    releaseSubagentTaskResultClaim,
    getMessages,
    getConversationTraceRefs,
    hasSampledTraceMessage,
    getMessagesForSubagentThreadView,
    listSubagentTasksForThreads,
    getMessage,
    getBranchReasoningOverride,
    getMessagesByCursor,
    searchMessages,
    getMessagesPage,
    searchUserMessages,
    deleteMessages,
    countMessagesByUser,
    insertMessageRecords,
  };
}

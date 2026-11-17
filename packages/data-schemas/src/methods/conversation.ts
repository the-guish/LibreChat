import { isForcedTemporaryRetention } from 'librechat-data-provider';
import type {
  AnyBulkWriteOperation,
  DeleteResult,
  FilterQuery,
  Model,
  SortOrder,
  Types,
  UpdateQuery,
} from 'mongoose';
import type { SearchParams } from 'meilisearch';
import type {
  IAgentEventActorCheckpoint,
  IAgentEventActorReconciliation,
  IAgentEventActorSnapshot,
  IAgentEventActorState,
  IAgentEventActorSuspensionEvidence,
  IAgentEventBindingRecord,
  IAgentTriggerDeliveryDocument,
  AppConfig,
  IChatProjectDocument,
  IActiveSubagentThreadLease,
  IConversation,
  IMessage,
  ISharedLink,
  ISubagentThreadReservation,
  ConvoBulkUpsert,
  ConvoBulkUpsertResult,
  ConvoByIdProjection,
  ConvoCodeEnvironmentDecision,
  ConvoDeletionCount,
  ConvoDeletionSelector,
  ConvoDeletionTarget,
  ConvoProjectAssignment,
  ConvoReplyStampState,
  ConvoWrite,
  ConvoWriteResult,
  UserRecordCount,
} from '~/types';
import type {
  ConvoLaneContext,
  ConvoLaneGitView,
  ConversationTitleState,
  ParentSubagentThreadRecord,
  SubagentThreadReadRecord,
  AgentEventActorCommitResult,
  AgentEventActorSettlementAuthority,
  AgentEventActorReconciliationStorageMetrics,
} from './conversationRules';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import type { DeleteConvosDeps } from './deleteConvos';
import type { MessageStore } from '~/ports/message';
import type { MessageMethods } from './message';
import {
  laneGitFences,
  laneGitReport,
  laneGitViewOf,
  convoListSort,
  laneContextOf,
  nextConvoCursor,
  sameLaneFilter,
  nextActorState,
  replyStampOf,
  convoPageSize,
  convoListOrder,
  convoWriteFilter,
  DEFAULT_CONVO_PAGE_SIZE,
  legacyReceiptExpiryLimit,
  LEGACY_RECEIPT_EXPIRY_DEFAULT_LIMIT,
  UNREAD_STATE_PROJECTION,
  REPLY_STAMP_STATE_PROJECTION,
  LAST_RESPONSE_STAMP_PROJECTION,
  queriedConvoPage,
  CONVO_LIST_FIELDS,
  legacyReceiptPull,
  toDeletionTargets,
  convoCursorFilter,
  convoSearchParams,
  actorCommitUpdate,
  threadTenantFilter,
  sharedLinksAllowed,
  messageFileFilter,
  archiveSweepFilter,
  replyStampUpdate,
  unsetExpiryFilter,
  convoWriteOperation,
  replyStampCasFilter,
  closeSuspensionUpdate,
  resumedCommitOutcome,
  holdsClosedSuspension,
  NO_OPEN_RECONCILIATION,
  actorSuspensionRecord,
  convoFilesFacetFilter,
  headOnCheckpointFilter,
  isVerifiableCheckpoint,
  expiredLegacyReceiptIds,
  humanConversationFilter,
  convoListFacetFilters,
  searchHitConversationIds,
  expectedActorHeadFilter,
  toolApprovalAllowNames,
  CONVO_BY_ID_PROJECTIONS,
  DELETION_TARGET_FIELDS,
  removableLegacyReceiptIds,
  protectingDeliveryFilter,
  subagentThreadReadRecord,
  agentEventBindingRecordOf,
  agentEventActorSnapshotOf,
  settlementAuthorityFilter,
  assertReconciliationThread,
  codeEnvironmentReplacement,
  LANE_GIT_WRITE_ATTEMPTS,
  AGENT_EVENT_BINDING_FIELDS,
  cancellableSuspensionFilter,
  SUBAGENT_THREAD_READ_FIELDS,
  suspensionPredecessorFilter,
  activeSubagentThreadLeasesOf,
  pendingReconciliationElement,
  validateAgentEventActorCommit,
  undecidedCodeEnvironmentFilter,
  exactReconciliationCheckpoint,
  reconciliationTransition,
  resolvableReconciliationElement,
  clearableReconciliationElement,
  reconciliationTransitionElement,
  PROJECT_DISCOVERY_MAX_ATTEMPTS,
  ARCHIVE_CONVERSATION_BATCH_SIZE,
  AGENT_EVENT_ACTOR_SNAPSHOT_FIELDS,
  validateAgentEventActorSuspension,
  visibleConversationRetentionFilter,
  AGENT_EVENT_ACTOR_RECEIPT_RETENTION_MS,
  validateAgentEventActorSuspensionClaim,
} from './conversationRules';
import {
  refreshChatProjectStatsForUser,
  updateChatProjectLastConversationForUser,
} from './chatProject';
import { activeExpirationFilter, createFallbackRetentionDate } from '~/utils/retention';
import { createTempChatExpirationDate } from '~/utils/tempChatRetention';
import { withoutMeiliIndexing } from '~/models/plugins/mongoMeili';
import { prepareSubagentContentDeletion } from './subagentContent';
import { refreshChatProjectStatsInBatches } from './projectStats';
import { createSearchConversation } from './searchConversation';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { isValidObjectIdString } from '~/utils/objectId';
import { createBulkSaveConvos } from './bulkSaveConvos';
import { decrementTagCounts } from './conversationTag';
import { createDeleteConvos } from './deleteConvos';
import { createSaveConvo } from './saveConvo';
import logger from '~/config/winston';

export type {
  ConvoLaneContext,
  ConvoLaneGitView,
  ConversationTitleState,
  ParentSubagentThreadRecord,
  SubagentThreadReadRecord,
  AgentEventActorCommitResult,
  AgentEventActorSettlementAuthority,
  AgentEventActorReconciliationStorageMetrics,
} from './conversationRules';

type ConversationUpdateResult = {
  value:
    | (IConversation & {
        _id: unknown;
        $isDefault: (path: string) => boolean;
        toObject: () => IConversation;
      })
    | null;
  lastErrorObject?: {
    updatedExisting?: boolean;
  };
};

async function discoverProjectIds(
  Conversation: Model<IConversation>,
  filter: FilterQuery<IConversation>,
): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PROJECT_DISCOVERY_MAX_ATTEMPTS; attempt++) {
    try {
      const currentProjectIds = await Conversation.distinct('chatProjectId', filter);
      return currentProjectIds.filter((projectId): projectId is string => Boolean(projectId));
    } catch (error) {
      lastError = error;
      logger.error('[archiveAllConvos] Conversations archived but project discovery failed', error);
    }
  }
  throw lastError;
}

export interface ConversationMethods {
  countConvosByUser(): Promise<UserRecordCount[]>;
  createConvoRecord(record: Record<string, unknown>): Promise<void>;
  getConvoFiles(conversationId: string): Promise<string[]>;
  searchConversation(
    conversationId: string,
    fieldsToSelect?: string | null,
  ): Promise<IConversation | null>;
  saveConvo(
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
      /** Same-tenant persisted agent already resolved by the request layer. */
      initialAgentId?: string | null;
      /** `_id`s of messages this save just wrote. When present, they are appended with
       *  `$addToSet` and the O(n) read-and-rewrite of the `messages` array is skipped;
       *  every save without this option still rebuilds the array from the database. */
      /** Casts plain string ids, so callers outside this package need not name the id type. */
      appendMessageIds?: Array<Types.ObjectId | string>;
      /** Advance the reply version and clear the catch-up after persisting an assistant reply. */
      stampReply?: boolean;
      /** Durable messageId paired atomically with a reply stamp. */
      replyMessageId?: string;
    },
  ): Promise<IConversation | { message: string } | null>;
  /**
   * Stamps forced-temporary retention onto an existing conversation and, optionally, some of its
   * messages, for writes that bypass the retention-aware save path. Reuses the stored deadline
   * rather than opening a new window, never upserts, never rewrites `messages`, and releases the
   * conversation's bookmark counts exactly once when it stops being visible.
   */
  stampForcedRetention(
    ctx: { userId: string; interfaceConfig?: AppConfig['interfaceConfig'] },
    target: { conversationId: string; messageIds?: string[] },
  ): Promise<void>;
  setConvoPinned(
    user: string,
    conversationId: string,
    pinned: boolean,
  ): Promise<IConversation | null>;
  appendConvoMessageReference(
    user: string,
    conversationId: string,
    messageId: string,
  ): Promise<IConversation | null>;
  getConvoCodeEnvironmentDecision(
    user: string,
    conversationId: string,
  ): Promise<Pick<
    IConversation,
    'conversationId' | 'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
  > | null>;
  reserveConvoLaneGitSeq(user: string, conversationId: string): Promise<number | null>;
  getConvoLaneContext(user: string, conversationId: string): Promise<ConvoLaneContext | null>;
  setConvoLaneGit(input: {
    user: string;
    conversationId: string;
    laneGit: Pick<NonNullable<IConversation['laneGit']>, 'branch' | 'head'>;
    repo?: string;
    /** A pull request the command's output linked to; replaces the one recorded for the lane. */
    pullRequest?: number;
    /** Reserved with `reserveConvoLaneGitSeq` when the command settled. */
    seq: number;
    /** The workspace the command ran in; the write applies only while the chat is still on it. */
    workspace?: {
      environmentId: string;
      workspaceId: string;
      required?: boolean;
      /** The attachment epoch read when the tool was created; see `getConvoLaneContext`. */
      epoch?: number;
    };
  }): Promise<boolean>;
  getConvoLaneGit(
    user: string,
    conversationId: string,
  ): Promise<Omit<NonNullable<IConversation['laneGit']>, 'seq'> | null>;
  getConvosLaneGit(
    user: string,
    conversationIds: string[],
  ): Promise<Array<{ conversationId: string; laneGit: ConvoLaneGitView }>>;
  addConvoToolApprovalAllows(input: {
    user: string;
    conversationId: string;
    toolNames: string[];
    max: number;
  }): Promise<boolean>;
  readAdmittedConvoCodeEnvironmentDecision(
    user: string,
    conversationId: string,
  ): Promise<Pick<
    IConversation,
    'conversationId' | 'codeEnvironmentMode' | 'codeWorkspaces' | 'codeAttachmentEpoch'
  > | null>;
  replaceConvoCodeEnvironmentDecision(
    params: {
      user: string;
      conversationId: string;
      expected: Pick<
        IConversation,
        'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
      >;
    } & (
      | {
          codeEnvironmentMode: 'attached';
          codeWorkspaces: NonNullable<IConversation['codeWorkspaces']>;
        }
      | { codeEnvironmentMode: 'without_attached'; codeWorkspaces?: undefined }
    ),
  ): Promise<IConversation | null>;
  bulkSaveConvos(conversations: Array<Record<string, unknown>>): Promise<unknown>;
  getConvosByCursor(
    user: string,
    options?: {
      cursor?: string | null;
      limit?: number;
      isArchived?: boolean;
      pinned?: boolean;
      tags?: string[];
      search?: string;
      sortBy?: string;
      sortDirection?: string;
      projectId?: string;
      updatedAfter?: Date;
      createdAfter?: Date;
      endpoints?: string[];
      hasFiles?: boolean;
      sharedOnly?: boolean;
    },
  ): Promise<{ conversations: IConversation[]; nextCursor: string | null }>;
  getConvosQueried(
    user: string,
    convoIds: Array<{ conversationId: string }> | null,
    cursor?: string | null,
    limit?: number,
  ): Promise<{
    conversations: IConversation[];
    nextCursor: string | null;
    convoMap: Record<string, unknown>;
  }>;
  getConvo(user: string, conversationId: string): Promise<IConversation | null>;
  getConvoTitleState(user: string, conversationId: string): Promise<ConversationTitleState | null>;
  getSubagentThreadForParent(input: {
    user: string;
    parentConversationId: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<SubagentThreadReadRecord | null>;
  listSubagentThreadsForParent(input: {
    user: string;
    parentConversationId: string;
    tenantId?: string;
    limit: number;
  }): Promise<ParentSubagentThreadRecord[]>;
  getAgentEventBinding(input: {
    user: string;
    bindingId: string;
    sourceKeyId: string;
    tenantId?: string;
  }): Promise<IAgentEventBindingRecord | null>;
  getAgentEventActorSnapshot(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<IAgentEventActorSnapshot | undefined>;
  commitAgentEventActorState(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    action: IAgentEventActorReconciliation['action'];
    expected?: IAgentEventActorState;
    expectedEpoch: number;
    checkpoint: IAgentEventActorCheckpoint;
    contextFingerprint?: IAgentEventActorState['contextFingerprint'];
    skillManifest?: IAgentEventActorState['skillManifest'];
    discoveredToolNames?: IAgentEventActorState['discoveredToolNames'];
    summary?: IAgentEventActorState['summary'];
    contextMeta?: IAgentEventActorState['contextMeta'];
    compactionSemanticIndex?: IAgentEventActorState['compactionSemanticIndex'];
    settlementAuthority?: AgentEventActorSettlementAuthority;
  }): Promise<AgentEventActorCommitResult>;
  storeAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspension: IAgentEventActorSuspensionEvidence;
    kind?: 'human_decision' | 'internal_completion';
    appliedAction?: { toolName: string; toolCallId?: string };
    handlingGenerationCreatedAt?: number;
    actionId: string;
    jobCreatedAt: number;
    /** The segment applied its expected action before publishing this successor pause. */
    invalidateHead?: boolean;
    previous?: AgentEventActorSettlementAuthority;
  }): Promise<{ status: 'stored' | 'stale' }>;
  claimAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    actionId: string;
    jobCreatedAt: number;
    resumeAttemptId: string;
  }): Promise<{ status: 'claimed' | 'stale' }>;
  settleAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    resumeAttemptId: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
  }): Promise<{ status: 'settled' | 'stale' }>;
  cancelAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    /** Exact orphaned resume claim proven not to have entered provider execution. */
    claimedResumeAttemptId?: string;
  }): Promise<{ status: 'cancelled' | 'stale' }>;
  beginAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean>;
  completeAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean>;
  recordAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    reconciliation: IAgentEventActorReconciliation;
  }): Promise<boolean>;
  resolveAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    expectedActionAdmitted?: boolean;
    resolution:
      | 'checkpoint_verified'
      | 'action_compensated'
      | 'history_repaired'
      | 'invocation_abandoned';
  }): Promise<boolean>;
  clearAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
  }): Promise<boolean>;
  getAgentEventActorReconciliationStorageMetrics(
    now: Date,
  ): Promise<AgentEventActorReconciliationStorageMetrics>;
  expireLegacyAgentEventActorReceipts(
    now: Date,
    limit?: number,
    activity?: { found: boolean },
  ): Promise<number>;
  reserveSubagentThread(input: {
    user: string;
    conversationId: string;
    conversation: Partial<IConversation>;
    tenantId?: string;
  }): Promise<ISubagentThreadReservation>;
  acquireSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    taskId: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean>;
  renewSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean>;
  releaseSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    tenantId?: string;
  }): Promise<boolean>;
  countActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<number>;
  listActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<IActiveSubagentThreadLease[]>;
  getConvoOwnership(
    user: string,
    conversationId: string,
    tenantId?: string | null,
  ): Promise<Pick<IConversation, 'user' | 'tenantId' | 'subagentThread'> | null>;
  getConvoRetention(
    user: string,
    conversationId: string,
  ): Promise<Pick<IConversation, 'expiredAt' | 'isTemporary'> | null>;
  getConvoTitle(user: string, conversationId: string): Promise<string | null>;
  markConvoSeen(
    user: string,
    conversationId: string,
    observedResponseAt?: Date,
  ): Promise<{ modified: boolean }>;
  markConvoUnread(
    user: string,
    conversationId: string,
  ): Promise<{
    modified: boolean;
    lastResponseAt?: Date;
    lastResponseMessageId?: string;
    lastResponseIsManual?: boolean;
    isMarkedUnread?: boolean;
  }>;
  stampConvoLastResponse(
    user: string,
    conversationId: string,
    responseMessageId: string,
  ): Promise<{ lastResponseAt: Date; lastResponseMessageId: string; updatedAt?: Date } | null>;
  deleteConvos(
    user: string,
    filter: FilterQuery<IConversation>,
    options?: {
      beforeDelete?: (conversationIds: string[]) => Promise<void>;
      allowEmpty?: boolean;
    },
  ): Promise<DeleteResult & { messages: DeleteResult; conversationIds: string[] }>;
  archiveAllConvos(user: string): Promise<{ archivedCount: number }>;

  /* ---------------------------------------------------------- saveConvo steps */

  /** The ids of the conversation's stored messages, oldest first. */
  getConvoMessageIds(user: string, conversationId: string): Promise<string[]>;
  /** Whether `chatProjectId` names a project owned by `user`; `false` for a malformed id. */
  isOwnedChatProject(user: string, chatProjectId: string): Promise<boolean>;
  /**
   * One conditional write to a conversation, atomic on its own. `null` when no conversation
   * matched and none was created. Keeps the search index in step with the write.
   */
  writeConvo(input: ConvoWrite): Promise<ConvoWriteResult | null>;
  convoExists(user: string, conversationId: string): Promise<boolean>;
  /**
   * Sets a code-environment decision only while the conversation holds none (no mode and no
   * workspaces). Never touches `updatedAt`. `true` when it wrote.
   */
  seedConvoCodeEnvironmentDecision(input: {
    user: string;
    conversationId: string;
    decision: ConvoCodeEnvironmentDecision;
  }): Promise<boolean>;
  /**
   * Sets `expiredAt` only while it is unset and the stored chat type still matches
   * `isTemporary`. Never touches `updatedAt`. `true` when it wrote.
   */
  setConvoExpiryIfUnset(input: {
    user: string;
    conversationId: string;
    isTemporary: boolean;
    expiredAt: Date;
  }): Promise<boolean>;
  /**
   * Stamps a persisted reply by compare-and-set: advances `lastResponseAt` monotonically,
   * records `responseMessageId`, and resets the unread state. Temporary conversations are
   * never stamped. `null` when no conversation qualifies.
   */
  stampConvoReply(input: {
    user: string;
    conversationId: string;
    responseMessageId: string;
  }): Promise<{ lastResponseAt: Date; state: ConvoReplyStampState } | null>;
  /** Stores `isTemporary: false` when the conversation has no stored chat type. `true` when it wrote. */
  backfillConvoIsTemporary(input: {
    user: string;
    conversationId: string;
    touchUpdatedAt: boolean;
  }): Promise<boolean>;
  /** Recomputes the project's conversation statistics from scratch. */
  refreshChatProjectStats(user: string, chatProjectId: string): Promise<void>;
  /** Moves the project's last-conversation pointer to `conversation` when it is newer. */
  recordChatProjectLastConversation(
    user: string,
    chatProjectId: string,
    conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  ): Promise<void>;

  /* ------------------------------------------------------- deleteConvos steps */

  /** The user's conversations `selector` names, with the fields a deletion needs. */
  listConvosForDeletion(
    user: string,
    selector: ConvoDeletionSelector,
  ): Promise<ConvoDeletionTarget[]>;
  /** The user's subagent threads anywhere below `rootConversationId`, at any depth. */
  listSubagentDescendantsForDeletion(
    user: string,
    rootConversationId: string,
  ): Promise<ConvoDeletionTarget[]>;
  /** The user's subagent threads whose direct parent is one of `parentConversationIds`. */
  listSubagentChildrenForDeletion(
    user: string,
    parentConversationIds: string[],
  ): Promise<ConvoDeletionTarget[]>;
  /**
   * Deletes the user's conversation records with the listed ids. Keeps the search index in
   * step with the delete. Touches no other record.
   */
  deleteConvoRecords(user: string, conversationIds: string[]): Promise<ConvoDeletionCount>;

  /* ----------------------------------------------------- bulkSaveConvos steps */

  /**
   * The stored project assignment of each listed conversation that exists. A pair with no
   * stored conversation is absent from the result.
   */
  listConvoProjectAssignments(
    pairs: Array<{ user: string; conversationId: string }>,
  ): Promise<ConvoProjectAssignment[]>;
  /**
   * Creates or updates each listed conversation, keyed by `user` and `conversationId`: assigns
   * `set`, plus `setOnInsert` when the upsert creates it. Touches neither `createdAt` nor
   * `updatedAt` beyond what those carry. A `tenantId` in either is never written; the tenant in
   * context scopes and stamps every row. An empty list writes nothing.
   */
  bulkUpsertConvos(upserts: ConvoBulkUpsert[]): Promise<ConvoBulkUpsertResult>;

  /* ------------------------------------------------- searchConversation steps */

  /**
   * The conversation with this id, whoever its user is (still scoped to the tenant), with the
   * fields `projection` names; `null` when none exists.
   */
  getConvoByIdAcrossUsers(
    conversationId: string,
    projection: ConvoByIdProjection,
  ): Promise<IConversation | null>;
}

/**
 * What the conversation methods need from other modules. `getMessages` and `deleteMessages` are
 * typed against the message store port; `searchMessages` stays the MongoDB method (MeiliSearch
 * parameters and response), which the port leaves out.
 */
export interface ConversationMethodDeps
  extends Pick<MessageStore, 'getMessages' | 'deleteMessages'> {
  searchMessages?: MessageMethods['searchMessages'];
  deleteAgentQueuedTurns?: (
    user: string,
    conversations: Array<{ conversationId: string; tenantId?: string; allTenants?: true }>,
  ) => Promise<void>;
  eraseAgentTriggerDeliveryConversationResults?: (
    user: string,
    conversationIds: string[],
  ) => Promise<void>;
  prepareAgentTriggerConversationResultErasure?: (
    user: string,
    conversationIds: string[],
  ) => Promise<void>;
}

export function createConversationMethods(
  mongoose: typeof import('mongoose'),
  deps?: ConversationMethodDeps,
): ConversationMethods {
  let legacyReceiptExpiryCursor: Types.ObjectId | undefined;

  /**
   * Stamps a real assistant reply with a strictly increasing server value.
   *
   * The read and write are a classic compare-and-set pair so this remains compatible with
   * DocumentDB: concurrent writers that read the same value retry against the winner and use
   * `max(now, previous + 1ms, updatedAt + 1ms)`. Advancing both versions makes the reply itself
   * distinguishable from a metadata-only promotion. Only a successful write supplies a stamp.
   */
  async function stampReplyWithCas(
    Conversation: Model<IConversation>,
    filter: FilterQuery<IConversation>,
    responseMessageId: string,
    projection?: Record<string, 0 | 1>,
  ): Promise<{ stamp: Date; conversation: Partial<IConversation> } | null> {
    const replyFilter = { ...filter, isTemporary: { $ne: true } };
    for (;;) {
      const current = await Conversation.findOne(replyFilter)
        .select({ lastResponseAt: 1, updatedAt: 1 })
        .lean<Pick<IConversation, 'lastResponseAt' | 'updatedAt'> | null>();
      if (!current) {
        return null;
      }
      const stamp = replyStampOf(current);
      const casFilter = replyStampCasFilter(replyFilter, current) as FilterQuery<IConversation>;
      const stamped = await Conversation.findOneAndUpdate(
        casFilter,
        replyStampUpdate(stamp, responseMessageId),
        { new: true, projection, timestamps: false },
      ).lean<Partial<IConversation> | null>();
      if (stamped) {
        return { stamp, conversation: stamped };
      }
    }
  }
  function getMessageMethods() {
    if (!deps) {
      throw new Error('Message methods not injected into conversation methods');
    }
    return deps;
  }

  function getVisibleConversationRetentionFilter(): FilterQuery<IConversation> {
    return visibleConversationRetentionFilter() as FilterQuery<IConversation>;
  }

  /** Child threads are durable execution records, not user-navigable conversations. */
  function getHumanConversationFilter(): FilterQuery<IConversation> {
    return humanConversationFilter() as FilterQuery<IConversation>;
  }

  /**
   * Retrieves a single conversation for a given user and conversation ID.
   */
  async function getConvo(user: string, conversationId: string) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOne({ user, conversationId }).lean<IConversation>();
    } catch (error) {
      logger.error('[getConvo] Error getting single conversation', error);
      throw new Error('Error getting single conversation');
    }
  }

  async function getConvoTitleState(
    user: string,
    conversationId: string,
  ): Promise<ConversationTitleState | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return Conversation.findOne({ user, conversationId })
      .select('title titleSetByUser titleRevision -_id')
      .lean<ConversationTitleState>();
  }

  /** Resolves a child only through its owning parent and includes its private live lease. */
  async function getSubagentThreadForParent(input: {
    user: string;
    parentConversationId: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<SubagentThreadReadRecord | null> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const conversation = await Conversation.findOne({
        user: input.user,
        conversationId: input.conversationId,
        'subagentThread.parentConversationId': input.parentConversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      })
        .select(SUBAGENT_THREAD_READ_FIELDS)
        .lean<IConversation>();
      if (conversation == null) return null;
      return subagentThreadReadRecord(conversation);
    } catch (error) {
      logger.error('[getSubagentThreadForParent] Error getting child conversation', error);
      throw new Error('Error getting child conversation');
    }
  }

  /**
   * Lists bounded child metadata through immutable parent lineage. Private
   * event-delivery records are collapsed to actor identity inside this Module.
   */
  async function listSubagentThreadsForParent(input: {
    user: string;
    parentConversationId: string;
    tenantId?: string;
    limit: number;
  }): Promise<ParentSubagentThreadRecord[]> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const conversations = await Conversation.find({
        user: input.user,
        'subagentThread.parentConversationId': input.parentConversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      })
        .select(SUBAGENT_THREAD_READ_FIELDS)
        .sort({ updatedAt: -1, conversationId: 1, _id: 1 })
        .limit(input.limit)
        .lean<IConversation[]>();
      return conversations.map(subagentThreadReadRecord);
    } catch (error) {
      logger.error('[listSubagentThreadsForParent] Error listing child conversations', error);
      throw new Error('Error listing child conversations');
    }
  }

  /** Resolves an event target only when the API key, owner, and tenant all match. */
  async function getAgentEventBinding(input: {
    user: string;
    bindingId: string;
    sourceKeyId: string;
    tenantId?: string;
  }): Promise<IAgentEventBindingRecord | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversation = await Conversation.findOne({
      user: input.user,
      'agentEventBinding.bindingId': input.bindingId,
      'agentEventBinding.sourceKeyId': input.sourceKeyId,
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    })
      .select(AGENT_EVENT_BINDING_FIELDS)
      .lean<IConversation>();
    return agentEventBindingRecordOf(conversation);
  }

  /** Reads the private actor head and every fail-closed reconciliation marker. */
  async function getAgentEventActorSnapshot(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<IAgentEventActorSnapshot | undefined> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversation = await Conversation.findOne({
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    })
      .select(AGENT_EVENT_ACTOR_SNAPSHOT_FIELDS)
      .lean<IConversation>();
    return agentEventActorSnapshotOf(conversation);
  }

  /** Publishes one SDK-issued suspension, or atomically replaces its exact claimed predecessor. */
  async function storeAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspension: IAgentEventActorSuspensionEvidence;
    kind?: 'human_decision' | 'internal_completion';
    appliedAction?: { toolName: string; toolCallId?: string };
    handlingGenerationCreatedAt?: number;
    actionId: string;
    jobCreatedAt: number;
    invalidateHead?: boolean;
    previous?: AgentEventActorSettlementAuthority;
  }): Promise<{ status: 'stored' | 'stale' }> {
    validateAgentEventActorSuspension(
      input.conversationId,
      input.suspension,
      input.actionId,
      input.jobCreatedAt,
      input.previous,
    );
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const predecessor = suspensionPredecessorFilter(input.previous) as FilterQuery<IConversation>;
    const ownership = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      agentEventActorReconciliations: {
        $elemMatch: {
          invocationId: input.suspension.invocation.invocationId,
          status: 'invocation_pending',
        },
      },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
      ...predecessor,
    };
    const suspension = actorSuspensionRecord(input);
    const storeUpdate = {
      $set: {
        agentEventActorSuspension: suspension,
        ...(input.invalidateHead === true ? { 'agentEventActor.requiresColdStart': true } : {}),
      },
    };
    let stored = await Conversation.findOneAndUpdate(
      {
        ...ownership,
        ...(input.invalidateHead === true ? { agentEventActor: { $exists: true } } : {}),
      },
      storeUpdate,
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    /** A headless actor is already guaranteed to cold-start; publish the
     * successor without manufacturing a partial canonical state. */
    if (stored == null && input.invalidateHead === true) {
      stored = await Conversation.findOneAndUpdate(
        { ...ownership, agentEventActor: { $exists: false } },
        {
          $set: {
            agentEventActorSuspension: suspension,
          },
        },
        { new: false, timestamps: false },
      )
        .select('_id')
        .lean<IConversation>();
    }
    return { status: stored == null ? 'stale' : 'stored' };
  }

  /** One resume attempt wins the canonical Conversation-side suspension fence. */
  async function claimAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    actionId: string;
    jobCreatedAt: number;
    resumeAttemptId: string;
  }): Promise<{ status: 'claimed' | 'stale' }> {
    validateAgentEventActorSuspensionClaim(input);
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const claimed = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        agentEventBinding: { $exists: true },
        'agentEventActorSuspension.status': { $in: ['pending', 'pending_owned'] },
        'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
        'agentEventActorSuspension.suspension.attempt': input.attempt,
        'agentEventActorSuspension.actionId': input.actionId,
        'agentEventActorSuspension.jobCreatedAt': input.jobCreatedAt,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      },
      {
        $set: {
          'agentEventActorSuspension.status': 'claimed_owned',
          'agentEventActorSuspension.resumeAttemptId': input.resumeAttemptId,
          'agentEventActorSuspension.observedAt': new Date(),
        },
        $unset: {
          'agentEventActorSuspension.outcome': 1,
          'agentEventActorSuspension.closedAt': 1,
        },
      },
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    return { status: claimed == null ? 'stale' : 'claimed' };
  }

  /** Closes a claimed no-action suspension while retaining one bounded retry receipt. */
  async function settleAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    resumeAttemptId: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
  }): Promise<{ status: 'settled' | 'stale' }> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const settled = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
        'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
        'agentEventActorSuspension.suspension.attempt': input.attempt,
        'agentEventActorSuspension.resumeAttemptId': input.resumeAttemptId,
        agentEventActorReconciliations: {
          $elemMatch: pendingReconciliationElement(input.invocationId, input.checkpoint),
        },
        ...subagentLeaseTenantFilter(input.tenantId),
      },
      {
        $set: closeSuspensionUpdate('settled'),
        $pull: {
          agentEventActorReconciliations: pendingReconciliationElement(
            input.invocationId,
            input.checkpoint,
          ),
        },
      },
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    if (settled != null) {
      return { status: 'settled' };
    }
    const snapshot = await getAgentEventActorSnapshot(input);
    return holdsClosedSuspension(snapshot, 'settled', input)
      ? { status: 'settled' }
      : { status: 'stale' };
  }

  /** Cancellation races resume through the same current-suspension predicate. */
  async function cancelAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    claimedResumeAttemptId?: string;
  }): Promise<{ status: 'cancelled' | 'stale' }> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const suspensionOwner = cancellableSuspensionFilter(input.claimedResumeAttemptId);
    const cancelled = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        ...suspensionOwner,
        'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
        'agentEventActorSuspension.suspension.attempt': input.attempt,
        agentEventActorReconciliations: {
          $elemMatch: pendingReconciliationElement(input.invocationId, input.checkpoint),
        },
        ...subagentLeaseTenantFilter(input.tenantId),
      },
      {
        $set: closeSuspensionUpdate('cancelled'),
        $pull: {
          agentEventActorReconciliations: pendingReconciliationElement(
            input.invocationId,
            input.checkpoint,
          ),
        },
      },
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    if (cancelled != null) {
      return { status: 'cancelled' };
    }
    const snapshot = await getAgentEventActorSnapshot(input);
    return holdsClosedSuspension(snapshot, 'cancelled', {
      suspensionId: input.suspensionId,
      attempt: input.attempt,
    })
      ? { status: 'cancelled' }
      : { status: 'stale' };
  }

  /** Advances one actor head only when its complete prior identity still matches. */
  async function commitAgentEventActorState(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    action: IAgentEventActorReconciliation['action'];
    expected?: IAgentEventActorState;
    expectedEpoch: number;
    checkpoint: IAgentEventActorCheckpoint;
    contextFingerprint?: IAgentEventActorState['contextFingerprint'];
    skillManifest?: IAgentEventActorState['skillManifest'];
    discoveredToolNames?: IAgentEventActorState['discoveredToolNames'];
    summary?: IAgentEventActorState['summary'];
    contextMeta?: IAgentEventActorState['contextMeta'];
    compactionSemanticIndex?: IAgentEventActorState['compactionSemanticIndex'];
    settlementAuthority?: AgentEventActorSettlementAuthority;
  }): Promise<AgentEventActorCommitResult> {
    validateAgentEventActorCommit(input);
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const expectedFilter = expectedActorHeadFilter(input) as FilterQuery<IConversation>;
    const settlementFilter = settlementAuthorityFilter(
      input.settlementAuthority,
    ) as FilterQuery<IConversation>;
    const nextState = nextActorState(input);
    const previous = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        agentEventBinding: { $exists: true },
        agentEventActorReconciliations: {
          $elemMatch: {
            invocationId: input.invocationId,
            status: 'invocation_pending',
          },
        },
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
        ...expectedFilter,
        ...settlementFilter,
      },
      actorCommitUpdate(input, nextState),
      { new: false, timestamps: false },
    )
      .select('+agentEventActor +agentEventActorSuspension')
      .lean<IConversation>();
    if (previous != null) {
      return {
        status: 'committed',
        state: nextState,
        ...(previous.agentEventActor?.previousCheckpoint == null
          ? {}
          : { prunableCheckpoint: previous.agentEventActor.previousCheckpoint }),
      };
    }
    if (input.settlementAuthority != null) {
      /** A resumed action must close its claim even when another head won.
       * The negative full-head predicate makes this mutually exclusive with
       * the commit CAS above; the retained closure is the ambiguous-reply receipt. */
      const closedStale = await Conversation.findOneAndUpdate(
        {
          user: input.user,
          conversationId: input.conversationId,
          subagentThread: { $exists: true },
          agentEventBinding: { $exists: true },
          agentEventActorReconciliations: {
            $elemMatch: {
              invocationId: input.invocationId,
              status: 'invocation_pending',
            },
          },
          ...subagentLeaseTenantFilter(input.tenantId),
          ...activeExpirationFilter<IConversation>(),
          ...settlementFilter,
          $nor: [expectedFilter],
        },
        { $set: closeSuspensionUpdate('stale') },
        { new: false, timestamps: false },
      )
        .select('+agentEventActor +agentEventActorSuspension')
        .lean<IConversation>();
      if (closedStale != null) {
        return {
          status: 'stale',
          ...(closedStale.agentEventActor == null ? {} : { state: closedStale.agentEventActor }),
        };
      }
      return resumedCommitOutcome(
        await getAgentEventActorSnapshot(input),
        input.settlementAuthority,
      );
    }
    const current = await getAgentEventActorSnapshot(input);
    return {
      status: 'stale',
      ...(current?.state == null ? {} : { state: current.state }),
    };
  }

  /**
   * Opens the durable fence for one legacy-path turn BEFORE it executes. One
   * mutually exclusive classic update sets the token and, only when a valid
   * head exists, marks it cold — no partial fence state is externally visible.
   * Refuses while another legacy turn or fork lifecycle is active. Abandoned
   * legacy tokens are reclaimed through the bounded recovery operation before
   * admission is retried.
   */
  async function beginAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const ownership: FilterQuery<IConversation> = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      agentEventActorLegacyTurn: { $exists: false },
      ...NO_OPEN_RECONCILIATION,
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    const legacyTurn = { token: input.token, startedAt: new Date() };
    /** DocumentDB does not support aggregation-pipeline updates. Split the
     * headful/headless shapes into mutually exclusive classic updates. A head
     * cannot appear between them without first creating an unresolved fork
     * lifecycle, which the shared ownership filter rejects. */
    const openedWithHead = await Conversation.findOneAndUpdate(
      { ...ownership, 'agentEventActor.generation': { $exists: true } },
      {
        $set: {
          agentEventActorLegacyTurn: legacyTurn,
          'agentEventActor.requiresColdStart': true,
        },
      },
      { new: true, timestamps: false },
    ).lean<IConversation>();
    if (openedWithHead != null) {
      return true;
    }
    const openedHeadless = await Conversation.findOneAndUpdate(
      { ...ownership, 'agentEventActor.generation': { $exists: false } },
      { $set: { agentEventActorLegacyTurn: legacyTurn } },
      { new: true, timestamps: false },
    ).lean<IConversation>();
    return openedHeadless != null;
  }

  /**
   * Closes the fence in ONE atomic write once the legacy turn's history is
   * durable: clears this exact token and advances the epoch together, so a
   * fork can never observe a cleared fence at an unchanged epoch. Matching the
   * token keeps a later turn's seal from closing an earlier turn's fence.
   */
  async function completeAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const sealed = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        agentEventBinding: { $exists: true },
        'agentEventActorLegacyTurn.token': input.token,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      },
      {
        $unset: { agentEventActorLegacyTurn: 1 },
        $inc: { agentEventActorEpoch: 1 },
      },
      { new: true, timestamps: false },
    ).lean<IConversation>();
    return sealed != null;
  }

  /** Acquires or advances one invocation lifecycle fence and blocks competing turns. */
  async function recordAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    reconciliation: IAgentEventActorReconciliation;
  }): Promise<boolean> {
    assertReconciliationThread(input.conversationId, input.reconciliation.checkpoint.threadId);
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const ownership = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    const existing = await Conversation.findOne(ownership)
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    const journal = existing?.agentEventActorReconciliations ?? [];
    const current = journal.find((item) => item.invocationId === input.reconciliation.invocationId);
    if (current != null) {
      const { confirmsActionAdmission, canTransition, sameIdentity } = reconciliationTransition(
        current,
        input.reconciliation,
      );
      /** A pending record is an exclusive ownership fence, not an idempotent
       * receipt. A second executor must not inherit the first owner's claim. */
      if (input.reconciliation.status === 'invocation_pending' && !confirmsActionAdmission) {
        return false;
      }
      if (!canTransition) {
        return sameIdentity;
      }
      const transitioned = await Conversation.findOneAndUpdate(
        {
          ...ownership,
          agentEventActorReconciliations: {
            $elemMatch: reconciliationTransitionElement(current, confirmsActionAdmission),
          },
        },
        { $set: { 'agentEventActorReconciliations.$': input.reconciliation } },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      return transitioned != null;
    }
    /** Every post-acquisition state must transition the exact pending lifecycle.
     * Never recreate a marker after terminal recovery has already removed it. */
    if (input.reconciliation.status !== 'invocation_pending') {
      return false;
    }
    const recorded = await Conversation.findOneAndUpdate(
      {
        ...ownership,
        agentEventActorLegacyTurn: { $exists: false },
        ...NO_OPEN_RECONCILIATION,
        'agentEventActorReconciliations.invocationId': { $ne: input.reconciliation.invocationId },
      },
      { $push: { agentEventActorReconciliations: input.reconciliation } },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (
      recorded?.agentEventActorReconciliations?.some(
        (item) => item.invocationId === input.reconciliation.invocationId,
      ) === true
    ) {
      return true;
    }
    /** Another writer won the same invocation fence while this write raced. */
    return false;
  }

  /** Resolves exactly one lifecycle after settlement, abandonment, or repair. */
  async function resolveAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    expectedActionAdmitted?: boolean;
    resolution:
      | 'checkpoint_verified'
      | 'action_compensated'
      | 'history_repaired'
      | 'invocation_abandoned';
  }): Promise<boolean> {
    assertReconciliationThread(input.conversationId, input.checkpoint.threadId);
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const exactCheckpoint = exactReconciliationCheckpoint(input.invocationId, input.checkpoint);
    if (!isVerifiableCheckpoint(input.resolution, input.checkpoint)) {
      return false;
    }
    const owner = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    if (input.resolution === 'checkpoint_verified') {
      const settled = await Conversation.findOneAndUpdate(
        {
          ...owner,
          ...headOnCheckpointFilter(input.checkpoint),
          agentEventActorReconciliations: {
            $elemMatch: { ...exactCheckpoint, status: 'history_persisted' },
          },
        },
        {
          $set: {
            'agentEventActorReconciliations.$.status': 'settled',
            'agentEventActorReconciliations.$.resolution': 'checkpoint_verified',
            'agentEventActorReconciliations.$.observedAt': new Date(),
          },
          $unset: { 'agentEventActorReconciliations.$.error': 1 },
        },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      if (settled != null) {
        return true;
      }
      /** A verification retry may replay only a receipt that verification
       * itself settled. A compensated receipt must fail this resolve so the
       * caller re-reads and honors the compensation instead. */
      const replay = await Conversation.exists({
        ...owner,
        ...headOnCheckpointFilter(input.checkpoint),
        agentEventActorReconciliations: {
          $elemMatch: { ...exactCheckpoint, status: 'settled', resolution: 'checkpoint_verified' },
        },
      });
      return replay != null;
    }
    const checkpointFilter = resolvableReconciliationElement({
      ...input,
      resolution: input.resolution,
    });
    const ownership = {
      ...owner,
      agentEventActorReconciliations: { $elemMatch: checkpointFilter },
    };
    const mustRebuild =
      input.resolution === 'action_compensated' || input.resolution === 'history_repaired';
    if (!mustRebuild) {
      const abandoned = await Conversation.findOneAndUpdate(
        ownership,
        { $pull: { agentEventActorReconciliations: checkpointFilter } },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      return abandoned != null;
    }
    /** Repair and compensation both act on an invocation whose action already
     * reached the outside world, so the receipt must survive as the durable
     * same-invocation tombstone. Deleting it would let a delayed duplicate
     * owner reacquire the same id and repeat that action. Compensation undoes
     * the effect; it does not re-authorize the delivery, so a legitimate retry
     * must arrive under a new invocation id. */
    const retainedReceipt = {
      'agentEventActorReconciliations.$.status': 'settled',
      'agentEventActorReconciliations.$.resolution': input.resolution,
      'agentEventActorReconciliations.$.observedAt': new Date(),
    };
    const resolved = await Conversation.findOneAndUpdate(
      { ...ownership, agentEventActor: { $exists: true } },
      { $set: { ...retainedReceipt, 'agentEventActor.requiresColdStart': true } },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (resolved != null) {
      return true;
    }
    /** Compensation before a first committed head must retire the exact fence
     * without creating a partial actor state that cannot be resumed. */
    const resolvedWithoutHead = await Conversation.findOneAndUpdate(
      { ...ownership, agentEventActor: { $exists: false } },
      { $set: retainedReceipt },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (resolvedWithoutHead != null) {
      return true;
    }
    /** A retried repair finds its own retained receipt already settled. */
    const replayed = await Conversation.exists({
      ...owner,
      agentEventActorReconciliations: {
        $elemMatch: { ...exactCheckpoint, status: 'settled', resolution: input.resolution },
      },
    });
    return replayed != null;
  }

  /** Removes an active lifecycle only after its terminal proof is durable elsewhere. */
  async function clearAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
  }): Promise<boolean> {
    assertReconciliationThread(input.conversationId, input.checkpoint.threadId);
    if (!isVerifiableCheckpoint(input.resolution, input.checkpoint)) {
      return false;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const owner = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    const lifecycle = clearableReconciliationElement(input);
    const clearedWithHead = await Conversation.findOneAndUpdate(
      {
        ...owner,
        agentEventActor: { $exists: true },
        ...(input.resolution === 'checkpoint_verified' && headOnCheckpointFilter(input.checkpoint)),
        agentEventActorReconciliations: { $elemMatch: lifecycle },
      },
      {
        ...(input.resolution === 'checkpoint_verified'
          ? {}
          : { $set: { 'agentEventActor.requiresColdStart': true } }),
        $pull: { agentEventActorReconciliations: lifecycle },
      },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (clearedWithHead != null) {
      return true;
    }
    if (input.resolution !== 'checkpoint_verified') {
      const clearedWithoutHead = await Conversation.findOneAndUpdate(
        {
          ...owner,
          agentEventActor: { $exists: false },
          agentEventActorReconciliations: { $elemMatch: lifecycle },
        },
        { $pull: { agentEventActorReconciliations: lifecycle } },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      if (clearedWithoutHead != null) {
        return true;
      }
    }
    const conflict = await Conversation.exists({
      ...owner,
      agentEventActorReconciliations: { $elemMatch: { invocationId: input.invocationId } },
    });
    if (conflict != null) {
      return false;
    }
    return (await Conversation.exists(owner)) != null;
  }

  async function getAgentEventActorReconciliationStorageMetrics(
    now: Date,
  ): Promise<AgentEventActorReconciliationStorageMetrics> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const [row] = await Conversation.aggregate<{ pending: number; oldestObservedAt?: Date }>([
      {
        $match: {
          agentEventActorReconciliations: {
            $elemMatch: { status: { $ne: 'settled' } },
          },
        },
      },
      { $unwind: '$agentEventActorReconciliations' },
      { $match: { 'agentEventActorReconciliations.status': { $ne: 'settled' } } },
      {
        $group: {
          _id: null,
          pending: { $sum: 1 },
          oldestObservedAt: { $min: '$agentEventActorReconciliations.observedAt' },
        },
      },
    ]);
    const oldestObservedAt = row?.oldestObservedAt;
    return {
      pending: row?.pending ?? 0,
      oldestPendingAgeSeconds:
        oldestObservedAt == null
          ? 0
          : Math.max(0, (now.getTime() - oldestObservedAt.getTime()) / 1000),
    };
  }

  /** Bounded mixed-version cleanup for terminal receipts embedded by older
   * builds. New receipts expire through the delivery collection TTL index,
   * but dormant legacy conversations need an independent retirement path. */
  async function expireLegacyAgentEventActorReceipts(
    now: Date,
    limit = LEGACY_RECEIPT_EXPIRY_DEFAULT_LIMIT,
    activity?: { found: boolean },
  ): Promise<number> {
    if (Number.isNaN(now.getTime())) {
      throw new TypeError('now must be a valid date');
    }
    const boundedLimit = legacyReceiptExpiryLimit(limit);
    const cutoff = new Date(now.getTime() - AGENT_EVENT_ACTOR_RECEIPT_RETENTION_MS);
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const Delivery = mongoose.models.AgentTriggerDelivery as
      | Model<IAgentTriggerDeliveryDocument>
      | undefined;
    if (Delivery == null) {
      return 0;
    }
    /** Advance a bounded candidate page before querying delivery protection.
     * Reaching the end resets the cursor so newly expiry-eligible older rows
     * enter the next sweep without making any one pass collection-wide. */
    const candidates = await Conversation.find({
      ...(legacyReceiptExpiryCursor == null ? {} : { _id: { $gt: legacyReceiptExpiryCursor } }),
    })
      /** Pure inclusion, as an object. The string form
       * `'_id +agentEventActorReconciliations'` compiles to `{ _id: 1 }` plus a
       * `: 0` exclusion for every OTHER `select: false` sibling — the `+` token
       * only un-hides its field and `_id` alone does not make the projection
       * inclusive. MongoDB tolerates that mixed shape via the `_id` exception;
       * Amazon DocumentDB rejects it, which failed this sweep on every pass and
       * took the sequenced lane reclamation down with it. An explicit `1` for a
       * `select: false` path overrides the schema default, so nothing hidden
       * leaks and nothing extra is fetched. */
      .select({ _id: 1, agentEventActorReconciliations: 1 })
      .sort({ _id: 1 })
      .limit(boundedLimit)
      .lean<
        Array<Pick<IConversation, 'agentEventActorReconciliations'> & { _id: Types.ObjectId }>
      >();
    if (candidates.length === 0) {
      legacyReceiptExpiryCursor = undefined;
      return 0;
    }
    legacyReceiptExpiryCursor = candidates[candidates.length - 1]._id;
    // A full page is not an empty sweep: later conversations may contain
    // expired receipts. Keep scanning at base cadence until the page walk ends.
    if (activity != null && candidates.length === boundedLimit) activity.found = true;
    const expiredInvocationIds = expiredLegacyReceiptIds(candidates, cutoff);
    if (expiredInvocationIds.length === 0) return 0;
    if (activity != null) activity.found = true;
    const protectedInvocationIds = new Set(
      (await Delivery.find(
        protectingDeliveryFilter(
          expiredInvocationIds,
        ) as FilterQuery<IAgentTriggerDeliveryDocument>,
      ).distinct('deliveryKey')) as string[],
    );
    const operations = candidates.flatMap((candidate) => {
      const removable = removableLegacyReceiptIds(candidate, cutoff, protectedInvocationIds);
      return removable.length === 0
        ? []
        : [
            {
              updateOne: {
                filter: { _id: candidate._id },
                update: legacyReceiptPull(removable, cutoff),
              },
            },
          ];
    }) as unknown as AnyBulkWriteOperation[];
    if (operations.length === 0) {
      return 0;
    }
    const result = await tenantSafeBulkWrite(Conversation, operations, {
      ordered: false,
      timestamps: false,
    });
    return result.modifiedCount;
  }

  /** Creates immutable child lineage exactly once without overwriting a concurrent winner. */
  async function reserveSubagentThread(input: {
    user: string;
    conversationId: string;
    conversation: Partial<IConversation>;
    tenantId?: string;
  }): Promise<ISubagentThreadReservation> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const filter = {
      user: input.user,
      conversationId: input.conversationId,
      ...(input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId }),
    };
    try {
      const result = (await Conversation.findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            ...input.conversation,
            user: input.user,
            conversationId: input.conversationId,
            messages: [],
          },
        },
        { new: true, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
      ).select('+agentEventBinding')) as unknown as ConversationUpdateResult;
      if (result.value == null) {
        throw new Error('Unable to reserve the subagent thread.');
      }
      return {
        conversation: result.value.toObject(),
        created: result.lastErrorObject?.updatedExisting !== true,
      };
    } catch (error) {
      /** Concurrent upserts can race at the unique index. The document that won is
       * the reservation; callers still validate its immutable lineage before use. */
      if ((error as { code?: number }).code === 11000) {
        const existing = await Conversation.findOne(filter)
          .select('+agentEventBinding')
          .lean<IConversation>();
        if (existing != null) {
          return { conversation: existing, created: false };
        }
      }
      throw error;
    }
  }

  function subagentLeaseTenantFilter(tenantId?: string): FilterQuery<IConversation> {
    return threadTenantFilter(tenantId) as FilterQuery<IConversation>;
  }

  /** Atomically claims one durable child thread across all API replicas. */
  async function acquireSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    taskId: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        ...subagentLeaseTenantFilter(input.tenantId),
        $or: [
          { subagentThreadLease: { $exists: false } },
          { 'subagentThreadLease.expiresAt': { $lte: input.now } },
          { 'subagentThreadLease.token': input.token },
        ],
      },
      {
        $set: {
          subagentThreadLease: {
            token: input.token,
            taskId: input.taskId,
            expiresAt: input.expiresAt,
          },
          /** Child threads are hidden from normal recents. Stamp the task start
           * explicitly so bounded parent discovery promotes real new activity;
           * automatic timestamps stay disabled for lease heartbeats/releases. */
          updatedAt: input.now,
        },
      },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  /** Renews only the unexpired lease owned by this exact task token. */
  async function renewSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      {
        user: input.user,
        conversationId: input.conversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        'subagentThreadLease.token': input.token,
        'subagentThreadLease.expiresAt': { $gt: input.now },
      },
      { $set: { 'subagentThreadLease.expiresAt': input.expiresAt } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  /** Releases only the lease owned by this exact task token. */
  async function releaseSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    tenantId?: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      {
        user: input.user,
        conversationId: input.conversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        'subagentThreadLease.token': input.token,
      },
      { $unset: { subagentThreadLease: 1 } },
      { timestamps: false },
    );
    return result.modifiedCount === 1;
  }

  /** Counts live child execution fences while account deletion drains. */
  async function countActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<number> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return Conversation.countDocuments({
      user: input.user,
      ...subagentLeaseTenantFilter(input.tenantId),
      'subagentThreadLease.expiresAt': { $gt: input.now },
    });
  }

  /** Resolves only live task addresses so account-wide cancellation stays O(active tasks). */
  async function listActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<IActiveSubagentThreadLease[]> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversations = await Conversation.find({
      user: input.user,
      ...subagentLeaseTenantFilter(input.tenantId),
      'subagentThreadLease.expiresAt': { $gt: input.now },
    })
      .select('conversationId subagentThread.parentConversationId +subagentThreadLease')
      .lean<
        Array<Pick<IConversation, 'conversationId' | 'subagentThread' | 'subagentThreadLease'>>
      >();
    return activeSubagentThreadLeasesOf(conversations);
  }

  /**
   * Public-read probe: resolves ownership plus the child-thread discriminator
   * without materializing the full conversation document (preset spread +
   * message ObjectId array).
   */
  async function getConvoOwnership(user: string, conversationId: string, tenantId?: string | null) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const tenantFilter =
        tenantId === undefined ? {} : subagentLeaseTenantFilter(tenantId ?? undefined);
      return await Conversation.findOne(
        {
          user,
          conversationId,
          ...tenantFilter,
          ...activeExpirationFilter<IConversation>(),
        },
        'user tenantId subagentThread',
      ).lean<Pick<IConversation, 'user' | 'tenantId' | 'subagentThread'>>();
    } catch (error) {
      logger.error('[getConvoOwnership] Error checking conversation ownership', error);
      throw new Error('Error checking conversation ownership');
    }
  }

  /**
   * Retrieves only the retention deadline for a conversation.
   */
  async function getConvoRetention(
    user: string,
    conversationId: string,
  ): Promise<Pick<IConversation, 'expiredAt' | 'isTemporary'> | null> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOne({ user, conversationId }, 'expiredAt isTemporary').lean<
        Pick<IConversation, 'expiredAt' | 'isTemporary'>
      >();
    } catch (error) {
      logger.error('[getConvoRetention] Error getting conversation retention fields', error);
      throw new Error('Error getting conversation retention fields');
    }
  }

  /**
   * Searches for a conversation by conversationId and returns associated file ids.
   */
  async function getConvoFiles(conversationId: string): Promise<string[]> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return (
        (await Conversation.findOne({ conversationId }, 'files').lean<IConversation>())?.files ?? []
      );
    } catch (error) {
      logger.error('[getConvoFiles] Error getting conversation files', error);
      throw new Error('Error getting conversation files');
    }
  }

  async function stampForcedRetention(
    { userId, interfaceConfig }: { userId: string; interfaceConfig?: AppConfig['interfaceConfig'] },
    { conversationId, messageIds = [] }: { conversationId: string; messageIds?: string[] },
  ): Promise<void> {
    if (!userId || !isForcedTemporaryRetention(interfaceConfig?.retentionMode)) {
      return;
    }

    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const stored = await Conversation.findOne({ conversationId, user: userId })
      .select({ _id: 1, isTemporary: 1, expiredAt: 1, tags: 1 })
      .lean<{
        _id: Types.ObjectId;
        isTemporary?: boolean;
        expiredAt?: Date | null;
        tags?: string[];
      } | null>();
    if (!stored) {
      return;
    }

    let expiredAt = stored.expiredAt ?? null;
    if (expiredAt == null) {
      try {
        expiredAt = createTempChatExpirationDate(interfaceConfig);
      } catch (err) {
        logger.error('[stampForcedRetention] Error creating temporary chat expiration date:', err);
        expiredAt = createFallbackRetentionDate();
      }
    }

    let stampedDeadline = stored.expiredAt != null;
    if (stored.isTemporary !== true) {
      /**
       * Conditional on the transition, so concurrent stamps release the bookmark counts once;
       * the released tags are cleared with it so a later delete cannot release them again.
       */
      const converted = await Conversation.updateOne(
        { _id: stored._id, isTemporary: { $ne: true } },
        { $set: { isTemporary: true, expiredAt, tags: [] } },
        { timestamps: false },
      );
      stampedDeadline ||= converted.modifiedCount > 0;
      if (converted.modifiedCount > 0 && stored.tags?.length) {
        await decrementTagCounts(mongoose, userId, stored.tags);
      }
    } else if (stored.expiredAt == null) {
      const stamped = await Conversation.updateOne(
        { _id: stored._id, expiredAt: null },
        { $set: { expiredAt } },
        { timestamps: false },
      );
      stampedDeadline = stamped.modifiedCount > 0;
    }

    if (messageIds.length === 0) {
      return;
    }
    if (!stampedDeadline) {
      /** A concurrent stamp set the conversation's deadline first; its messages share that one. */
      const current = await Conversation.findOne({ _id: stored._id })
        .select({ expiredAt: 1 })
        .lean<{ expiredAt?: Date | null } | null>();
      expiredAt = current?.expiredAt ?? expiredAt;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    await Message.updateMany(
      { user: userId, conversationId, messageId: { $in: messageIds } },
      { $set: { isTemporary: true, expiredAt } },
      { timestamps: false },
    );
  }

  /**
   * Flips the pinned flag on its own rather than routing through `saveConvo`.
   *
   * Pinning is pure metadata: it moves no chat between projects, changes nothing the
   * project workspace hides, and opens no retention window, so none of `saveConvo`'s
   * tail work applies. Going direct drops the `getMessages` round trip and the rewrite
   * of the whole message-id array that a one-field toggle would otherwise pay for, and
   * `timestamps: false` keeps the sidebar ordering by real activity.
   *
   * Returns null when no conversation matched, so a pin can never insert one.
   */
  async function setConvoPinned(user: string, conversationId: string, pinned: boolean) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOneAndUpdate(
        { conversationId, user },
        { $set: { pinned } },
        { new: true, timestamps: false },
      ).lean<IConversation>();
    } catch (error) {
      logger.error('[setConvoPinned] Error updating pinned state', error);
      throw new Error('Error updating pinned state');
    }
  }

  /**
   * Adds one message's id to a conversation's message list, and nothing else.
   *
   * A message write that failed, or that resolved falsy on a duplicate key it could not
   * re-read, leaves its row out of `messages`, and the bare `saveMessage` retries that
   * restore the row never add it. Going direct keeps the repair to what it is: no
   * `getMessages` round trip, no rewrite of the whole array, and no `$set` of fields the
   * caller never meant to touch. `timestamps: false` because repairing a reference is not
   * activity and must not reorder the sidebar.
   *
   * Takes the id as a string so callers stay free of the storage engine's own id type; the
   * cast to it happens here. Returns null when no conversation matched, so a repair can
   * never insert one.
   */
  async function appendConvoMessageReference(
    user: string,
    conversationId: string,
    messageId: string,
  ) {
    if (!isValidObjectIdString(messageId)) {
      logger.warn('[appendConvoMessageReference] Ignoring an unusable message id');
      return null;
    }
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOneAndUpdate(
        { conversationId, user },
        { $addToSet: { messages: new mongoose.Types.ObjectId(messageId) } },
        { new: true, timestamps: false },
      ).lean<IConversation>();
    } catch (error) {
      logger.error('[appendConvoMessageReference] Error appending the message reference', error);
      throw new Error('Error appending the message reference');
    }
  }

  /** Internal snapshot for a transition. The revision is never exposed in ordinary chat reads. */
  async function getConvoCodeEnvironmentDecision(user: string, conversationId: string) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return Conversation.findOne({ user, conversationId })
      .select('conversationId codeEnvironmentMode codeWorkspaces +codeEnvironmentRevision')
      .lean<IConversation>();
  }

  /**
   * Call only AFTER publishing the generation's active job. Atomically advance the fence and
   * return the post-update decision in one round trip. A run that wins invalidates an in-flight
   * transition's revision; a transition that wins is observed by this read.
   */
  /**
   * Remember tools the owner approved for the rest of one conversation. Owner-scoped,
   * idempotent (`$addToSet`), and bounded: the write matches only while the stored list
   * plus the names it does not hold yet fits `max`, so concurrent resumes cannot grow it
   * past the cap and a name already stored costs no room. Returns whether it applied.
   */
  async function addConvoToolApprovalAllows({
    user,
    conversationId,
    toolNames,
    max,
  }: {
    user: string;
    conversationId: string;
    toolNames: string[];
    max: number;
  }): Promise<boolean> {
    const names = toolApprovalAllowNames(toolNames, max);
    if (names == null) {
      return false;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await withoutMeiliIndexing(
      Conversation.updateOne(
        {
          user,
          conversationId,
          $expr: {
            $lte: [
              { $size: { $setUnion: [{ $ifNull: ['$toolApprovalAllows', []] }, names] } },
              max,
            ],
          },
        },
        { $addToSet: { toolApprovalAllows: { $each: names } } },
        { timestamps: false },
      ),
    );
    return result.matchedCount === 1;
  }

  /**
   * Reserve the next lane report sequence number for an owner's conversation. The counter lives in
   * the database, so every replica draws from one order that no process clock can skew, and the
   * number is taken when a command settles, before its write is attempted. Resolves to null when
   * the conversation does not exist yet for this owner.
   */
  async function reserveConvoLaneGitSeq(
    user: string,
    conversationId: string,
  ): Promise<number | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const reserved = await withoutMeiliIndexing(
      Conversation.findOneAndUpdate(
        { user, conversationId, ...activeExpirationFilter<IConversation>() },
        { $inc: { laneGitSeq: 1 } },
        { new: true, timestamps: false },
      ),
    )
      .select('laneGitSeq')
      .lean<Pick<IConversation, 'laneGitSeq'> | null>();
    return reserved?.laneGitSeq ?? null;
  }

  /**
   * The route and attachment epoch a lane recorder needs, in one owner-scoped read. A subagent
   * thread's route names the visible conversation its lane belongs to. The epoch advances only
   * when the owner moves or detaches the workspace (never when a generation is admitted), so a
   * report captured before a move away and back to the same workspace still reads as stale.
   * Resolves to null for a conversation that does not exist yet, or is not this owner's.
   */
  async function getConvoLaneContext(
    user: string,
    conversationId: string,
  ): Promise<ConvoLaneContext | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const now = new Date();
    /**
     * The thread and its visible root in one operation, so the epoch cannot move between two
     * reads. The tenant plugin scopes only the base collection of an aggregate, never the joined
     * one, so the join is narrowed here to the same owner, tenant and visibility as the base row:
     * a root outside them reads as absent, exactly as it did when it was read on its own.
     */
    const [row] = await Conversation.aggregate<{
      subagentThread?: IConversation['subagentThread'] | null;
      codeAttachmentEpoch?: number;
      _root?: Array<{ codeAttachmentEpoch?: number }>;
    }>([
      { $match: { user, conversationId, ...activeExpirationFilter<IConversation>() } },
      {
        $lookup: {
          from: 'conversations',
          localField: 'subagentThread.rootConversationId',
          foreignField: 'conversationId',
          as: '_root',
        },
      },
      {
        $project: {
          subagentThread: 1,
          codeAttachmentEpoch: 1,
          _root: {
            $filter: {
              input: '$_root',
              as: 'r',
              cond: {
                $and: [
                  { $eq: ['$$r.user', user] },
                  { $eq: [{ $ifNull: ['$$r.tenantId', null] }, { $ifNull: ['$tenantId', null] }] },
                  {
                    $or: [
                      { $eq: [{ $ifNull: ['$$r.expiredAt', null] }, null] },
                      { $gt: ['$$r.expiredAt', now] },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      { $limit: 1 },
    ]);
    if (row == null) return null;
    /** A thread's report is written to its visible root, so it is fenced by the root's epoch. */
    return laneContextOf(conversationId, row, row._root?.[0]);
  }

  /**
   * Record the branch and head a conversation's code lane last reported. Owner-scoped and fenced
   * by the sequence number reserved when the command settled: the write matches only while the
   * stored report carries a lower one, so a delayed older report, from this process or another
   * replica, can never replace a newer state. When the caller names the workspace the command ran
   * in, the write also matches only while the conversation is still attached to it, so a report
   * queued before a move or detach cannot bring the old workspace's lane back. A conversation
   * with no stored workspace (an agent default) accepts the report unless the caller requires a
   * recorded one. Server-written only: generic saves and imports cannot set it. An expired
   * temporary chat is treated as gone, here and in the reservation and the read, the way every
   * other owner-scoped conversation access treats it. Resolves to whether the write applied; false
   * means a newer report is already stored, the workspace no longer matches, or there is no such
   * conversation for this owner.
   */
  async function setConvoLaneGit({
    user,
    conversationId,
    laneGit,
    repo,
    pullRequest,
    seq,
    workspace,
  }: {
    user: string;
    conversationId: string;
    laneGit: Pick<NonNullable<IConversation['laneGit']>, 'branch' | 'head'>;
    repo?: string;
    pullRequest?: number;
    seq: number;
    workspace?: { environmentId: string; workspaceId: string; required?: boolean; epoch?: number };
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const fences = laneGitFences(seq, workspace) as FilterQuery<IConversation>[];
    const write = async (
      lane: FilterQuery<IConversation> | null,
      update: UpdateQuery<IConversation>,
    ): Promise<boolean> => {
      const result = await withoutMeiliIndexing(
        Conversation.updateOne(
          {
            user,
            conversationId,
            ...activeExpirationFilter<IConversation>(),
            $and: lane == null ? fences : [...fences, lane],
          },
          update,
          { timestamps: false },
        ),
      );
      return result.modifiedCount === 1;
    };
    const replaced = laneGitReport({ laneGit, repo, pullRequest, seq });
    if (pullRequest != null) return write(null, { $set: { laneGit: replaced } });
    /**
     * A report without a link keeps the one already recorded while the lane is still on that
     * branch and repository, and drops it otherwise. Plain updates rather than an aggregation
     * pipeline, which Amazon DocumentDB rejects: the first matches only the same lane and sets its
     * fields one by one, the second only another lane and replaces the whole state. A concurrent
     * write can move the stored lane between the two, so they are retried once.
     */
    const sameLane = sameLaneFilter(laneGit, repo) as FilterQuery<IConversation>;
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
  }

  /** The last reported lane state, or null when the conversation has none or is not the owner's. */
  async function getConvoLaneGit(
    user: string,
    conversationId: string,
  ): Promise<Omit<NonNullable<IConversation['laneGit']>, 'seq'> | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const stored = await Conversation.findOne({
      user,
      conversationId,
      ...activeExpirationFilter<IConversation>(),
    })
      .select('laneGit')
      .lean<Pick<IConversation, 'laneGit'> | null>();
    if (stored?.laneGit == null) return null;
    return laneGitViewOf(stored.laneGit);
  }

  /**
   * The last reported lane state of each of the owner's conversations that has one, in one query.
   * A conversation that is missing, expired, another owner's or has no lane is simply absent, so a
   * caller cannot tell them apart.
   */
  async function getConvosLaneGit(
    user: string,
    conversationIds: string[],
  ): Promise<Array<{ conversationId: string; laneGit: ConvoLaneGitView }>> {
    if (conversationIds.length === 0) return [];
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const stored = await Conversation.find({
      user,
      conversationId: { $in: conversationIds },
      laneGit: { $exists: true, $ne: null },
      ...activeExpirationFilter<IConversation>(),
    })
      .select('conversationId laneGit')
      .lean<Array<Pick<IConversation, 'conversationId' | 'laneGit'>>>();
    return stored.flatMap(({ conversationId, laneGit }) => {
      if (laneGit == null || conversationId == null) return [];
      return [{ conversationId, laneGit: laneGitViewOf(laneGit) }];
    });
  }

  /**
   * The decision a run is admitted on, with the attachment epoch of that same document. The epoch
   * is `0` for a conversation never moved, so a lane report can be fenced by exactly the snapshot
   * the workspace came from instead of a second read that a move could slip between.
   */
  async function readAdmittedConvoCodeEnvironmentDecision(user: string, conversationId: string) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const admitted = await withoutMeiliIndexing(
      Conversation.findOneAndUpdate(
        { user, conversationId },
        { $inc: { codeEnvironmentRevision: 1 } },
        { new: true, timestamps: false },
      ),
    )
      .select('conversationId codeEnvironmentMode codeWorkspaces +codeAttachmentEpoch')
      .lean<IConversation>();
    return admitted == null
      ? admitted
      : { ...admitted, codeAttachmentEpoch: admitted.codeAttachmentEpoch ?? 0 };
  }

  /**
   * Compare-and-swap for an owner's explicit replacement of a code-environment decision, whether
   * that attaches an environment, moves to another, or leaves attached execution behind.
   * The filter repeats the stored decision being replaced, so a writer that changed it first
   * leaves this update unmatched rather than overwritten. A missing and a null mode both
   * describe a legacy decision inferred from its selections. Leaving attached execution clears
   * the selections outright: a decision that kept them would read as attached again.
   */
  async function replaceConvoCodeEnvironmentDecision({
    user,
    conversationId,
    expected,
    codeEnvironmentMode,
    codeWorkspaces,
  }: {
    user: string;
    conversationId: string;
    expected: Pick<
      IConversation,
      'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
    >;
  } & (
    | {
        codeEnvironmentMode: 'attached';
        codeWorkspaces: NonNullable<IConversation['codeWorkspaces']>;
      }
    | { codeEnvironmentMode: 'without_attached'; codeWorkspaces?: undefined }
  )) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const { filter, update } = codeEnvironmentReplacement({
        user,
        conversationId,
        expected,
        codeEnvironmentMode,
        codeWorkspaces,
      });
      return await Conversation.findOneAndUpdate(filter as FilterQuery<IConversation>, update, {
        new: true,
        timestamps: false,
      }).lean<IConversation>();
    } catch (error) {
      logger.error('[replaceConvoCodeEnvironmentDecision] Error moving code environment', error);
      throw new Error('Error moving code environment');
    }
  }

  /**
   * Flags which conversations on a page currently have an active shared link, in one
   * batched lookup instead of a query per row. The flag lives in another collection, so
   * it is derived per request rather than projected; a failure here degrades the badge
   * but must never fail the conversation list itself.
   */
  async function attachSharedFlags(user: string, conversations: IConversation[]): Promise<void> {
    const SharedLink = mongoose.models.SharedLink as Model<ISharedLink> | undefined;
    if (!SharedLink || conversations.length === 0) {
      return;
    }
    /* A deployment with shared links off serves no links and renders no badge, so the
       extra round trip on the sidebar's first page would buy nothing. */
    if (!sharedLinksAllowed()) {
      return;
    }

    try {
      const shares = await SharedLink.find({
        user,
        conversationId: { $in: conversations.map((convo) => convo.conversationId) },
        ...activeExpirationFilter<ISharedLink>(),
      })
        .select('conversationId')
        .lean();

      const shared = new Set(shares.map((share) => share.conversationId));
      for (const convo of conversations) {
        convo.isShared = shared.has(convo.conversationId);
      }
    } catch (error) {
      logger.error('[attachSharedFlags] Error resolving shared conversations', error);
    }
  }

  /** Conversations with a file on any of this user's messages (see `messageFileFilter`). */
  async function getMessageFileConversationIds(user: string): Promise<string[] | null> {
    const Message = mongoose.models.Message as Model<IMessage> | undefined;
    if (!Message) {
      return null;
    }
    return Message.find(messageFileFilter(user) as FilterQuery<IMessage>).distinct(
      'conversationId',
    );
  }

  /**
   * The conversations this user is actively sharing.
   *
   * Shared state is not a field on the conversation: it is a live link that can expire,
   * so a denormalized flag would keep saying "shared" after a link lapsed. This asks the
   * links themselves, indexed by `{ user, conversationId }`, and returns `null` when the
   * deployment has sharing switched off so the caller can tell "no links" from "not
   * applicable".
   */
  async function getSharedConversationIds(user: string): Promise<string[] | null> {
    const SharedLink = mongoose.models.SharedLink as Model<ISharedLink> | undefined;
    if (!SharedLink) {
      return null;
    }
    if (!sharedLinksAllowed()) {
      return null;
    }

    /* Distinct, not find: the only thing this caller can use is the set of IDs, so the
       server dedupes and returns nothing else. Covered by `{ user, conversationId }`. */
    const sharedIds = await SharedLink.find({
      user,
      ...activeExpirationFilter<ISharedLink>(),
    }).distinct('conversationId');

    return sharedIds.filter(
      (conversationId): conversationId is string => typeof conversationId === 'string',
    );
  }

  /**
   * Retrieves conversations using cursor-based pagination.
   */
  async function getConvosByCursor(
    user: string,
    options: {
      cursor?: string | null;
      limit?: number;
      isArchived?: boolean;
      pinned?: boolean;
      tags?: string[];
      search?: string;
      sortBy?: string;
      sortDirection?: string;
      projectId?: string;
      updatedAfter?: Date;
      createdAfter?: Date;
      endpoints?: string[];
      hasFiles?: boolean;
      sharedOnly?: boolean;
    } = {},
  ) {
    const {
      cursor,
      limit = DEFAULT_CONVO_PAGE_SIZE,
      search,
      sortBy = 'updatedAt',
      sortDirection = 'desc',
      hasFiles,
      sharedOnly,
    } = options;
    const Conversation = mongoose.models.Conversation as Model<IConversation> &
      Pick<SchemaWithMeiliMethods, 'meiliSearch'>;
    const pageSize = convoPageSize(limit);
    const filters = convoListFacetFilters(user, options) as FilterQuery<IConversation>[];

    /* The two facet lookups are independent user-scoped reads, so they start together
       instead of adding their latencies on every page that combines them. */
    const [messageFileIds, activeShares] = await Promise.all([
      hasFiles === true ? getMessageFileConversationIds(user) : null,
      sharedOnly === true ? getSharedConversationIds(user) : null,
    ]);

    if (hasFiles === true) {
      filters.push(convoFilesFacetFilter(messageFileIds) as FilterQuery<IConversation>);
    }

    /* When this filter runs, the page's rows are already known to be shared, so the set
       is kept and used to mark `isShared` directly instead of issuing a second
       SharedLink query after the conversation query for the same answers. */
    let sharedIds: Set<string> | null = null;
    if (sharedOnly === true) {
      /* Nothing shared, or sharing switched off, means nothing can match. Returning early
         also keeps an empty `$in` out of the query, which would match every document. */
      if (activeShares == null || activeShares.length === 0) {
        return { conversations: [], nextCursor: null };
      }
      sharedIds = new Set(activeShares);
      filters.push({ conversationId: { $in: activeShares } } as FilterQuery<IConversation>);
    }

    filters.push(getVisibleConversationRetentionFilter());
    filters.push(getHumanConversationFilter());

    if (search) {
      try {
        const searchParams: SearchParams = convoSearchParams(user);
        const [convoResults, messageHits] = await Promise.all([
          Conversation.meiliSearch(search, searchParams),
          deps?.searchMessages
            ? deps.searchMessages(search, searchParams).then(
                (results) => (Array.isArray(results.hits) ? results.hits : []),
                (error) => {
                  logger.error(
                    '[getConvosByCursor] Message search failed, using title matches only',
                    error,
                  );
                  return [];
                },
              )
            : [],
        ]);
        const matchingIds = searchHitConversationIds(convoResults.hits ?? [], messageHits);
        if (!matchingIds.length) {
          return { conversations: [], nextCursor: null };
        }
        filters.push({
          conversationId: { $in: matchingIds },
        } as FilterQuery<IConversation>);
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
        (id) => new mongoose.Types.ObjectId(id),
        isValidObjectIdString,
      ) as FilterQuery<IConversation> | null;
      if (cursorFilter) {
        filters.push(cursorFilter);
      } else {
        logger.warn('[getConvosByCursor] Invalid cursor format, starting from beginning');
      }
    }

    const query: FilterQuery<IConversation> =
      filters.length === 1 ? filters[0] : ({ $and: filters } as FilterQuery<IConversation>);

    try {
      const convos = await Conversation.find(query)
        /* `isArchived` rides along so a row can offer archive or restore from its own state:
           the sidebar lists archived and unarchived chats in the same session, and the
           active list also carries the unarchived pins beside them. */
        .select(CONVO_LIST_FIELDS)
        .sort(convoListSort(order) as Record<string, SortOrder>)
        .limit(pageSize + 1)
        .lean<IConversation[]>();

      let nextCursor: string | null = null;
      if (convos.length > pageSize) {
        convos.pop();
        nextCursor = nextConvoCursor(convos[convos.length - 1], order);
      }

      /* Stamped by the replica that selected the decision, so a row from one that predates it
         is told apart from an ordinary chat, which carries no decision either. */
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
  }

  /**
   * Fetches specific conversations by ID array with pagination.
   */
  async function getConvosQueried(
    user: string,
    convoIds: Array<{ conversationId: string }> | null,
    cursor: string | null = null,
    limit = 25,
  ) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      if (!convoIds?.length) {
        return { conversations: [], nextCursor: null, convoMap: {} };
      }

      const conversationIds = convoIds.map((convo) => convo.conversationId);

      const results = await Conversation.find({
        $and: [
          { user, conversationId: { $in: conversationIds } },
          getVisibleConversationRetentionFilter(),
          getHumanConversationFilter(),
        ],
      } as FilterQuery<IConversation>).lean<IConversation[]>();

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
  }

  /**
   * Gets conversation title, returning 'New Chat' as default.
   */
  async function getConvoTitle(user: string, conversationId: string) {
    try {
      const convo = await getConvo(user, conversationId);
      if (convo && !convo.title) {
        return null;
      } else {
        return convo?.title || 'New Chat';
      }
    } catch (error) {
      logger.error('[getConvoTitle] Error getting conversation title', error);
      throw new Error('Error getting conversation title');
    }
  }

  /* ------------------------------------------------------- deleteConvos steps */

  async function listConvosForDeletion(
    user: string,
    selector: ConvoDeletionSelector,
  ): Promise<ConvoDeletionTarget[]> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const filter: FilterQuery<IConversation> =
      'conversationIds' in selector
        ? { conversationId: { $in: selector.conversationIds }, user }
        : { user };
    const conversations = await Conversation.find(filter)
      .select(DELETION_TARGET_FIELDS)
      .lean<ConvoDeletionTarget[]>();
    return toDeletionTargets(conversations);
  }

  async function listSubagentDescendantsForDeletion(
    user: string,
    rootConversationId: string,
  ): Promise<ConvoDeletionTarget[]> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversations = await Conversation.find({
      user,
      'subagentThread.rootConversationId': rootConversationId,
    })
      .select(DELETION_TARGET_FIELDS)
      .lean<ConvoDeletionTarget[]>();
    return toDeletionTargets(conversations);
  }

  async function listSubagentChildrenForDeletion(
    user: string,
    parentConversationIds: string[],
  ): Promise<ConvoDeletionTarget[]> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversations = await Conversation.find({
      user,
      'subagentThread.parentConversationId': { $in: parentConversationIds },
    })
      .select(DELETION_TARGET_FIELDS)
      .lean<ConvoDeletionTarget[]>();
    return toDeletionTargets(conversations);
  }

  /** The search documents go with the records through the schema's `deleteMany` hook. */
  async function deleteConvoRecords(
    user: string,
    conversationIds: string[],
  ): Promise<ConvoDeletionCount> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.deleteMany({
      user,
      conversationId: { $in: conversationIds },
    });
    return { acknowledged: result.acknowledged, deletedCount: result.deletedCount };
  }

  /**
   * The non-conversation work `deleteConvos` carries along, with today's MongoDB queries.
   * Resolved per call so an instance built without message methods fails up front.
   */
  function getDeleteConvosDeps(): DeleteConvosDeps {
    const messageDeps = getMessageMethods();
    const { deleteMessages, getMessages } = messageDeps;
    return {
      hasConvoMessages: async (user, conversationId) =>
        (await getMessages({ user, conversationId }, '_id', { limit: 1 })).length > 0,
      deleteConvoMessages: (user, conversationIds) =>
        deleteMessages({ conversationId: { $in: conversationIds }, user }),
      prepareSubagentContentDeletion: (user, conversationIds) =>
        prepareSubagentContentDeletion(mongoose, {
          user,
          conversationId: { $in: conversationIds },
        }),
      decrementTagCounts: (user, tags) => decrementTagCounts(mongoose, user, tags),
      deleteToolApprovalGrants: async (user, conversationIds) => {
        await mongoose.models.ToolApprovalGrant?.deleteMany({
          user,
          conversationId: { $in: conversationIds },
        });
      },
      ...(messageDeps.deleteAgentQueuedTurns && {
        deleteAgentQueuedTurns: async (user, conversations) => {
          await messageDeps.deleteAgentQueuedTurns?.(user, conversations);
        },
      }),
      ...(messageDeps.prepareAgentTriggerConversationResultErasure && {
        prepareAgentTriggerConversationResultErasure: async (user, conversationIds) => {
          await messageDeps.prepareAgentTriggerConversationResultErasure?.(user, conversationIds);
        },
      }),
      ...(messageDeps.eraseAgentTriggerDeliveryConversationResults && {
        eraseAgentTriggerDeliveryConversationResults: async (user, conversationIds) => {
          await messageDeps.eraseAgentTriggerDeliveryConversationResults?.(user, conversationIds);
        },
      }),
    };
  }

  /**
   * Archives every conversation the user can currently see in one pass. Temporary and
   * retention-expired conversations are left alone: they are already hidden from the
   * chat list, so archiving them would only resurrect them in the archived view.
   */
  async function archiveAllConvos(user: string) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const projectIds = new Set<string>();
    /** One stamp for the whole sweep so the archived view groups the run together
     * instead of fanning it out across however long the batching took, and so the
     * recovery below can find everything this call committed without holding an id
     * per conversation in memory. */
    const archivedAt = new Date();
    let archivedCount = 0;
    /** A write whose result never came back may still have committed, so reconciliation
     * keys off the attempt rather than off `archivedCount`: a stepdown between commit and
     * acknowledgement would otherwise strand those chats with stale project counts, and no
     * retry can find them again because they no longer match the sweep filter. */
    let attemptedArchiveWrite = false;
    try {
      const filter = archiveSweepFilter(user) as FilterQuery<IConversation>;

      const snapshotBoundary = await Conversation.findOne(filter)
        .select('_id')
        .sort({ _id: -1 })
        .lean<Pick<IConversation, '_id'>>();
      if (!snapshotBoundary) {
        return { archivedCount: 0 };
      }

      let lastConversationId: Types.ObjectId | null = null;

      while (true) {
        const idRange = lastConversationId
          ? { $gt: lastConversationId, $lte: snapshotBoundary._id }
          : { $lte: snapshotBoundary._id };
        const conversations = await Conversation.find({ ...filter, _id: idRange })
          .select('_id chatProjectId')
          .sort({ _id: 1 })
          .limit(ARCHIVE_CONVERSATION_BATCH_SIZE)
          .lean<Array<Pick<IConversation, '_id' | 'chatProjectId'>>>();
        if (conversations.length === 0) {
          break;
        }

        const conversationIds: Types.ObjectId[] = [];
        for (const conversation of conversations) {
          conversationIds.push(conversation._id);
          if (conversation.chatProjectId) {
            projectIds.add(conversation.chatProjectId);
          }
        }
        lastConversationId = conversationIds[conversationIds.length - 1];

        /**
         * `timestamps: false` keeps each conversation's own `updatedAt`, so the archived
         * view stays sorted by real activity instead of collapsing onto the archive time.
         * `archivedAt` is still stamped: the filter only matches unarchived chats, so this
         * cannot move an existing stamp, and leaving it unset would drop the whole sweep
         * into the legacy group the archived table sorts and dates by `createdAt`.
         */
        attemptedArchiveWrite = true;
        const result = await Conversation.updateMany(
          { ...filter, _id: { $in: conversationIds } },
          { $set: { isArchived: true, archivedAt } },
          { timestamps: false },
        );
        const batchArchivedCount = result.modifiedCount ?? 0;
        archivedCount += batchArchivedCount;

        if (batchArchivedCount > 0) {
          const currentProjectIds = await discoverProjectIds(Conversation, {
            _id: { $in: conversationIds },
            user,
          });
          for (const projectId of currentProjectIds) {
            projectIds.add(projectId);
          }
        }
      }

      return { archivedCount };
    } catch (error) {
      logger.error('[archiveAllConvos] Error archiving conversations', error);
      throw error;
    } finally {
      /**
       * Best-effort, mirroring `deleteConvos`: committed batches are already archived, so
       * a stats failure must not hide that from the caller. Recover destination projects
       * first, because in-loop discovery can throw after a move and a retry cannot see
       * those already-archived chats. The sweep marker is what identifies them, so this
       * costs one indexed query rather than a per-conversation id list: history size
       * changes how much this reads, never how much it holds.
       */
      if (attemptedArchiveWrite) {
        try {
          const recoveredProjectIds = await discoverProjectIds(Conversation, {
            user,
            isArchived: true,
            archivedAt,
          });
          for (const projectId of recoveredProjectIds) {
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
          await refreshChatProjectStatsInBatches(
            (projectId) => refreshChatProjectStatsForUser(mongoose, user, projectId),
            projectIds,
          );
        } catch (error) {
          logger.error('[archiveAllConvos] Conversations archived but stats refresh failed', error);
        }
      }
    }
  }

  /**
   * Records that the user has caught up with a conversation's newest message.
   *
   * `observedResponseAt` is the reply the client actually had on screen. Filtering on it keeps
   * the acknowledgement bound to that reply: if another device persisted a newer one in the
   * meantime, nothing matches and the indicator survives instead of being cleared for a message
   * nobody read. The stamp itself stays server-side, so no client clock is trusted.
   *
   * Deliberately bypasses `saveConvo`: this needs neither the message lookup nor the upsert,
   * and `timestamps: false` keeps `updatedAt` untouched so reading a conversation does not
   * reorder the sidebar.
   */
  async function markConvoSeen(user: string, conversationId: string, observedResponseAt?: Date) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const filter: FilterQuery<IConversation> = { conversationId, user };
      if (observedResponseAt) {
        filter.lastResponseAt = { $lte: observedResponseAt };
      }
      /* Never earlier than the reply being acknowledged. The filter guarantees the stored
       * response is no newer than what the client observed, but across replicas the node
       * writing this can be behind the one that stamped the reply, and a catch-up older than
       * the response it acknowledges would read as unseen again on the next refetch. */
      const now = new Date();
      const lastSeenAt = observedResponseAt && observedResponseAt > now ? observedResponseAt : now;
      const result = await Conversation.updateOne(
        filter,
        { $set: { lastSeenAt }, $unset: { isMarkedUnread: '' } },
        { timestamps: false },
      );
      /* Matched, not modified: a retry of an acknowledgement that already landed writes the
       * same value back, which MongoDB reports as zero documents modified. The client reads
       * `modified: false` as a rejected stale acknowledgement and rolls its cache back to
       * unseen, so success has to mean "the observed reply is still the newest", which is
       * exactly what the filter matching does. */
      return { modified: result.matchedCount > 0 };
    } catch (error) {
      logger.error('[markConvoSeen] Error marking conversation seen', error);
      throw new Error('Error marking conversation seen');
    }
  }

  /**
   * Flags a conversation as unread again: the user explicitly wants the indicator back.
   *
   * A conversation that has never been replied to has no stamp for the dot to compare against,
   * so the flag stamps a strictly monotonic server value and records its source explicitly.
   * A real reply racing this write either wins first (and the clear-only path preserves it) or
   * sees the synthetic stamp and advances past it while clearing the marker.
   *
   * Classic operators only. Pipeline-form updates (and `$$REMOVE`) are unsupported on every
   * DocumentDB engine this project targets.
   */
  async function markConvoUnread(user: string, conversationId: string) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const projection = UNREAD_STATE_PROJECTION;
      const stamped = await Conversation.findOneAndUpdate(
        {
          conversationId,
          user,
          $or: [{ lastResponseAt: null }, { lastResponseAt: { $exists: false } }],
        },
        {
          $set: { lastResponseAt: new Date(), lastResponseIsManual: true, isMarkedUnread: true },
          $unset: { lastSeenAt: '', lastResponseMessageId: '' },
        },
        { timestamps: false, new: true, projection },
      ).lean<
        Pick<
          IConversation,
          'lastResponseAt' | 'lastResponseMessageId' | 'lastResponseIsManual' | 'isMarkedUnread'
        >
      >();
      if (stamped) {
        return {
          modified: true,
          lastResponseAt: stamped.lastResponseAt,
          lastResponseMessageId: stamped.lastResponseMessageId,
          lastResponseIsManual: stamped.lastResponseIsManual === true,
          isMarkedUnread: stamped.isMarkedUnread,
        };
      }

      const cleared = await Conversation.findOneAndUpdate(
        { conversationId, user },
        { $set: { isMarkedUnread: true }, $unset: { lastSeenAt: '' } },
        { timestamps: false, new: true, projection },
      ).lean<
        Pick<
          IConversation,
          'lastResponseAt' | 'lastResponseMessageId' | 'lastResponseIsManual' | 'isMarkedUnread'
        >
      >();

      return cleared
        ? {
            modified: true,
            lastResponseAt: cleared.lastResponseAt,
            lastResponseMessageId: cleared.lastResponseMessageId,
            lastResponseIsManual: cleared.lastResponseIsManual === true,
            isMarkedUnread: cleared.isMarkedUnread,
          }
        : { modified: false };
    } catch (error) {
      logger.error('[markConvoUnread] Error marking conversation unread', error);
      throw new Error('Error marking conversation unread');
    }
  }

  /**
   * Stamps a persisted assistant reply for paths that save the message directly
   * (assistants threads, resumed runs, terminal abort re-saves) rather than through
   * BaseClient's saveConvo payload.
   *
   * The same compare-and-set write `saveConvo` uses advances the reply version and clears the
   * previous catch-up atomically. Every persisted reply advances beyond the stored version,
   * including concurrent replies and replies from hosts whose clocks are behind.
   *
   * `updatedAt` moves with it, exactly as BaseClient's reply path already does: a new reply is
   * real activity and belongs at the top of the sidebar. It is also what the away poll pages
   * by, so a stamp that left the order alone would hide replies to any conversation that had
   * fallen past the first page. Contrast `markConvoSeen`, where reading must not reorder.
   */
  async function stampConvoLastResponse(
    user: string,
    conversationId: string,
    responseMessageId: string,
  ) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const stamped = await stampReplyWithCas(
        Conversation,
        { conversationId, user },
        responseMessageId,
        LAST_RESPONSE_STAMP_PROJECTION,
      );

      /* Moving `updatedAt` is only half of what `saveConvo` does for a project chat: the
       * workspace sorts on `ChatProject.lastConversationAt`, so lifting the conversation
       * while leaving its project behind would make the two views disagree. */
      if (stamped?.conversation.chatProjectId) {
        try {
          await updateChatProjectLastConversationForUser(
            mongoose,
            user,
            stamped.conversation.chatProjectId,
            stamped.conversation as IConversation,
          );
        } catch (error) {
          logger.error('[stampConvoLastResponse] Failed to update project activity', error);
        }
      }

      /* Return the exact server-side stamp that won the CAS. Callers that deliver a terminal
       * event can merge this into their read-state cache without inventing a browser timestamp. */
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
  }

  /* ------------------------------------------------ command line scripts (ConversationStore) */

  /** How many conversations each user owns, over every conversation (`user-stats`). */
  async function countConvosByUser(): Promise<UserRecordCount[]> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const rows = await Conversation.aggregate<{ _id: unknown; count: number }>([
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]);
    return rows.map(({ _id, count }) => ({ user: _id == null ? null : String(_id), count }));
  }

  /**
   * Creates one conversation record from `record` as given, with the schema's defaults and
   * timestamps, outside `saveConvo`'s rules (`create-error-convo` seeds a gallery with it).
   */
  async function createConvoRecord(record: Record<string, unknown>): Promise<void> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    await Conversation.create(record);
  }

  /* -------------------------------------------------- saveConvo steps (ConversationStore) */

  async function getConvoMessageIds(user: string, conversationId: string): Promise<string[]> {
    const { getMessages } = getMessageMethods();
    const messages = await getMessages({ conversationId, user }, '_id');
    return messages.map((message) => String(message._id));
  }

  async function isOwnedChatProject(user: string, chatProjectId: string): Promise<boolean> {
    if (!isValidObjectIdString(chatProjectId)) {
      return false;
    }
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const project = await ChatProject.exists({
      _id: new mongoose.Types.ObjectId(chatProjectId),
      user,
    });
    return project != null;
  }

  async function writeConvo(input: ConvoWrite): Promise<ConvoWriteResult | null> {
    const { upsert } = input;
    const filter = convoWriteFilter(input);
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const operation = convoWriteOperation(input);
    const result = (await Conversation.findOneAndUpdate(filter, operation, {
      new: true,
      upsert,
      includeResultMetadata: true,
      ...(input.timestamps ? {} : { timestamps: false }),
    })) as unknown as ConversationUpdateResult;
    if (!result.value) {
      return null;
    }
    return {
      conversation: result.value.toObject(),
      inserted: result.lastErrorObject?.updatedExisting === false,
    };
  }

  async function convoExists(user: string, conversationId: string): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return (await Conversation.exists({ conversationId, user })) != null;
  }

  async function seedConvoCodeEnvironmentDecision(input: {
    user: string;
    conversationId: string;
    decision: ConvoCodeEnvironmentDecision;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      undecidedCodeEnvironmentFilter(
        input.conversationId,
        input.user,
      ) as FilterQuery<IConversation>,
      { $set: input.decision },
      { timestamps: false },
    );
    return result.modifiedCount > 0;
  }

  async function setConvoExpiryIfUnset(input: {
    user: string;
    conversationId: string;
    isTemporary: boolean;
    expiredAt: Date;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      unsetExpiryFilter(input) as FilterQuery<IConversation>,
      { $set: { expiredAt: input.expiredAt } },
      { timestamps: false },
    );
    return result.modifiedCount > 0;
  }

  async function stampConvoReply(input: {
    user: string;
    conversationId: string;
    responseMessageId: string;
  }): Promise<{ lastResponseAt: Date; state: ConvoReplyStampState } | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const stamped = await stampReplyWithCas(
      Conversation,
      { conversationId: input.conversationId, user: input.user },
      input.responseMessageId,
      REPLY_STAMP_STATE_PROJECTION,
    );
    return stamped
      ? { lastResponseAt: stamped.stamp, state: stamped.conversation as ConvoReplyStampState }
      : null;
  }

  async function backfillConvoIsTemporary(input: {
    user: string;
    conversationId: string;
    touchUpdatedAt: boolean;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      { conversationId: input.conversationId, user: input.user, isTemporary: { $in: [null] } },
      { $set: { isTemporary: false } },
      input.touchUpdatedAt ? {} : { timestamps: false },
    );
    return result.modifiedCount > 0;
  }

  async function refreshChatProjectStats(user: string, chatProjectId: string): Promise<void> {
    await refreshChatProjectStatsForUser(mongoose, user, chatProjectId);
  }

  async function recordChatProjectLastConversation(
    user: string,
    chatProjectId: string,
    conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    await updateChatProjectLastConversationForUser(mongoose, user, chatProjectId, conversation);
  }

  /* ---------------------------------------------- bulkSaveConvos steps (ConversationStore) */

  async function listConvoProjectAssignments(
    pairs: Array<{ user: string; conversationId: string }>,
  ): Promise<ConvoProjectAssignment[]> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const existing = await Conversation.find(
      { $or: pairs },
      'user conversationId chatProjectId',
    ).lean<ConvoProjectAssignment[]>();
    return existing.map(({ user, conversationId, chatProjectId }) => ({
      user,
      conversationId,
      ...(chatProjectId !== undefined && { chatProjectId }),
    }));
  }

  /**
   * `bulkWrite` runs no query middleware, so `tenantSafeBulkWrite` strips `tenantId` from the
   * payload and scopes every row to the tenant in context. Returns the driver's result.
   */
  async function bulkUpsertConvos(upserts: ConvoBulkUpsert[]): Promise<ConvoBulkUpsertResult> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return tenantSafeBulkWrite(
      Conversation,
      upserts.map(({ user, conversationId, set, setOnInsert }) => ({
        updateOne: {
          filter: { conversationId, user },
          update: { $set: set, $setOnInsert: setOnInsert },
          upsert: true,
          timestamps: false,
        },
      })),
    );
  }

  /** The chat-project ownership `bulkSaveConvos` checks, in one batched read. */
  async function listOwnedChatProjectIds(
    pairs: Array<{ user: string; chatProjectId: string }>,
  ): Promise<Array<{ user: string; chatProjectId: string }>> {
    const candidates = pairs.filter(({ chatProjectId }) => isValidObjectIdString(chatProjectId));
    if (candidates.length === 0) {
      return [];
    }
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
    const owned = await ChatProject.find({
      $or: candidates.map(({ user, chatProjectId }) => ({
        _id: new mongoose.Types.ObjectId(chatProjectId),
        user,
      })),
    })
      .select('_id user')
      .lean<Array<{ _id: { toString: () => string }; user: string }>>();
    return owned.map((project) => ({ user: project.user, chatProjectId: project._id.toString() }));
  }

  /* ------------------------------------------ searchConversation steps (ConversationStore) */

  /** Not scoped to a user; the tenant-isolation plugin still scopes it to the tenant. */
  async function getConvoByIdAcrossUsers(
    conversationId: string,
    projection: ConvoByIdProjection,
  ): Promise<IConversation | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return Conversation.findOne(
      { conversationId },
      CONVO_BY_ID_PROJECTIONS[projection],
    ).lean<IConversation>();
  }

  /** Written once on the steps above (see `./saveConvo`), sharing this instance. */
  const saveConvo: ConversationMethods['saveConvo'] = createSaveConvo({
    getConvo,
    getConvoMessageIds,
    isOwnedChatProject,
    writeConvo,
    convoExists,
    seedConvoCodeEnvironmentDecision,
    setConvoExpiryIfUnset,
    stampConvoReply,
    backfillConvoIsTemporary,
    refreshChatProjectStats,
    recordChatProjectLastConversation,
  });

  /** Written once on the steps above (see `./deleteConvos`), sharing this instance. */
  const deleteConvos: ConversationMethods['deleteConvos'] = createDeleteConvos(
    {
      listConvosForDeletion,
      listSubagentDescendantsForDeletion,
      listSubagentChildrenForDeletion,
      deleteConvoRecords,
      refreshChatProjectStats,
    },
    getDeleteConvosDeps,
  );

  /** Written once on the steps above (see `./bulkSaveConvos`), sharing this instance. */
  const bulkSaveConvos: ConversationMethods['bulkSaveConvos'] = createBulkSaveConvos(
    { listConvoProjectAssignments, bulkUpsertConvos, refreshChatProjectStats },
    { listOwnedChatProjectIds },
  );

  /** Written once on the step above (see `./searchConversation`), sharing this instance. */
  const searchConversation: ConversationMethods['searchConversation'] = createSearchConversation({
    getConvoByIdAcrossUsers,
  });

  return {
    countConvosByUser,
    createConvoRecord,
    listConvoProjectAssignments,
    bulkUpsertConvos,
    getConvoByIdAcrossUsers,
    listConvosForDeletion,
    listSubagentDescendantsForDeletion,
    listSubagentChildrenForDeletion,
    deleteConvoRecords,
    getConvoMessageIds,
    isOwnedChatProject,
    writeConvo,
    convoExists,
    seedConvoCodeEnvironmentDecision,
    setConvoExpiryIfUnset,
    stampConvoReply,
    backfillConvoIsTemporary,
    refreshChatProjectStats,
    recordChatProjectLastConversation,
    getConvoFiles,
    searchConversation,
    stampForcedRetention,
    saveConvo,
    setConvoPinned,
    appendConvoMessageReference,
    getConvoCodeEnvironmentDecision,
    addConvoToolApprovalAllows,
    reserveConvoLaneGitSeq,
    setConvoLaneGit,
    getConvoLaneGit,
    getConvosLaneGit,
    getConvoLaneContext,
    readAdmittedConvoCodeEnvironmentDecision,
    replaceConvoCodeEnvironmentDecision,
    bulkSaveConvos,
    getConvosByCursor,
    getConvosQueried,
    getConvo,
    getConvoTitleState,
    getSubagentThreadForParent,
    listSubagentThreadsForParent,
    getAgentEventBinding,
    getAgentEventActorSnapshot,
    commitAgentEventActorState,
    storeAgentEventActorSuspension,
    claimAgentEventActorSuspension,
    settleAgentEventActorSuspension,
    cancelAgentEventActorSuspension,
    beginAgentEventActorLegacyTurn,
    completeAgentEventActorLegacyTurn,
    recordAgentEventActorReconciliation,
    resolveAgentEventActorReconciliation,
    clearAgentEventActorReconciliation,
    getAgentEventActorReconciliationStorageMetrics,
    expireLegacyAgentEventActorReceipts,
    reserveSubagentThread,
    acquireSubagentThreadLease,
    renewSubagentThreadLease,
    releaseSubagentThreadLease,
    countActiveSubagentThreadLeases,
    listActiveSubagentThreadLeases,
    getConvoOwnership,
    getConvoRetention,
    getConvoTitle,
    markConvoSeen,
    markConvoUnread,
    stampConvoLastResponse,
    deleteConvos,
    archiveAllConvos,
  };
}

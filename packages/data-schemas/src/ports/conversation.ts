/**
 * Conversation store port.
 *
 * The operations the application performs on conversations, stated independently of the
 * database behind them, so a MongoDB adapter and a PostgreSQL adapter can both satisfy it.
 * Nothing here may import `mongoose`; adapters live elsewhere.
 *
 * Signatures are copied verbatim from `ConversationMethods` (`~/methods/conversation`) so no
 * caller changes. `conversation.spec.ts` beside this file fails the typecheck if the two drift.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`). Methods
 *   that take an explicit `tenantId` use it as given.
 * - A conversation that does not exist, or is not visible to `user` in that tenant, reads as
 *   `null` (or `undefined`/`false`/an empty list where the return type says so); it never throws.
 *
 * Not in this port, because their signatures expose MongoDB itself and need a neutral
 * replacement before a second adapter can implement them:
 * - `saveConvo`: `metadata.unsetFields` is a `$unset` map and `appendMessageIds` accepts
 *   `Types.ObjectId`.
 * - `deleteConvos`: takes a `FilterQuery<IConversation>` and returns `DeleteResult`s.
 * - `bulkSaveConvos`: takes untyped records and returns the driver's bulk-write result.
 * - `searchConversation`: takes a Mongo projection string and is not scoped to a user.
 *
 * Known leaks kept for now so callers stay unchanged: `IConversation` extends mongoose's
 * `Document`, and several record types are still declared in `~/methods/conversation`.
 */
import type {
  AppConfig,
  IActiveSubagentThreadLease,
  IAgentEventActorCheckpoint,
  IAgentEventActorReconciliation,
  IAgentEventActorSnapshot,
  IAgentEventActorState,
  IAgentEventActorSuspensionEvidence,
  IAgentEventBindingRecord,
  IConversation,
  ISubagentThreadReservation,
} from '~/types';
import type {
  AgentEventActorCommitResult,
  AgentEventActorReconciliationStorageMetrics,
  AgentEventActorSettlementAuthority,
  ConversationTitleState,
  ConvoLaneContext,
  ConvoLaneGitView,
  ParentSubagentThreadRecord,
  SubagentThreadReadRecord,
} from '~/methods/conversation';

export interface ConversationStore {
  /* ---------------------------------------------------------------- reads */

  getConvo(user: string, conversationId: string): Promise<IConversation | null>;
  getConvoTitle(user: string, conversationId: string): Promise<string | null>;
  getConvoTitleState(user: string, conversationId: string): Promise<ConversationTitleState | null>;
  getConvoOwnership(
    user: string,
    conversationId: string,
    tenantId?: string | null,
  ): Promise<Pick<IConversation, 'user' | 'tenantId' | 'subagentThread'> | null>;
  getConvoRetention(
    user: string,
    conversationId: string,
  ): Promise<Pick<IConversation, 'expiredAt' | 'isTemporary'> | null>;
  getConvoFiles(conversationId: string): Promise<string[]>;
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

  /* ------------------------------------------------------- single-field writes */

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
  archiveAllConvos(user: string): Promise<{ archivedCount: number }>;
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
  addConvoToolApprovalAllows(input: {
    user: string;
    conversationId: string;
    toolNames: string[];
    max: number;
  }): Promise<boolean>;

  /* ------------------------------------------------------- code environment */

  getConvoCodeEnvironmentDecision(
    user: string,
    conversationId: string,
  ): Promise<Pick<
    IConversation,
    'conversationId' | 'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
  > | null>;
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

  /* ---------------------------------------------------------------- lane git */

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

  /* ---------------------------------------------------------- subagent threads */

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

  /* --------------------------------------------------------- agent event actor */

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
}

/**
 * One entry per method of {@link ConversationStore}. Typed as the full key set, so leaving a
 * method out or naming one the port lacks is a compile error.
 */
const conversationStoreMethods: { readonly [K in keyof ConversationStore]: true } = {
  getConvo: true,
  getConvoTitle: true,
  getConvoTitleState: true,
  getConvoOwnership: true,
  getConvoRetention: true,
  getConvoFiles: true,
  getConvosByCursor: true,
  getConvosQueried: true,
  setConvoPinned: true,
  appendConvoMessageReference: true,
  markConvoSeen: true,
  markConvoUnread: true,
  stampConvoLastResponse: true,
  archiveAllConvos: true,
  stampForcedRetention: true,
  addConvoToolApprovalAllows: true,
  getConvoCodeEnvironmentDecision: true,
  readAdmittedConvoCodeEnvironmentDecision: true,
  replaceConvoCodeEnvironmentDecision: true,
  reserveConvoLaneGitSeq: true,
  getConvoLaneContext: true,
  setConvoLaneGit: true,
  getConvoLaneGit: true,
  getConvosLaneGit: true,
  getSubagentThreadForParent: true,
  listSubagentThreadsForParent: true,
  reserveSubagentThread: true,
  acquireSubagentThreadLease: true,
  renewSubagentThreadLease: true,
  releaseSubagentThreadLease: true,
  countActiveSubagentThreadLeases: true,
  listActiveSubagentThreadLeases: true,
  getAgentEventBinding: true,
  getAgentEventActorSnapshot: true,
  commitAgentEventActorState: true,
  storeAgentEventActorSuspension: true,
  claimAgentEventActorSuspension: true,
  settleAgentEventActorSuspension: true,
  cancelAgentEventActorSuspension: true,
  beginAgentEventActorLegacyTurn: true,
  completeAgentEventActorLegacyTurn: true,
  recordAgentEventActorReconciliation: true,
  resolveAgentEventActorReconciliation: true,
  clearAgentEventActorReconciliation: true,
  getAgentEventActorReconciliationStorageMetrics: true,
  expireLegacyAgentEventActorReceipts: true,
};

/** Every method of {@link ConversationStore}, for adapters and conformance checks. */
export const CONVERSATION_STORE_METHODS: ReadonlyArray<keyof ConversationStore> = Object.keys(
  conversationStoreMethods,
) as Array<keyof ConversationStore>;

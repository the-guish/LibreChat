/**
 * The database-neutral rules of the conversation store, shared by the MongoDB methods
 * (`./conversation`) and the PostgreSQL store (`~/adapters/postgres/stores/conversation`): the
 * limits, the input validation of the agent event actor writes, the record shapes the reads hand
 * out, and the filters and updates of the guarded writes, stated in the query language both
 * backends speak. Nothing here may import `mongoose` or touch a model.
 */
import { Buffer } from 'node:buffer';
import { UNSEEN_REPLY_WATERMARK } from 'librechat-data-provider';
import type {
  IAgentEventActorCheckpoint,
  IAgentEventActorReconciliation,
  IAgentEventActorSnapshot,
  IAgentEventActorState,
  IAgentEventActorSuspensionEvidence,
  IAgentEventBindingRecord,
  IConversation,
  ConvoDeletionTarget,
  ConvoByIdProjection,
  ConvoWrite,
} from '~/types';
import {
  MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS,
  MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH,
  MAX_AGENT_EVENT_ACTOR_SKILLS,
  MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH,
  MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH,
} from '~/types/convo';
import { isAgentFadingTier, isAgentFadingTierEntries } from '~/utils/fading';
import { isCompactionSemanticIndexProjection } from '~/types/compaction';
import { buildRetentionVisibilityFilter } from '~/utils/retention';

/** A filter or an update in the query language both backends speak. */
type Query = Record<string, unknown>;

/* ------------------------------------------------------------------------------ record types */

/** The lane state a reader may see; the sequence number that fences writes stays private. */
export type ConvoLaneGitView = Omit<NonNullable<IConversation['laneGit']>, 'seq'>;

/** What a lane recorder needs to place and fence its writes, read once when its tool is created. */
export type ConvoLaneContext = {
  subagentThread?: IConversation['subagentThread'] | null;
  /** Counts the owner's moves and detaches of the workspace the report is written to (the visible
   *  root for a subagent thread); 0 until the first. */
  codeAttachmentEpoch: number;
};

export type SubagentThreadReadRecord = Pick<
  IConversation,
  | 'conversationId'
  | 'tenantId'
  | 'title'
  | 'agent_id'
  | 'updatedAt'
  | 'subagentThread'
  | 'subagentThreadLease'
> & {
  actorId?: string;
};

export type ParentSubagentThreadRecord = SubagentThreadReadRecord;

export type AgentEventActorCommitResult =
  | {
      status: 'committed';
      state: IAgentEventActorState;
      prunableCheckpoint?: IAgentEventActorCheckpoint;
    }
  | { status: 'stale'; state?: IAgentEventActorState };

export interface AgentEventActorSettlementAuthority {
  suspensionId: string;
  attempt: number;
  resumeAttemptId: string;
}

export interface AgentEventActorReconciliationStorageMetrics {
  pending: number;
  oldestPendingAgeSeconds: number;
}

export type ConversationTitleState = Pick<
  IConversation,
  'title' | 'titleSetByUser' | 'titleRevision'
>;

/* ---------------------------------------------------------------------------------- limits */

export const AGENT_EVENT_ACTOR_RECEIPT_RETENTION_MS: number = 90 * 24 * 60 * 60_000;
export const MAX_AGENT_EVENT_ACTOR_SUSPENSION_BYTES: number = 64 * 1_024;
/** MeiliSearch's default `pagination.maxTotalHits` ceiling. */
export const MEILI_SEARCH_LIMIT = 1000;
/** Ceiling for a single conversation page; the sidebar's largest request is 100. */
export const MAX_CONVO_PAGE_SIZE = 100;
export const DEFAULT_CONVO_PAGE_SIZE = 25;
export const ARCHIVE_CONVERSATION_BATCH_SIZE = 500;
export const PROJECT_DISCOVERY_MAX_ATTEMPTS = 3;
/** The bounds of the legacy receipt expiry sweep's page. */
export const LEGACY_RECEIPT_EXPIRY_DEFAULT_LIMIT = 100;
export const LEGACY_RECEIPT_EXPIRY_MAX_LIMIT = 1_000;

/** The reconciliation states a repair or compensation may resolve or clear. */
export const UNSETTLED_REPLAY_STATUSES = [
  'persistence_pending',
  'history_persisted',
  'commit_conflict',
  'commit_indeterminate',
  'persistence_failed',
] as const;

/** A strictly later stamp than `previous`, and never earlier than now. */
export const nextMonotonicStamp = (previous?: Date): Date => {
  const previousMs = previous?.getTime() ?? 0;
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0));
};

export const escapeMeiliFilterValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/* ------------------------------------------------------------------------------ validation */

export function validateAgentEventActorSuspension(
  conversationId: string,
  suspension: IAgentEventActorSuspensionEvidence,
  actionId: string,
  jobCreatedAt: number,
  previous?: AgentEventActorSettlementAuthority,
): void {
  const invocation = suspension?.invocation;
  const fork = invocation?.fork;
  const checkpoint = suspension?.checkpoint;
  if (
    suspension?.version !== 1 ||
    typeof suspension.suspensionId !== 'string' ||
    suspension.suspensionId.length === 0 ||
    !Number.isSafeInteger(suspension.attempt) ||
    suspension.attempt < 0 ||
    !Number.isSafeInteger(suspension.issuedAt) ||
    !Number.isSafeInteger(suspension.expiresAt) ||
    suspension.expiresAt <= suspension.issuedAt ||
    invocation?.actorThreadId !== conversationId ||
    fork?.threadId !== conversationId ||
    checkpoint?.threadId !== conversationId ||
    fork?.invocationId !== invocation?.invocationId ||
    checkpoint?.invocationId !== invocation?.invocationId ||
    checkpoint?.checkpointNs !== fork?.checkpointNs ||
    typeof suspension.interrupt?.id !== 'string' ||
    suspension.interrupt.id.length === 0 ||
    typeof suspension.suspensionDigest !== 'string' ||
    suspension.suspensionDigest.length === 0 ||
    typeof actionId !== 'string' ||
    actionId.length === 0 ||
    !Number.isSafeInteger(jobCreatedAt) ||
    jobCreatedAt < 0 ||
    (previous == null ? suspension.attempt !== 0 : suspension.attempt !== previous.attempt + 1)
  ) {
    throw new Error('Event actor suspension evidence is invalid');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(suspension);
  } catch {
    throw new Error('Event actor suspension evidence is not JSON-safe');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AGENT_EVENT_ACTOR_SUSPENSION_BYTES) {
    throw new RangeError('Event actor suspension exceeds maximum payload size');
  }
}

/** Refuses a malformed resume claim before any read. */
export function validateAgentEventActorSuspensionClaim(input: {
  suspensionId: string;
  attempt: number;
  actionId: string;
  jobCreatedAt: number;
  resumeAttemptId: string;
}): void {
  if (
    input.suspensionId.length === 0 ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 0 ||
    input.actionId.length === 0 ||
    !Number.isSafeInteger(input.jobCreatedAt) ||
    input.jobCreatedAt < 0 ||
    input.resumeAttemptId.length === 0
  ) {
    throw new Error('Event actor suspension claim is invalid');
  }
}

/** What `commitAgentEventActorState` is given. */
export interface AgentEventActorCommitInput {
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
}

/** Refuses an actor head that changed its thread or carries invalid warm state, before writing. */
export function validateAgentEventActorCommit(input: AgentEventActorCommitInput): void {
  if (input.checkpoint.threadId !== input.conversationId) {
    throw new Error('Event actor checkpoint changed its logical thread');
  }
  if ((input.skillManifest?.length ?? 0) > MAX_AGENT_EVENT_ACTOR_SKILLS) {
    throw new RangeError(`Event actor Skill manifest exceeds ${MAX_AGENT_EVENT_ACTOR_SKILLS}`);
  }
  if (
    (input.discoveredToolNames?.length ?? 0) > MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS ||
    input.discoveredToolNames?.some(
      (name) => name.length === 0 || name.length > MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH,
    )
  ) {
    throw new RangeError('Event actor discovered-tool state is invalid');
  }
  if (
    input.summary != null &&
    (input.summary.text.length === 0 ||
      input.summary.text.length > MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH ||
      !Number.isFinite(input.summary.tokenCount) ||
      input.summary.tokenCount < 0)
  ) {
    throw new RangeError('Event actor summary state is invalid');
  }
  if (
    input.contextMeta != null &&
    (!Number.isFinite(input.contextMeta.calibrationRatio) ||
      input.contextMeta.calibrationRatio < 0.5 ||
      input.contextMeta.calibrationRatio > 5 ||
      (input.contextMeta.encoding != null &&
        (input.contextMeta.encoding.length === 0 ||
          input.contextMeta.encoding.length > MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH)))
  ) {
    throw new RangeError('Event actor context calibration is invalid');
  }
  if (
    input.contextMeta?.fadingTiers != null &&
    !isAgentFadingTierEntries(input.contextMeta.fadingTiers)
  ) {
    throw new RangeError('Event actor context fading tiers are invalid');
  }
  if (input.contextMeta?.fading != null && !isAgentFadingTier(input.contextMeta.fading)) {
    throw new RangeError('Event actor context fading tier is invalid');
  }
  if (
    input.compactionSemanticIndex != null &&
    !isCompactionSemanticIndexProjection(input.compactionSemanticIndex)
  ) {
    throw new RangeError('Event actor compaction semantic index is invalid');
  }
}

/** Refuses a reconciliation write naming another thread than its conversation. */
export function assertReconciliationThread(conversationId: string, threadId: string): void {
  if (threadId !== conversationId) {
    throw new Error('Event actor reconciliation changed its logical thread');
  }
}

/* ------------------------------------------------------------------------- record shapes */

/** The fields a subagent thread read selects. */
export const SUBAGENT_THREAD_READ_FIELDS =
  'conversationId tenantId title agent_id updatedAt subagentThread +subagentThreadLease +agentEventBinding';

/** The fields an event binding lookup selects. */
export const AGENT_EVENT_BINDING_FIELDS =
  'conversationId agent_id tenantId isTemporary expiredAt subagentThread +agentEventBinding';

/** The private actor fields a snapshot reads. */
export const AGENT_EVENT_ACTOR_SNAPSHOT_FIELDS =
  '+agentEventActor +agentEventActorReconciliations +agentEventActorEpoch +agentEventActorLegacyTurn +agentEventActorSuspension';

/** The fields a sidebar page lists. */
export const CONVO_LIST_FIELDS =
  'conversationId endpoint title titleSetByUser titleRevision createdAt updatedAt archivedAt isArchived user model agent_id assistant_id spec iconURL chatProjectId pinned lastResponseAt lastResponseMessageId lastResponseIsManual isMarkedUnread lastSeenAt codeEnvironmentMode codeWorkspaces';

/** The fields a deletion needs of each conversation. */
export const DELETION_TARGET_FIELDS = 'conversationId tenantId chatProjectId tags';

/** The projections of `getConvoByIdAcrossUsers`; `null` selects every non-hidden field. */
export const CONVO_BY_ID_PROJECTIONS: Record<ConvoByIdProjection, string | null> = {
  ownership: 'conversationId user',
  withoutMessages: '-messages',
  full: null,
};

/** The read-state fields a reply stamp returns. */
export const REPLY_STAMP_STATE_PROJECTION = {
  lastResponseAt: 1,
  lastResponseMessageId: 1,
  lastResponseIsManual: 1,
  isMarkedUnread: 1,
  lastSeenAt: 1,
  updatedAt: 1,
} as const;

/** The fields `stampConvoLastResponse` returns and its project pointer needs. */
export const LAST_RESPONSE_STAMP_PROJECTION = {
  conversationId: 1,
  chatProjectId: 1,
  createdAt: 1,
  updatedAt: 1,
  lastResponseMessageId: 1,
} as const;

/** The fields `markConvoUnread` reports. */
export const UNREAD_STATE_PROJECTION = {
  lastResponseAt: 1,
  lastResponseMessageId: 1,
  lastResponseIsManual: 1,
  isMarkedUnread: 1,
} as const;

export const subagentThreadReadRecord = (
  conversation: IConversation,
): SubagentThreadReadRecord => ({
  conversationId: conversation.conversationId,
  ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
  ...(conversation.title == null ? {} : { title: conversation.title }),
  ...(conversation.agent_id == null ? {} : { agent_id: conversation.agent_id }),
  ...(conversation.updatedAt == null ? {} : { updatedAt: conversation.updatedAt }),
  ...(conversation.subagentThread == null ? {} : { subagentThread: conversation.subagentThread }),
  ...(conversation.subagentThreadLease == null
    ? {}
    : { subagentThreadLease: conversation.subagentThreadLease }),
  ...(conversation.agentEventBinding?.actorId == null
    ? {}
    : { actorId: conversation.agentEventBinding.actorId }),
});

/** The event binding a lookup resolves, or `null` for a thread that is not event-bound. */
export function agentEventBindingRecordOf(
  conversation: IConversation | null,
): IAgentEventBindingRecord | null {
  if (
    conversation?.agentEventBinding == null ||
    conversation.subagentThread == null ||
    typeof conversation.agent_id !== 'string'
  ) {
    return null;
  }
  return {
    conversationId: conversation.conversationId,
    agentId: conversation.agent_id,
    ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
    ...(conversation.isTemporary == null ? {} : { isTemporary: conversation.isTemporary }),
    ...(conversation.expiredAt == null ? {} : { expiredAt: conversation.expiredAt }),
    binding: conversation.agentEventBinding,
    lineage: conversation.subagentThread,
  };
}

/** The suspension as readers see it: the owned states read as their public names. */
export function readableActorSuspension(
  suspension: IConversation['agentEventActorSuspension'],
): IAgentEventActorSnapshot['suspension'] {
  if (suspension == null) return null;
  if (suspension.status === 'pending_owned') return { ...suspension, status: 'pending' };
  if (suspension.status === 'claimed_owned') return { ...suspension, status: 'claimed' };
  return suspension;
}

/** The snapshot of an actor thread read with {@link AGENT_EVENT_ACTOR_SNAPSHOT_FIELDS}. */
export function agentEventActorSnapshotOf(
  conversation: IConversation | null,
): IAgentEventActorSnapshot | undefined {
  return conversation == null
    ? undefined
    : {
        state: conversation.agentEventActor ?? null,
        reconciliations: conversation.agentEventActorReconciliations ?? [],
        legacyTurn: conversation.agentEventActorLegacyTurn ?? null,
        suspension: readableActorSuspension(conversation.agentEventActorSuspension),
        epoch: conversation.agentEventActorEpoch ?? 0,
      };
}

/** The live lease addresses of the threads read, skipping incomplete ones. */
export function activeSubagentThreadLeasesOf(
  conversations: Array<
    Pick<IConversation, 'conversationId' | 'subagentThread' | 'subagentThreadLease'>
  >,
): Array<{ conversationId: string; parentConversationId: string; taskId: string }> {
  return conversations.flatMap((conversation) => {
    const { conversationId } = conversation;
    const parentConversationId = conversation.subagentThread?.parentConversationId;
    const taskId = conversation.subagentThreadLease?.taskId;
    return typeof conversationId === 'string' &&
      conversationId !== '' &&
      typeof parentConversationId === 'string' &&
      parentConversationId !== '' &&
      typeof taskId === 'string' &&
      taskId !== ''
      ? [{ conversationId, parentConversationId, taskId }]
      : [];
  });
}

/** The lane state a reader may see. */
export function laneGitViewOf(laneGit: NonNullable<IConversation['laneGit']>): ConvoLaneGitView {
  const { branch, head, repo, pullRequest } = laneGit;
  return {
    branch,
    head,
    ...(repo ? { repo } : {}),
    ...(pullRequest != null ? { pullRequest } : {}),
  };
}

/** The epoch a lane report is fenced by: the visible root's for a subagent thread. */
export function laneContextOf(
  conversationId: string,
  row: {
    subagentThread?: IConversation['subagentThread'] | null;
    codeAttachmentEpoch?: number;
  },
  root: { codeAttachmentEpoch?: number } | undefined,
): ConvoLaneContext {
  const rootId = row.subagentThread?.rootConversationId;
  const fenced = rootId && rootId !== conversationId ? root : row;
  return {
    subagentThread: row.subagentThread ?? null,
    codeAttachmentEpoch: fenced?.codeAttachmentEpoch ?? 0,
  };
}

/** Plain deletion targets from lean documents, keeping absent fields absent. */
export function toDeletionTargets(conversations: ConvoDeletionTarget[]): ConvoDeletionTarget[] {
  return conversations.map(({ conversationId, tenantId, chatProjectId, tags }) => ({
    conversationId,
    ...(tenantId !== undefined && { tenantId }),
    ...(chatProjectId !== undefined && { chatProjectId }),
    ...(tags !== undefined && { tags }),
  }));
}

/* --------------------------------------------------------------------------------- filters */

/** Child threads are durable execution records, not user-navigable conversations. */
export function humanConversationFilter(): Query {
  return { subagentThread: { $exists: false } };
}

/** The conversations a user can currently see in the chat list. */
export function visibleConversationRetentionFilter(): Query {
  return buildRetentionVisibilityFilter() as Query;
}

/** The exact tenant of a subagent thread: tenantless when none is given. */
export function threadTenantFilter(tenantId?: string): Query {
  return tenantId == null ? { tenantId: { $exists: false } } : { tenantId };
}

/** The visible, unarchived chats `archiveAllConvos` sweeps. */
export function archiveSweepFilter(user: string): Query {
  return {
    user,
    $and: [
      { $or: [{ isArchived: false }, { isArchived: { $exists: false } }] },
      visibleConversationRetentionFilter(),
      humanConversationFilter(),
    ],
  };
}

/** The element condition naming one reconciliation by its invocation and exact checkpoint. */
export function exactReconciliationCheckpoint(
  invocationId: string,
  checkpoint: IAgentEventActorReconciliation['checkpoint'],
): Query {
  return {
    invocationId,
    'checkpoint.threadId': checkpoint.threadId,
    'checkpoint.checkpointNs': checkpoint.checkpointNs,
    ...(checkpoint.checkpointId == null
      ? { 'checkpoint.checkpointId': { $exists: false } }
      : { 'checkpoint.checkpointId': checkpoint.checkpointId }),
  };
}

/** The pending lifecycle a suspension settle or cancel pulls. */
export function pendingReconciliationElement(
  invocationId: string,
  checkpoint: IAgentEventActorReconciliation['checkpoint'],
): Query {
  return {
    invocationId,
    status: 'invocation_pending',
    'checkpoint.threadId': checkpoint.threadId,
    'checkpoint.checkpointNs': checkpoint.checkpointNs,
    ...(checkpoint.checkpointId == null
      ? { 'checkpoint.checkpointId': { $exists: false } }
      : { 'checkpoint.checkpointId': checkpoint.checkpointId }),
  };
}

/** The suspension a new one replaces: none or a closed one, or its exact claimed predecessor. */
export function suspensionPredecessorFilter(previous?: AgentEventActorSettlementAuthority): Query {
  return previous == null
    ? {
        $or: [
          { agentEventActorSuspension: { $exists: false } },
          { 'agentEventActorSuspension.status': 'closed' },
        ],
      }
    : {
        'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
        'agentEventActorSuspension.suspension.suspensionId': previous.suspensionId,
        'agentEventActorSuspension.suspension.attempt': previous.attempt,
        'agentEventActorSuspension.resumeAttemptId': previous.resumeAttemptId,
      };
}

/** The suspension record a store writes. */
export function actorSuspensionRecord(input: {
  suspension: IAgentEventActorSuspensionEvidence;
  kind?: 'human_decision' | 'internal_completion';
  appliedAction?: { toolName: string; toolCallId?: string };
  handlingGenerationCreatedAt?: number;
  actionId: string;
  jobCreatedAt: number;
}): NonNullable<IConversation['agentEventActorSuspension']> & { status: 'pending_owned' } {
  return {
    suspension: input.suspension,
    kind: input.kind ?? 'human_decision',
    ...(input.appliedAction == null ? {} : { appliedAction: input.appliedAction }),
    handlingGenerationCreatedAt: input.handlingGenerationCreatedAt ?? input.jobCreatedAt,
    actionId: input.actionId,
    jobCreatedAt: input.jobCreatedAt,
    status: 'pending_owned' as const,
    observedAt: new Date(),
  };
}

/** The exact claimed suspension a resumed commit holds authority from. */
export function settlementAuthorityFilter(authority?: AgentEventActorSettlementAuthority): Query {
  return authority == null
    ? {}
    : {
        'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
        'agentEventActorSuspension.suspension.suspensionId': authority.suspensionId,
        'agentEventActorSuspension.suspension.attempt': authority.attempt,
        'agentEventActorSuspension.resumeAttemptId': authority.resumeAttemptId,
      };
}

/**
 * The complete prior identity a head commit compares and sets on: the invalidation epoch
 * observed at preparation, no legacy turn in flight, and every field of the expected head.
 */
export function expectedActorHeadFilter(input: {
  expected?: IAgentEventActorState;
  expectedEpoch: number;
}): Query {
  const { expected } = input;
  return {
    /** A legacy turn against a headless or already cold-marked actor leaves the head fields
     * unchanged, so the CAS must also require the invalidation epoch observed at preparation.
     * `null` matches a document that has never been invalidated. */
    agentEventActorEpoch: input.expectedEpoch === 0 ? null : input.expectedEpoch,
    /** A legacy turn in flight has not yet persisted its messages, so no fork rebuild can be
     * complete — refuse the commit outright rather than relying on the epoch, which only moves
     * once that turn seals. */
    agentEventActorLegacyTurn: { $exists: false },
    ...(expected == null
      ? { agentEventActor: { $exists: false } }
      : {
          'agentEventActor.generation': expected.generation,
          'agentEventActor.checkpoint.threadId': expected.checkpoint.threadId,
          'agentEventActor.checkpoint.checkpointId': expected.checkpoint.checkpointId,
          'agentEventActor.checkpoint.checkpointNs': expected.checkpoint.checkpointNs,
          'agentEventActor.previousCheckpoint': expected.previousCheckpoint ?? {
            $exists: false,
          },
          ...(expected.contextFingerprint == null
            ? { 'agentEventActor.contextFingerprint': { $exists: false } }
            : {
                'agentEventActor.contextFingerprint.algorithm':
                  expected.contextFingerprint.algorithm,
                'agentEventActor.contextFingerprint.version': expected.contextFingerprint.version,
                'agentEventActor.contextFingerprint.digest': expected.contextFingerprint.digest,
              }),
          ...(expected.skillManifest == null
            ? { 'agentEventActor.skillManifest': { $exists: false } }
            : { 'agentEventActor.skillManifest': expected.skillManifest }),
          ...(expected.discoveredToolNames == null
            ? { 'agentEventActor.discoveredToolNames': { $exists: false } }
            : { 'agentEventActor.discoveredToolNames': expected.discoveredToolNames }),
          ...(expected.summary == null
            ? { 'agentEventActor.summary': { $exists: false } }
            : { 'agentEventActor.summary': expected.summary }),
          ...(expected.contextMeta == null
            ? { 'agentEventActor.contextMeta': { $exists: false } }
            : { 'agentEventActor.contextMeta': expected.contextMeta }),
          ...(expected.compactionSemanticIndex == null
            ? { 'agentEventActor.compactionSemanticIndex': { $exists: false } }
            : { 'agentEventActor.compactionSemanticIndex': expected.compactionSemanticIndex }),
          'agentEventActor.requiresColdStart':
            expected.requiresColdStart === true ? true : { $ne: true },
        }),
  };
}

/** The head a commit writes: one generation past the expected head, which it remembers. */
export function nextActorState(input: AgentEventActorCommitInput): IAgentEventActorState {
  return {
    generation: (input.expected?.generation ?? 0) + 1,
    checkpoint: input.checkpoint,
    ...(input.contextFingerprint == null ? {} : { contextFingerprint: input.contextFingerprint }),
    ...(input.skillManifest == null ? {} : { skillManifest: input.skillManifest }),
    ...(input.discoveredToolNames == null
      ? {}
      : { discoveredToolNames: input.discoveredToolNames }),
    ...(input.summary == null ? {} : { summary: input.summary }),
    ...(input.contextMeta == null ? {} : { contextMeta: input.contextMeta }),
    ...(input.compactionSemanticIndex == null
      ? {}
      : { compactionSemanticIndex: input.compactionSemanticIndex }),
    ...(input.expected == null ? {} : { previousCheckpoint: input.expected.checkpoint }),
  };
}

/** The update of a head commit: the head, its pending lifecycle advanced, the claim closed. */
export function actorCommitUpdate(
  input: AgentEventActorCommitInput,
  nextState: IAgentEventActorState,
): Query {
  return {
    $set: {
      agentEventActor: nextState,
      'agentEventActorReconciliations.$.status': 'persistence_pending',
      'agentEventActorReconciliations.$.checkpoint': input.checkpoint,
      'agentEventActorReconciliations.$.action': input.action,
      'agentEventActorReconciliations.$.observedAt': new Date(),
      ...(input.settlementAuthority == null
        ? {}
        : {
            'agentEventActorSuspension.status': 'closed',
            'agentEventActorSuspension.outcome': 'committed',
            'agentEventActorSuspension.closedAt': new Date(),
            'agentEventActorSuspension.observedAt': new Date(),
          }),
    },
    ...(input.expected?.previousCheckpoint == null
      ? {}
      : {
          $addToSet: { agentEventActorCleanup: input.expected.previousCheckpoint },
        }),
    $unset: { 'agentEventActorReconciliations.$.error': 1 },
  };
}

/** The update closing a suspension with `outcome`. */
export function closeSuspensionUpdate(outcome: 'stale' | 'settled' | 'cancelled'): Query {
  return {
    'agentEventActorSuspension.status': 'closed',
    'agentEventActorSuspension.outcome': outcome,
    'agentEventActorSuspension.closedAt': new Date(),
    'agentEventActorSuspension.observedAt': new Date(),
  };
}

/**
 * What a resumed commit that lost its compare-and-set reports, from the snapshot read after it:
 * its own closed receipt (committed or stale) when the authority matches, a throw when the
 * authority still holds an open claim, and `stale` otherwise.
 */
export function resumedCommitOutcome(
  current: IAgentEventActorSnapshot | undefined,
  authority: AgentEventActorSettlementAuthority,
): AgentEventActorCommitResult {
  const receipt = current?.suspension;
  const matchesAuthority =
    receipt?.suspension.suspensionId === authority.suspensionId &&
    receipt?.suspension.attempt === authority.attempt &&
    receipt?.resumeAttemptId === authority.resumeAttemptId;
  if (matchesAuthority && receipt?.status === 'closed') {
    if (receipt.outcome === 'committed' && current?.state != null) {
      return { status: 'committed', state: current.state };
    }
    if (receipt.outcome === 'stale') {
      return {
        status: 'stale',
        ...(current?.state == null ? {} : { state: current.state }),
      };
    }
  }
  if (matchesAuthority) {
    throw new Error('Resumed event actor commit could not close its suspension fence');
  }
  return {
    status: 'stale',
    ...(current?.state == null ? {} : { state: current.state }),
  };
}

/** Whether a snapshot holds this exact closed suspension receipt (a replayed settle or cancel). */
export function holdsClosedSuspension(
  snapshot: IAgentEventActorSnapshot | undefined,
  outcome: 'settled' | 'cancelled',
  receipt: { suspensionId: string; attempt: number; resumeAttemptId?: string },
): boolean {
  return (
    snapshot?.suspension?.status === 'closed' &&
    snapshot.suspension.outcome === outcome &&
    snapshot.suspension.suspension.suspensionId === receipt.suspensionId &&
    snapshot.suspension.suspension.attempt === receipt.attempt &&
    (receipt.resumeAttemptId === undefined ||
      snapshot.suspension.resumeAttemptId === receipt.resumeAttemptId)
  );
}

/** The live suspension a cancellation targets: a pending one, or the exact orphaned claim. */
export function cancellableSuspensionFilter(claimedResumeAttemptId?: string): Query {
  return claimedResumeAttemptId == null
    ? { 'agentEventActorSuspension.status': { $in: ['pending', 'pending_owned'] } }
    : {
        'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
        'agentEventActorSuspension.resumeAttemptId': claimedResumeAttemptId,
      };
}

/** No lifecycle other than settled receipts is open. */
export const NO_OPEN_RECONCILIATION: Query = {
  agentEventActorReconciliations: {
    $not: { $elemMatch: { status: { $ne: 'settled' } } },
  },
};

/** How a recorded reconciliation relates to the stored lifecycle of the same invocation. */
export interface ReconciliationTransition {
  /** The pending record only gains its action admission. */
  confirmsActionAdmission: boolean;
  /** The recorded state may replace the stored one. */
  canTransition: boolean;
  /** The recorded state is the stored one (an idempotent receipt). */
  sameIdentity: boolean;
}

/** The transition rules of the reconciliation lifecycle. */
export function reconciliationTransition(
  current: IAgentEventActorReconciliation,
  next: IAgentEventActorReconciliation,
): ReconciliationTransition {
  const sameCheckpointAndAction =
    current.checkpoint.threadId === next.checkpoint.threadId &&
    current.checkpoint.checkpointId === next.checkpoint.checkpointId &&
    current.checkpoint.checkpointNs === next.checkpoint.checkpointNs &&
    current.action.toolName === next.action.toolName &&
    current.action.toolCallId === next.action.toolCallId;
  const confirmsActionAdmission =
    current.status === 'invocation_pending' &&
    current.actionAdmitted !== true &&
    next.status === 'invocation_pending' &&
    next.actionAdmitted === true &&
    sameCheckpointAndAction;
  const canTransition =
    confirmsActionAdmission ||
    (current.status === 'invocation_pending' && next.status !== 'invocation_pending') ||
    (current.status === 'persistence_pending' &&
      (next.status === 'persistence_failed' || next.status === 'history_persisted')) ||
    (current.status === 'persistence_failed' && next.status === 'history_persisted');
  const sameIdentity =
    current.status === next.status &&
    current.actionAdmitted === next.actionAdmitted &&
    sameCheckpointAndAction;
  return { confirmsActionAdmission, canTransition, sameIdentity };
}

/** The element a transition replaces: the stored state, exactly when admission is confirmed. */
export function reconciliationTransitionElement(
  current: IAgentEventActorReconciliation,
  confirmsActionAdmission: boolean,
): Query {
  return {
    invocationId: current.invocationId,
    status: current.status,
    ...(confirmsActionAdmission && {
      actionAdmitted: { $ne: true },
      'checkpoint.threadId': current.checkpoint.threadId,
      'checkpoint.checkpointNs': current.checkpoint.checkpointNs,
      ...(current.checkpoint.checkpointId == null
        ? { 'checkpoint.checkpointId': { $exists: false } }
        : { 'checkpoint.checkpointId': current.checkpoint.checkpointId }),
      'action.toolName': current.action.toolName,
      ...(current.action.toolCallId == null
        ? { 'action.toolCallId': { $exists: false } }
        : { 'action.toolCallId': current.action.toolCallId }),
    }),
  };
}

/** The lifecycle element `resolveAgentEventActorReconciliation` acts on. */
export function resolvableReconciliationElement(input: {
  invocationId: string;
  checkpoint: IAgentEventActorReconciliation['checkpoint'];
  expectedActionAdmitted?: boolean;
  resolution: 'action_compensated' | 'history_repaired' | 'invocation_abandoned';
}): Query {
  let expectedAdmissionFilter: Query = {};
  if (input.expectedActionAdmitted != null) {
    expectedAdmissionFilter = input.expectedActionAdmitted
      ? { actionAdmitted: true }
      : { actionAdmitted: { $ne: true } };
  }
  return {
    ...exactReconciliationCheckpoint(input.invocationId, input.checkpoint),
    ...(input.resolution === 'invocation_abandoned'
      ? {
          status: 'invocation_pending',
          ...expectedAdmissionFilter,
        }
      : { status: { $in: [...UNSETTLED_REPLAY_STATUSES] } }),
  };
}

/** The lifecycle element `clearAgentEventActorReconciliation` pulls: active, or its own receipt. */
export function clearableReconciliationElement(input: {
  invocationId: string;
  checkpoint: IAgentEventActorReconciliation['checkpoint'];
  resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
}): Query {
  const activeStatuses =
    input.resolution === 'checkpoint_verified'
      ? ['history_persisted']
      : [...UNSETTLED_REPLAY_STATUSES];
  return {
    ...exactReconciliationCheckpoint(input.invocationId, input.checkpoint),
    $or: [{ status: { $in: activeStatuses } }, { status: 'settled', resolution: input.resolution }],
  };
}

/** The head conditions of a verification: the head sits on the verified checkpoint. */
export function headOnCheckpointFilter(
  checkpoint: IAgentEventActorReconciliation['checkpoint'],
): Query {
  return {
    'agentEventActor.checkpoint.threadId': checkpoint.threadId,
    'agentEventActor.checkpoint.checkpointId': checkpoint.checkpointId,
    'agentEventActor.checkpoint.checkpointNs': checkpoint.checkpointNs,
  };
}

/** Whether a verification names a checkpoint at all (one without an id cannot be verified). */
export function isVerifiableCheckpoint(
  resolution: string,
  checkpoint: IAgentEventActorReconciliation['checkpoint'],
): boolean {
  return !(
    resolution === 'checkpoint_verified' &&
    (typeof checkpoint.checkpointId !== 'string' || checkpoint.checkpointId.length === 0)
  );
}

/** The settled receipts of a page of candidates older than `cutoff`, by conversation. */
export function expiredLegacyReceiptIds(
  candidates: Array<Pick<IConversation, 'agentEventActorReconciliations'>>,
  cutoff: Date,
): string[] {
  return [
    ...new Set(
      candidates.flatMap((candidate) =>
        (candidate.agentEventActorReconciliations ?? [])
          .filter((receipt) => receipt.status === 'settled' && receipt.observedAt <= cutoff)
          .map((receipt) => receipt.invocationId),
      ),
    ),
  ];
}

/** The receipts of one candidate the sweep removes: expired and not protected by a delivery. */
export function removableLegacyReceiptIds(
  candidate: Pick<IConversation, 'agentEventActorReconciliations'>,
  cutoff: Date,
  protectedInvocationIds: ReadonlySet<string>,
): string[] {
  return (candidate.agentEventActorReconciliations ?? [])
    .filter(
      (receipt) =>
        receipt.status === 'settled' &&
        receipt.observedAt <= cutoff &&
        !protectedInvocationIds.has(receipt.invocationId),
    )
    .map((receipt) => receipt.invocationId);
}

/** The pull removing `removable` settled receipts older than `cutoff`. */
export function legacyReceiptPull(removable: string[], cutoff: Date): Query {
  return {
    $pull: {
      agentEventActorReconciliations: {
        invocationId: { $in: removable },
        status: 'settled',
        observedAt: { $lte: cutoff },
      },
    },
  };
}

/** The deliveries whose receipts stay: not handled yet, or handling started. */
export function protectingDeliveryFilter(invocationIds: string[]): Query {
  return {
    deliveryKey: { $in: invocationIds },
    $or: [{ handling: { $exists: false } }, { 'handling.status': 'started' }],
  };
}

/** The legacy receipt sweep's page size. */
export function legacyReceiptExpiryLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit), LEGACY_RECEIPT_EXPIRY_MAX_LIMIT));
}

/* ---------------------------------------------------------------------------------- lane git */

export interface LaneGitWorkspace {
  environmentId: string;
  workspaceId: string;
  required?: boolean;
  epoch?: number;
}

/** The fences a lane report must pass: a lower stored sequence, and the workspace and epoch. */
export function laneGitFences(seq: number, workspace?: LaneGitWorkspace): Query[] {
  const epochFence =
    workspace?.epoch == null
      ? []
      : [
          {
            codeAttachmentEpoch: workspace.epoch === 0 ? { $in: [null, 0] } : workspace.epoch,
          },
        ];
  const workspaceFence =
    workspace == null
      ? []
      : [
          ...epochFence,
          {
            $or: [
              {
                codeWorkspaces: {
                  $elemMatch: {
                    environmentId: workspace.environmentId,
                    workspaceId: workspace.workspaceId,
                  },
                },
              },
              ...(workspace.required === true
                ? []
                : [
                    {
                      codeEnvironmentMode: { $ne: 'without_attached' },
                      $or: [
                        { codeWorkspaces: { $exists: false } },
                        { codeWorkspaces: null },
                        { codeWorkspaces: { $size: 0 } },
                      ],
                    },
                  ]),
            ],
          },
        ];
  return [
    {
      $or: [
        { 'laneGit.seq': { $exists: false } },
        { 'laneGit.seq': null },
        { 'laneGit.seq': { $lt: seq } },
      ],
    },
    ...workspaceFence,
  ];
}

/** The lane state a report replaces the stored one with. */
export function laneGitReport(input: {
  laneGit: Pick<NonNullable<IConversation['laneGit']>, 'branch' | 'head'>;
  repo?: string;
  pullRequest?: number;
  seq: number;
}): NonNullable<IConversation['laneGit']> {
  return {
    branch: input.laneGit.branch,
    head: input.laneGit.head,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.pullRequest != null ? { pullRequest: input.pullRequest } : {}),
    seq: input.seq,
  };
}

/** The stored lane the report continues (same branch and repository), keeping its pull request. */
export function sameLaneFilter(
  laneGit: Pick<NonNullable<IConversation['laneGit']>, 'branch'>,
  repo?: string,
): Query {
  return { 'laneGit.branch': laneGit.branch, 'laneGit.repo': repo || null };
}

/** How many times the two-step lane write is retried when a concurrent write moved the lane. */
export const LANE_GIT_WRITE_ATTEMPTS = 2;

/* ---------------------------------------------------------------------- the sidebar listing */

/** The options of `getConvosByCursor`. */
export interface ConvoListOptions {
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
}

/**
 * `.limit(0)` is "no limit" to MongoDB and a negative one caps to a single batch, so an
 * unclamped page size hands the caller the whole collection rather than a page of it.
 */
export function convoPageSize(limit: number): number {
  return Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), MAX_CONVO_PAGE_SIZE)
    : DEFAULT_CONVO_PAGE_SIZE;
}

/** The facet filters of a page that need no other collection, in the order they apply. */
export function convoListFacetFilters(user: string, options: ConvoListOptions): Query[] {
  const {
    isArchived = false,
    pinned = false,
    tags,
    projectId,
    updatedAfter,
    createdAfter,
  } = options;
  const filters: Query[] = [{ user }];
  if (isArchived) {
    filters.push({ isArchived: true });
  } else {
    filters.push({ $or: [{ isArchived: false }, { isArchived: { $exists: false } }] });
  }
  if (pinned) {
    filters.push({ pinned: true });
  }
  if (Array.isArray(tags) && tags.length > 0) {
    filters.push({ tags: { $in: tags } });
  }
  if (projectId === 'unassigned') {
    filters.push({ $or: [{ chatProjectId: null }, { chatProjectId: { $exists: false } }] });
  } else if (projectId) {
    filters.push({ chatProjectId: projectId });
  }
  /* Ranges are half-open on purpose: the caller sends the start of the window it
     means, and "since midnight" must not depend on how the clock rounds. */
  if (updatedAfter instanceof Date && !Number.isNaN(updatedAfter.getTime())) {
    filters.push({ updatedAt: { $gte: updatedAfter } });
  }
  if (createdAfter instanceof Date && !Number.isNaN(createdAfter.getTime())) {
    filters.push({ createdAt: { $gte: createdAfter } });
  }
  if (Array.isArray(options.endpoints) && options.endpoints.length > 0) {
    filters.push({ endpoint: { $in: options.endpoints } });
  }
  return filters;
}

/**
 * Attachments are not one field: the standard flow rides them on messages, imports can land
 * them on the conversation, and `files` is absent or `[]` when empty. The conversation-side
 * predicate alone would miss every ordinary chat with an upload, so the message-side
 * conversation IDs are OR-matched in.
 */
export function convoFilesFacetFilter(messageFileIds: string[] | null): Query {
  const orClauses: Query[] = [{ files: { $exists: true, $not: { $size: 0 } } }];
  if (messageFileIds != null && messageFileIds.length > 0) {
    orClauses.push({ conversationId: { $in: messageFileIds } });
  }
  return { $or: orClauses };
}

/**
 * Conversations with a file on any of this user's messages. A message holds files in three
 * places: uploads on `files`, tool and assistant output on `attachments` (a stored file, or a
 * download-only one the client renders by its `filepath`), and content parts in every shape
 * replay reads (a steer's `files`, a provider-native `file` or `image_file`, or a bare
 * `file_id`).
 */
export function messageFileFilter(user: string): Query {
  return {
    user,
    $or: [
      { 'files.0': { $exists: true } },
      { 'attachments.file_id': { $type: 'string' } },
      { 'attachments.filepath': { $type: 'string', $gt: '' } },
      { 'content.files.0': { $exists: true } },
      { 'content.file.file_id': { $type: 'string' } },
      { 'content.image_file.file_id': { $type: 'string' } },
      { 'content.file_id': { $type: 'string' } },
    ],
  };
}

/** Whether the deployment serves shared links (`ALLOW_SHARED_LINKS` unset or `true`). */
export function sharedLinksAllowed(): boolean {
  const allowSharedLinks = process.env.ALLOW_SHARED_LINKS;
  return allowSharedLinks === undefined || allowSharedLinks.toLowerCase().trim() === 'true';
}

/** The search parameters of the title and message search a page filters on. */
export function convoSearchParams(user: string): {
  filter: string;
  limit: number;
  attributesToRetrieve: string[];
} {
  return {
    filter: `user = "${escapeMeiliFilterValue(user)}"`,
    limit: MEILI_SEARCH_LIMIT,
    attributesToRetrieve: ['conversationId', 'originalConversationId'],
  };
}

/** The conversation ids of search hits, deduplicated. */
export function searchHitConversationIds(
  ...hitLists: ReadonlyArray<ReadonlyArray<unknown>>
): string[] {
  const matchingIds = new Set<string>();
  for (const hits of hitLists) {
    for (const hit of hits) {
      const conversationId = (hit as { conversationId?: unknown } | null)?.conversationId;
      if (typeof conversationId === 'string') {
        matchingIds.add(conversationId);
      }
    }
  }
  return [...matchingIds];
}

const VALID_SORT_FIELDS = ['title', 'createdAt', 'updatedAt', 'archivedAt'];

/** The sort of a page: the field, its secondary key and the direction. */
export interface ConvoListOrder {
  sortBy: string;
  direction: 'asc' | 'desc';
  secondaryField: 'createdAt' | 'updatedAt';
  /** `title` and `archivedAt` are absent on plenty of rows. */
  nullable: boolean;
}

/** The sort a page asks for; throws on a field outside the list. */
export function convoListOrder(sortBy: string, sortDirection: string): ConvoListOrder {
  if (!VALID_SORT_FIELDS.includes(sortBy)) {
    throw new Error(
      `Invalid sortBy field: ${sortBy}. Must be one of ${VALID_SORT_FIELDS.join(', ')}`,
    );
  }
  return {
    sortBy,
    direction: sortDirection === 'asc' ? 'asc' : 'desc',
    /* The archive view renders `archivedAt ?? createdAt`, so the legacy group, which shares a
       missing `archivedAt`, has to be ordered by the same `createdAt` the cell shows rather than
       by last activity, or its dates read out of order. */
    secondaryField: sortBy === 'archivedAt' ? 'createdAt' : 'updatedAt',
    /* `title` and `archivedAt` are both absent on plenty of rows, and BSON orders a missing
       field before every string and every date alike. The paging clauses therefore treat them
       the same way; `createdAt`/`updatedAt` are always present. */
    nullable: sortBy === 'title' || sortBy === 'archivedAt',
  };
}

/** The sort keys of a page: the field, its secondary key, then `_id`. */
export function convoListSort(order: ConvoListOrder): Record<string, 1 | -1> {
  const sortOrder = order.direction === 'asc' ? 1 : -1;
  const sort: Record<string, 1 | -1> = { [order.sortBy]: sortOrder };
  if (order.sortBy !== order.secondaryField) {
    sort[order.secondaryField] = sortOrder;
  }
  sort._id = sortOrder;
  return sort;
}

/**
 * The filter of the rows after a page cursor, or `null` when the cursor cannot be decoded (the
 * page then starts from the beginning). `toId` turns a valid 24-hex id into the backend's id.
 */
export function convoCursorFilter(
  cursor: string,
  order: ConvoListOrder,
  toId: (hex: string) => unknown,
  isValidId: (value: string) => boolean,
): Query | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
    const { primary, secondary, id } = decoded;
    const { sortBy, secondaryField } = order;
    const secondaryValue = new Date(secondary);
    const descending = order.direction !== 'asc';
    const op = descending ? '$lt' : '$gt';
    const sortsBySecondary = sortBy === secondaryField;
    const boundaryId = typeof id === 'string' && isValidId(id) ? { [op]: toId(id) } : null;

    /* One clause per sort level, so the page boundary is exact. Titles and timestamps both
       repeat; `_id` is the only field guaranteed to break the tie, and without that last clause
       every row sharing the boundary's (sort field, updatedAt) pair is skipped instead of
       returned. */
    const clauses: Query[] = [];

    /* A title or an archive stamp can be absent, and BSON orders a missing field before every
       string and date while `$lt`/`$gt` never cross that type boundary. Those rows therefore
       need clauses of their own: their own tail when the boundary is one of them, and the whole
       group when a descending page runs past the last non-null value. */
    if (primary == null) {
      clauses.push({ [sortBy]: null, [secondaryField]: { [op]: secondaryValue } });
      if (boundaryId) {
        clauses.push({
          [sortBy]: null,
          [secondaryField]: secondaryValue,
          _id: boundaryId,
        });
      }
      if (!descending) {
        clauses.push({ [sortBy]: { $ne: null } });
      }
    } else {
      const primaryValue = sortBy === 'title' ? primary : new Date(primary);
      clauses.push({ [sortBy]: { [op]: primaryValue } });
      if (!sortsBySecondary) {
        clauses.push({
          [sortBy]: primaryValue,
          [secondaryField]: { [op]: secondaryValue },
        });
      }
      if (boundaryId) {
        clauses.push({
          [sortBy]: primaryValue,
          ...(sortsBySecondary ? {} : { [secondaryField]: secondaryValue }),
          _id: boundaryId,
        });
      }
      if (descending && order.nullable) {
        clauses.push({ [sortBy]: null });
      }
    }
    return { $or: clauses };
  } catch {
    return null;
  }
}

/** The cursor of the page after `lastReturned`. */
export function nextConvoCursor(lastReturned: IConversation, order: ConvoListOrder): string {
  const sortValues: Record<string, string | Date | null | undefined> = {
    title: lastReturned.title,
    createdAt: lastReturned.createdAt,
    updatedAt: lastReturned.updatedAt,
    archivedAt: lastReturned.archivedAt,
  };
  const primaryValue = sortValues[order.sortBy];

  /* A null primary is what tells the next page it is inside the missing-value group, so an
     absent stamp has to survive as null rather than collapse to the epoch, which would page
     from 1970 and replay the whole archive. */
  let primaryStr: string | null = null;
  if (order.sortBy === 'title') {
    primaryStr = typeof primaryValue === 'string' ? primaryValue : null;
  } else if (primaryValue != null) {
    primaryStr = new Date(primaryValue).toISOString();
  }
  const secondaryValueOut =
    order.secondaryField === 'createdAt' ? lastReturned.createdAt : lastReturned.updatedAt;
  const secondaryStr = new Date(secondaryValueOut ?? 0).toISOString();
  const composite = {
    primary: primaryStr,
    secondary: secondaryStr,
    id: String(lastReturned._id),
  };
  return Buffer.from(JSON.stringify(composite)).toString('base64');
}

/**
 * One page of `getConvosQueried` from every listed conversation: newest `updatedAt` first, the
 * rows strictly older than the date cursor, and the next cursor the last row's `updatedAt`.
 */
export function queriedConvoPage(
  results: IConversation[],
  cursor: string | null,
  limit: number,
): { conversations: IConversation[]; nextCursor: string | null } {
  results.sort(
    (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
  );

  let filtered = results;
  if (cursor && cursor !== 'start') {
    const cursorDate = new Date(cursor);
    filtered = results.filter((convo) => new Date(convo.updatedAt ?? 0) < cursorDate);
  }

  const limited = filtered.slice(0, limit + 1);
  let nextCursor: string | null = null;
  if (limited.length > limit) {
    limited.pop();
    nextCursor = (limited[limited.length - 1].updatedAt as Date).toISOString();
  }
  return { conversations: limited, nextCursor };
}

/* ------------------------------------------------------------------------- the reply stamp */

/** The compare-and-set filter of a reply stamp over the read `current` state. */
export function replyStampCasFilter(
  replyFilter: Query,
  current: Pick<IConversation, 'lastResponseAt' | 'updatedAt'>,
): Query {
  const previous = current.lastResponseAt;
  return previous == null
    ? {
        ...replyFilter,
        updatedAt: current.updatedAt ?? null,
        $or: [{ lastResponseAt: null }, { lastResponseAt: { $exists: false } }],
      }
    : { ...replyFilter, lastResponseAt: previous, updatedAt: current.updatedAt ?? null };
}

/** The stamp a reply takes: past the stored stamp and the latest activity. */
export function replyStampOf(current: Pick<IConversation, 'lastResponseAt' | 'updatedAt'>): Date {
  const previous = current.lastResponseAt;
  const latestActivity =
    current.updatedAt && (!previous || current.updatedAt > previous) ? current.updatedAt : previous;
  return nextMonotonicStamp(latestActivity);
}

/** The update a reply stamp writes. */
export function replyStampUpdate(stamp: Date, responseMessageId: string): Query {
  return {
    $set: {
      lastResponseAt: stamp,
      lastResponseMessageId: responseMessageId,
      isMarkedUnread: false,
      lastSeenAt: new Date(UNSEEN_REPLY_WATERMARK),
    },
    $unset: { lastResponseIsManual: '' },
    $max: { updatedAt: stamp },
  };
}

/* -------------------------------------------------------------------------- the saveConvo write */

/** The filter of a {@link ConvoWrite}: the owner's conversation and its `when` conditions. */
export function convoWriteFilter(input: ConvoWrite): Query {
  const { user, conversationId, when, upsert } = input;
  if (upsert && when != null && Object.keys(when).length > 0) {
    throw new Error('[writeConvo] `upsert` cannot be combined with `when`');
  }
  const filter: Query = { conversationId, user };
  if (when?.isArchived === true) {
    filter.isArchived = true;
  } else if (when?.isArchived === false) {
    filter.isArchived = { $ne: true };
  }
  if (when?.titleSetByUser === false) {
    filter.titleSetByUser = { $ne: true };
  }
  if (when?.titleIn != null) {
    filter.title = { $in: when.titleIn };
  }
  return filter;
}

/** The update of a {@link ConvoWrite}. */
export function convoWriteOperation(input: ConvoWrite): Query {
  const operation: Query = { $set: input.set };
  if (input.unset != null && input.unset.length > 0) {
    operation.$unset = Object.fromEntries(input.unset.map((field) => [field, '']));
  }
  if (input.setOnInsert != null && Object.keys(input.setOnInsert).length > 0) {
    operation.$setOnInsert = input.setOnInsert;
  }
  if (input.increment?.titleRevision != null) {
    operation.$inc = { titleRevision: input.increment.titleRevision };
  }
  if (input.max?.lastResponseAt instanceof Date) {
    operation.$max = { lastResponseAt: input.max.lastResponseAt };
  }
  if (input.appendMessageIds != null && input.appendMessageIds.length > 0) {
    operation.$addToSet = { messages: { $each: input.appendMessageIds } };
  }
  return operation;
}

/** A code-environment decision is seeded only while none is held. */
export function undecidedCodeEnvironmentFilter(conversationId: string, user: string): Query {
  return {
    conversationId,
    user,
    codeEnvironmentMode: { $in: [null] },
    $or: [{ codeWorkspaces: { $in: [null] } }, { codeWorkspaces: { $size: 0 } }],
  };
}

/** The deadline is set only while unset and while the stored chat type matches. */
export function unsetExpiryFilter(input: {
  user: string;
  conversationId: string;
  isTemporary: boolean;
}): Query {
  return {
    conversationId: input.conversationId,
    user: input.user,
    expiredAt: null,
    isTemporary: input.isTemporary ? true : { $ne: true },
  };
}

/** The filter and update of the code-environment compare-and-swap. */
export function codeEnvironmentReplacement(input: {
  user: string;
  conversationId: string;
  expected: Pick<
    IConversation,
    'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
  >;
  codeEnvironmentMode: 'attached' | 'without_attached';
  codeWorkspaces?: IConversation['codeWorkspaces'];
}): { filter: Query; update: Query } {
  const { expected, codeEnvironmentMode, codeWorkspaces } = input;
  return {
    filter: {
      conversationId: input.conversationId,
      user: input.user,
      codeEnvironmentMode: expected.codeEnvironmentMode ?? { $in: [null] },
      codeWorkspaces: expected.codeWorkspaces ?? { $in: [null] },
      codeEnvironmentRevision: expected.codeEnvironmentRevision ?? { $in: [null] },
    },
    /** The reported lane belongs to the workspace being replaced, so it goes with it. */
    update:
      codeEnvironmentMode === 'attached'
        ? {
            $set: { codeEnvironmentMode, codeWorkspaces },
            $unset: { laneGit: 1 },
            $inc: { codeEnvironmentRevision: 1, codeAttachmentEpoch: 1 },
          }
        : {
            $set: { codeEnvironmentMode },
            $unset: { codeWorkspaces: 1, laneGit: 1 },
            $inc: { codeEnvironmentRevision: 1, codeAttachmentEpoch: 1 },
          },
  };
}

/** The distinct, non-empty tool names an approval write may add, or `null` when it may not. */
export function toolApprovalAllowNames(toolNames: string[], max: number): string[] | null {
  const names = [...new Set(toolNames.filter((name) => typeof name === 'string' && name))];
  return names.length === 0 || names.length > max ? null : names;
}

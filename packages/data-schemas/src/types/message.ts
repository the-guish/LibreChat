import type {
  TFeedbackRating,
  TFeedbackTag,
  TReasoningOverride,
  UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';
import type { IAgentEventActorContextMeta } from './convo';

export type SubagentTaskControlAction =
  | 'steer'
  | 'queue'
  | 'interrupt'
  | 'cancel'
  | 'cancel_message';

export type SubagentTaskControlReceiptStatus =
  | 'reserved'
  | 'accepted'
  | 'applied'
  | 'rejected'
  | 'failed';

export type SubagentTriggerProjection = {
  version: 1;
  eventType: string;
  sourceType: string;
  occurredAt: Date;
  expectedActionToolName?: string;
};

/** Server-private durable receipt for one parent-to-child control invocation. */
export interface ISubagentTaskControlReceipt {
  invocationId: string;
  fingerprint: string;
  controlId?: string;
  action: SubagentTaskControlAction;
  status: SubagentTaskControlReceiptStatus;
  createdAt: Date;
  updatedAt: Date;
  boundary?: 'preempt' | 'tool' | 'turn';
  reason?: string;
  message?: string;
  messageTruncated?: boolean;
}

// @ts-ignore
export interface IMessage extends Document {
  /** Public content capture version and expected terminal watermark; never a transcript. */
  subagentContent?: { version: 1; throughSequence?: number; deleted?: boolean };
  messageId: string;
  conversationId: string;
  user: string;
  model?: string;
  endpoint?: string;
  conversationSignature?: string;
  clientId?: string;
  invocationId?: number;
  parentMessageId?: string | null;
  tokenCount?: number;
  summaryTokenCount?: number;
  sender?: string;
  text?: string;
  summary?: string;
  /** Authenticated ciphertext, available only through the owner-view read. */
  privateText?: string;
  privacyRevision?: string;
  privateTextTokens?: string[];
  isCreatedByUser: boolean;
  /** True when the complete stored row came from outside the model. */
  isUserSubmitted?: boolean;
  /** JSON pointers to caller-authored fields in an otherwise mixed model response. */
  userSubmittedPaths?: string[];
  /** Exact HITL message fields stored at caller-authored paths in a mixed response. */
  userSubmittedMessageFieldPaths?: UserSubmittedMessageFieldPath[];
  isTemporary?: boolean;
  unfinished?: boolean;
  error?: boolean;
  finish_reason?: string;
  feedback?: {
    rating: TFeedbackRating;
    tag: TFeedbackTag | undefined;
    text?: string;
  };
  langfuseSampled?: boolean;
  langfuseDestinationIds?: string[];
  /** The run whose trace this response reports, when that run's id is not the message's own (a failed turn's error row). */
  langfuseRunId?: string;
  _meiliIndex?: boolean;
  files?: unknown[];
  plugin?: {
    latest?: string;
    inputs?: unknown[];
    outputs?: string;
  };
  plugins?: unknown[];
  content?: unknown[];
  thread_id?: string;
  iconURL?: string;
  addedConvo?: boolean;
  metadata?: Record<string, unknown>;
  /** Server-private canonical message delta for durable subagent-thread continuation. */
  subagentTranscript?: {
    taskId: string;
    mode: 'append' | 'replace';
    messagesJson: string;
  };
  /** Server-private bounded rendering projection derived once at child settlement. */
  subagentActivityProjection?: {
    taskId: string;
    version: 1 | 2;
    activityJson: string;
    truncated: boolean;
  };
  /** Server-private durable idempotency marker for one detached subagent turn. */
  subagentTask?: {
    attemptKey: string;
    /** Parent response that initiated this exact child task. */
    parentRunId?: string;
    requestFingerprint?: string;
    status: 'running' | 'completed' | 'error' | 'cancelled';
    resultClaim?: {
      kind: 'manual' | 'wakeup';
      claimId: string;
      claimedAt: Date;
      /** Response generation that owns a manual delivery claim. */
      generationId?: string;
    };
    controlReceipts?: ISubagentTaskControlReceipt[];
  };
  subagentTriggerProjection?: SubagentTriggerProjection;
  contextMeta?: Partial<IAgentEventActorContextMeta>;
  attachments?: unknown[];
  /** Skills the user invoked manually via the `$` popover on this turn. UI-only metadata for `SkillPills`. */
  manualSkills?: string[];
  /**
   * Skills auto-primed on this turn via `always-apply` frontmatter. Persisted
   * at turn time so pinned badges survive later flips of the skill's
   * `alwaysApply` flag — the audit trail follows what actually ran, not what
   * the current catalog says.
   */
  alwaysAppliedSkills?: string[];
  /** Verbatim excerpts the user quoted to reference on this turn. UI-only metadata for `MessageQuotes`. */
  quotes?: string[];
  /** Request-scoped reasoning selection that produced this user turn. */
  reasoningOverride?: TReasoningOverride;
  expiredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

/*
 * Record types of the message methods (`~/methods/message`) and the message store port
 * (`~/ports/message`). Declared here so the port need not import the methods file; the methods
 * file re-exports them under the same names.
 */

/** The outcome of `claimSubagentTaskResult`. */
export type SubagentTaskResultClaim =
  | { status: 'not_found' }
  | { status: 'claimed'; message: IMessage }
  | { status: 'acquired'; message: IMessage };

export interface BackgroundToolResultRecord {
  taskId: string;
  toolCallId: string;
  toolName: string;
  status: 'completed' | 'error' | 'cancelled';
  output: string;
  agentId?: string;
  /** When the task reached this terminal status. Absent on rows written before
   * the stamp existed, so a consumer must treat it as optional. */
  settledAt?: Date;
}

/** The outcome of `claimBackgroundToolResults`. */
export type BackgroundToolResultClaim =
  | { status: 'not_found' | 'not_ready' }
  | { status: 'outcome_unknown'; toolName: string }
  | {
      status: 'claimed';
      claim?: {
        kind: 'manual' | 'wakeup';
        claimId: string;
        generationId?: string;
        batchId?: string;
        receiptReconciled?: true;
      };
      messageId?: string;
    }
  | { status: 'acquired'; results: BackgroundToolResultRecord[]; messageId?: string };

/** One message of the bounded public child-thread projection (`getMessagesForSubagentThreadView`). */
export type SubagentThreadViewMessageRecord = Pick<
  IMessage,
  | 'messageId'
  | 'parentMessageId'
  | 'isCreatedByUser'
  | 'text'
  | 'createdAt'
  | 'error'
  | 'unfinished'
  | 'subagentTranscript'
  | 'subagentTriggerProjection'
> & {
  textProjectionTruncated?: boolean;
  contentRecoveryAvailable?: boolean;
  subagentTranscriptProjectionTruncated?: boolean;
  /** Storage-bounded visible content; validated into the public activity type by the API. */
  subagentActivity?: unknown[];
  subagentActivityProjectionJson?: string;
  subagentActivityProjectionTruncated?: boolean;
  /** Storage-bounded task state; private replay and execution fields never cross this seam. */
  subagentTask?: {
    status?: NonNullable<IMessage['subagentTask']>['status'];
    controlReceipts?: Array<
      Omit<ISubagentTaskControlReceipt, 'fingerprint'> & { fingerprint?: never }
    >;
    controlReceiptsProjectionTruncated?: boolean;
  };
};

/** The newest task outcomes of one child thread (`listSubagentTasksForThreads`). */
export type ParentSubagentTaskRecord = {
  conversationId: string;
  /** The shared bounded source window filled, so this child's history may be incomplete. */
  sourceTruncated?: boolean;
  tasks: Array<
    Pick<IMessage, 'messageId' | 'createdAt'> & {
      status: NonNullable<IMessage['subagentTask']>['status'];
      /** True when status was inferred from an ordinary event-turn row. */
      statusDerived?: boolean;
      /** Private ordering token used only while merging bounded storage reads. */
      occurrenceId?: Types.ObjectId;
    }
  >;
};

/** A response message whose run was sampled into a trace. */
export interface SampledTraceMessage {
  messageId: string;
  createdAt?: Date;
  /** Opaque ids of the tracing destinations eligible to hold the trace, when recorded. */
  langfuseDestinationIds?: string[];
  /** The run whose trace this response reports, when it is not the message's own id. */
  langfuseRunId?: string;
  /** Opaque position in the conversation's response order, which a later read can resume from. */
  orderKey?: string;
}

export interface ConversationTraceRefs {
  /** Creation time of the user's earliest message in the conversation. */
  firstMessageAt?: Date;
  /** Sampled response messages, oldest first. */
  sampledMessages: SampledTraceMessage[];
}

/** The private original of a user message's text, written with `saveMessage`. */
export interface PrivateTextWrite {
  readonly envelope: string;
  readonly revision: string;
}

/** A user message's stored private text (`getPrivateMessageTexts`). */
export interface PrivateTextRead {
  readonly _id?: unknown;
  readonly messageId: string;
  readonly text: string;
  readonly privacyRevision: string;
  readonly privateText: string;
}

/**
 * Message store port: the messages of conversations, with the durable state hung on them
 * (background tool results and their claims, subagent task results and control receipts, trace
 * sampling marks, the private originals of protected user text). Nothing here may import
 * `mongoose`. Signatures are those of `MessageMethods` (`~/methods/message`), copied verbatim
 * but for `listSubagentTasksForThreads`, whose records the port states without the MongoDB
 * ordering token (see {@link ParentSubagentTaskStoreRecord}); `message.spec.ts` fails the
 * typecheck if the MongoDB methods stop satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`). Methods
 *   that take an explicit `tenantId` also match it as given (no `tenantId` matches records
 *   stored without one).
 * - Every read and write is scoped to the user it names (`user` or `userId`); another user's
 *   message reads as absent.
 *
 * Not in this port, each because its signature takes raw MongoDB or search-engine input:
 * - `getMessages`: a `FilterQuery<IMessage>`, a projection string and sort/limit options;
 * - `getMessagesByCursor`: a `FilterQuery<IMessage>`, a projection string and a sort field;
 * - `deleteMessages`: a `FilterQuery<IMessage>`, and it resolves the driver's `DeleteResult`;
 * - `searchMessages`: MeiliSearch `SearchParams` (a filter in MeiliSearch's syntax), resolving
 *   MeiliSearch's `SearchResponse`, through the meilisearch plugin of the MongoDB model.
 * The conversation methods receive `getMessages`, `deleteMessages` and `searchMessages` as
 * dependencies (`ConversationMethodDeps`); those keep coming from the MongoDB methods.
 *
 * Known leaks kept for now so callers stay unchanged: `IMessage` extends mongoose's `Document`,
 * and the writes take partial `IMessage` records.
 */
import type {
  AppConfig,
  IMessage,
  ConversationTraceRefs,
  ParentSubagentTaskRecord,
  PrivateTextRead,
  PrivateTextWrite,
  SubagentTaskResultClaim,
  BackgroundToolResultClaim,
  SubagentThreadViewMessageRecord,
} from '~/types';
import { listPortMethods } from './common';

/**
 * {@link ParentSubagentTaskRecord} without `occurrenceId`, the MongoDB adapter's private
 * ordering token for merging its bounded reads. No caller reads it, so the port does not
 * promise it (the MongoDB adapter still returns it).
 */
export type ParentSubagentTaskStoreRecord = Omit<ParentSubagentTaskRecord, 'tasks'> & {
  tasks: Array<Omit<ParentSubagentTaskRecord['tasks'][number], 'occurrenceId'>>;
};

/** A receipt of one parent-to-child control invocation, as stored on the child's task input. */
type SubagentTaskControlReceipt = NonNullable<
  NonNullable<IMessage['subagentTask']>['controlReceipts']
>[number];

export interface MessageStore {
  /* ------------------------------------------------------- private text */

  /**
   * The id of the user's unexpired message whose stored text and privacy revision are exactly
   * the given ones and which holds a private original, or `null`. Also `null` for a missing
   * field, a conversation id that is not a UUID, or a `tenantId` other than the active tenant.
   */
  getPersistedPrivateTextId(
    input: Parameters<MessageStore['hasPersistedPrivateText']>[0],
  ): Promise<string | null>;
  /** Whether {@link MessageStore.getPersistedPrivateTextId} finds such a message. */
  hasPersistedPrivateText(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageId: string;
    privacyRevision: string;
    text: string;
  }): Promise<boolean>;
  /**
   * The private originals of the user's unexpired, user-authored messages among `messageIds`
   * (at most 50; more, or a conversation id that is not a UUID, throws). Empty when `tenantId`
   * is not the active tenant.
   */
  getPrivateMessageTexts(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageIds: readonly string[];
  }): Promise<PrivateTextRead[]>;

  /* ---------------------------------------------------------- writes */

  /**
   * Creates or updates the user's message `params.messageId` (renamed to `newMessageId` when
   * given; `metadata.insertOnly` only creates), applying the retention the context implies.
   * Resolves the stored message; `undefined` when the conversation id is not a UUID, or when a
   * concurrent create of the same id won and that message can no longer be read. Throws without
   * `userId`.
   */
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
   * Upserts each message by its `messageId` (and its `user`, when the record names one) for
   * imports, forks and copies, never storing private text; with `overrideTimestamp` the
   * records' own timestamps are kept. What it resolves is the store's own report.
   */
  bulkSaveMessages(
    messages: Array<Partial<IMessage>>,
    overrideTimestamp?: boolean,
    provenance?: { privateTextTokens: ReadonlyMap<string, readonly string[]> },
  ): Promise<unknown>;
  /**
   * Updates fields of the user's existing message `message.messageId` and resolves its
   * sanitized fields. Throws when there is no such message.
   */
  updateMessage(
    userId: string,
    message: Partial<IMessage> & { newMessageId?: string },
    metadata?: { context?: string },
  ): Promise<Partial<IMessage>>;

  /* --------------------------------------------- background tool results */

  /**
   * Patches one persisted tool call of a message in place with a result that settled after the
   * turn was saved, appending attachments; idempotent, so it can be re-applied. `matched:
   * false` when the message is not stored yet; `unfinished` when it is a mid-turn partial save.
   */
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
  /**
   * Atomically assigns a settled background tool result to one consumer (a manual poll or one
   * automatic wakeup); a wakeup also claims a bounded set of settled siblings of the same
   * response.
   */
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
  /** Commits a manual claim once receipt arbitration completed; whether it is committed. */
  confirmBackgroundToolResultClaim(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    taskId: string;
    claimId: string;
  }): Promise<boolean>;
  /** Releases exactly this consumer's claims so another consumer can claim the results. */
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

  /* ------------------------------------------------------ subagent tasks */

  /**
   * Atomically records one bounded parent-to-child control receipt on the child task's input;
   * terminal receipt states never regress.
   */
  recordSubagentTaskControlReceipt(input: {
    userId: string;
    conversationId: string;
    taskId: string;
    tenantId?: string;
    receipt: SubagentTaskControlReceipt;
  }): Promise<boolean | 'unchanged' | 'conflict'>;
  /** The receipt of one control invocation on the task, or `null`. */
  getSubagentTaskControlReceipt(input: {
    userId: string;
    conversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
    activeOnly?: boolean;
  }): Promise<SubagentTaskControlReceipt | null>;
  /**
   * The receipt of one control invocation with a summary of its task, read after the task's
   * live owner disappeared; the task's child thread must belong to `parentConversationId`.
   * `null` when there is no such receipt.
   */
  getSubagentTaskControlReplay(input: {
    userId: string;
    parentConversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
  }): Promise<{
    receipt: SubagentTaskControlReceipt;
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
  /** Atomically assigns a task's terminal result to one consumer (a manual poll or a wakeup). */
  claimSubagentTaskResult(params: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<SubagentTaskResultClaim>;
  /** Releases exactly this consumer's claim on the task's result; whether one was released. */
  releaseSubagentTaskResultClaim(params: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean>;
  /**
   * The bounded public projection of a child thread's messages: at most `limit`, newest first,
   * starting at `beforeMessageId` when given (empty when the thread has no such message), with
   * text cut to `textCodePointLimit` code points by the store. `selectedTaskId` is the task
   * whose own activity the caller reads separately.
   */
  getMessagesForSubagentThreadView(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    selectedTaskId?: string;
    beforeMessageId?: string;
    limit: number;
    textCodePointLimit: number;
  }): Promise<SubagentThreadViewMessageRecord[]>;
  /**
   * The newest task outcomes (at most `limitPerThread`) of each listed child thread, ordered by
   * conversation id; a thread with no tasks is left out.
   */
  listSubagentTasksForThreads(input: {
    user: string;
    conversationIds: string[];
    tenantId?: string;
    limitPerThread: number;
  }): Promise<ParentSubagentTaskStoreRecord[]>;

  /* ------------------------------------------------------------- traces */

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

  /* -------------------------------------------------------------- reads */

  /** The user's message `messageId`, or `null`. */
  getMessage(params: { user: string; messageId: string }): Promise<IMessage | null>;
  /**
   * The reasoning level a branch runs at: the override on the nearest user message at or above
   * `parentMessageId` that carries one, or `null` when none does.
   */
  getBranchReasoningOverride(params: {
    user: string;
    conversationId: string;
    parentMessageId: string;
  }): Promise<IMessage['reasoningOverride'] | null>;
}

/** Every method of {@link MessageStore}, for adapters and conformance checks. */
export const MESSAGE_STORE_METHODS: ReadonlyArray<keyof MessageStore> =
  listPortMethods<MessageStore>({
    getPersistedPrivateTextId: true,
    hasPersistedPrivateText: true,
    getPrivateMessageTexts: true,
    saveMessage: true,
    bulkSaveMessages: true,
    updateMessage: true,
    updateToolCallResult: true,
    claimBackgroundToolResults: true,
    confirmBackgroundToolResultClaim: true,
    releaseBackgroundToolResultClaims: true,
    recordSubagentTaskControlReceipt: true,
    getSubagentTaskControlReceipt: true,
    getSubagentTaskControlReplay: true,
    claimSubagentTaskResult: true,
    releaseSubagentTaskResultClaim: true,
    getMessagesForSubagentThreadView: true,
    listSubagentTasksForThreads: true,
    getConversationTraceRefs: true,
    hasSampledTraceMessage: true,
    getMessage: true,
    getBranchReasoningOverride: true,
  });

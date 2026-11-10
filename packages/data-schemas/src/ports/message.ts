/**
 * Message store port: the messages of conversations, with the durable state hung on them
 * (background tool results and their claims, subagent task results and control receipts, trace
 * sampling marks, the private originals of protected user text). Nothing here may import
 * `mongoose`. Signatures are those of `MessageMethods` (`~/methods/message`), copied verbatim
 * but for `listSubagentTasksForThreads`, whose records the port states without the MongoDB
 * ordering token (see {@link ParentSubagentTaskStoreRecord}), and for `getMessages` and
 * `deleteMessages`, whose criteria, projection and order the port states in the store query
 * language (`./query`) and whose delete report it states as {@link DeleteCount};
 * `message.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`). Methods
 *   that take an explicit `tenantId` also match it as given (no `tenantId` matches records
 *   stored without one).
 * - Every read and write is scoped to the user it names (`user` or `userId`); another user's
 *   message reads as absent. `getMessages` and `deleteMessages` are scoped by their filter
 *   instead: a filter without `user` matches every user's messages in the tenant.
 *
 * Projections are strings ({@link StoreProjectionString}). The one projection beyond the
 * language that callers pass is {@link CLIENT_MESSAGE_SELECT}, which also leaves out nested
 * server-only fields; it is named here so that any store recognizes it by value.
 *
 * Paging and search, in neutral form:
 * - `getMessagesPage` reads one page of a keyset-paged read; its cursor is opaque and
 *   store-defined (see {@link MessagePageOptions});
 * - `searchUserMessages` runs a full-text search over one user's messages. Each backend owns its
 *   search index (MeiliSearch today, fed by the MongoDB model's meilisearch plugin); the port
 *   states only the scope, the text and the size of a search, never the engine's parameters.
 *
 * Not in this port, each because its signature takes raw MongoDB or search-engine input (callers
 * are to move to the two methods above):
 * - `getMessagesByCursor`: a `FilterQuery<IMessage>`, and its options carry a projection string,
 *   a sort field and a cursor in the MongoDB adapter's own format (`<sortValue>|<ObjectId hex>`);
 *   `getMessagesPage` restates it;
 * - `searchMessages`: MeiliSearch `SearchParams` (a filter in MeiliSearch's syntax), resolving
 *   MeiliSearch's `SearchResponse`, through the meilisearch plugin of the MongoDB model;
 *   `searchUserMessages` restates the user-scoped search the messages route runs.
 * The conversation methods receive `getMessages`, `deleteMessages` and `searchMessages` as
 * dependencies (`ConversationMethodDeps`); the first two are typed against this port, and
 * `searchMessages` keeps the MongoDB method's type (it runs inside the MongoDB adapter, beside
 * the conversation title search on the same engine).
 *
 * Known leaks kept for now so callers stay unchanged: `IMessage` extends mongoose's `Document`,
 * and the writes take partial `IMessage` records. The MongoDB adapter's hydrated search reads
 * the stored fields by `messageId` alone (MeiliSearch's primary key), not by user and
 * `messageId`, so a hit can carry another user's stored fields when two users' messages share a
 * `messageId`; another store hydrates by user and `messageId`.
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
import type { StoreFilter, StoreProjectionString, StoreSort } from './query';
import type { DeleteCount } from './common';
import { listPortMethods } from './common';

/**
 * The projection of client-facing message reads: every field but the server-only ones (ids
 * and owner, private text and its tokens, trace sampling marks, context metadata) and the
 * server-only parts of nested records (thought signatures, background-task claim state, bulky
 * web-search attachment sections). Unlike the {@link StoreProjectionString}s of the language it
 * names nested paths, so a store recognizes this exact value rather than parsing it.
 */
export const CLIENT_MESSAGE_SELECT: string = [
  '-_id',
  '-__v',
  '-user',
  '-clientId',
  '-invocationId',
  '-conversationSignature',
  '-summary',
  '-summaryTokenCount',
  '-privateText',
  '-privateTextTokens',
  '-contextMeta',
  '-langfuseSampled',
  '-langfuseDestinationIds',
  '-langfuseRunId',
  '-metadata.thoughtSignatures',
  '-content.tool_call.backgroundTask.resultClaim',
  '-content.tool_call.backgroundTask.completionWakeup',
  '-attachments.web_search.knowledgeGraph',
  '-attachments.web_search.peopleAlsoAsk',
  '-attachments.web_search.relatedSearches',
  '-attachments.web_search.shopping',
  '-attachments.web_search.places',
  '-attachments.web_search.news',
  '-attachments.web_search.organic.sitelinks',
  '-attachments.web_search.organic.highlights',
  '-attachments.web_search.topStories.highlights',
].join(' ');

/**
 * Order and size of a {@link MessageStore.getMessages} read. `sort` defaults to `createdAt`
 * ascending; `sort: false` asks for no order at all (the store returns the matches in whatever
 * order it reads them, which spares a sort when the caller reorders or wants any one match).
 * A `limit` of `0` or less, or none, means no limit.
 */
export interface MessageStoreReadOptions {
  sort?: StoreSort | false;
  limit?: number;
}

/** The fields a {@link MessageStore.getMessagesPage} read can be ordered by. */
export type MessagePageSortField = 'createdAt' | 'updatedAt' | 'endpoint';

/**
 * One page of a keyset-paged {@link MessageStore.getMessagesPage} read.
 *
 * Rows are ordered by `sort.field` in `sort.order`, ties broken by the store's own record id in
 * the same direction, so the order is total and a page boundary inside a run of equal sort
 * values neither skips nor repeats rows. A missing or `null` sort value orders before every
 * other value.
 *
 * `after` is a cursor the same store returned as a page's `nextCursor`: the page starts strictly
 * after the row it names. Cursors are opaque and store-defined (the MongoDB adapter writes
 * `<sortValue>|<ObjectId hex>`); callers pass them back unchanged and never build or parse one.
 * A store also accepts a bare sort value as a cursor (the form older clients still send) and
 * then starts at the first row whose sort value comes strictly after it in the page's order.
 * `null` or absent starts at the first row.
 */
export interface MessagePageOptions {
  sort: { field: MessagePageSortField; order: 1 | -1 };
  /** The most rows on the page (positive). */
  limit: number;
  after?: string | null;
  /**
   * As in {@link MessageStore.getMessages} ({@link CLIENT_MESSAGE_SELECT} included). It must
   * keep `sort.field`: the MongoDB adapter builds the next cursor from the page's last row, so
   * an inclusion projection without the sort field yields cursors that skip or repeat rows.
   */
  select?: StoreProjectionString;
}

/** A page of messages and the cursor of the next one (`null` on the last page). */
export interface MessagePage {
  messages: IMessage[];
  nextCursor: string | null;
}

/** What {@link MessageStore.searchUserMessages} searches for. */
export interface MessageSearchInput {
  /** The user whose messages are searched; no other user's message is ever a hit. */
  user: string;
  /** The search text, matched the way the store's search index matches it. */
  text: string;
  /** The most hits returned (positive; callers cap it at `MEILI_SEARCH_LIMIT`). */
  limit: number;
  /** Also return each hit's stored fields (the default projection), not only the indexed ones. */
  hydrate?: boolean;
}

/**
 * One search hit: the indexed fields of a message (`messageId`, `conversationId`, `user`,
 * `sender`, `text`; MeiliSearch indexes a `conversationId` containing `|` with `--` in its
 * place), and with `hydrate` the message's stored fields under them (the indexed ones win).
 */
export interface MessageSearchHit {
  messageId: string;
  conversationId: string;
  [field: string]: unknown;
}

/** The hits of a {@link MessageStore.searchUserMessages} search, best match first. */
export interface MessageSearchResult {
  hits: MessageSearchHit[];
}

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

  /**
   * The messages matching `filter`, with the fields `select` selects (the default fields without
   * one; see {@link CLIENT_MESSAGE_SELECT} for the one projection beyond the language), ordered
   * and limited by `options` (`createdAt` ascending by default; see
   * {@link MessageStoreReadOptions}).
   */
  getMessages(
    filter: StoreFilter,
    select?: StoreProjectionString,
    options?: MessageStoreReadOptions,
  ): Promise<IMessage[]>;

  /**
   * One page of the messages matching `filter`, with the fields `select` selects, in the total
   * order and from the cursor {@link MessagePageOptions} describes. `nextCursor` is `null` when
   * no row follows the page.
   */
  getMessagesPage(filter: StoreFilter, options: MessagePageOptions): Promise<MessagePage>;

  /**
   * The user's messages that the store's search index matches for `text`, at most `limit`, best
   * match first. Scoped by `user` only: the index holds no tenant (user ids are unique across
   * tenants), while `hydrate` reads the stored fields the way other reads do (active tenant), so
   * a hit whose message is not readable there keeps its indexed fields only. Throws when the
   * store has no search index (MongoDB: MeiliSearch is not configured).
   */
  searchUserMessages(input: MessageSearchInput): Promise<MessageSearchResult>;

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

  /* ------------------------------------------------------------ deletes */

  /**
   * Deletes the messages matching `filter`, after the subagent content their subagent tasks
   * hold; resolves how many messages it removed.
   */
  deleteMessages(filter: StoreFilter): Promise<DeleteCount>;
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
    getMessages: true,
    getMessagesPage: true,
    searchUserMessages: true,
    getMessage: true,
    getBranchReasoningOverride: true,
    deleteMessages: true,
  });

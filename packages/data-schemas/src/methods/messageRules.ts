/**
 * The message store's database-neutral rules (`MessageStore`, `~/ports/message`), shared by every
 * backend: the MongoDB methods (`./message`) and the PostgreSQL store
 * (`adapters/postgres/stores/message.ts`). Provenance normalization and merging, the control
 * receipt retention, the save and import plans (retention, private text, provenance), the
 * tool-call settlement and the background-result claim protocol over a message's content, the
 * subagent task summaries, the trace references, the keyset page cursor and the thread view's
 * bounds. Filters and updates here are in MongoDB's query and update language, which both
 * backends accept. Nothing here may import `mongoose` or the MongoDB driver.
 */
import {
  backgroundResultMetadata,
  HITL_MESSAGE_FILTER_FIELDS,
  isForcedTemporaryRetention,
  RetentionMode,
} from 'librechat-data-provider';
import type { UserSubmittedMessageFieldPath } from 'librechat-data-provider';
import type {
  AppConfig,
  IMessage,
  PrivateTextWrite,
  ConversationTraceRefs,
  ParentSubagentTaskRecord,
  BackgroundToolResultClaim,
  BackgroundToolResultRecord,
  SubagentThreadViewMessageRecord,
} from '~/types';
import { createChatExpirationDate, createTempChatExpirationDate } from '~/utils/tempChatRetention';
import { createFallbackRetentionDate } from '~/utils/retention';
import { tenantStorage } from '~/config/tenantContext';
import logger from '~/config/winston';

/** Simple UUID v4 regex to replace zod validation */
export const UUID_REGEX: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STORED_USER_SUBMITTED_PATHS = 256;
const MAX_NORMALIZED_USER_SUBMITTED_PATHS = MAX_STORED_USER_SUBMITTED_PATHS + 1;
const MAX_STORED_USER_SUBMITTED_FIELD_PATHS = MAX_NORMALIZED_USER_SUBMITTED_PATHS;
const MAX_USER_SUBMITTED_PATH_LENGTH = 2048;
export const MAX_PROVENANCE_CAS_ATTEMPTS = 8;
const MAX_SUBAGENT_CONTROL_RECEIPTS = 64;
export const MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH: number = 4 * 1024;
/** One owner admits at most 64 terminal control invocations. The optimistic
 * writer therefore has enough rounds for every admitted receipt to converge. */
export const MAX_SUBAGENT_CONTROL_RECEIPT_CAS_ATTEMPTS = 64;
const HITL_MESSAGE_FILTER_FIELD_SET = new Set<string>(HITL_MESSAGE_FILTER_FIELDS);

export function normalizeUserSubmittedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > MAX_USER_SUBMITTED_PATH_LENGTH ||
      seen.has(path)
    ) {
      continue;
    }
    seen.add(path);
    normalized.push(path);
    if (normalized.length >= MAX_NORMALIZED_USER_SUBMITTED_PATHS) {
      break;
    }
  }
  return normalized;
}

export function normalizeUserSubmittedMessageFieldPaths(
  values: unknown,
): UserSubmittedMessageFieldPath[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized: UserSubmittedMessageFieldPath[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value == null || typeof value !== 'object') {
      continue;
    }
    const { path, field } = value as { path?: unknown; field?: unknown };
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > MAX_USER_SUBMITTED_PATH_LENGTH ||
      typeof field !== 'string' ||
      !HITL_MESSAGE_FILTER_FIELD_SET.has(field)
    ) {
      continue;
    }
    const key = `${field}:${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ path, field: field as UserSubmittedMessageFieldPath['field'] });
    if (normalized.length >= MAX_NORMALIZED_USER_SUBMITTED_PATHS) {
      break;
    }
  }
  return normalized;
}

export function capNormalizedProvenance(
  userSubmittedPaths: readonly string[],
  userSubmittedMessageFieldPaths: readonly UserSubmittedMessageFieldPath[],
): {
  userSubmittedPaths: string[];
  userSubmittedMessageFieldPaths: UserSubmittedMessageFieldPath[];
  promoteWholeMessage: boolean;
} {
  return {
    userSubmittedPaths: userSubmittedPaths.slice(0, MAX_STORED_USER_SUBMITTED_PATHS),
    userSubmittedMessageFieldPaths: userSubmittedMessageFieldPaths.slice(
      0,
      MAX_STORED_USER_SUBMITTED_FIELD_PATHS,
    ),
    promoteWholeMessage: userSubmittedPaths.length > MAX_STORED_USER_SUBMITTED_PATHS,
  };
}

export type StoredSubagentControlReceipt = NonNullable<
  NonNullable<IMessage['subagentTask']>['controlReceipts']
>[number];

export const terminalControlReceipt = (receipt: StoredSubagentControlReceipt): boolean =>
  receipt.status === 'applied' || receipt.status === 'rejected' || receipt.status === 'failed';

export function retainSubagentControlReceipts(
  current: StoredSubagentControlReceipt[],
  receipt: StoredSubagentControlReceipt,
): {
  status: 'updated' | 'unchanged' | 'conflict' | 'capacity';
  receipts: StoredSubagentControlReceipt[];
} {
  const existingIndex = current.findIndex(
    (candidate) => candidate.invocationId === receipt.invocationId,
  );
  let merged: StoredSubagentControlReceipt[];
  if (existingIndex < 0) {
    merged = [...current, receipt];
  } else {
    const existing = current[existingIndex];
    if (existing.fingerprint !== receipt.fingerprint) {
      return { status: 'conflict', receipts: current };
    }
    if (
      terminalControlReceipt(existing) ||
      existing.status === receipt.status ||
      (existing.status === 'accepted' && receipt.status === 'reserved')
    ) {
      return { status: 'unchanged', receipts: current };
    }
    merged = current.map((candidate, index) => (index === existingIndex ? receipt : candidate));
  }
  const accepted = merged.filter(
    (candidate) => candidate.status === 'reserved' || candidate.status === 'accepted',
  );
  /** Reserved and accepted receipts are idempotency fences for commands that can
   * still take effect. Never evict one to admit another receipt: report capacity
   * so the caller refuses the command before mutating the live task. */
  if (accepted.length > MAX_SUBAGENT_CONTROL_RECEIPTS) {
    return { status: 'capacity', receipts: current };
  }
  const terminalAllowance = Math.max(0, MAX_SUBAGENT_CONTROL_RECEIPTS - accepted.length);
  let terminal =
    terminalAllowance === 0
      ? []
      : merged
          .filter((candidate) => candidate.status !== 'reserved' && candidate.status !== 'accepted')
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.invocationId.localeCompare(right.invocationId),
          )
          .slice(-terminalAllowance);
  const advancesActiveFence =
    existingIndex >= 0 &&
    !terminalControlReceipt(current[existingIndex]) &&
    terminalControlReceipt(receipt);
  if (
    advancesActiveFence &&
    !terminal.some((candidate) => candidate.invocationId === receipt.invocationId)
  ) {
    /** A terminal transition for an active fence must outrank unrelated terminal
     * history even though it retains the command's older occurrence timestamp. */
    const otherAllowance = Math.max(0, terminalAllowance - 1);
    terminal = [
      ...(otherAllowance === 0
        ? []
        : terminal
            .filter((candidate) => candidate.invocationId !== receipt.invocationId)
            .slice(-otherAllowance)),
      receipt,
    ].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.invocationId.localeCompare(right.invocationId),
    );
  }
  const receipts = [...accepted, ...terminal];
  if (!receipts.some((candidate) => candidate.invocationId === receipt.invocationId)) {
    return { status: 'capacity', receipts: current };
  }
  return { status: 'updated', receipts };
}

export type MessageProvenance = Pick<
  IMessage,
  'isUserSubmitted' | 'userSubmittedPaths' | 'userSubmittedMessageFieldPaths'
>;

export function mergeMessageProvenance(
  current: MessageProvenance | null,
  userSubmittedPaths: readonly string[],
  userSubmittedMessageFieldPaths: readonly UserSubmittedMessageFieldPath[],
  stampModelOutputOnInsert = false,
  explicitIsUserSubmitted?: boolean,
  preserveStoredIsUserSubmitted = true,
): MessageProvenance {
  const provenance = capNormalizedProvenance(
    normalizeUserSubmittedPaths([...(current?.userSubmittedPaths ?? []), ...userSubmittedPaths]),
    normalizeUserSubmittedMessageFieldPaths([
      ...(current?.userSubmittedMessageFieldPaths ?? []),
      ...userSubmittedMessageFieldPaths,
    ]),
  );

  let isUserSubmitted = preserveStoredIsUserSubmitted ? current?.isUserSubmitted : undefined;
  if (typeof explicitIsUserSubmitted === 'boolean') {
    isUserSubmitted = explicitIsUserSubmitted;
  } else if (stampModelOutputOnInsert && isUserSubmitted == null) {
    isUserSubmitted = false;
  }
  if (provenance.promoteWholeMessage) {
    isUserSubmitted = true;
  }

  return {
    userSubmittedPaths: provenance.userSubmittedPaths,
    userSubmittedMessageFieldPaths: provenance.userSubmittedMessageFieldPaths,
    ...(typeof isUserSubmitted === 'boolean' && { isUserSubmitted }),
  };
}

export function getProvenanceSnapshotFilter(current: MessageProvenance): Record<string, unknown> {
  return {
    userSubmittedPaths: !Object.prototype.hasOwnProperty.call(current, 'userSubmittedPaths')
      ? { $exists: false }
      : current.userSubmittedPaths,
    userSubmittedMessageFieldPaths: !Object.prototype.hasOwnProperty.call(
      current,
      'userSubmittedMessageFieldPaths',
    )
      ? { $exists: false }
      : current.userSubmittedMessageFieldPaths,
    isUserSubmitted: !Object.prototype.hasOwnProperty.call(current, 'isUserSubmitted')
      ? { $exists: false }
      : current.isUserSubmitted,
  };
}

export function getMissingProvenanceFilter(): Record<string, unknown> {
  return {
    userSubmittedPaths: { $exists: false },
    userSubmittedMessageFieldPaths: { $exists: false },
    isUserSubmitted: { $exists: false },
  };
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

export function getSteerUserSubmittedPaths(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const paths: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const part = content[index] as { type?: unknown } | null | undefined;
    if (part?.type === 'steer') {
      paths.push(`/content/${index}`);
    }
  }
  return paths;
}

/** Mongoose omits undefined $set values. Strip identity/version inputs before any sizing callback. */
export function sanitizeMessageUpdate(update: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(update).filter(
      ([key, value]) => value !== undefined && !['_id', 'tenantId', '__v'].includes(key),
    ),
  );
}

/** Conservatively admit any server-bound resource to the slow path, including legacy MIME forms. */
export const NO_BOUND_APPS = { 'attachments.ui_resources.serverBinding': { $exists: false } };

/** The update a message save writes: its fields, the version advance and the insert-only parts. */
export interface MessageSaveUpdate {
  $set: Record<string, unknown>;
  $inc: { __v: 1 };
  $setOnInsert?: Record<string, unknown>;
  $unset?: Record<string, 1>;
}

/**
 * A terminal save that must drop a stored `contextMeta` unsets it in the same
 * update that persists the response, so no failure between two writes can
 * leave a completed row carrying a disconnect snapshot's state.
 */
export function buildMessageSaveUpdate(
  update: Record<string, unknown>,
  options: {
    stampModelOutputOnInsert: boolean;
    unsetContextMeta: boolean;
    unsetPrivateText?: boolean;
    retentionOnInsert?: { expiredAt: Date; isTemporary: false };
  },
): MessageSaveUpdate {
  return {
    $set: update,
    $inc: { __v: 1 },
    ...((options.stampModelOutputOnInsert || options.retentionOnInsert != null) && {
      $setOnInsert: {
        ...(options.stampModelOutputOnInsert && { isUserSubmitted: false }),
        ...options.retentionOnInsert,
      },
    }),
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
  };
}

/**
 * A legacy temporary message stores only its deadline; hydration then fills
 * `isTemporary` with the schema default `false`, which must not read as permanent.
 */
export function isTemporaryMessage(message: IMessage): boolean {
  if (message.isTemporary === true) {
    return true;
  }
  const implicit = message.isTemporary == null || message.$isDefault?.('isTemporary') === true;
  return implicit && message.expiredAt != null;
}

/**
 * Maximum private transcript JSON that may cross the MongoDB projection seam
 * for the bounded public subagent-activity view. This gives the sanitizer
 * enough source headroom while preventing multi-megabyte transcripts from
 * being materialized merely to produce a 64 KiB public activity response.
 */
export const SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT: number = 256 * 1024;
export const SUBAGENT_ACTIVITY_PROJECTION_SOURCE_BYTE_LIMIT: number = 64 * 1024;

/**
 * Maximum activity sources materialized for one child-view poll. New writers
 * supply at most four 64 KiB public projections; legacy rows fall back to at
 * most four 256 KiB private transcripts during a rolling deployment.
 */
export const SUBAGENT_TRANSCRIPT_PAGE_LIMIT: number = 4;
export const SUBAGENT_ACTIVITY_SOURCE_CANDIDATE_LIMIT: number = SUBAGENT_TRANSCRIPT_PAGE_LIMIT * 2;

/**
 * Ordinary persisted message content is the authoritative refresh source when
 * an execution did not write a private subagent transcript. Project only the
 * visible activity vocabulary and bound it before MongoDB returns the row.
 */
/**
 * Per-item bounds mirror `SUBAGENT_ACTIVITY_LIMITS` in `packages/api`
 * (`src/agents/activity.ts`) at worst-case 4-byte UTF-8, so activity projected
 * from ordinary message content is clipped no harder than activity projected
 * from a private transcript. The whole view stays bounded downstream by the
 * 64KB serialized-activity budget and the 256KB response trim.
 */
export const SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT: number = 100;
export const SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT = 8192;
export const SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT = 2048;
export const SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT = 4096;
export const SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT = 128;
export const SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT = 512;
export const SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT = 8;
export const SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT: number = 64 * 1024;
export const SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT = 32;
export const SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT = 128;

/**
 * A response the server generated and sampled into a trace. Its trace fields are
 * an ownership claim, so rows a client authored (the message-create route and
 * imports stamp `isUserSubmitted: true`) never count, even if one was persisted
 * with forged fields before those writes stripped them.
 */
/** A response's position in trace order: its creation time, then its `_id`. */
export function traceOrderKey(createdAt: Date, id: { toString(): string }): string {
  return `${createdAt.getTime().toString(36)}.${id.toString()}`;
}

export function parseTraceOrderKey(key: string): { createdAt: Date; id: string } | undefined {
  const [time, hex] = key.split('.');
  const createdAt = new Date(Number.parseInt(time ?? '', 36));
  if (Number.isNaN(createdAt.getTime()) || hex == null || !/^[0-9a-f]{24}$/.test(hex)) {
    return undefined;
  }
  return { createdAt, id: hex };
}

/** An explicit tenant scope, so a read without request tenant context still cannot span tenants. */
export const traceTenantScope = (
  tenantId?: string,
): { tenantId: string } | { tenantId: { $exists: false } } =>
  tenantId == null ? { tenantId: { $exists: false } } : { tenantId };

export const SERVER_AUTHORED_SAMPLED_RESPONSE = {
  langfuseSampled: true,
  isCreatedByUser: false,
  isUserSubmitted: { $ne: true },
} as const;

/** Amazon DocumentDB does not support `$$REMOVE`, so the bounded thread-view
 * projections emit `null` where they mean "omit this key". This is the shape as
 * it leaves the aggregation, before those sentinels are pruned back to absent. */
/** Widens the given keys to admit the projection's `null` sentinel. */
export type WithNullSentinels<T, K extends keyof T> = Omit<T, K> & {
  [P in K]?: NonNullable<T[P]> | null;
};

export type ThreadViewRecord = SubagentThreadViewMessageRecord;
export type ProjectedSubagentThreadViewMessage = WithNullSentinels<
  Omit<ThreadViewRecord, 'subagentTask' | 'subagentTriggerProjection'>,
  'subagentTranscriptProjectionTruncated'
> & {
  subagentTriggerProjection?: WithNullSentinels<
    NonNullable<ThreadViewRecord['subagentTriggerProjection']>,
    'expectedActionToolName'
  > | null;
  subagentTask?:
    | (Omit<NonNullable<ThreadViewRecord['subagentTask']>, 'controlReceipts'> & {
        controlReceipts?: Array<
          WithNullSentinels<
            NonNullable<NonNullable<ThreadViewRecord['subagentTask']>['controlReceipts']>[number],
            'controlId' | 'reason' | 'message'
          >
        >;
      })
    | null;
};

/** Restores the absent-vs-present contract by dropping the `null` sentinels the
 * projection emitted. Bounded by the projection's own row, receipt, and byte
 * limits, and folded into the pass that already materializes each record. */
export function pruneProjectedThreadViewMessage(
  message: ProjectedSubagentThreadViewMessage,
): SubagentThreadViewMessageRecord {
  if (message.subagentTranscriptProjectionTruncated === null) {
    delete message.subagentTranscriptProjectionTruncated;
  }
  if (message.subagentTriggerProjection === null) {
    delete message.subagentTriggerProjection;
  } else if (message.subagentTriggerProjection?.expectedActionToolName === null) {
    delete message.subagentTriggerProjection.expectedActionToolName;
  }
  if (message.subagentTask === null) {
    delete message.subagentTask;
  } else {
    for (const receipt of message.subagentTask?.controlReceipts ?? []) {
      if (receipt.controlId === null) delete receipt.controlId;
      if (receipt.reason === null) delete receipt.reason;
      if (receipt.message === null) delete receipt.message;
    }
  }
  return message as SubagentThreadViewMessageRecord;
}

/**
 * Reads a stored terminal stamp defensively: rows written before the stamp existed
 * omit it, and a document can reach here from a raw read where the date is still a
 * string, so an unusable value is reported as absent rather than as `Invalid Date`.
 */
export function toSettledAt(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

const DATE_SORT_FIELDS = new Set(['createdAt', 'updatedAt']);
/** Cursor marker for a null or missing sort value, which MongoDB orders before every string, '' included. */
export const NULL_SORT_VALUE = '\u0000';
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Encodes the last row of a page as `<sortValue>|<_id>`; dates use ISO strings so milliseconds survive. */
export function formatMessageCursor(value: unknown, id: unknown): string {
  if (value == null) {
    return id == null ? NULL_SORT_VALUE : `${NULL_SORT_VALUE}|${String(id)}`;
  }
  const sortValue = value instanceof Date ? value.toISOString() : String(value);
  return id == null ? sortValue : `${sortValue}|${String(id)}`;
}

/** Accepts both the compound cursor and the legacy bare sort value from older clients. */
export function parseMessageCursor(cursor: string): { value: string; id?: string } {
  const split = cursor.lastIndexOf('|');
  if (split >= 0 && OBJECT_ID_PATTERN.test(cursor.slice(split + 1))) {
    return { value: cursor.slice(0, split), id: cursor.slice(split + 1) };
  }
  return { value: cursor };
}

/** The rows after a cursor, following MongoDB's order: null/missing, then '' (strings only), then values. */
export function buildCursorFilter(
  sortField: string,
  op: '$gt' | '$lt',
  value: string | Date,
  position: { value: string; id?: unknown },
): Record<string, unknown> {
  if (position.id == null) {
    return { [sortField]: { [op]: value } };
  }
  const tieId = { _id: { [op]: position.id } };
  const ascending = op === '$gt';
  if (position.value === NULL_SORT_VALUE) {
    return {
      $or: [
        { [sortField]: null, ...tieId },
        ...(ascending ? [{ [sortField]: { $ne: null } }] : []),
      ],
    };
  }
  return {
    $or: [
      { [sortField]: { [op]: value } },
      { [sortField]: value, ...tieId },
      ...(ascending ? [] : [{ [sortField]: null }]),
    ],
  };
}

/** The agent-ownership rule shared by background-tool settling and claiming:
 * `agentId` on the part wins, then `tool_call.agentId`, and a part without
 * agent identity belongs to any caller (single-agent runs). `field: null`
 * matches both a missing field and a stored null. The settle and claim paths
 * MUST apply the identical rule, or a settled part becomes unclaimable. */
export function agentOwnershipFilter(prefix: string, agentId: string): Record<string, unknown> {
  return {
    $or: [
      { [`${prefix}agentId`]: agentId },
      { [`${prefix}agentId`]: null, [`${prefix}tool_call.agentId`]: agentId },
      { [`${prefix}agentId`]: null, [`${prefix}tool_call.agentId`]: null },
    ],
  };
}

export type UpdateToolCallResultInput = {
  userId: string;
  messageId: string;
  conversationId: string;
  toolCallId: string;
  stepId?: string;
  /** Scopes the part match when provider tool-call ids repeat across
   *  agents in one response message (e.g. `call_0` per response); a part
   *  without agent identity matches any caller (single-agent runs). */
  agentId?: string;
  output?: string;
  attachments?: unknown[];
  /**
   * Stamps `backgrounded: true` onto the patched tool call. Replacing the
   * dispatch-handle output with the settled task's stdout destroys the only
   * signal renderers had that this call ran detached (the handle JSON and
   * the live status-marker attachment are both transient), so the patch
   * that erases it must persist a durable one alongside.
   */
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
    };
  };
};

export type SteplessToolCallFallback = {
  content: NonNullable<IMessage['content']>;
  hasResultClaim: boolean;
};

export const MAX_BACKGROUND_TOOL_RESULT_BATCH = 16;
/** Bounds the attachments-merge fence retries. Each lost round means a
 * concurrent writer changed the array, so re-reading converges. */
export const ATTACHMENT_MERGE_CAS_ATTEMPTS = 8;

export function readBackgroundToolResultClaim(
  row: Pick<IMessage, 'content'>,
  taskId: string,
):
  | {
      kind: 'manual' | 'wakeup';
      claimId: string;
      generationId?: string;
      batchId?: string;
      receiptReconciled?: true;
    }
  | undefined {
  for (const part of row.content ?? []) {
    if (part == null || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const backgroundTask = (
      part as {
        tool_call?: {
          backgroundTask?: {
            taskId?: unknown;
            resultClaim?: {
              kind?: unknown;
              claimId?: unknown;
              generationId?: unknown;
              batchId?: unknown;
              receiptReconciled?: unknown;
            };
          };
        };
      }
    ).tool_call?.backgroundTask;
    if (backgroundTask?.taskId !== taskId) {
      continue;
    }
    const claim = backgroundTask.resultClaim;
    if (
      (claim?.kind === 'manual' || claim?.kind === 'wakeup') &&
      typeof claim.claimId === 'string' &&
      claim.claimId.length > 0
    ) {
      return {
        kind: claim.kind,
        claimId: claim.claimId,
        ...(typeof claim.batchId === 'string' && { batchId: claim.batchId }),
        ...(claim.receiptReconciled === true && { receiptReconciled: true }),
        ...(typeof claim.generationId === 'string' && claim.generationId.length > 0
          ? { generationId: claim.generationId }
          : {}),
      };
    }
    return;
  }
}

export function parseBackgroundToolResults(
  message: IMessage,
  claim: { kind: 'manual' | 'wakeup'; claimId: string; batchId?: string },
): BackgroundToolResultRecord[] {
  const results: BackgroundToolResultRecord[] = [];
  for (const part of message.content ?? []) {
    if (part == null || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const record = part as {
      agentId?: unknown;
      tool_call?: {
        id?: unknown;
        agentId?: unknown;
        output?: unknown;
        backgroundTask?: {
          taskId?: unknown;
          toolName?: unknown;
          status?: unknown;
          cancelled?: unknown;
          settledAt?: unknown;
          resultClaim?: { kind?: unknown; claimId?: unknown; batchId?: unknown };
        };
      };
    };
    const toolCall = record.tool_call;
    const task = toolCall?.backgroundTask;
    if (
      typeof toolCall?.id !== 'string' ||
      typeof task?.taskId !== 'string' ||
      typeof task.toolName !== 'string' ||
      (task.status !== 'completed' && task.status !== 'error') ||
      task.resultClaim?.kind !== claim.kind ||
      task.resultClaim.claimId !== claim.claimId ||
      task.resultClaim.batchId !== claim.batchId
    ) {
      continue;
    }
    let resultAgentId: string | undefined;
    if (typeof record.agentId === 'string') {
      resultAgentId = record.agentId;
    } else if (typeof toolCall.agentId === 'string') {
      resultAgentId = toolCall.agentId;
    }
    const settledAt = toSettledAt(task.settledAt);
    results.push({
      taskId: task.taskId,
      toolCallId: toolCall.id,
      toolName: task.toolName,
      status: task.cancelled === true ? 'cancelled' : task.status,
      output: typeof toolCall.output === 'string' ? toolCall.output : '',
      ...(resultAgentId == null ? {} : { agentId: resultAgentId }),
      ...(settledAt == null ? {} : { settledAt }),
    });
  }
  return results;
}

export function readBackgroundToolHandle(
  message: IMessage,
  taskId: string,
  agentId?: string,
): string | undefined {
  for (const part of message.content ?? []) {
    if (part == null || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const record = part as {
      agentId?: unknown;
      tool_call?: { agentId?: unknown; output?: unknown };
    };
    const partAgentId = record.agentId ?? record.tool_call?.agentId;
    const sameAgent =
      agentId == null ||
      partAgentId == null ||
      (typeof partAgentId === 'string' && partAgentId === agentId);
    const output = record.tool_call?.output;
    if (!sameAgent || typeof output !== 'string' || !output.includes(taskId)) {
      continue;
    }
    try {
      const handle = JSON.parse(output) as {
        background_task_id?: unknown;
        subagent_type?: unknown;
        tool?: unknown;
        status?: unknown;
      };
      if (
        handle.background_task_id === taskId &&
        handle.status === 'running' &&
        typeof handle.subagent_type !== 'string' &&
        typeof handle.tool === 'string' &&
        handle.tool.length > 0
      ) {
        return handle.tool;
      }
    } catch {
      continue;
    }
  }
  return;
}

/* ------------------------------------------------------------------ saves */

/** Who saves a message, and the retention its chat implies (`MessageStore.saveMessage`). */
export interface SaveMessageContext {
  userId: string;
  isTemporary?: boolean;
  expiredAt?: Date;
  interfaceConfig?: AppConfig['interfaceConfig'];
}

/** The message fields a save takes (`MessageStore.saveMessage`). */
export type SaveMessageParams = Omit<Partial<IMessage>, 'contextMeta'> & {
  newMessageId?: string;
  /** `null` unsets a previously stored value; omission leaves it in place. */
  contextMeta?: IMessage['contextMeta'] | null;
};

/** What a save carries beside its fields (`MessageStore.saveMessage`). */
export interface SaveMessageMetadata {
  context?: string;
  privateText?: PrivateTextWrite;
  insertOnly?: boolean;
}

/** What one `saveMessage` writes, decided before any storage step. */
export interface PreparedMessageSave {
  /** The fields to set: the caller's, with the owner, the effective id, retention and private text. */
  update: Record<string, unknown>;
  /** The retention a message gets only when the save creates it. */
  retentionOnInsert?: { expiredAt: Date; isTemporary: false };
  /** `contextMeta: null` asked to drop a stored context meta. */
  unsetContextMeta: boolean;
  userSubmittedPaths: string[];
  userSubmittedMessageFieldPaths: UserSubmittedMessageFieldPath[];
  /** A model response without explicit provenance is stamped not user-submitted on insert. */
  stampModelOutputOnInsert: boolean;
  /** A save of `text` without a private original drops the stored one. */
  unsetPrivateText: boolean;
}

/**
 * The fields, retention and provenance of one `saveMessage` (the conversation id is already
 * checked). Throws when a private original comes with something other than a user's text.
 */
export function prepareMessageSave(
  { userId, isTemporary, expiredAt, interfaceConfig }: SaveMessageContext,
  params: SaveMessageParams,
  metadata?: SaveMessageMetadata,
): PreparedMessageSave {
  const update: Record<string, unknown> = {
    ...params,
    user: userId,
    messageId: params.newMessageId || params.messageId,
  };
  delete update.privateText;
  delete update.privacyRevision;
  delete update.privateTextTokens;
  if (metadata?.privateText != null) {
    if (params.isCreatedByUser !== true || typeof params.text !== 'string') {
      throw new Error('Private text requires a user message.');
    }
    update.privateText = metadata.privateText.envelope;
    update.privacyRevision = metadata.privateText.revision;
  }
  delete update.isTemporary;
  delete update.expiredAt;
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
      logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
      update.expiredAt = createFallbackRetentionDate();
    }
  } else if (interfaceConfig?.retentionMode === RetentionMode.ALL) {
    if (typeof isTemporary === 'boolean') {
      update.isTemporary = isTemporary;
    }
    if (typeof isTemporary === 'boolean' || interfaceConfig.generalChatRetention === undefined) {
      try {
        update.expiredAt = createChatExpirationDate(interfaceConfig, isTemporary);
      } catch (err) {
        logger.error('Error creating chat expiration date:', err);
        logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
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
        logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
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
      logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
      update.expiredAt = createFallbackRetentionDate();
    }
  } else if (isTemporary === false) {
    update.isTemporary = false;
    update.expiredAt = null;
  }

  /** A response that ends with nothing to carry must drop what an earlier
   * partial save (a disconnect snapshot) stored, or the next turn would seed
   * from stale state; omission never unsets, and the unset rides the same
   * update as the response. */
  const unsetContextMeta = update.contextMeta === null;
  if (unsetContextMeta) {
    delete update.contextMeta;
  }
  if (update.tokenCount != null && isNaN(update.tokenCount as number)) {
    logger.warn(
      `Resetting invalid \`tokenCount\` for message \`${params.messageId}\`: ${update.tokenCount}`,
    );
    logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
    update.tokenCount = 0;
  }
  const userSubmittedPaths = normalizeUserSubmittedPaths([
    ...(Array.isArray(params.userSubmittedPaths) ? params.userSubmittedPaths : []),
    ...getSteerUserSubmittedPaths(params.content),
  ]);
  const userSubmittedMessageFieldPaths = normalizeUserSubmittedMessageFieldPaths(
    params.userSubmittedMessageFieldPaths,
  );
  delete update.userSubmittedPaths;
  delete update.userSubmittedMessageFieldPaths;
  delete update.__v;
  const stampModelOutputOnInsert =
    params.isCreatedByUser === false && params.isUserSubmitted === undefined;
  return {
    update,
    retentionOnInsert,
    unsetContextMeta,
    userSubmittedPaths,
    userSubmittedMessageFieldPaths,
    stampModelOutputOnInsert,
    unsetPrivateText:
      metadata?.privateText == null && Object.prototype.hasOwnProperty.call(update, 'text'),
  };
}

/**
 * The upsert of an insert-only save (`metadata.insertOnly`): every field only when the save
 * creates the message, with its own timestamps. Throws for a private original.
 */
export function buildInsertOnlyMessageUpdate(
  prepared: PreparedMessageSave,
  metadata: SaveMessageMetadata,
): { $setOnInsert: Record<string, unknown> } {
  if (metadata.privateText != null) {
    throw new Error('A private message cannot use the ordinary insert-only writer.');
  }
  const now = new Date();
  const { update, userSubmittedPaths, userSubmittedMessageFieldPaths, retentionOnInsert } =
    prepared;
  return {
    $setOnInsert: {
      ...update,
      ...(userSubmittedPaths.length > 0 && { userSubmittedPaths }),
      ...(userSubmittedMessageFieldPaths.length > 0 && { userSubmittedMessageFieldPaths }),
      ...retentionOnInsert,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** A saved message as the retention rules after a save read it. */
type SavedRetention = Pick<IMessage, '_id' | 'expiredAt' | 'isTemporary'> & {
  $isDefault?: IMessage['$isDefault'];
};

/**
 * Under `retentionMode: all` with a general retention period, a save that names no chat type
 * gives a stored message without a deadline the one its stored chat type implies: the guarded
 * update (without timestamps) and the deadline, or `undefined` when none applies.
 */
export function planRetentionDeadlineBackfill(
  { isTemporary, interfaceConfig }: SaveMessageContext,
  message: SavedRetention,
):
  | { filter: Record<string, unknown>; update: Record<string, unknown>; deadline: Date }
  | undefined {
  if (
    interfaceConfig?.retentionMode !== RetentionMode.ALL ||
    interfaceConfig.generalChatRetention === undefined ||
    typeof isTemporary === 'boolean' ||
    message.expiredAt != null
  ) {
    return undefined;
  }
  const deadline = createChatExpirationDate(interfaceConfig, message.isTemporary === true);
  return {
    filter: {
      _id: message._id,
      expiredAt: null,
      isTemporary: message.isTemporary === true ? true : { $ne: true },
    },
    update: { $set: { expiredAt: deadline } },
    deadline,
  };
}

/**
 * Under `retentionMode: all`, a save that names no chat type marks a message whose chat type is
 * unknown (missing, or only the schema default) as permanent: the guarded update, or `undefined`.
 */
export function planPermanentChatTypeBackfill(
  { isTemporary, interfaceConfig }: SaveMessageContext,
  message: SavedRetention,
): { filter: Record<string, unknown>; update: Record<string, unknown> } | undefined {
  if (
    interfaceConfig?.retentionMode !== RetentionMode.ALL ||
    typeof isTemporary === 'boolean' ||
    !(
      message.isTemporary == null ||
      (message.isTemporary === false && message.$isDefault?.('isTemporary') === true)
    )
  ) {
    return undefined;
  }
  return {
    filter: { _id: message._id, isTemporary: { $ne: false } },
    update: { $set: { isTemporary: false } },
  };
}

/** One upsert of `bulkSaveMessages`, by message id (and user, when the record names one). */
export interface BulkSaveMessageOperation {
  updateOne: {
    filter: Record<string, unknown>;
    update: {
      $set: Record<string, unknown>;
      $inc: { __v: 1 };
      $unset: Record<string, 1>;
    };
    timestamps: boolean;
    upsert: true;
  };
}

/**
 * The upsert `bulkSaveMessages` writes for one record: its fields without identity, version or
 * private text, private text tokens only from the caller's provenance (and only those the text
 * holds), normalized provenance; the stored private original is always dropped.
 */
export function buildBulkSaveMessageOperation(
  message: Record<string, unknown>,
  overrideTimestamp: boolean,
  provenance?: { privateTextTokens: ReadonlyMap<string, readonly string[]> },
): BulkSaveMessageOperation {
  const normalizedMessage = sanitizeMessageUpdate(message);
  delete normalizedMessage.privateText;
  delete normalizedMessage.privacyRevision;
  delete normalizedMessage.privateTextTokens;
  const tokens = provenance?.privateTextTokens.get(String(message.messageId));
  const text = message.text;
  if (
    tokens?.length &&
    tokens.length <= 4096 &&
    message.isCreatedByUser === true &&
    typeof text === 'string'
  ) {
    normalizedMessage.privateTextTokens = tokens.filter(
      (token) =>
        /^\[(?:EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_\d+_[a-f0-9]{32}\]$/.test(token) &&
        text.includes(token),
    );
  }
  const submittedProvenance = capNormalizedProvenance(
    normalizeUserSubmittedPaths(message.userSubmittedPaths),
    normalizeUserSubmittedMessageFieldPaths(message.userSubmittedMessageFieldPaths),
  );
  if (submittedProvenance.userSubmittedPaths.length > 0) {
    normalizedMessage.userSubmittedPaths = submittedProvenance.userSubmittedPaths;
  } else {
    delete normalizedMessage.userSubmittedPaths;
  }
  if (submittedProvenance.userSubmittedMessageFieldPaths.length > 0) {
    normalizedMessage.userSubmittedMessageFieldPaths =
      submittedProvenance.userSubmittedMessageFieldPaths;
  } else {
    delete normalizedMessage.userSubmittedMessageFieldPaths;
  }
  if (submittedProvenance.promoteWholeMessage) {
    normalizedMessage.isUserSubmitted = true;
  }
  return {
    updateOne: {
      filter: {
        messageId: message.messageId,
        ...(message.user != null ? { user: message.user } : {}),
      },
      update: {
        $set: normalizedMessage,
        $inc: { __v: 1 },
        $unset: {
          privateText: 1,
          privacyRevision: 1,
          ...(normalizedMessage.privateTextTokens == null && { privateTextTokens: 1 }),
        },
      },
      timestamps: !overrideTimestamp,
      upsert: true,
    },
  };
}

/** The fields `updateMessage` resolves for the updated message. */
export function toUpdatedMessageFields(updatedMessage: IMessage): Partial<IMessage> {
  return {
    messageId: updatedMessage.messageId,
    conversationId: updatedMessage.conversationId,
    parentMessageId: updatedMessage.parentMessageId,
    sender: updatedMessage.sender,
    text: updatedMessage.text,
    isCreatedByUser: updatedMessage.isCreatedByUser,
    isUserSubmitted: updatedMessage.isUserSubmitted,
    userSubmittedPaths: updatedMessage.userSubmittedPaths,
    userSubmittedMessageFieldPaths: updatedMessage.userSubmittedMessageFieldPaths,
    tokenCount: updatedMessage.tokenCount,
    feedback: updatedMessage.feedback,
    endpoint: updatedMessage.endpoint,
    isTemporary: isTemporaryMessage(updatedMessage),
    langfuseSampled: updatedMessage.langfuseSampled,
    langfuseDestinationIds: updatedMessage.langfuseDestinationIds,
    langfuseRunId: updatedMessage.langfuseRunId,
  };
}

/* --------------------------------------------------- background tool results */

/**
 * The one part with the call id (and agent scope) that has no stored step, on a finished row,
 * when the exact step match of a settlement cannot land: a turn resumed after an approval pause
 * persists the calls it made before the pause without their step ids. `undefined` when the row is
 * unfinished, a part already carries the exact step, or more than one part qualifies.
 */
export function findSteplessToolCallFallback(
  row: Pick<IMessage, 'content' | 'unfinished'> | null,
  { toolCallId, stepId, agentId }: UpdateToolCallResultInput,
): SteplessToolCallFallback | undefined {
  if (row == null || row.unfinished === true) {
    return;
  }
  let candidates = 0;
  let hasResultClaim = false;
  const content = row.content ?? [];
  for (const part of content) {
    const entry = part as {
      type?: unknown;
      agentId?: unknown;
      tool_call?: {
        id?: unknown;
        stepId?: unknown;
        agentId?: unknown;
        backgroundTask?: { resultClaim?: unknown };
      };
    } | null;
    if (entry?.type !== 'tool_call' || entry.tool_call?.id !== toolCallId) {
      continue;
    }
    const owner = entry.agentId ?? entry.tool_call.agentId;
    if (agentId != null && owner != null && owner !== agentId) {
      continue;
    }
    /** An unmatched write can mean attachment contention, not a missing
     * identity. Never substitute a sibling for an existing exact part. */
    if (entry.tool_call.stepId === stepId) {
      return;
    }
    if (entry.tool_call.stepId != null) {
      continue;
    }
    candidates += 1;
    if (candidates > 1) {
      return;
    }
    hasResultClaim = entry.tool_call.backgroundTask?.resultClaim != null;
  }
  return candidates === 1 ? { content, hasResultClaim } : undefined;
}

/** The writes of one tool-call settlement (`updateToolCallResult`). */
export interface ToolCallSettlementPlan {
  /** The message holding the part (by its `$elemMatch`, or the fallback's content fence). */
  messageFilter: Record<string, unknown>;
  /** The settlement: the version advance, the part patch and the wakeup disarm. */
  settleUpdate: {
    $inc: { __v: 1 };
    $set?: Record<string, unknown>;
    $unset?: Record<string, 1>;
  };
  /** The part patch, merged with the attachments when those are written too. */
  settlePatch: Record<string, unknown>;
  /** The `arrayFilters` of the settlement, when it addresses the part. */
  arrayFilters?: Array<Record<string, unknown>>;
  /** A supplied claim stamped before the settlement, on matching parts that carry none. */
  claimStamp?: {
    update: { $set: Record<string, unknown> };
    arrayFilters: Array<Record<string, unknown>>;
  };
  incomingAttachments: unknown[];
  mergingAttachments: boolean;
}

/**
 * The writes that settle one tool call, or `null` when there is nothing to write.
 * `stepMatch` is a step id to match exactly, `null` to match a part with no stored step, or
 * `undefined` to ignore steps; `fallback` fences the stepless fallback on the content it read.
 */
export function planToolCallSettlement(
  {
    userId,
    messageId,
    conversationId,
    toolCallId,
    agentId,
    output,
    attachments,
    markBackgrounded,
    backgroundTask,
  }: UpdateToolCallResultInput,
  stepMatch: string | null | undefined,
  fallback?: SteplessToolCallFallback,
): ToolCallSettlementPlan | null {
  /** One source of truth for which content part this settle may touch:
   * `prefix: ''` yields the `$elemMatch` document filter, `prefix: 'part.'`
   * the arrayFilters element filter — the same predicate in one dialect,
   * where the old code kept an aggregation `$expr` twin of it. `field: null`
   * matches both a missing field and a stored null, mirroring the previous
   * `$ifNull` chains. */
  const partScope = (prefix: string): Record<string, unknown> => ({
    [`${prefix}type`]: 'tool_call',
    [`${prefix}tool_call.id`]: toolCallId,
    ...(stepMatch !== undefined ? { [`${prefix}tool_call.stepId`]: stepMatch } : {}),
    ...(agentId != null ? agentOwnershipFilter(prefix, agentId) : {}),
  });
  const messageFilter = {
    messageId,
    user: userId,
    conversationId,
    ...(fallback == null
      ? { content: { $elemMatch: partScope('') } }
      : { content: fallback.content, unfinished: { $ne: true } }),
  };
  const partIdentityFilter = partScope('part.');
  /** Amazon DocumentDB rejects aggregation-pipeline updates, so the part
   * patch addresses the matching tool-call parts with the filtered positional
   * operator and plain `$set`/`$unset`. Setting `backgroundTask` subfields
   * individually preserves an existing `resultClaim` without the per-part
   * branching the old pipeline needed, and clearing `completionWakeup` keeps
   * the old whole-object replacement's disarm semantics. */
  const partPatch: Record<string, string | number | boolean | Date> = {};
  let disarmWakeup = false;
  if (output !== undefined || backgroundTask != null) {
    if (output !== undefined) {
      partPatch['content.$[part].tool_call.output'] = output;
    }
    if (markBackgrounded === true) {
      partPatch['content.$[part].tool_call.backgrounded'] = true;
    }
    if (backgroundTask != null) {
      partPatch['content.$[part].tool_call.backgroundTask.version'] = 1;
      partPatch['content.$[part].tool_call.backgroundTask.taskId'] = backgroundTask.taskId;
      partPatch['content.$[part].tool_call.backgroundTask.toolName'] = backgroundTask.toolName;
      partPatch['content.$[part].tool_call.backgroundTask.status'] = backgroundTask.status;
      partPatch['content.$[part].tool_call.backgroundTask.cancelled'] =
        backgroundTask.cancelled === true;
      partPatch['content.$[part].tool_call.backgroundTask.settledAt'] = backgroundTask.settledAt;
      if (backgroundTask.completionReceipt === true) {
        partPatch['content.$[part].tool_call.backgroundTask.completionReceipt'] = true;
      }
      if (backgroundTask.completionWakeup === true) {
        partPatch['content.$[part].tool_call.backgroundTask.completionWakeup'] = true;
      } else {
        disarmWakeup = true;
      }
    }
  }
  const incomingAttachments = attachments ?? [];
  const mergingAttachments = incomingAttachments.length > 0;
  if (Object.keys(partPatch).length === 0 && !mergingAttachments) {
    return null;
  }
  /** Fence the fallback on the content used to establish its unique identity.
   * A concurrent save or claim must invalidate the whole write, including any
   * supplied claim. The snapshot lets us preserve an existing claim and stamp
   * a missing one atomically with settlement, rather than before this fence. */
  const settlePatch = {
    ...partPatch,
    ...(fallback != null && !fallback.hasResultClaim && backgroundTask?.resultClaim != null
      ? { 'content.$[part].tool_call.backgroundTask.resultClaim': backgroundTask.resultClaim }
      : {}),
  };
  const settleUpdate = {
    $inc: { __v: 1 as const },
    ...(Object.keys(settlePatch).length > 0 ? { $set: settlePatch } : {}),
    ...(disarmWakeup
      ? {
          $unset: { 'content.$[part].tool_call.backgroundTask.completionWakeup': 1 as const },
        }
      : {}),
  };
  return {
    messageFilter,
    settleUpdate,
    settlePatch,
    ...(Object.keys(partPatch).length > 0 || disarmWakeup
      ? { arrayFilters: [partIdentityFilter] }
      : {}),
    /** A supplied claim is stamped BEFORE the settle write, on parts that
     * carry none (`resultClaim: null` also admits a stored null, as the old
     * `$ifNull` did). Ordering is what keeps the split safe: until the settle
     * write lands, the part is not terminal, so a concurrent wakeup or manual
     * poll sees `not_ready` and stands down. A crash between the writes is
     * healed by the settle retry, whose claim write no-ops against its own stamp. */
    ...(fallback == null && backgroundTask?.resultClaim != null
      ? {
          claimStamp: {
            update: {
              $set: {
                'content.$[part].tool_call.backgroundTask.resultClaim': backgroundTask.resultClaim,
              },
            },
            arrayFilters: [
              { ...partIdentityFilter, 'part.tool_call.backgroundTask.resultClaim': null },
            ],
          },
        }
      : {}),
    incomingAttachments,
    mergingAttachments,
  };
}

/**
 * The message's attachments with the settlement's merged in. Dedupe key mirrors the resume
 * merge: `file_id ?? filepath`, so download-fallback attachments (no `file_id`, only a filepath)
 * stay idempotent across re-applications instead of duplicating per poll. Replace only THIS tool
 * call's prior entries: sibling calls can legitimately share a `file_id` (the filename claim is
 * per-conversation), and the client anchors attachments to cards by `toolCallId`. Provider
 * tool-call ids repeat across agents in handoff messages, so a sibling agent's attachment under
 * the same id/key must survive (missing agent identity = legacy wildcard).
 */
export function mergeToolCallAttachments(
  prior: unknown,
  incomingAttachments: unknown[],
  { toolCallId, agentId, stepId }: UpdateToolCallResultInput,
): unknown[] {
  const attachmentKeys = new Set(
    incomingAttachments
      .map((attachment) => {
        const { file_id, filepath } = attachment as { file_id?: unknown; filepath?: unknown };
        return typeof file_id === 'string' ? file_id : filepath;
      })
      .filter((key): key is string => typeof key === 'string'),
  );
  const replacesEntry = (existing: unknown): boolean => {
    if (existing == null || typeof existing !== 'object') return false;
    const entry = existing as {
      file_id?: unknown;
      filepath?: unknown;
      toolCallId?: unknown;
      agentId?: unknown;
      stepId?: unknown;
    };
    const key = entry.file_id ?? entry.filepath;
    if (typeof key !== 'string' || !attachmentKeys.has(key)) return false;
    if (entry.toolCallId !== toolCallId) return false;
    const entryAgent = entry.agentId ?? null;
    if (agentId != null && entryAgent !== null && entryAgent !== agentId) return false;
    const entryStep = entry.stepId ?? null;
    if (stepId != null && entryStep !== null && entryStep !== stepId) return false;
    return true;
  };
  const existing = Array.isArray(prior) ? prior : [];
  return [...existing.filter((entry) => !replacesEntry(entry)), ...incomingAttachments];
}

/**
 * The content parts as the settlement leaves them, computed in memory to budget a bound App's
 * attachments against the whole message (exactly the `agentOwnershipFilter` precedence: part
 * agent, then call agent, then wildcard).
 */
export function settleToolCallContent(
  content: unknown,
  {
    toolCallId,
    stepId,
    agentId,
    output,
    markBackgrounded,
    backgroundTask,
  }: UpdateToolCallResultInput,
): unknown[] {
  const parts = Array.isArray(content) ? content : [];
  return parts.map((entry) => {
    if (entry == null || typeof entry !== 'object') return entry;
    const part = entry as {
      type?: unknown;
      agentId?: unknown;
      tool_call?: {
        id?: unknown;
        stepId?: unknown;
        agentId?: unknown;
        backgroundTask?: Record<string, unknown>;
      };
    };
    const owner = part.agentId ?? part.tool_call?.agentId;
    if (
      part.type !== 'tool_call' ||
      part.tool_call?.id !== toolCallId ||
      (stepId != null && part.tool_call.stepId !== stepId) ||
      (agentId != null && owner != null && owner !== agentId)
    )
      return entry;
    const task = { ...part.tool_call.backgroundTask };
    if (backgroundTask) {
      Object.assign(task, {
        version: 1,
        taskId: backgroundTask.taskId,
        toolName: backgroundTask.toolName,
        status: backgroundTask.status,
        cancelled: backgroundTask.cancelled === true,
        settledAt: backgroundTask.settledAt,
      });
      if (backgroundTask.completionReceipt) task.completionReceipt = true;
      if (backgroundTask.completionWakeup) task.completionWakeup = true;
      else delete task.completionWakeup;
    }
    return {
      ...part,
      tool_call: {
        ...part.tool_call,
        ...(output !== undefined && { output }),
        ...((output !== undefined || backgroundTask != null) &&
          markBackgrounded && { backgrounded: true }),
        ...(backgroundTask && { backgroundTask: task }),
      },
    };
  });
}

/** A request of `claimBackgroundToolResults`. */
export interface BackgroundToolResultClaimInput {
  userId: string;
  conversationId: string;
  messageId?: string;
  taskId: string;
  agentId?: string;
  kind: 'manual' | 'wakeup';
  claimId: string;
  batchId?: string;
  generationId?: string;
  allowUnfinished?: boolean;
  limit?: number;
  maxMetadataChars?: number;
}

/** A validated claim request, with its defaults applied and its ids trimmed. */
export interface BackgroundToolResultClaimRequest {
  userId: string;
  conversationId: string;
  requestedMessageId?: string;
  requestedGenerationId?: string;
  taskId: string;
  agentId?: string;
  kind: 'manual' | 'wakeup';
  claimId: string;
  batchId?: string;
  allowUnfinished: boolean;
  boundedLimit: number;
  maxMetadataChars?: number;
}

/** Validates a claim request (a `TypeError` otherwise) and applies its defaults. */
export function normalizeBackgroundToolResultClaim({
  userId,
  conversationId,
  messageId,
  taskId,
  agentId,
  kind,
  claimId,
  generationId,
  batchId,
  allowUnfinished = false,
  limit = kind === 'wakeup' ? 8 : 1,
  maxMetadataChars,
}: BackgroundToolResultClaimInput): BackgroundToolResultClaimRequest {
  const requestedMessageId = messageId?.trim();
  const requestedGenerationId = generationId?.trim();
  if (
    (requestedMessageId != null &&
      (requestedMessageId.length === 0 || requestedMessageId.length > 256)) ||
    (batchId != null && (batchId.length === 0 || batchId.length > 128 || kind !== 'wakeup')) ||
    taskId.length === 0 ||
    taskId.length > 256 ||
    claimId.length === 0 ||
    claimId.length > 128 ||
    (requestedGenerationId != null &&
      (requestedGenerationId.length === 0 || requestedGenerationId.length > 256)) ||
    (requestedGenerationId != null && kind !== 'manual') ||
    (allowUnfinished && kind !== 'manual') ||
    (kind !== 'manual' && kind !== 'wakeup') ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    (maxMetadataChars != null && (!Number.isSafeInteger(maxMetadataChars) || maxMetadataChars < 1))
  ) {
    throw new TypeError('Invalid background tool result claim');
  }
  return {
    userId,
    conversationId,
    requestedMessageId,
    requestedGenerationId,
    taskId,
    agentId,
    kind,
    claimId,
    batchId,
    allowUnfinished,
    boundedLimit: Math.max(1, Math.min(MAX_BACKGROUND_TOOL_RESULT_BATCH, limit)),
    maxMetadataChars,
  };
}

/** The newest message a claim reads: the requested one, or the one holding the task. */
export function backgroundClaimSourceFilter(
  request: BackgroundToolResultClaimRequest,
): Record<string, unknown> {
  return {
    user: request.userId,
    conversationId: request.conversationId,
    ...(request.requestedMessageId != null
      ? { messageId: request.requestedMessageId }
      : {
          content: {
            $elemMatch: { 'tool_call.backgroundTask.taskId': request.taskId },
          },
        }),
  };
}

/** The newest message holding the task's launch handle in a tool call's output. */
export function backgroundTaskHandleFilter(
  request: BackgroundToolResultClaimRequest,
): Record<string, unknown> {
  const escapedTaskId = request.taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    user: request.userId,
    conversationId: request.conversationId,
    content: {
      $elemMatch: {
        type: 'tool_call',
        'tool_call.output': new RegExp(`"background_task_id"\\s*:\\s*"${escapedTaskId}"`),
        ...(request.agentId == null ? {} : agentOwnershipFilter('', request.agentId)),
      },
    },
  };
}

/** What a claim writes once its source message was read. */
export interface BackgroundToolResultClaimWrite {
  resolvedMessageId: string;
  /** `{ messageId }` when the request did not name the message. */
  recoveredSource: { messageId?: string };
  /** A lost-receipt retry replays exactly its original assignment. */
  replaying: boolean;
  /** The tasks the claim takes, the requested one first. */
  candidates: string[];
  claimStamp: Record<string, unknown>;
}

/**
 * The claim's outcome from its source message alone (`not_ready`, `claimed`, `not_found`), or
 * the write that takes the requested task and the siblings a wakeup batches with it.
 */
export function planBackgroundToolResultClaim(
  row: Pick<IMessage, 'content' | 'unfinished' | 'messageId'>,
  request: BackgroundToolResultClaimRequest,
): { outcome: BackgroundToolResultClaim } | { write: BackgroundToolResultClaimWrite } {
  const { taskId, agentId, kind, claimId, batchId, boundedLimit, maxMetadataChars } = request;
  /** Only an owner-process manual poll that already retired automatic
   * delivery may consume a terminal receipt on an unfinished response.
   * Every other claimant waits for finalization, preventing a poll from
   * racing the automatic continuation while the parent generation runs. */
  if (row.unfinished === true && !(kind === 'manual' && request.allowUnfinished)) {
    return { outcome: { status: 'not_ready' } };
  }
  const resolvedMessageId = row.messageId;
  if (typeof resolvedMessageId !== 'string' || resolvedMessageId.length === 0) {
    return { outcome: { status: 'not_found' } };
  }
  const recoveredSource =
    request.requestedMessageId == null ? { messageId: resolvedMessageId } : {};
  const requestedClaim = readBackgroundToolResultClaim(row, taskId);
  const replaying =
    requestedClaim?.kind === kind &&
    requestedClaim.claimId === claimId &&
    requestedClaim.batchId === batchId;
  const candidates: string[] = [];
  const costs = new Map<string, number>();
  let receiptBacked = false;
  let requestedState: 'ready' | 'claimed' | 'missing' = 'missing';
  for (const part of row.content ?? []) {
    if (part == null || typeof part !== 'object' || Array.isArray(part)) {
      continue;
    }
    const task = (part as { tool_call?: { backgroundTask?: Record<string, unknown> } }).tool_call
      ?.backgroundTask;
    const partRecord = part as { agentId?: unknown; tool_call?: { agentId?: unknown } };
    const partAgentId = partRecord.agentId ?? partRecord.tool_call?.agentId;
    const candidateId = task?.taskId;
    if (typeof candidateId !== 'string') {
      continue;
    }
    const terminal = task?.status === 'completed' || task?.status === 'error';
    const wakeupEligible = kind !== 'wakeup' || task?.completionWakeup === true;
    const resultClaim = task?.resultClaim as
      | { kind?: unknown; claimId?: unknown; batchId?: unknown }
      | undefined;
    const replay =
      resultClaim?.kind === kind &&
      resultClaim.claimId === claimId &&
      resultClaim.batchId === batchId;
    const sameAgent =
      agentId == null ||
      partAgentId == null ||
      (typeof partAgentId === 'string' && partAgentId === agentId);
    /** A lost-receipt retry replays exactly its original assignment. It must
     * not absorb siblings that completed after the already-admitted input
     * was constructed, or those results would be claimed but never shown. */
    const claimable =
      terminal && wakeupEligible && sameAgent && (replaying ? replay : resultClaim == null);
    if (candidateId === taskId) {
      receiptBacked = task?.completionReceipt === true;
      if (claimable) {
        requestedState = 'ready';
      } else if (resultClaim != null) {
        requestedState = 'claimed';
      }
    }
    if (
      claimable &&
      (candidateId === taskId || task?.completionReceipt !== true) &&
      (candidateId === taskId || kind === 'wakeup') &&
      candidates.length < boundedLimit
    ) {
      candidates.push(candidateId);
    }
    if (claimable && (candidateId === taskId || candidates.includes(candidateId))) {
      const call = (part as { tool_call?: { id?: string } }).tool_call;
      if (typeof call?.id === 'string' && typeof task?.toolName === 'string') {
        const terminalStatus = task.status === 'error' ? 'error' : 'completed';
        costs.set(
          candidateId,
          JSON.stringify(
            backgroundResultMetadata({
              taskId: candidateId,
              toolCallId: call.id,
              toolName: task.toolName,
              status: task.cancelled === true ? 'cancelled' : terminalStatus,
            }),
          ).length + 1,
        );
      }
    }
  }
  if (requestedState === 'missing') {
    return { outcome: { status: 'not_ready' } };
  }
  if (requestedState === 'claimed') {
    return {
      outcome: {
        status: 'claimed',
        ...(requestedClaim == null ? {} : { claim: requestedClaim }),
        ...recoveredSource,
      },
    };
  }
  if (!candidates.includes(taskId)) {
    candidates.unshift(taskId);
    candidates.splice(boundedLimit);
  }
  if (!replaying) {
    /** A receipt lives on another document, so it cannot join this atomic
     * message-row batch. Keep its delivery task-local in both directions. */
    if (receiptBacked) candidates.splice(0, candidates.length, taskId);
    if (maxMetadataChars != null) {
      let remaining = maxMetadataChars - 1 - (costs.get(taskId) ?? maxMetadataChars);
      if (remaining < 0) throw new TypeError('Background result metadata exceeds its input budget');
      const admitted = candidates.filter((id) => {
        if (id === taskId) return true;
        const cost = costs.get(id) ?? maxMetadataChars;
        if (cost > remaining) return false;
        remaining -= cost;
        return true;
      });
      candidates.splice(0, candidates.length, ...admitted);
    }
  }
  const claimedAt = new Date();
  const claimStamp = {
    kind,
    claimId,
    claimedAt,
    ...(batchId != null && { batchId }),
    ...(kind === 'manual' && request.requestedGenerationId != null
      ? { generationId: request.requestedGenerationId }
      : {}),
  };
  return { write: { resolvedMessageId, recoveredSource, replaying, candidates, claimStamp } };
}

/**
 * The guard of a claim's write: the source message still finished (unless an owner takeover),
 * with the requested task terminal and either unclaimed or (on a replay) claimed by this exact
 * claimant. A store adds the agent scope of the requested part (`agentId`) in its own dialect.
 */
export function backgroundClaimWriteFilter(
  request: BackgroundToolResultClaimRequest,
  write: BackgroundToolResultClaimWrite,
): Record<string, unknown> {
  const { taskId, kind, claimId, batchId } = request;
  return {
    user: request.userId,
    conversationId: request.conversationId,
    messageId: write.resolvedMessageId,
    ...(kind === 'manual' && request.allowUnfinished ? {} : { unfinished: { $ne: true } }),
    content: {
      $elemMatch: {
        type: 'tool_call',
        'tool_call.backgroundTask.taskId': taskId,
        'tool_call.backgroundTask.status': { $in: ['completed', 'error'] },
        ...(kind === 'wakeup' ? { 'tool_call.backgroundTask.completionWakeup': true } : {}),
        ...(write.replaying
          ? {
              'tool_call.backgroundTask.resultClaim.kind': kind,
              'tool_call.backgroundTask.resultClaim.claimId': claimId,
              'tool_call.backgroundTask.resultClaim.batchId': batchId ?? null,
            }
          : /** Missing OR stored null: the in-memory claimable scan, the
             * claim arrayFilters, and the settle stamp all treat a null
             * claim as unclaimed, and the subfield-preserving settle write
             * keeps a persisted null a whole-object rewrite used to drop.
             * `$exists: false` here would strand such a part as terminal
             * but permanently unclaimable. */
            { 'tool_call.backgroundTask.resultClaim': null }),
      },
    },
  };
}

/**
 * The claim's stamp on every part the pass admitted: the filtered positional operator selects
 * those parts by predicate, so the write touches only them.
 */
export function backgroundClaimStampUpdate(
  request: BackgroundToolResultClaimRequest,
  write: BackgroundToolResultClaimWrite,
): { update: Record<string, unknown>; arrayFilters: Array<Record<string, unknown>> } {
  const { kind, agentId } = request;
  return {
    update: { $set: { 'content.$[part].tool_call.backgroundTask.resultClaim': write.claimStamp } },
    arrayFilters: [
      {
        'part.type': 'tool_call',
        'part.tool_call.backgroundTask.taskId': { $in: write.candidates },
        'part.tool_call.backgroundTask.status': { $in: ['completed', 'error'] },
        ...(kind === 'wakeup' ? { 'part.tool_call.backgroundTask.completionWakeup': true } : {}),
        $and: [
          {
            'part.tool_call.backgroundTask.resultClaim': null,
          },
          ...(agentId == null ? [] : [agentOwnershipFilter('part.', agentId)]),
        ],
      },
    ],
  };
}

/** The claim's outcome from the message its write left (or `null` when the guard failed). */
export function backgroundClaimOutcome(
  updated: Pick<IMessage, 'content'> | null,
  request: BackgroundToolResultClaimRequest,
  write: BackgroundToolResultClaimWrite,
): BackgroundToolResultClaim {
  if (updated == null) {
    return { status: 'not_ready' };
  }
  const { taskId, kind, claimId, batchId } = request;
  const results = parseBackgroundToolResults(updated as IMessage, { kind, claimId, batchId });
  const competingClaim = readBackgroundToolResultClaim(updated, taskId);
  return results.some((result) => result.taskId === taskId)
    ? { status: 'acquired', results, ...write.recoveredSource }
    : {
        status: 'claimed',
        ...(competingClaim == null ? {} : { claim: competingClaim }),
        ...write.recoveredSource,
      };
}

/** The exact manual claim `confirmBackgroundToolResultClaim` commits, as a part predicate. */
export function confirmedBackgroundClaimIdentity(input: {
  taskId: string;
  claimId: string;
}): Record<string, unknown> {
  return {
    'tool_call.backgroundTask.taskId': input.taskId,
    'tool_call.backgroundTask.resultClaim.kind': 'manual',
    'tool_call.backgroundTask.resultClaim.claimId': input.claimId,
  };
}

/** The commit of a manual claim: the guard, the receipt mark and its `arrayFilters`. */
export function planBackgroundClaimConfirmation(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  taskId: string;
  claimId: string;
}): {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  arrayFilters: Array<Record<string, unknown>>;
  /** The committed state a lost write reply is checked against. */
  committedFilter: Record<string, unknown>;
} {
  const identity = confirmedBackgroundClaimIdentity(input);
  const owner = {
    user: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
  };
  return {
    filter: { ...owner, content: { $elemMatch: identity } },
    update: {
      $set: { 'content.$[part].tool_call.backgroundTask.resultClaim.receiptReconciled': true },
    },
    arrayFilters: [
      {
        'part.tool_call.backgroundTask.taskId': input.taskId,
        'part.tool_call.backgroundTask.resultClaim.kind': 'manual',
        'part.tool_call.backgroundTask.resultClaim.claimId': input.claimId,
      },
    ],
    committedFilter: {
      ...owner,
      content: {
        $elemMatch: {
          ...identity,
          'tool_call.backgroundTask.resultClaim.receiptReconciled': true,
        },
      },
    },
  };
}

/** A request of `releaseBackgroundToolResultClaims`. */
export interface BackgroundClaimReleaseInput {
  userId: string;
  conversationId: string;
  messageId: string;
  taskIds?: string[];
  allowMissingMessage?: true;
  onlyIfUnreconciled?: true;
  batchId?: string;
  kind: 'manual' | 'wakeup';
  claimId: string;
}

/**
 * The release of exactly one claimant's claims: the guard (a `content` array, since the filtered
 * positional operator errors on a row without one), the unset and its `arrayFilters`. `null`
 * when there is nothing to release (an empty `taskIds`); a `TypeError` for an unreconciled
 * rollback of a wakeup.
 */
export function planBackgroundClaimRelease({
  userId,
  conversationId,
  messageId,
  taskIds,
  onlyIfUnreconciled,
  kind,
  claimId,
  batchId,
}: BackgroundClaimReleaseInput): {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  arrayFilters: Array<Record<string, unknown>>;
} | null {
  if (onlyIfUnreconciled === true && kind !== 'manual')
    throw new TypeError('Unreconciled rollback requires a manual claim');
  if (taskIds?.length === 0) {
    return null;
  }
  return {
    filter: { user: userId, conversationId, messageId, content: { $type: 'array' } },
    update: { $unset: { 'content.$[part].tool_call.backgroundTask.resultClaim': 1 } },
    arrayFilters: [
      {
        'part.tool_call.backgroundTask.resultClaim.kind': kind,
        'part.tool_call.backgroundTask.resultClaim.claimId': claimId,
        'part.tool_call.backgroundTask.resultClaim.batchId': batchId ?? null,
        ...(onlyIfUnreconciled === true && {
          'part.tool_call.backgroundTask.resultClaim.receiptReconciled': { $ne: true },
        }),
        ...(taskIds == null ? {} : { 'part.tool_call.backgroundTask.taskId': { $in: taskIds } }),
      },
    ],
  };
}

/** Whether the release left none of the claimant's claims on the requested tasks. */
export function backgroundClaimsReleased(
  updated: Pick<IMessage, 'content'>,
  { kind, claimId, batchId, taskIds }: BackgroundClaimReleaseInput,
): boolean {
  const remaining = parseBackgroundToolResults(updated as IMessage, { kind, claimId, batchId });
  return taskIds == null
    ? remaining.length === 0
    : !remaining.some((result) => taskIds.includes(result.taskId));
}

/* ------------------------------------------------------------ subagent tasks */

/** A request of `recordSubagentTaskControlReceipt`. */
export interface SubagentControlReceiptInput {
  userId: string;
  conversationId: string;
  taskId: string;
  tenantId?: string;
  receipt: StoredSubagentControlReceipt;
}

/**
 * Validates a control receipt write (a `TypeError` otherwise) and resolves the task input it is
 * recorded on: the user's `<taskId>:user` message in the given tenant (none: stored without
 * one), while its task runs, or settled too for an authoritative `task_not_running` rejection.
 */
export function subagentControlReceiptIdentity({
  userId,
  conversationId,
  taskId,
  tenantId,
  receipt,
}: SubagentControlReceiptInput): Record<string, unknown> {
  const validActions = new Set(['steer', 'queue', 'interrupt', 'cancel', 'cancel_message']);
  const validStatuses = new Set(['reserved', 'accepted', 'applied', 'rejected', 'failed']);
  if (
    userId.length === 0 ||
    conversationId.length === 0 ||
    conversationId.length > 256 ||
    taskId.length === 0 ||
    taskId.length > 256 ||
    receipt.invocationId.length === 0 ||
    receipt.invocationId.length > 128 ||
    receipt.fingerprint.length === 0 ||
    receipt.fingerprint.length > 128 ||
    !validActions.has(receipt.action) ||
    !validStatuses.has(receipt.status) ||
    (receipt.controlId != null && receipt.controlId.length > 256) ||
    (receipt.message != null && receipt.message.length > MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH) ||
    !Number.isFinite(receipt.createdAt.getTime()) ||
    !Number.isFinite(receipt.updatedAt.getTime())
  ) {
    throw new TypeError('Invalid subagent task control receipt');
  }
  const recordsTerminalRejection =
    receipt.status === 'rejected' && receipt.reason === 'task_not_running';
  return {
    user: userId,
    conversationId,
    ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
    messageId: `${taskId}:user`,
    /** A genuinely new command can arrive after its task settles or its final
     * lease expires. Persist that authoritative rejection for retries; every
     * command that could still be applied remains fenced to a running task. */
    ...(recordsTerminalRejection
      ? { 'subagentTask.status': { $in: ['running', 'completed', 'error', 'cancelled'] } }
      : { 'subagentTask.status': 'running' }),
  };
}

/** Validates the identity of a single receipt read (a `TypeError` otherwise). */
export function validateSubagentControlReceiptRead(input: {
  userId: string;
  conversationId: string;
  taskId: string;
  invocationId: string;
}): void {
  if (
    input.userId.length === 0 ||
    input.conversationId.length === 0 ||
    input.conversationId.length > 256 ||
    input.taskId.length === 0 ||
    input.taskId.length > 256 ||
    input.invocationId.length === 0 ||
    input.invocationId.length > 128
  ) {
    throw new TypeError('Invalid subagent task control receipt identity');
  }
}

/**
 * The public receipt of one invocation among a task input's receipts: reservations are a
 * server-private at-most-once fence, not proof that a control was applied, so they read as
 * `null`.
 */
export function publicSubagentControlReceipt(
  receipts: readonly StoredSubagentControlReceipt[] | undefined,
  invocationId: string,
): StoredSubagentControlReceipt | null {
  const receipt = receipts?.find((candidate) => candidate.invocationId === invocationId);
  return receipt?.status === 'reserved' ? null : (receipt ?? null);
}

/** Validates the identity of a receipt replay (a `TypeError` otherwise). */
export function validateSubagentControlReplay(input: {
  userId: string;
  parentConversationId: string;
  taskId: string;
  invocationId: string;
}): void {
  if (
    input.userId.length === 0 ||
    input.parentConversationId.length === 0 ||
    input.parentConversationId.length > 256 ||
    input.taskId.length === 0 ||
    input.taskId.length > 256 ||
    input.invocationId.length === 0 ||
    input.invocationId.length > 128
  ) {
    throw new TypeError('Invalid subagent task control replay identity');
  }
}

/** A receipt replay: the receipt and a summary of its task. */
export interface SubagentControlReplay {
  receipt: StoredSubagentControlReceipt;
  task: {
    taskId: string;
    threadId: string;
    subagentType: string;
    status: 'running' | 'completed' | 'error' | 'cancelled';
    resultAvailable: boolean;
    resultClaimed: boolean;
    pendingControls: number;
    createdAt: Date;
    updatedAt: Date;
  };
}

/**
 * The replay of one receipt from the task input holding it, the child thread's subagent type
 * (read through the caller's parent conversation) and the task's terminal row, or `null`.
 */
export function toSubagentControlReplay(
  taskId: string,
  invocationId: string,
  input: Pick<IMessage, 'conversationId' | 'createdAt' | 'updatedAt' | 'subagentTask'>,
  subagentType: string | null | undefined,
  terminal: Pick<IMessage, 'updatedAt' | 'subagentTask'> | null,
): SubagentControlReplay | null {
  const receipt = input.subagentTask?.controlReceipts?.find(
    (candidate) => candidate.invocationId === invocationId,
  );
  const status = input.subagentTask?.status;
  if (receipt == null || status == null || input.createdAt == null || input.updatedAt == null) {
    return null;
  }
  if (subagentType == null || subagentType === '') return null;
  /** A committed cancel receipt is itself the authoritative cancellation
   * boundary. The terminal row is written asynchronously and may not exist if
   * the owner exits between those two durable commits. */
  const replayStatus =
    terminal?.subagentTask?.status ??
    (receipt.action === 'cancel' && receipt.status === 'applied' ? 'cancelled' : status);
  return {
    receipt,
    task: {
      taskId,
      threadId: input.conversationId,
      subagentType,
      status: replayStatus,
      resultAvailable: terminal != null,
      resultClaimed: terminal?.subagentTask?.resultClaim != null,
      pendingControls:
        input.subagentTask?.controlReceipts?.filter((candidate) => candidate.status === 'accepted')
          .length ?? 0,
      createdAt: input.createdAt,
      updatedAt:
        terminal?.updatedAt ??
        (receipt.action === 'cancel' && receipt.status === 'applied'
          ? receipt.updatedAt
          : input.updatedAt),
    },
  };
}

/** The terminal statuses of a subagent task. */
export const SUBAGENT_TERMINAL_STATUSES: string[] = ['completed', 'error', 'cancelled'];

/** The fields of a task result a claim resolves. */
export const SUBAGENT_RESULT_PROJECTION = {
  messageId: 1,
  conversationId: 1,
  parentMessageId: 1,
  sender: 1,
  text: 1,
  error: 1,
  createdAt: 1,
  updatedAt: 1,
  subagentTask: 1,
} as const;

/** Validates a task result claim or release (a `TypeError` with `message` otherwise). */
export function validateSubagentResultClaim(
  input: { conversationId: string; taskId: string; kind: string; claimId: string },
  message: string,
): void {
  if (
    input.taskId.length === 0 ||
    input.taskId.length > 256 ||
    input.conversationId.length === 0 ||
    input.conversationId.length > 256 ||
    (input.kind !== 'manual' && input.kind !== 'wakeup') ||
    input.claimId.length === 0 ||
    input.claimId.length > 128
  ) {
    throw new TypeError(message);
  }
}

/**
 * Who may take a terminal task result: an unclaimed one, this exact claimant again, or (manual)
 * a legacy claim that names this claim id without a kind.
 */
export function subagentResultClaimable(
  kind: 'manual' | 'wakeup',
  claimId: string,
): Record<string, unknown> {
  return {
    $or: [
      { 'subagentTask.resultClaim': { $exists: false } },
      {
        'subagentTask.resultClaim.kind': kind,
        'subagentTask.resultClaim.claimId': claimId,
      },
      ...(kind === 'manual'
        ? [
            {
              'subagentTask.resultClaim.kind': { $exists: false },
              'subagentTask.resultClaim.claimId': claimId,
            },
          ]
        : []),
    ],
  };
}

/** The bounded window of task rows `listSubagentTasksForThreads` reads beside the latest ones. */
export function subagentTaskSourceLimit(input: {
  conversationIds: readonly string[];
  limitPerThread: number;
}): number {
  return Math.min(
    4096,
    Math.max(input.conversationIds.length, input.conversationIds.length * input.limitPerThread * 2),
  );
}

/** A task record with the private ordering token a store merges by (its record id). */
type OrderedSubagentTask = Omit<ParentSubagentTaskRecord['tasks'][number], 'occurrenceId'> & {
  occurrenceId?: { toString(): string };
};

/** A child thread's tasks as one of the two bounded reads returns them. */
export interface SubagentTaskThreadRecord<T extends OrderedSubagentTask = OrderedSubagentTask> {
  conversationId: string;
  tasks: T[];
  sourceTruncated?: boolean;
}

/**
 * Merges the two bounded reads of `listSubagentTasksForThreads`: the latest task of every child
 * (`latestRecords`) and the newest tasks of the shared recent window (`recentRecords`, whose
 * rows counted `sourceRows` against `sourceLimit`), newest first per thread, at most
 * `limitPerThread`, by conversation id.
 */
export function mergeSubagentTaskRecords<T extends OrderedSubagentTask>(
  latestRecords: ReadonlyArray<SubagentTaskThreadRecord<T>>,
  recentRecords: ReadonlyArray<SubagentTaskThreadRecord<T> & { sourceRows?: number }>,
  sourceLimit: number,
  limitPerThread: number,
): Array<SubagentTaskThreadRecord<T>> {
  const compareOccurrenceIds = (
    left?: { toString(): string },
    right?: { toString(): string },
  ): number => {
    const leftValue = left == null ? '' : left.toString();
    const rightValue = right == null ? '' : right.toString();
    if (leftValue === rightValue) return 0;
    return leftValue > rightValue ? 1 : -1;
  };
  const taskTimestamp = (value: Date | undefined): number =>
    value == null ? Number.NEGATIVE_INFINITY : value.getTime();
  const sourceTruncated =
    recentRecords.reduce((total, record) => total + (record.sourceRows ?? 0), 0) > sourceLimit;
  const records = new Map<string, SubagentTaskThreadRecord<T>>(
    recentRecords.map((record) => [
      record.conversationId,
      {
        conversationId: record.conversationId,
        tasks: record.tasks,
        ...(sourceTruncated ? { sourceTruncated: true } : {}),
      },
    ]),
  );
  for (const latest of latestRecords) {
    const current = records.get(latest.conversationId);
    if (current == null) {
      records.set(latest.conversationId, {
        ...latest,
        ...(sourceTruncated ? { sourceTruncated: true } : {}),
      });
      continue;
    }
    const candidates = [...current.tasks, ...latest.tasks];
    const tasksById = new Map<string, T>();
    for (const candidate of candidates) {
      const taskId = candidate.messageId.replace(/:(user|assistant)$/, '');
      const existing = tasksById.get(taskId);
      const candidateTime = taskTimestamp(candidate.createdAt);
      const existingTime = taskTimestamp(existing?.createdAt);
      const candidateIsAssistant = candidate.messageId.endsWith(':assistant');
      const existingIsAssistant = existing?.messageId.endsWith(':assistant') === true;
      const occurrenceDifference = compareOccurrenceIds(
        candidate.occurrenceId,
        existing?.occurrenceId,
      );
      if (
        existing == null ||
        candidateTime > existingTime ||
        (candidateTime === existingTime && occurrenceDifference > 0) ||
        (candidateTime === existingTime &&
          occurrenceDifference === 0 &&
          candidateIsAssistant &&
          !existingIsAssistant)
      ) {
        tasksById.set(taskId, candidate);
      }
    }
    current.tasks = [...tasksById.values()]
      .sort((left, right) => {
        const timeDifference = taskTimestamp(right.createdAt) - taskTimestamp(left.createdAt);
        if (timeDifference !== 0) return timeDifference;
        const occurrenceDifference = compareOccurrenceIds(right.occurrenceId, left.occurrenceId);
        if (occurrenceDifference !== 0) return occurrenceDifference;
        const assistantDifference =
          Number(right.messageId.endsWith(':assistant')) -
          Number(left.messageId.endsWith(':assistant'));
        if (assistantDifference !== 0) return assistantDifference;
        return left.messageId.localeCompare(right.messageId);
      })
      .slice(0, limitPerThread);
  }
  return [...records.values()].sort((left, right) =>
    left.conversationId.localeCompare(right.conversationId),
  );
}

/* --------------------------------------------------------------------- traces */

/** A sampled response as the trace references read it. */
export type SampledTraceRow = Pick<
  IMessage,
  'messageId' | 'createdAt' | 'langfuseDestinationIds' | 'langfuseRunId'
> & { _id: { toString(): string } };

/** The range of a trace page through a position (`through`), or `{}` without one. */
export function traceRange(
  anchor: { createdAt: Date; id: unknown } | undefined,
): Record<string, unknown> {
  return anchor != null
    ? {
        $or: [
          { createdAt: { $lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, _id: { $lte: anchor.id } },
        ],
      }
    : {};
}

/**
 * The trace references from the conversation's first message time and the sampled responses read
 * (oldest first); a position that no longer names its response resumes nothing.
 */
export function toConversationTraceRefs(
  firstMessageAt: Date | undefined,
  sampled: readonly SampledTraceRow[],
  through?: { messageId: string },
): ConversationTraceRefs {
  /** A position that no longer names its response (deleted, or never issued) resumes nothing. */
  if (through != null && sampled[sampled.length - 1]?.messageId !== through.messageId) {
    return { firstMessageAt, sampledMessages: [] };
  }
  return {
    firstMessageAt,
    sampledMessages: sampled
      .filter((message) => typeof message.messageId === 'string')
      .map(({ _id, messageId: id, createdAt, langfuseDestinationIds, langfuseRunId }) => ({
        messageId: id,
        ...(createdAt != null ? { createdAt, orderKey: traceOrderKey(createdAt, _id) } : {}),
        ...(Array.isArray(langfuseDestinationIds) ? { langfuseDestinationIds } : {}),
        ...(typeof langfuseRunId === 'string' && langfuseRunId.length > 0 ? { langfuseRunId } : {}),
      })),
  };
}

/** The sampled responses of a destination: those recording it, and those recording none. */
export function sampledTraceDestinationFilter(destinationIds: string[]): Record<string, unknown> {
  return {
    $or: [{ langfuseDestinationIds: null }, { langfuseDestinationIds: { $in: destinationIds } }],
  };
}

/* ---------------------------------------------------------------------- reads */

/** A message's branch links and reasoning level, as the branch walk reads them. */
export type BranchReasoningRow = Pick<
  IMessage,
  'messageId' | 'parentMessageId' | 'isCreatedByUser' | 'reasoningOverride'
>;

/**
 * The override on the nearest user message at or above `parentMessageId` that carries one, or
 * `null`; a cycle in the links ends the walk.
 */
export function findBranchReasoningOverride(
  rows: readonly BranchReasoningRow[],
  parentMessageId: string,
): IMessage['reasoningOverride'] | null {
  const byId = new Map(rows.map((row) => [row.messageId, row]));
  const visited = new Set<string>();
  let current = byId.get(parentMessageId);
  while (current != null && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    if (current.isCreatedByUser === true && current.reasoningOverride != null) {
      return current.reasoningOverride;
    }
    current = current.parentMessageId != null ? byId.get(current.parentMessageId) : undefined;
  }
  return null;
}

/** The page filter after a cursor (`after`), or `filter` itself at the first page. */
export function messagePageFilter(
  filter: Record<string, unknown>,
  sortField: string,
  sortOrder: 1 | -1,
  cursor: string | null | undefined,
  toId: (hex: string) => unknown,
): Record<string, unknown> {
  const queryFilter: Record<string, unknown> = { ...filter };
  const position = cursor ? parseMessageCursor(cursor) : null;
  if (position != null) {
    const op = sortOrder === 1 ? '$gt' : '$lt';
    const value =
      DATE_SORT_FIELDS.has(sortField) && position.value !== NULL_SORT_VALUE
        ? new Date(position.value)
        : position.value;
    const id = position.id == null ? undefined : toId(position.id);
    const after = buildCursorFilter(sortField, op, value, { value: position.value, id });
    queryFilter.$and = [...((queryFilter.$and as unknown[] | undefined) ?? []), after];
  }
  return queryFilter;
}

/** The projection a page reads: the cursor needs `_id`, so `-_id` is applied after the read. */
export function messagePageProjection(select: string | undefined): {
  projection?: string;
  omitId: boolean;
} {
  const tokens = select ? select.split(/\s+/).filter(Boolean) : [];
  return {
    ...(tokens.length > 0 && {
      projection: tokens.filter((token) => token !== '-_id').join(' '),
    }),
    omitId: tokens.includes('-_id'),
  };
}

/** The page from the `limit + 1` rows read: the next cursor from its last row, `-_id` applied. */
export function finishMessagePage<T extends { _id?: unknown }>(
  messages: T[],
  limit: number,
  sortField: string,
  omitId: boolean,
): { messages: T[]; nextCursor: string | null } {
  let nextCursor: string | null = null;
  if (messages.length > limit) {
    messages.pop();
    const last = messages[messages.length - 1];
    nextCursor = formatMessageCursor((last as Record<string, unknown>)[sortField], last._id);
  }
  if (omitId) {
    for (const message of messages) {
      delete message._id;
    }
  }
  return { messages, nextCursor };
}

/* -------------------------------------------------------------------- deletes */

/** Whether a message id names a subagent task's input or result row. */
export const isSubagentTaskMessageId = (messageId: string): boolean =>
  /:(user|assistant)$/.test(messageId);

/**
 * Whether a delete covers whole conversations of one user (only `user`, `conversationId` and
 * `tenantId`), whose subagent content goes by the same scope.
 */
export function isWholeMessageScope(filter: Record<string, unknown>): boolean {
  return (
    typeof filter.user === 'string' &&
    Object.keys(filter).every((key) => ['user', 'conversationId', 'tenantId'].includes(key))
  );
}

/** One run's content scope, as a subagent content filter. */
export interface SubagentContentDeletionScope {
  user: string;
  conversationId: string;
  taskId: string;
  tenantId: string | { $exists: false };
}

/** The subagent runs whose task rows a delete removes, one scope per run. */
export function subagentContentDeletionScopes(
  sources: ReadonlyArray<Pick<IMessage, 'user' | 'conversationId' | 'messageId' | 'tenantId'>>,
): SubagentContentDeletionScope[] {
  const scopes = new Map<string, SubagentContentDeletionScope>();
  for (const source of sources) {
    const taskId = source.messageId.replace(/:(user|assistant)$/, '');
    if (taskId === source.messageId) continue;
    scopes.set(`${source.tenantId ?? ''}:${source.user}:${source.conversationId}:${taskId}`, {
      user: source.user,
      conversationId: source.conversationId,
      taskId,
      tenantId: source.tenantId ?? { $exists: false },
    });
  }
  return [...scopes.values()];
}

/**
 * The fence a scoped delete sets before discarding the runs' content: both task rows of each run
 * are marked deleted, so admitted appends stop and retries rediscover them.
 */
export function subagentContentDeletionFence(scopes: readonly SubagentContentDeletionScope[]): {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
} {
  return {
    filter: {
      $or: scopes.map(({ taskId, ...scope }) => ({
        ...scope,
        messageId: { $in: [`${taskId}:user`, `${taskId}:assistant`] },
      })),
    },
    update: { $set: { 'subagentContent.deleted': true } },
  };
}

/* --------------------------------------------------------------- private text */

/** A private text lookup: who, where, which message, which canonical text and revision. */
export interface PersistedPrivateTextInput {
  userId: string;
  tenantId?: string;
  conversationId: string;
  messageId: string;
  privacyRevision: string;
  text: string;
}

/** Whether `tenantId` is not the active tenant (an active tenant reads only its own). */
export function isForeignPrivateTextTenant(tenantId: string | undefined): boolean {
  const activeTenant = tenantStorage.getStore()?.tenantId;
  return activeTenant != null && activeTenant !== tenantId;
}

/**
 * The unexpired message holding a private original for exactly this text and revision, or
 * `null` when the lookup cannot match (a missing field, a conversation id that is not a UUID, a
 * tenant other than the active one).
 */
export function persistedPrivateTextFilter(
  input: PersistedPrivateTextInput,
): Record<string, unknown> | null {
  if (
    !input.userId ||
    !input.messageId ||
    !input.privacyRevision ||
    !UUID_REGEX.test(input.conversationId)
  ) {
    return null;
  }
  if (isForeignPrivateTextTenant(input.tenantId)) {
    return null;
  }
  return {
    user: input.userId,
    ...traceTenantScope(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    text: input.text,
    privacyRevision: input.privacyRevision,
    privateText: { $exists: true },
    $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
  };
}

/**
 * The unexpired user messages among `messageIds` holding a private original, or `null` when
 * `tenantId` is not the active tenant. Throws for more than 50 ids or a conversation id that is
 * not a UUID.
 */
export function privateMessageTextsFilter(input: {
  userId: string;
  tenantId?: string;
  conversationId: string;
  messageIds: readonly string[];
}): Record<string, unknown> | null {
  if (!input.userId || !UUID_REGEX.test(input.conversationId) || input.messageIds.length > 50) {
    throw new Error('Invalid private message read.');
  }
  if (isForeignPrivateTextTenant(input.tenantId)) {
    return null;
  }
  return {
    user: input.userId,
    ...traceTenantScope(input.tenantId),
    conversationId: input.conversationId,
    messageId: { $in: input.messageIds },
    isCreatedByUser: true,
    privateText: { $exists: true },
    $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
  };
}

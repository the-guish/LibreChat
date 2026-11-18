/**
 * The PostgreSQL `MessageStore` (`~/ports/message`) on the `messages` table, through the collection
 * primitive, with the rules of `~/methods/messageRules` (save and import plans, provenance,
 * tool-call settlement, the background-result and task-result claims, control receipts, traces,
 * the keyset page) and the thread view of `./messageThreadView`. Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * - `content`, `attachments` and `metadata` are `json` columns: predicates over content parts
 *   (`$elemMatch`, `$type: 'array'`, regular expressions on tool outputs) are jsonpath, and the
 *   positional part updates (`content.$[part].…` with `arrayFilters`) are the primitive's tier-2
 *   read-modify-write under the row lock, which keeps the other parts, their order and every key
 *   order.
 * - Every save advances `__v` as on MongoDB. Where the MongoDB method runs an optimistic
 *   compare-and-set on a whole stored array (the provenance merge, the attachment merge of a
 *   settlement, the stepless settlement fenced on the content it read, the control receipts),
 *   this store locks the row (`SELECT … FOR UPDATE`, `lockedRecord`), reads it in the next
 *   statement and writes it by `_id` in the same transaction: the write always sees the latest
 *   row, so no round is lost and no retry bound applies. A first save that inserts races the
 *   others on the unique `{ messageId, user, tenantId }` index and is retried, as on MongoDB.
 * - The agent scope of a background-result claim (an aggregation `$expr` on MongoDB) is the same
 *   predicate as `agentOwnershipFilter` on the requested part, so it is an `$elemMatch`.
 * - The MCP App budget measures the record as this backend stores it (the UTF-8 bytes of its
 *   canonical JSON, `postgresStoreDocuments`), with the same deployment budget.
 * - Hand-written SQL: `countMessagesByUser` (`GROUP BY "user"`), the newest task row of every
 *   listed thread (`DISTINCT ON ("conversationId")`) and the row locks.
 * - `searchUserMessages` searches the MeiliSearch `messages` index (`../search`, I3) with the
 *   user's filter; a hydrated search reads the stored messages by user and `messageId`, so a hit
 *   never carries another user's message. It rejects while MeiliSearch is not configured. The
 *   save path that writes with `updateOne` (a caller's `onWrite`) opts in to the search write
 *   hook, as MongoDB writes it with `findOneAndUpdate`.
 */
import { sql } from 'kysely';
import type { ProjectedSubagentThreadViewMessage } from '~/methods/messageRules';
import type { BackgroundToolResultClaimRequest } from '~/methods/messageRules';
import type { ThreadViewRow, ThreadViewSource } from './messageThreadView';
import type { UpdateToolCallResultInput } from '~/methods/messageRules';
import type { SteplessToolCallFallback } from '~/methods/messageRules';
import type { MessageSearchHit, MessageStore } from '~/ports/message';
import type { ParentSubagentTaskRecord } from '~/types';
import type { StoreTransaction } from '~/ports/common';
import type { PostgresStoreContext } from './context';
import type { IMessage } from '~/types';
import {
  NO_BOUND_APPS,
  UUID_REGEX,
  traceRange,
  prepareMessageSave,
  parseTraceOrderKey,
  traceTenantScope,
  sanitizeMessageUpdate,
  buildMessageSaveUpdate,
  mergeMessageProvenance,
  finishMessagePage,
  messagePageFilter,
  agentOwnershipFilter,
  toUpdatedMessageFields,
  messagePageProjection,
  backgroundClaimOutcome,
  isWholeMessageScope,
  isSubagentTaskMessageId,
  planToolCallSettlement,
  settleToolCallContent,
  subagentResultClaimable,
  subagentTaskSourceLimit,
  mergeToolCallAttachments,
  readBackgroundToolHandle,
  toConversationTraceRefs,
  toSubagentControlReplay,
  backgroundClaimsReleased,
  mergeSubagentTaskRecords,
  persistedPrivateTextFilter,
  privateMessageTextsFilter,
  backgroundClaimWriteFilter,
  backgroundTaskHandleFilter,
  backgroundClaimStampUpdate,
  SUBAGENT_RESULT_PROJECTION,
  SUBAGENT_TERMINAL_STATUSES,
  planBackgroundClaimRelease,
  findBranchReasoningOverride,
  backgroundClaimSourceFilter,
  findSteplessToolCallFallback,
  validateSubagentResultClaim,
  buildBulkSaveMessageOperation,
  buildInsertOnlyMessageUpdate,
  planPermanentChatTypeBackfill,
  planRetentionDeadlineBackfill,
  publicSubagentControlReceipt,
  subagentContentDeletionFence,
  planBackgroundToolResultClaim,
  retainSubagentControlReceipts,
  subagentContentDeletionScopes,
  sampledTraceDestinationFilter,
  pruneProjectedThreadViewMessage,
  subagentControlReceiptIdentity,
  validateSubagentControlReplay,
  planBackgroundClaimConfirmation,
  SERVER_AUTHORED_SAMPLED_RESPONSE,
  normalizeBackgroundToolResultClaim,
  validateSubagentControlReceiptRead,
  normalizeUserSubmittedPaths,
  normalizeUserSubmittedMessageFieldPaths,
  SUBAGENT_TRANSCRIPT_PAGE_LIMIT,
  SUBAGENT_ACTIVITY_SOURCE_CANDIDATE_LIMIT,
} from '~/methods/messageRules';
import {
  threadViewSource,
  transcriptAvailable,
  projectThreadViewMessage,
  hasThreadViewSourcePaths,
  activityProjectionAvailable,
} from './messageThreadView';
import { fitBoundAppSnapshotsBy, hasBoundAppSnapshots } from '~/methods/appSnapshotRules';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { asRecord, runStoreSql, storeWhere } from './context';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { postgresStoreDocuments } from '../storeDocuments';
import { activeExpirationFilter } from '~/utils/retention';
import { generatePostgresStoreId } from '../storeIds';
import { matchesExtendedFilter } from '../evaluator';
import { encodeJsonColumn } from '../values';
import logger from '~/config/winston';

type MessageRecord = IMessage & Record<string, unknown>;

/** What the message store is built with beside the context. */
export interface PostgresMessageStoreDeps {
  /** Read from deployment config, never from a message/request or a principal override. */
  getMCPAppMessageBudget?: () => Promise<number | undefined>;
}

/** The options of one write of `writeMessage`. */
interface WriteOptions {
  upsert: boolean;
  stampModelOutputOnInsert?: boolean;
  unsetContextMeta?: boolean;
  retentionOnInsert?: { expiredAt: Date; isTemporary: false };
  unsetPrivateText?: boolean;
  timestamps?: boolean;
  onWrite?: (inserted: boolean, id: unknown) => void;
}

/** First saves that insert race on the unique index; the losers retry as updates. */
const MAX_INSERT_ATTEMPTS = 8;

/** `+path` for every hidden path of the messages table: a record with its private fields. */
const PRIVATE_PROJECTION = (
  SCHEMA_DESCRIPTOR.tables.find((table) => table.name === 'messages')?.hiddenPaths ?? []
)
  .map((path) => `+${path}`)
  .join(' ');

/** The top-level paths the messages schema declares (with `_id`, timestamps and `__v`). */
const DECLARED_TOP_LEVEL = new Set([
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
  ...(SCHEMA_DESCRIPTOR.tables.find((table) => table.name === 'messages')?.fields ?? []).map(
    (field) => field.path.split('.')[0],
  ),
]);

/** A filter no record matches. */
const NO_MATCH = { _id: { $in: [] } };

/**
 * A caller's filter with its conditions on paths the schema does not declare resolved as MongoDB
 * resolves them on a strict schema's documents, which never hold such a field: each condition is
 * evaluated against a missing value (`{ missing: { $exists: true } }` matches nothing,
 * `{ missing: null }` everything). The translator refuses undeclared paths (R9) rather than
 * guessing; the port's filter methods take caller filters, so this store answers them.
 * `true`/`false` stand for a filter that matches every record or none.
 */
function resolveUndeclared(filter: Record<string, unknown>): Record<string, unknown> | boolean {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      const branches = (Array.isArray(value) ? value : []).map((branch) =>
        resolveUndeclared(branch as Record<string, unknown>),
      );
      const open = branches.filter((branch) => typeof branch !== 'boolean');
      if (key === '$and') {
        if (branches.includes(false)) return false;
        if (open.length > 0) resolved.$and = open;
      } else if (key === '$or') {
        if (branches.includes(true)) continue;
        if (open.length === 0) return false;
        resolved.$or = open;
      } else {
        if (branches.includes(true)) return false;
        if (open.length > 0) resolved.$nor = open;
      }
      continue;
    }
    if (key.startsWith('$') || DECLARED_TOP_LEVEL.has(key.split('.')[0])) {
      resolved[key] = value;
      continue;
    }
    if (!matchesExtendedFilter({}, { [key]: value })) {
      return false;
    }
  }
  return Object.keys(resolved).length === 0 ? true : resolved;
}

/** {@link resolveUndeclared} as a filter of the primitive. */
function callerFilter(filter: unknown): Record<string, unknown> {
  const resolved = resolveUndeclared(filter as Record<string, unknown>);
  if (resolved === true) return {};
  if (resolved === false) return NO_MATCH;
  return resolved;
}

/** The hidden subagent paths the thread view and the task reads need beside the defaults. */
const SUBAGENT_PROJECTION =
  '+subagentContent +subagentTranscript +subagentActivityProjection +subagentTriggerProjection +subagentTask';

const isDuplicateKeyError = (error: unknown): boolean => error instanceof StoreDuplicateKeyError;

/** Equality of two stored values as MongoDB compares documents: by value and key order. */
const sameStoredValue = (left: unknown, right: unknown): boolean =>
  encodeJsonColumn(left ?? null, { countNul: false }) ===
  encodeJsonColumn(right ?? null, { countNul: false });

export function createPostgresMessageStore(
  context: PostgresStoreContext,
  deps: PostgresMessageStoreDeps = {},
): MessageStore {
  const messages = () => context.collections().collection<MessageRecord>('messages');
  const conversations = () => context.collections().collection('conversations');
  const contents = () => context.collections().collection('subagentcontents');

  /**
   * In `tx`: locks the first message matching `filter` (by `sort`) and reads it whole, in the
   * next statement (§3.5); `null` when none matches.
   */
  async function lockedRecord(
    tx: StoreTransaction | undefined,
    filter: Record<string, unknown>,
  ): Promise<MessageRecord | null> {
    const where = storeWhere(context, 'messages', filter, { operation: 'Query' });
    const { rows } = await runStoreSql<{ _id: string }>(
      context,
      sql`SELECT t."_id" FROM "messages" AS t WHERE ${where} ORDER BY t."_id" LIMIT 1 FOR UPDATE`,
      tx,
    );
    if (rows.length === 0) {
      return null;
    }
    return messages().findOne(
      { ...filter, _id: rows[0]._id },
      { projection: PRIVATE_PROJECTION, tx },
    );
  }

  /**
   * The update with a bound App's View documents dropped as the deployment budget requires,
   * measured on the record this write leaves (MongoDB's `prepareAppUpdate`).
   */
  async function prepareAppUpdate(
    update: Record<string, unknown>,
    current: Record<string, unknown> | null,
    unsetContextMeta = false,
    retentionOnInsert?: { expiredAt: Date; isTemporary: false },
  ): Promise<Record<string, unknown>> {
    const safeUpdate = sanitizeMessageUpdate(update);
    // Omission retains the attachments of THIS locked row; null/[] explicitly clears them.
    const attachments = Object.prototype.hasOwnProperty.call(safeUpdate, 'attachments')
      ? safeUpdate.attachments
      : current?.attachments;
    if (!hasBoundAppSnapshots(attachments)) return safeUpdate;
    const maxBytes = await deps.getMCPAppMessageBudget?.();
    const admitted = fitBoundAppSnapshotsBy(
      attachments as unknown[],
      (candidateAttachments) => {
        const candidate: Record<string, unknown> = {
          ...current,
          ...(current == null ? retentionOnInsert : {}),
          ...safeUpdate,
          attachments: candidateAttachments,
          createdAt: current?.createdAt ?? safeUpdate.createdAt ?? new Date(),
          updatedAt: new Date(),
          __v: (Number(current?.__v) || 0) + 1,
        };
        if (unsetContextMeta) delete candidate.contextMeta;
        return postgresStoreDocuments.measureDocument(candidate);
      },
      (resource) => postgresStoreDocuments.measureDocument({ resource }),
      maxBytes,
    );
    if (admitted !== attachments) {
      logger.warn('[saveMessage] Optional MCP App documents exceeded the message budget');
    }
    return admitted === attachments ? safeUpdate : { ...safeUpdate, attachments: admitted };
  }

  /** The common single write of a save: an upsert (or update) that never touches a bound App row. */
  async function fastWrite(
    identity: Record<string, unknown>,
    update: Record<string, unknown>,
    options: WriteOptions,
  ): Promise<MessageRecord | null> {
    const filter = { ...identity, ...NO_BOUND_APPS };
    const saveUpdate = asRecord(
      buildMessageSaveUpdate(update, {
        stampModelOutputOnInsert: options.stampModelOutputOnInsert ?? false,
        unsetContextMeta: options.unsetContextMeta ?? false,
        retentionOnInsert: options.retentionOnInsert,
        unsetPrivateText: options.unsetPrivateText,
      }),
    );
    if (options.onWrite == null) {
      return messages().findOneAndUpdate(filter, saveUpdate, {
        upsert: options.upsert,
        returnDocument: 'after',
        timestamps: options.timestamps,
      });
    }
    const onWrite = options.onWrite;
    return context.transactions.transaction(async (tx) => {
      const result = await messages().updateOne(filter, saveUpdate, {
        upsert: options.upsert,
        timestamps: options.timestamps,
        tx,
        writeHooks: true,
      });
      if (result.matchedCount === 0 && result.upsertedCount === 0) {
        return null;
      }
      const written = await messages().findOne(
        result.upsertedId != null ? { _id: result.upsertedId } : identity,
        { tx },
      );
      if (written != null) onWrite(result.upsertedCount === 1, written._id);
      return written;
    });
  }

  /**
   * The provenance merge (MongoDB's `findOneAndMergeMessageProvenance`) under the row lock: the
   * stored provenance is merged with the write's, the update is budgeted against the locked
   * record, and the record is written by `_id`; without a record (and with `upsert`) a new one is
   * inserted under a fresh `_id`, retried when a concurrent first save took the unique key.
   */
  async function mergedWrite(
    identity: Record<string, unknown>,
    update: Record<string, unknown>,
    userSubmittedPaths: readonly string[],
    userSubmittedMessageFieldPaths: ReturnType<typeof normalizeUserSubmittedMessageFieldPaths>,
    options: WriteOptions,
  ): Promise<MessageRecord | null> {
    const safeUpdate = sanitizeMessageUpdate(update);
    const preservesStoredIsUserSubmitted = !Object.prototype.hasOwnProperty.call(
      safeUpdate,
      'isUserSubmitted',
    );
    for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt += 1) {
      try {
        return await context.transactions.transaction(async (tx) => {
          const current = await lockedRecord(tx, identity);
          if (current == null && !options.upsert) {
            return null;
          }
          const provenance = mergeMessageProvenance(
            current,
            userSubmittedPaths,
            userSubmittedMessageFieldPaths,
            options.stampModelOutputOnInsert,
            typeof safeUpdate.isUserSubmitted === 'boolean'
              ? safeUpdate.isUserSubmitted
              : undefined,
            preservesStoredIsUserSubmitted,
          );
          const admitted = await prepareAppUpdate(
            { ...safeUpdate, ...provenance },
            current,
            options.unsetContextMeta,
            options.retentionOnInsert,
          );
          const write = {
            $set: admitted,
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
          };
          const id = current?._id ?? generatePostgresStoreId();
          const written = await messages().findOneAndUpdate({ ...identity, _id: id }, write, {
            upsert: current == null,
            returnDocument: 'after',
            timestamps: options.timestamps,
            tx,
          });
          if (written != null) {
            options.onWrite?.(current == null, written._id);
          }
          return written;
        });
      } catch (error) {
        if (!isDuplicateKeyError(error) || !options.upsert) {
          throw error;
        }
      }
    }
    throw new Error('Message provenance write contention exceeded its retry bound.');
  }

  /** One admission owner for save, edit and import (MongoDB's `writeMessage`). */
  async function writeMessage(
    identity: Record<string, unknown>,
    input: Record<string, unknown>,
    options: WriteOptions,
  ): Promise<MessageRecord | null> {
    const update = sanitizeMessageUpdate(input);
    const paths = normalizeUserSubmittedPaths(update.userSubmittedPaths);
    const fields = normalizeUserSubmittedMessageFieldPaths(update.userSubmittedMessageFieldPaths);
    delete update.userSubmittedPaths;
    delete update.userSubmittedMessageFieldPaths;
    if (!hasBoundAppSnapshots(update.attachments) && paths.length === 0 && fields.length === 0) {
      try {
        // An App row is excluded by NO_BOUND_APPS; its unique (messageId, user, tenantId) key
        // then rejects the upsert, and the merged write below budgets that row.
        const fast = await fastWrite(identity, update, options);
        if (fast != null) {
          return fast;
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
    return mergedWrite(identity, update, paths, fields, options);
  }

  /** The settlement of one tool call (MongoDB's `settleToolCallResult`). */
  async function settleToolCallResult(
    input: UpdateToolCallResultInput,
    stepMatch: string | null | undefined,
    fallback?: SteplessToolCallFallback,
  ): Promise<{ matched: boolean; unfinished: boolean }> {
    const plan = planToolCallSettlement(input, stepMatch, fallback);
    if (plan == null) {
      return { matched: false, unfinished: false };
    }
    const { messageFilter, settleUpdate, settlePatch, incomingAttachments } = plan;
    const arrayFilters = plan.arrayFilters;
    try {
      /** A supplied claim is stamped BEFORE the settle write, on parts that carry none; until
       * the settle write lands the part is not terminal, so no consumer can claim it. */
      if (plan.claimStamp != null) {
        await messages().updateOne(messageFilter, plan.claimStamp.update, {
          arrayFilters: plan.claimStamp.arrayFilters,
        });
      }
      /** The stepless fallback is fenced on the content it read, a whole-array comparison:
       * it takes the locked path below, where that comparison runs on the locked row. */
      const { content: fencedContent, ...lockFilter } = messageFilter as Record<string, unknown>;
      const rowFilter = fallback == null ? messageFilter : lockFilter;
      if (!plan.mergingAttachments && fallback == null) {
        const fast = await messages().findOneAndUpdate(
          { ...messageFilter, ...NO_BOUND_APPS },
          settleUpdate,
          { returnDocument: 'after', projection: 'unfinished', arrayFilters },
        );
        if (fast) return { matched: true, unfinished: fast.unfinished === true };
        // Either absent, or a bound-App row needs a budgeted write even for tiny results.
      }
      return await context.transactions.transaction(async (tx) => {
        const current = await lockedRecord(tx, rowFilter);
        if (
          current == null ||
          (fallback != null && !sameStoredValue(current.content, fencedContent))
        ) {
          return { matched: false, unfinished: false };
        }
        const hasApps =
          hasBoundAppSnapshots(incomingAttachments) || hasBoundAppSnapshots(current.attachments);
        const writesAttachments = plan.mergingAttachments || hasApps;
        let admitted = writesAttachments
          ? mergeToolCallAttachments(current.attachments, incomingAttachments, input)
          : undefined;
        if (hasApps) {
          const nextContent = settleToolCallContent(current.content, input);
          admitted = (
            await prepareAppUpdate({ attachments: admitted, content: nextContent }, current)
          ).attachments as unknown[];
        }
        const $set = { ...settlePatch, ...(writesAttachments ? { attachments: admitted } : {}) };
        const result = await messages().findOneAndUpdate(
          { ...rowFilter, _id: current._id },
          { ...settleUpdate, ...(Object.keys($set).length > 0 ? { $set } : {}) },
          { returnDocument: 'after', projection: 'unfinished', arrayFilters, tx },
        );
        return result == null
          ? { matched: false, unfinished: false }
          : { matched: true, unfinished: result.unfinished === true };
      });
    } catch (err) {
      logger.error('Error updating tool call result:', err);
      throw err;
    }
  }

  /** The newest task row of every listed thread (`DISTINCT ON`), then read through the primitive. */
  async function latestTaskRows(match: Record<string, unknown>): Promise<MessageRecord[]> {
    const where = storeWhere(context, 'messages', match);
    const { rows } = await runStoreSql<{ _id: string }>(
      context,
      sql`SELECT DISTINCT ON (t."conversationId") t."_id" FROM "messages" AS t WHERE ${where}
          ORDER BY t."conversationId", t."createdAt" DESC NULLS LAST, t."_id" DESC`,
    );
    if (rows.length === 0) {
      return [];
    }
    return messages().find(
      { _id: { $in: rows.map((row) => row._id) } },
      { projection: TASK_ROW_PROJECTION },
    );
  }

  const store: MessageStore = {
    async getPersistedPrivateTextId(input) {
      const filter = persistedPrivateTextFilter(input);
      if (filter == null) {
        return null;
      }
      const stored = await messages().exists(filter);
      return stored == null ? null : String(stored._id);
    },

    async hasPersistedPrivateText(input) {
      return (await store.getPersistedPrivateTextId(input)) != null;
    },

    async getPrivateMessageTexts(input) {
      const filter = privateMessageTextsFilter(input);
      if (filter == null) {
        return [];
      }
      return (await messages().find(filter, {
        projection: 'messageId text privacyRevision +privateText',
        limit: 50,
      })) as unknown as Awaited<ReturnType<MessageStore['getPrivateMessageTexts']>>;
    },

    async saveMessage(ctx, params, metadata) {
      const { userId } = ctx;
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
        const prepared = prepareMessageSave(ctx, params, metadata);
        if (metadata?.insertOnly === true) {
          return await messages().findOneAndUpdate(
            { messageId: params.messageId, user: userId },
            buildInsertOnlyMessageUpdate(prepared, metadata),
            { upsert: true, returnDocument: 'after', timestamps: false },
          );
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
        const backfill = planRetentionDeadlineBackfill(ctx, message);
        if (backfill != null) {
          const result = await messages().updateOne(backfill.filter, backfill.update, {
            timestamps: false,
          });
          if (result.modifiedCount > 0) {
            message.expiredAt = backfill.deadline;
          }
        }
        const permanent = planPermanentChatTypeBackfill(ctx, message);
        if (permanent != null) {
          await messages().updateOne(permanent.filter, permanent.update);
          message.isTemporary = false;
        }
        return message;
      } catch (err: unknown) {
        logger.error('Error saving message:', err);
        logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
        if (isDuplicateKeyError(err)) {
          logger.warn(`Duplicate messageId detected: ${params.messageId}. Continuing execution.`);
          try {
            return (
              (await messages().findOne({ messageId: params.messageId, user: userId })) ?? undefined
            );
          } catch (findError) {
            logger.warn(
              `Could not retrieve existing message with ID ${params.messageId}: ${(findError as Error).message}`,
            );
            return undefined;
          }
        }
        throw err;
      }
    },

    async bulkSaveMessages(records, overrideTimestamp = false, provenance) {
      try {
        const bulkOps = records.map((message) =>
          buildBulkSaveMessageOperation(
            message as Record<string, unknown>,
            overrideTimestamp,
            provenance,
          ),
        );
        // Keep no-App imports batched. A race with App attachment creation collides on the
        // unique key, at which point only that row uses the merged write.
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
            result = await messages().bulk(
              ordinary.map((op) => ({
                updateOne: {
                  filter: { ...op.updateOne.filter, ...NO_BOUND_APPS },
                  update: op.updateOne.update,
                  upsert: true,
                },
              })),
              { ordered: false, timestamps: !overrideTimestamp },
            );
          } catch (error) {
            const failure = error as {
              writeErrors?: Array<{ index: number; error: unknown }>;
              result?: typeof result;
            };
            if (
              !failure.writeErrors?.length ||
              failure.writeErrors.some((item) => !isDuplicateKeyError(item.error))
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
    },

    async updateMessage(userId, message, metadata) {
      try {
        const { messageId, ...update } = message as { messageId: string } & Record<string, unknown>;
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
    },

    async updateToolCallResult(input) {
      const exact = await settleToolCallResult(input, input.stepId);
      if (exact.matched || input.stepId == null) {
        return exact;
      }
      /** A turn resumed after an approval pause persists its earlier tool calls without step
       * ids: on a finished row, fall back to the one part with this call id and no step. */
      const row = await messages().findOne(
        { messageId: input.messageId, user: input.userId, conversationId: input.conversationId },
        { projection: 'content unfinished' },
      );
      const fallback = findSteplessToolCallFallback(row, input);
      if (fallback == null) {
        return exact;
      }
      return settleToolCallResult(input, null, fallback);
    },

    async claimBackgroundToolResults(input) {
      const request = normalizeBackgroundToolResultClaim(input);
      const { taskId, agentId } = request;
      const row = await messages().findOne(backgroundClaimSourceFilter(request), {
        projection: 'content unfinished messageId',
        sort: { createdAt: -1, _id: -1 },
      });
      if (row == null) {
        if (request.requestedMessageId == null) {
          const handleRow = await messages().findOne(backgroundTaskHandleFilter(request), {
            projection: 'content',
            sort: { createdAt: -1, _id: -1 },
          });
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
      const claimFilter = backgroundClaimWithAgentScope(request, write);
      const stamp = backgroundClaimStampUpdate(request, write);
      const updated = write.replaying
        ? await messages().findOne(claimFilter, { projection: 'content' })
        : await messages().findOneAndUpdate(claimFilter, stamp.update, {
            returnDocument: 'after',
            projection: 'content',
            arrayFilters: stamp.arrayFilters,
          });
      return backgroundClaimOutcome(updated, request, write);
    },

    async confirmBackgroundToolResultClaim(input) {
      const plan = planBackgroundClaimConfirmation(input);
      try {
        const confirmed = await messages().updateOne(plan.filter, plan.update, {
          arrayFilters: plan.arrayFilters,
        });
        return confirmed.matchedCount === 1;
      } catch (error) {
        // A lost write reply is not an uncommitted handoff. Read only the exact manual claim.
        const committed = await messages().exists(plan.committedFilter);
        if (committed != null) return true;
        throw error;
      }
    },

    async releaseBackgroundToolResultClaims(input) {
      const plan = planBackgroundClaimRelease(input);
      if (plan == null) {
        return true;
      }
      const { userId, conversationId, messageId, allowMissingMessage } = input;
      const updated = await messages().findOneAndUpdate(plan.filter, plan.update, {
        returnDocument: 'after',
        projection: 'content',
        arrayFilters: plan.arrayFilters,
      });
      if (updated == null) {
        const arraylessRow = await messages().exists({
          user: userId,
          conversationId,
          messageId,
          content: { $not: { $type: 'array' } },
        });
        if (arraylessRow != null) return true;
        return (
          allowMissingMessage === true &&
          (await messages().exists({ user: userId, conversationId, messageId })) == null
        );
      }
      return backgroundClaimsReleased(updated, input);
    },

    async recordSubagentTaskControlReceipt(input) {
      const identity = subagentControlReceiptIdentity(input);
      /** The receipts are rewritten as a whole: under the row lock, from the latest receipts. */
      return context.transactions.transaction(async (tx) => {
        const current = await lockedRecord(tx, identity);
        if (current == null) return false;
        const receipts = current.subagentTask?.controlReceipts ?? [];
        const retained = retainSubagentControlReceipts(receipts, input.receipt);
        if (retained.status === 'conflict') return 'conflict';
        if (retained.status === 'unchanged') return 'unchanged';
        if (retained.status === 'capacity') return false;
        const updated = await messages().findOneAndUpdate(
          { ...identity, _id: current._id },
          { $set: { 'subagentTask.controlReceipts': retained.receipts } },
          { projection: 'messageId', tx },
        );
        return updated != null;
      });
    },

    async getSubagentTaskControlReceipt({
      userId,
      conversationId,
      taskId,
      invocationId,
      tenantId,
      activeOnly = false,
    }) {
      validateSubagentControlReceiptRead({ userId, conversationId, taskId, invocationId });
      const input = await messages().findOne(
        {
          ...(activeOnly ? activeExpirationFilter() : {}),
          user: userId,
          conversationId,
          ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
          messageId: `${taskId}:user`,
          'subagentTask.controlReceipts.invocationId': invocationId,
        },
        { projection: { 'subagentTask.controlReceipts': 1, _id: 0 } },
      );
      return publicSubagentControlReceipt(input?.subagentTask?.controlReceipts, invocationId);
    },

    async getSubagentTaskControlReplay({
      userId,
      parentConversationId,
      taskId,
      invocationId,
      tenantId,
    }) {
      validateSubagentControlReplay({ userId, parentConversationId, taskId, invocationId });
      const tenant = tenantId == null ? { tenantId: { $exists: false } } : { tenantId };
      const input = await messages().findOne(
        {
          user: userId,
          ...tenant,
          messageId: `${taskId}:user`,
          'subagentTask.controlReceipts.invocationId': invocationId,
        },
        {
          projection: {
            conversationId: 1,
            createdAt: 1,
            updatedAt: 1,
            'subagentTask.status': 1,
            'subagentTask.controlReceipts': 1,
            _id: 0,
          },
        },
      );
      if (input == null || input.createdAt == null || input.updatedAt == null) {
        return null;
      }
      const receipt = input.subagentTask?.controlReceipts?.find(
        (candidate) => candidate.invocationId === invocationId,
      );
      if (receipt == null || input.subagentTask?.status == null) {
        return null;
      }
      const [conversation, terminal] = await Promise.all([
        conversations().findOne(
          {
            user: userId,
            conversationId: input.conversationId,
            ...tenant,
            'subagentThread.parentConversationId': parentConversationId,
            ...activeExpirationFilter(),
          },
          { projection: { 'subagentThread.subagentType': 1, _id: 0 } },
        ),
        messages().findOne(
          {
            user: userId,
            conversationId: input.conversationId,
            ...tenant,
            messageId: `${taskId}:assistant`,
            'subagentTask.status': { $in: SUBAGENT_TERMINAL_STATUSES },
          },
          {
            projection: {
              updatedAt: 1,
              'subagentTask.status': 1,
              'subagentTask.resultClaim': 1,
              _id: 0,
            },
          },
        ),
      ]);
      const subagentType = (conversation?.subagentThread as { subagentType?: string } | undefined)
        ?.subagentType;
      return toSubagentControlReplay(taskId, invocationId, input, subagentType, terminal);
    },

    async claimSubagentTaskResult({ userId, conversationId, taskId, kind, claimId }) {
      validateSubagentResultClaim(
        { conversationId, taskId, kind, claimId },
        'Invalid subagent task result claim',
      );
      const messageId = `${taskId}:assistant`;
      const claim = { kind, claimId, claimedAt: new Date() };
      const projection = { ...SUBAGENT_RESULT_PROJECTION };
      const acquired = await messages().findOneAndUpdate(
        {
          user: userId,
          conversationId,
          messageId,
          'subagentTask.status': { $in: SUBAGENT_TERMINAL_STATUSES },
          ...subagentResultClaimable(kind, claimId),
        },
        { $set: { 'subagentTask.resultClaim': claim } },
        { returnDocument: 'after', projection },
      );
      if (acquired != null) {
        return { status: 'acquired', message: acquired };
      }
      const existing = await messages().findOne(
        {
          user: userId,
          conversationId,
          messageId,
          'subagentTask.status': { $in: SUBAGENT_TERMINAL_STATUSES },
        },
        { projection },
      );
      return existing == null ? { status: 'not_found' } : { status: 'claimed', message: existing };
    },

    async releaseSubagentTaskResultClaim({ userId, conversationId, taskId, kind, claimId }) {
      validateSubagentResultClaim(
        { conversationId, taskId, kind, claimId },
        'Invalid subagent task result claim release',
      );
      const result = await messages().updateOne(
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
    },

    async getMessagesForSubagentThreadView(input) {
      try {
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
            : await messages().findOne(
                { ...baseMatch, messageId: input.beforeMessageId },
                { projection: '_id createdAt' },
              );
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
        const newestFirst = { createdAt: -1, _id: -1 } as const;
        const selectedAssistant =
          input.selectedTaskId == null ? undefined : `${input.selectedTaskId}:assistant`;
        /** Each read is one statement, so a row's bounded fields and its source payload come
         * from the same row version (MongoDB's single-snapshot guarantee for the selected pair). */
        const [pageRows, candidateRows, selectedRows] = await Promise.all([
          messages().find(pageMatch, {
            sort: newestFirst,
            limit: input.limit,
            projection: SUBAGENT_PROJECTION,
          }),
          messages().find(pageMatch, {
            sort: newestFirst,
            limit: SUBAGENT_ACTIVITY_SOURCE_CANDIDATE_LIMIT,
            projection: SUBAGENT_PROJECTION,
          }),
          input.selectedTaskId == null
            ? Promise.resolve([] as MessageRecord[])
            : messages().find(
                {
                  ...baseMatch,
                  messageId: {
                    $in: [`${input.selectedTaskId}:user`, `${input.selectedTaskId}:assistant`],
                  },
                },
                { limit: 2, projection: SUBAGENT_PROJECTION },
              ),
        ]);
        const project = (row: ThreadViewRow) =>
          projectThreadViewMessage(row, input.textCodePointLimit);
        const viewMessages: ProjectedSubagentThreadViewMessage[] = pageRows.map(project);
        const recentSources: ThreadViewSource[] = candidateRows
          .filter(
            (row) =>
              (selectedAssistant == null || row.messageId !== selectedAssistant) &&
              hasThreadViewSourcePaths(row) &&
              (activityProjectionAvailable(row) || transcriptAvailable(row)),
          )
          .slice(0, SUBAGENT_TRANSCRIPT_PAGE_LIMIT - (input.selectedTaskId == null ? 0 : 1))
          .map(threadViewSource);
        const selectedSources: ThreadViewSource[] = [];
        const selectedMessages = selectedRows.map((row) => {
          const taskSource =
            row.messageId === selectedAssistant &&
            ((row.subagentActivityProjection?.taskId === input.selectedTaskId &&
              activityProjectionAvailable(row)) ||
              (row.subagentTranscript?.taskId === input.selectedTaskId &&
                transcriptAvailable(row)));
          if (taskSource) selectedSources.push(threadViewSource(row));
          return project(row);
        });
        const sourcesByMessageId = new Map(
          [...selectedSources, ...recentSources].map((record) => [record.messageId, record]),
        );
        /** The selected task's single-read pair is authoritative over a page duplicate. */
        const selectedByMessageId = new Map(
          selectedMessages.map((message) => [message.messageId, message]),
        );
        for (let index = 0; index < viewMessages.length; index += 1) {
          const snapshot = selectedByMessageId.get(viewMessages[index].messageId);
          if (snapshot != null) {
            viewMessages[index] = snapshot;
            selectedByMessageId.delete(snapshot.messageId);
          }
        }
        for (const message of selectedByMessageId.values()) {
          viewMessages.push(message);
        }
        return viewMessages.map((row) => {
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
    },

    async listSubagentTasksForThreads(input) {
      if (input.conversationIds.length === 0) {
        return [];
      }
      const match = {
        user: input.user,
        conversationId: { $in: input.conversationIds },
        ...(input.tenantId == null
          ? { tenantId: { $exists: false } }
          : { tenantId: input.tenantId }),
        messageId: { $regex: /:(user|assistant)$/ },
      };
      const sourceLimit = subagentTaskSourceLimit(input);
      const [latestRows, recentRows] = await Promise.all([
        latestTaskRows(match),
        messages().find(match, {
          sort: { createdAt: -1, _id: -1 },
          limit: sourceLimit + 1,
          projection: TASK_ROW_PROJECTION,
        }),
      ]);
      const latestRecords = [...latestRows]
        .sort((left, right) => compareStrings(left.conversationId, right.conversationId))
        .map((row) => ({ conversationId: row.conversationId, tasks: [taskEntry(row)] }));
      const merged = mergeSubagentTaskRecords(
        latestRecords,
        groupRecentTaskRows(recentRows, input.limitPerThread),
        sourceLimit,
        input.limitPerThread,
      );
      return merged.map((record) => ({
        ...record,
        tasks: record.tasks.map(({ occurrenceId: _occurrence, ...task }) => task),
      })) as ParentSubagentTaskRecord[];
    },

    async getConversationTraceRefs({ user, conversationId, tenantId, messageId, through, limit }) {
      try {
        const scope = { user, conversationId, ...traceTenantScope(tenantId) };
        const anchor = through != null ? parseTraceOrderKey(through.orderKey) : undefined;
        const filter = {
          ...scope,
          ...SERVER_AUTHORED_SAMPLED_RESPONSE,
          ...(messageId != null ? { messageId } : {}),
          ...traceRange(anchor),
        };
        const projection = '_id messageId createdAt langfuseDestinationIds langfuseRunId';
        const bounded = limit != null;
        const [first, rows] = await Promise.all([
          messages().findOne(scope, { projection: 'createdAt -_id', sort: { createdAt: 1 } }),
          through != null && anchor == null
            ? Promise.resolve([] as MessageRecord[])
            : messages().find(
                filter,
                bounded
                  ? { projection, sort: { createdAt: -1, _id: -1 }, limit }
                  : { projection, sort: { createdAt: 1, _id: 1 } },
              ),
        ]);
        const sampled = bounded ? rows.reverse() : rows;
        return toConversationTraceRefs(
          first?.createdAt,
          sampled as unknown as Parameters<typeof toConversationTraceRefs>[1],
          through,
        );
      } catch (err) {
        logger.error('Error getting conversation trace references:', err);
        throw err;
      }
    },

    async hasSampledTraceMessage({ user, conversationId, tenantId, destinationIds }) {
      try {
        const match = await messages().exists({
          user,
          conversationId,
          ...traceTenantScope(tenantId),
          ...SERVER_AUTHORED_SAMPLED_RESPONSE,
          ...sampledTraceDestinationFilter(destinationIds),
        });
        return match != null;
      } catch (err) {
        logger.error('Error checking for a sampled trace message:', err);
        throw err;
      }
    },

    async getMessages(filter, select, options = {}) {
      try {
        return await messages().find(callerFilter(filter), {
          ...(select ? { projection: select } : {}),
          ...(options.sort !== false ? { sort: options.sort ?? { createdAt: 1 } } : {}),
          ...(options.limit != null && options.limit > 0 ? { limit: options.limit } : {}),
        });
      } catch (err) {
        logger.error('Error getting messages:', err);
        throw err;
      }
    },

    async getMessagesPage(filter, options) {
      const sortField = options.sort.field;
      const sortOrder = options.sort.order;
      const queryFilter = messagePageFilter(
        callerFilter(filter),
        sortField,
        sortOrder,
        options.after,
        (hex) => hex,
      );
      const { projection, omitId } = messagePageProjection(options.select);
      /** `_id` makes the order total, so a page boundary inside a run of equal values is stable. */
      const rows = await messages().find(queryFilter, {
        ...(projection != null ? { projection } : {}),
        sort: { [sortField]: sortOrder, _id: sortOrder },
        limit: options.limit + 1,
      });
      return finishMessagePage(rows, options.limit, sortField, omitId);
    },

    async searchUserMessages({ user, text, limit, hydrate }) {
      const search = context.search;
      if (!search?.configured()) {
        throw new Error('MeiliSearch plugin not registered on Message model');
      }
      const escapedUser = user.replace(/[\\"]/g, '\\$&');
      const response = await search.search(
        'messages',
        text,
        { filter: `user = "${escapedUser}"`, limit },
        hydrate
          ? (hits) =>
              messages().find({
                user,
                messageId: { $in: hits.map((hit) => String(hit.messageId)) },
              })
          : undefined,
      );
      return { hits: response.hits as MessageSearchHit[] };
    },

    async getMessage({ user, messageId }) {
      try {
        return await messages().findOne({ user, messageId });
      } catch (err) {
        logger.error('Error getting message:', err);
        throw err;
      }
    },

    async getBranchReasoningOverride({ user, conversationId, parentMessageId }) {
      const rows = await messages().find(
        { user, conversationId },
        {
          projection: {
            _id: 0,
            messageId: 1,
            parentMessageId: 1,
            isCreatedByUser: 1,
            reasoningOverride: 1,
          },
        },
      );
      return findBranchReasoningOverride(rows, parentMessageId);
    },

    async deleteMessages(filter) {
      try {
        const criteria = callerFilter(filter);
        if (
          typeof criteria.messageId === 'string' &&
          !isSubagentTaskMessageId(criteria.messageId)
        ) {
          return await messages().deleteMany(criteria);
        }
        if (isWholeMessageScope(criteria)) {
          /** Fence admitted appends first, then discard the runs' content by the same scope. */
          await messages().updateMany(
            { ...criteria, 'subagentContent.version': 1 },
            { $set: { 'subagentContent.deleted': true } },
          );
          await contents().deleteMany(criteria);
          return await messages().deleteMany(criteria);
        }
        const contentSources = await messages().find(
          { $and: [criteria, { subagentContent: { $exists: true } }] },
          { projection: 'user tenantId conversationId messageId' },
        );
        const contentScopes = subagentContentDeletionScopes(contentSources);
        if (contentScopes.length > 0) {
          /** Revoke the task before cleanup, including appends already admitted. Retain both
           * markers until payload deletion succeeds so retries rediscover them. */
          const fence = subagentContentDeletionFence(contentScopes);
          await messages().updateMany(fence.filter, fence.update);
          await contents().deleteMany({ $or: contentScopes });
        }
        return await messages().deleteMany(criteria);
      } catch (err) {
        logger.error('Error deleting messages:', err);
        throw err;
      }
    },

    async countMessagesByUser() {
      const where = storeWhere(context, 'messages', {});
      const { rows } = await runStoreSql<{ user: string | null; count: string | number }>(
        context,
        sql`SELECT t."user" AS "user", count(*) AS "count" FROM "messages" AS t WHERE ${where} GROUP BY t."user"`,
      );
      return rows.map(({ user, count }) => ({ user: user ?? null, count: Number(count) }));
    },

    async insertMessageRecords(records) {
      await messages().insertMany(records, { timestamps: false });
    },
  };

  /**
   * The claim's write guard with the requested part's agent scope: the part holding the task
   * belongs to the agent or to none (MongoDB's `$expr` over the parts, the same predicate as
   * `agentOwnershipFilter` on that part).
   */
  function backgroundClaimWithAgentScope(
    request: BackgroundToolResultClaimRequest,
    write: Parameters<typeof backgroundClaimWriteFilter>[1],
  ): Record<string, unknown> {
    const filter = backgroundClaimWriteFilter(request, write);
    if (request.agentId == null) {
      return filter;
    }
    return {
      ...filter,
      $and: [
        {
          content: {
            $elemMatch: {
              'tool_call.backgroundTask.taskId': request.taskId,
              ...agentOwnershipFilter('', request.agentId),
            },
          },
        },
      ],
    };
  }

  return store;
}

/** The fields of a task row that `listSubagentTasksForThreads` derives an outcome from. */
const TASK_ROW_PROJECTION = 'messageId conversationId createdAt error unfinished +subagentTask';

/** MongoDB's binary string order. */
const compareStrings = (left: unknown, right: unknown): number => {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

type TaskEntry = Omit<ParentSubagentTaskRecord['tasks'][number], 'occurrenceId'> & {
  occurrenceId: string;
};

/** One task outcome from its row (MongoDB's `taskProjection`): stored, or derived for ordinary rows. */
function taskEntry(row: MessageRecord): TaskEntry {
  const stored = row.subagentTask?.status;
  return {
    messageId: row.messageId,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    occurrenceId: String(row._id),
    statusDerived: stored == null,
    status: stored ?? derivedTaskStatus(row),
  };
}

/** The status of an ordinary event-turn row: a result row's outcome, or an input row's run. */
function derivedTaskStatus(row: MessageRecord): NonNullable<IMessage['subagentTask']>['status'] {
  if (!/:assistant$/.test(row.messageId)) {
    return 'running';
  }
  if (row.error === true) {
    return 'error';
  }
  return row.unfinished === true ? 'cancelled' : 'completed';
}

/** Descending order of dates with missing ones last (MongoDB's descending sort). */
const compareDatesDesc = (left: unknown, right: unknown): number => {
  const a = left instanceof Date ? left.getTime() : Number.NEGATIVE_INFINITY;
  const b = right instanceof Date ? right.getTime() : Number.NEGATIVE_INFINITY;
  if (a === b) return 0;
  return a > b ? -1 : 1;
};

/**
 * The recent window grouped as the MongoDB pipeline groups it: per thread and task the newest row
 * (the result row first), counted; per thread the tasks newest first, at most `limitPerThread`,
 * with the window rows they took.
 */
function groupRecentTaskRows(
  rows: MessageRecord[],
  limitPerThread: number,
): Array<{ conversationId: string; tasks: TaskEntry[]; sourceRows: number }> {
  const groups = new Map<
    string,
    { conversationId: string; taskId: string; row: MessageRecord; rows: number }
  >();
  for (const row of rows) {
    const isAssistant = /:assistant$/.test(row.messageId);
    const taskId = row.messageId.slice(0, row.messageId.length - (isAssistant ? 10 : 5));
    const key = JSON.stringify([row.conversationId, taskId]);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, { conversationId: row.conversationId, taskId, row, rows: 1 });
      continue;
    }
    group.rows += 1;
    const currentIsAssistant = /:assistant$/.test(group.row.messageId);
    const better =
      (isAssistant && !currentIsAssistant) ||
      (isAssistant === currentIsAssistant &&
        (compareDatesDesc(row.createdAt, group.row.createdAt) < 0 ||
          (compareDatesDesc(row.createdAt, group.row.createdAt) === 0 &&
            compareStrings(row._id, group.row._id) > 0)));
    if (better) group.row = row;
  }
  const ordered = [...groups.values()].sort(
    (left, right) =>
      compareStrings(left.conversationId, right.conversationId) ||
      compareDatesDesc(left.row.createdAt, right.row.createdAt) ||
      -compareStrings(left.row._id, right.row._id) ||
      compareStrings(left.taskId, right.taskId),
  );
  const threads = new Map<
    string,
    { conversationId: string; tasks: TaskEntry[]; sourceRows: number }
  >();
  for (const group of ordered) {
    const thread = threads.get(group.conversationId) ?? {
      conversationId: group.conversationId,
      tasks: [],
      sourceRows: 0,
    };
    thread.tasks.push(taskEntry(group.row));
    thread.sourceRows += group.rows;
    threads.set(group.conversationId, thread);
  }
  return [...threads.values()].map((thread) => ({
    ...thread,
    tasks: thread.tasks.slice(0, limitPerThread),
  }));
}

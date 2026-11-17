/**
 * What the PostgreSQL conversation store (`./conversation`) shares across its parts: the tables
 * it reaches, the guarded write on a locked conversation for conditions the query language
 * cannot state, and the work on other collections a conversation write carries along (a chat
 * project's statistics, bookmark counts, subagent content), written on the same database-neutral
 * rules as the MongoDB methods. Must not import `mongoose`, `mongodb` or `bson`.
 */
import { sql } from 'kysely';
import type { ProjectStatsSnapshot } from '~/methods/chatProjectRules';
import type { PgCollection, PgFilter, PgRecord } from '../collection';
import type { IChatProject, IConversation } from '~/types';
import type { StoreTransaction } from '~/ports/common';
import type { PostgresStoreContext } from './context';
import {
  refreshChatProjectStatsWith,
  updateChatProjectLastConversationWith,
} from '~/methods/chatProjectRules';
import { refreshChatProjectStatsInBatches } from '~/methods/projectStats';
import { tagCountDecrements } from '~/methods/conversationTagRules';
import { isValidObjectIdString } from '~/utils/objectId';
import { matchesExtendedFilter } from '../evaluator';
import { runStoreSql, storeWhere } from './context';
import logger from '~/config/winston';

export type ConversationRow = IConversation & PgRecord;

/** The collections the conversation store reaches, in document mode. */
export interface ConversationTables {
  conversations(): PgCollection<ConversationRow>;
  messages(): PgCollection;
  chatProjects(): PgCollection;
  sharedLinks(): PgCollection;
  conversationTags(): PgCollection;
  toolApprovalGrants(): PgCollection;
  subagentContents(): PgCollection;
  triggerDeliveries(): PgCollection;
}

export function conversationTables(context: PostgresStoreContext): ConversationTables {
  const collection = (name: string) => context.collections().collection(name);
  return {
    conversations: () => context.collections().collection<ConversationRow>('conversations'),
    messages: () => collection('messages'),
    chatProjects: () => collection('chatprojects'),
    sharedLinks: () => collection('sharedlinks'),
    conversationTags: () => collection('conversationtags'),
    toolApprovalGrants: () => collection('toolapprovalgrants'),
    subagentContents: () => collection('subagentcontents'),
    triggerDeliveries: () => collection('agenttriggerdeliveries'),
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]';

/**
 * `value` with every object's keys in one order and undefined members dropped: mongoose casts a
 * subdocument (or subdocument array) given as a filter value through its schema, so MongoDB
 * compares it with the stored one in the schema's key order whatever order the caller wrote.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      result[key] = canonical(value[key]);
    }
  }
  return result;
}

/**
 * Whether the stored `record` matches `filter` by MongoDB's rules, subdocuments compared by value
 * as mongoose's casting makes MongoDB compare them (see {@link canonical}). For the conditions
 * the query language cannot state (equality of a subdocument or a subdocument array with a
 * value), evaluated on a row the caller holds locked.
 */
export function matchesStoredState(record: PgRecord, filter: Record<string, unknown>): boolean {
  return matchesExtendedFilter(
    canonical(record) as Record<string, unknown>,
    canonical(filter) as Record<string, unknown>,
  );
}

/**
 * Writes the first conversation matching `filter` whose stored state, read under its row lock,
 * also passes `check` (conditions the query language cannot state), in one transaction (or the
 * caller's `tx`): each candidate's row is locked (`SELECT ... FOR UPDATE` on its id, a statement
 * that reads no child rows, §3.5), re-read with `projection` in the next statement and checked,
 * and `write` (given the id and the transaction) re-evaluates `filter` on the locked row through
 * the primitive. Every write of a conversation's child rows locks its row first, so the checked
 * state cannot change before the write. `null` when no candidate passes.
 */
export async function writeCheckedConversation<T>(
  context: PostgresStoreContext,
  input: {
    filter: PgFilter;
    projection: Record<string, 1>;
    check: (record: PgRecord) => boolean;
    write: (id: string, tx: StoreTransaction | undefined) => Promise<T | null>;
    tx?: StoreTransaction;
  },
): Promise<T | null> {
  const conversations = () => context.collections().collection('conversations');
  const run = async (tx: StoreTransaction | undefined): Promise<T | null> => {
    const candidates = await conversations().find(input.filter, { projection: { _id: 1 }, tx });
    for (const candidate of candidates) {
      const id = String(candidate._id);
      await runStoreSql(
        context,
        sql`SELECT t._id FROM conversations t WHERE ${storeWhere(context, 'conversations', {
          _id: id,
        })} FOR UPDATE`,
        tx,
      );
      const current = await conversations().findOne(
        { ...input.filter, _id: id },
        { projection: input.projection, tx },
      );
      if (current == null || !input.check(current)) {
        continue;
      }
      const written = await input.write(id, tx);
      if (written != null) {
        return written;
      }
    }
    return null;
  };
  return input.tx !== undefined ? run(input.tx) : context.transactions.transaction(run);
}

/** A chat project's statistics and activity pointer, on the PostgreSQL tables. */
export interface ChatProjectStats {
  refreshChatProjectStats(user: string, projectId: string): Promise<IChatProject | null>;
  recordChatProjectLastConversation(
    user: string,
    projectId: string,
    conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  ): Promise<void>;
  /** Recomputes the listed projects' statistics, in bounded batches. */
  refreshChatProjectsStats(user: string, projectIds: Iterable<string>): Promise<void>;
}

export function createChatProjectStats(tables: ConversationTables): ChatProjectStats {
  async function refreshChatProjectStats(
    user: string,
    projectId: string,
  ): Promise<IChatProject | null> {
    if (!isValidObjectIdString(projectId)) {
      return null;
    }
    const projectFilter = { _id: projectId.toLowerCase(), user };
    return refreshChatProjectStatsWith<IChatProject>(
      {
        readSnapshot: async () =>
          (await tables.chatProjects().findOne(projectFilter, {
            projection: 'conversationCount lastConversationAt lastConversationId',
          })) as ProjectStatsSnapshot | null,
        countConversations: (filter) => tables.conversations().count(filter),
        latestConversation: (filter) =>
          tables.conversations().findOne(filter, {
            projection: 'conversationId updatedAt createdAt',
            sort: { updatedAt: -1, _id: -1 },
          }),
        writeIfUnchanged: async (snapshotFilter, set) =>
          (await tables
            .chatProjects()
            .findOneAndUpdate(
              { ...projectFilter, ...snapshotFilter },
              { $set: set },
              { returnDocument: 'after' },
            )) as IChatProject | null,
      },
      user,
      projectId,
    );
  }

  async function recordChatProjectLastConversation(
    user: string,
    projectId: string,
    conversation: Pick<IConversation, 'conversationId' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    if (!isValidObjectIdString(projectId) || !conversation.conversationId) {
      return;
    }
    const projectFilter = { _id: projectId.toLowerCase(), user };
    await updateChatProjectLastConversationWith(
      {
        updateProject: (condition, update) =>
          tables.chatProjects().updateOne({ ...projectFilter, ...condition }, update),
        conversationExists: async (filter) => (await tables.conversations().exists(filter)) != null,
        refresh: () => refreshChatProjectStats(user, projectId),
      },
      user,
      projectId,
      conversation,
    );
  }

  const refreshChatProjectsStats = (user: string, projectIds: Iterable<string>) =>
    refreshChatProjectStatsInBatches(
      (projectId) => refreshChatProjectStats(user, projectId),
      projectIds,
    );

  return { refreshChatProjectStats, recordChatProjectLastConversation, refreshChatProjectsStats };
}

/**
 * Lowers the user's bookmark counts by one per entry of `tags`, never below zero, in one ordered
 * bulk write (the rules of `tagCountDecrements`); a failure is logged, as on MongoDB.
 */
export async function decrementTagCounts(
  tables: ConversationTables,
  user: string,
  tags: string[],
): Promise<void> {
  if (!tags.length) {
    return;
  }
  const operations = tagCountDecrements(user, tags);
  if (operations.length === 0) {
    return;
  }
  try {
    await tables.conversationTags().bulk(operations);
  } catch (error) {
    logger.error('[decrementTagCounts] Error decrementing tag counts', error);
  }
}

/**
 * Releases the subagent content of the user's messages in the listed conversations: the
 * messages that hold content are marked deleted first (fencing admitted appends), then the
 * content goes.
 */
export async function prepareSubagentContentDeletion(
  tables: ConversationTables,
  user: string,
  conversationIds: string[],
): Promise<void> {
  const filter = { user, conversationId: { $in: conversationIds } };
  await tables
    .messages()
    .updateMany(
      { ...filter, 'subagentContent.version': 1 },
      { $set: { 'subagentContent.deleted': true } },
    );
  await tables.subagentContents().deleteMany(filter);
}

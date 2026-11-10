/**
 * `deleteConvos`, written once on the database-neutral "deleteConvos steps" of the conversation
 * store.
 *
 * Every rule of a deletion lives here: which filters a caller may pass, the root-first walk of
 * subagent lineage, the order of the per-wave cascade, retries, the recovery of a partly deleted
 * root, and which clean-up failures are swallowed. Conversation records go only through the
 * store steps; work on other collections (messages, subagent content, bookmarks, remembered tool
 * approvals, queued turns, trigger results) goes through {@link DeleteConvosDeps}. Any adapter
 * that implements both gets the same `deleteConvos`. Nothing here may import `mongoose` or touch
 * a model.
 *
 * {@link DeleteConvosStore} repeats the step signatures of `ConversationStore`
 * (`~/ports/conversation`) instead of picking them, because that port imports
 * `~/methods/conversation`, which builds its `deleteConvos` from this module.
 * `deleteConvos.spec.ts` beside this file fails the typecheck if the two drift.
 */
import type { ConvoDeletionCount, ConvoDeletionSelector, ConvoDeletionTarget } from '~/types';
import { refreshChatProjectStatsInBatches } from './projectStats';
import logger from '~/config/winston';

/** The conversation-store operations `deleteConvos` is written on; signatures as in the port. */
export interface DeleteConvosStore {
  listConvosForDeletion(
    user: string,
    selector: ConvoDeletionSelector,
  ): Promise<ConvoDeletionTarget[]>;
  listSubagentDescendantsForDeletion(
    user: string,
    rootConversationId: string,
  ): Promise<ConvoDeletionTarget[]>;
  listSubagentChildrenForDeletion(
    user: string,
    parentConversationIds: string[],
  ): Promise<ConvoDeletionTarget[]>;
  deleteConvoRecords(user: string, conversationIds: string[]): Promise<ConvoDeletionCount>;
  refreshChatProjectStats(user: string, chatProjectId: string): Promise<void>;
}

/** Work on records outside the conversation collection that a deletion carries along. */
export interface DeleteConvosDeps {
  /** Whether the conversation still has at least one stored message. */
  hasConvoMessages(user: string, conversationId: string): Promise<boolean>;
  /** Deletes the user's messages in the listed conversations. */
  deleteConvoMessages(user: string, conversationIds: string[]): Promise<ConvoDeletionCount>;
  /** Releases the subagent content of the user's messages in the listed conversations. */
  prepareSubagentContentDeletion(user: string, conversationIds: string[]): Promise<void>;
  /** Lowers the user's bookmark counts by one per entry (a tag may repeat), never below zero. */
  decrementTagCounts(user: string, tags: string[]): Promise<void>;
  /** Removes the user's remembered tool approvals in the listed conversations. */
  deleteToolApprovalGrants(user: string, conversationIds: string[]): Promise<void>;
  deleteAgentQueuedTurns?: (
    user: string,
    conversations: Array<{ conversationId: string; tenantId?: string; allTenants?: true }>,
  ) => Promise<void>;
  prepareAgentTriggerConversationResultErasure?: (
    user: string,
    conversationIds: string[],
  ) => Promise<void>;
  eraseAgentTriggerDeliveryConversationResults?: (
    user: string,
    conversationIds: string[],
  ) => Promise<void>;
}

/**
 * The filters `deleteConvos` accepts, typed structurally so this module need not name the
 * MongoDB filter type: `{}` (every conversation of the user), `{ conversationId: string }` and
 * `{ conversationId: { $in: string[] } }`. A `user` key is ignored: the `user` argument always
 * scopes the deletion. Anything else is rejected.
 */
export type DeleteConvosFilter = { conversationId?: unknown; [key: string]: unknown };

/**
 * The signature of `ConversationMethods['deleteConvos']`, with the filter and results typed
 * structurally. Assignable to the method's declared type.
 */
export type DeleteConvos = (
  user: string,
  filter: DeleteConvosFilter,
  options?: {
    beforeDelete?: (conversationIds: string[]) => Promise<void>;
    /** Idempotent destructive-recovery mode. An empty selection is success, while
     * query, cascade, reconciliation, and deletion failures still propagate. */
    allowEmpty?: boolean;
  },
) => Promise<ConvoDeletionCount & { messages: ConvoDeletionCount; conversationIds: string[] }>;

const FILTER_SHAPES = '{}, { conversationId: string } or { conversationId: { $in: string[] } }';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Translates a caller's filter to the neutral selector, and names the single conversation a
 * `{ conversationId: string }` filter asked for (the only form that can resume a partly
 * deleted root). Throws on any other shape, naming the keys it cannot translate.
 */
function translateFilter(filter: DeleteConvosFilter): {
  selector: ConvoDeletionSelector;
  singleConversationId?: string;
} {
  const unsupported: string[] = [];
  let selector: ConvoDeletionSelector = { all: true };
  let singleConversationId: string | undefined;
  for (const key of Object.keys(filter)) {
    if (key === 'user') {
      continue;
    }
    if (key !== 'conversationId') {
      unsupported.push(key);
      continue;
    }
    const value = filter.conversationId;
    if (typeof value === 'string') {
      selector = { conversationIds: [value] };
      singleConversationId = value;
      continue;
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      unsupported.push('conversationId');
      continue;
    }
    const operators = Object.keys(value);
    const others = operators.filter((operator) => operator !== '$in');
    unsupported.push(...others.map((operator) => `conversationId.${operator}`));
    if (!operators.includes('$in')) {
      if (others.length === 0) {
        unsupported.push('conversationId');
      }
      continue;
    }
    const ids = (value as { $in?: unknown }).$in;
    if (!isStringList(ids)) {
      unsupported.push('conversationId.$in');
      continue;
    }
    selector = { conversationIds: [...ids] };
  }
  if (unsupported.length > 0) {
    throw new Error(
      `deleteConvos does not support the filter key(s) ${unsupported.join(', ')}; pass ${FILTER_SHAPES}.`,
    );
  }
  return { selector, singleConversationId };
}

async function retryCascadeOperation<T>(operation: () => PromiseLike<T> | T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Builds `deleteConvos` on `store`, which it shares: pass the steps of one instance.
 * `resolveDeps` runs at the start of every call, inside its error handling, so an instance
 * built without its message dependencies fails before it reads or deletes anything.
 */
export function createDeleteConvos(
  store: DeleteConvosStore,
  resolveDeps: () => DeleteConvosDeps,
): DeleteConvos {
  return async function deleteConvos(user, filter, options) {
    try {
      const deps = resolveDeps();
      const { selector, singleConversationId } = translateFilter(filter);
      let conversations = await store.listConvosForDeletion(user, selector);
      const recoveryConversationIds: string[] = [];
      if (!conversations.length && singleConversationId != null) {
        /** A prior attempt may have deleted the root before a descendant read failed.
         * Resume from immutable root lineage and retain the root id for message,
         * checkpoint, and tool cleanup. The message probe distinguishes that partial
         * commit from a conversation id that never existed. */
        const [descendants, rootHasMessages] = await Promise.all([
          retryCascadeOperation(() =>
            store.listSubagentDescendantsForDeletion(user, singleConversationId),
          ),
          deps.hasConvoMessages(user, singleConversationId),
        ]);
        if (descendants.length === 0 && !rootHasMessages && options?.allowEmpty !== true) {
          throw new Error('Conversation not found or already deleted.');
        }
        conversations = descendants;
        recoveryConversationIds.push(singleConversationId);
      } else if (!conversations.length) {
        if (options?.allowEmpty === true) {
          return {
            acknowledged: true,
            deletedCount: 0,
            messages: { acknowledged: true, deletedCount: 0 },
            conversationIds: [],
          };
        }
        throw new Error('Conversation not found or already deleted.');
      }

      /**
       * Delete roots first, then walk their owner-scoped lineage. Apart from
       * making child threads share the parent's lifecycle, deleting each wave
       * before discovering the next closes the child-creation race: a creator
       * that started concurrently sees its parent disappear and rolls back,
       * while a child already committed is found by the next query.
       */
      const deletedConversations: ConvoDeletionTarget[] = [];
      const seen = new Set<string>();
      let pending = conversations;
      let acknowledged = true;
      let deletedCount = 0;
      const reconcileDeletedWave = async (
        wave: ConvoDeletionTarget[],
        waveDeletedCount: number,
      ): Promise<void> => {
        if (waveDeletedCount === 0) {
          return;
        }

        /**
         * Commit derived metadata while the deleted documents are still available in
         * memory. Descendant discovery can fail after this point; deferring the
         * reconciliation until the whole walk completes would make the root's tags and
         * project impossible to recover on a later retry.
         */
        const tagDecrements: string[] = [];
        for (const conversation of wave) {
          for (const tag of new Set(conversation.tags ?? [])) {
            tagDecrements.push(tag);
          }
        }
        await deps.decrementTagCounts(user, tagDecrements);

        const waveProjectIds = new Set(
          wave
            .map((conversation) => conversation.chatProjectId)
            .filter((projectId): projectId is string => Boolean(projectId)),
        );
        if (waveProjectIds.size > 0) {
          try {
            await refreshChatProjectStatsInBatches(
              (projectId) => store.refreshChatProjectStats(user, projectId),
              waveProjectIds,
            );
          } catch (error) {
            logger.error('[deleteConvos] Conversations deleted but stats refresh failed', error);
          }
        }
      };
      while (pending.length > 0) {
        const wave = pending.filter((conversation) => !seen.has(conversation.conversationId));
        if (wave.length === 0) {
          break;
        }
        const waveIds = wave.map((conversation) => conversation.conversationId);
        await deps.deleteAgentQueuedTurns?.(
          user,
          wave.map((conversation) => ({
            conversationId: conversation.conversationId,
            ...(conversation.tenantId != null && { tenantId: conversation.tenantId }),
          })),
        );
        await options?.beforeDelete?.(waveIds);
        await deps.prepareAgentTriggerConversationResultErasure?.(user, waveIds);
        await retryCascadeOperation(() => deps.prepareSubagentContentDeletion(user, waveIds));
        /** Not retried: the step also keeps the search index in step with the delete. */
        const result = await store.deleteConvoRecords(user, waveIds);
        if (result.deletedCount > 0) {
          /** Result erasure is irreversible. Keep receipts intact when a
           * pre-delete hook or the conversation delete itself fails, so a
           * retained conversation cannot lose a receipt-only completion. */
          try {
            await deps.eraseAgentTriggerDeliveryConversationResults?.(user, waveIds);
          } catch (error) {
            logger.error('[deleteConvos] Receipt erasure deferred to durable cleanup', error);
          }
        }
        acknowledged &&= result.acknowledged;
        deletedCount += result.deletedCount;
        await reconcileDeletedWave(wave, result.deletedCount);
        for (const conversation of wave) {
          seen.add(conversation.conversationId);
          deletedConversations.push(conversation);
        }
        pending = await retryCascadeOperation(() =>
          store.listSubagentChildrenForDeletion(user, waveIds),
        );
      }

      const conversationIds = [
        ...recoveryConversationIds,
        ...deletedConversations.map((conversation) => conversation.conversationId),
      ];

      if (recoveryConversationIds.length > 0) {
        await deps.deleteAgentQueuedTurns?.(
          user,
          recoveryConversationIds.map((conversationId) => ({
            conversationId,
            allTenants: true,
          })),
        );
        try {
          await deps.eraseAgentTriggerDeliveryConversationResults?.(user, recoveryConversationIds);
        } catch (error) {
          logger.error('[deleteConvos] Receipt erasure deferred to durable cleanup', error);
        }
      }

      const deleteConvoResult: ConvoDeletionCount = { acknowledged, deletedCount };

      /**
       * Post-delete cleanup is best-effort: the conversations are already gone, so a
       * thrown error here would hide the deletion from the caller — dropping the
       * `conversationIds` that downstream cleanup (e.g. agent-checkpoint pruning)
       * needs, with no way to recover them on retry (the query finds nothing).
       */
      let deleteMessagesResult: ConvoDeletionCount = { acknowledged: false, deletedCount: 0 };
      try {
        deleteMessagesResult = await deps.deleteConvoMessages(user, conversationIds);
      } catch (error) {
        logger.error('[deleteConvos] Conversations deleted but message cleanup failed', error);
      }

      try {
        await deps.deleteToolApprovalGrants(user, conversationIds);
      } catch {
        logger.warn('[deleteConvos] Remembered approval cleanup failed.');
      }

      // conversationIds lets callers run sibling cleanup that lives in higher layers
      // (e.g. pruning the conversations' durable agent checkpoints) without re-querying
      // documents that no longer exist.
      return { ...deleteConvoResult, messages: deleteMessagesResult, conversationIds };
    } catch (error) {
      logger.error('[deleteConvos] Error deleting conversations and messages', error);
      throw error;
    }
  };
}

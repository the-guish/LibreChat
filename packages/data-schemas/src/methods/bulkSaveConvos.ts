/**
 * `bulkSaveConvos`, written once on the database-neutral "bulkSaveConvos steps" of the
 * conversation store.
 *
 * Every rule of a bulk save lives here: which imported fields are dropped, which are only seeded
 * on insert, the project-ownership check, and which projects get their statistics refreshed.
 * Conversation records go only through the store steps; the ownership of chat projects (another
 * collection) goes through {@link BulkSaveConvosDeps}. Any adapter that implements both gets the
 * same `bulkSaveConvos`. Nothing here may import `mongoose` or touch a model.
 *
 * {@link BulkSaveConvosStore} repeats the step signatures of `ConversationStore`
 * (`~/ports/conversation`) instead of picking them, because that port imports
 * `~/methods/conversation`, which builds its `bulkSaveConvos` from this module.
 * `bulkSaveConvos.spec.ts` beside this file fails the typecheck if the two drift.
 */
import type { ConvoBulkUpsert, ConvoBulkUpsertResult, ConvoProjectAssignment } from '~/types';
import { LANE_PRIVATE_FIELDS, stripActorCheckpointFields, stripFields } from './conversationFields';
import logger from '~/config/winston';

/** The conversation-store operations `bulkSaveConvos` is written on; signatures as in the port. */
export interface BulkSaveConvosStore {
  listConvoProjectAssignments(
    pairs: Array<{ user: string; conversationId: string }>,
  ): Promise<ConvoProjectAssignment[]>;
  bulkUpsertConvos(upserts: ConvoBulkUpsert[]): Promise<ConvoBulkUpsertResult>;
  refreshChatProjectStats(user: string, chatProjectId: string): Promise<void>;
}

/** Work on records outside the conversation collection that a bulk save needs. */
export interface BulkSaveConvosDeps {
  /**
   * The listed pairs whose project exists and is owned by that user, with the project id as the
   * store spells it. A malformed id is never owned.
   */
  listOwnedChatProjectIds(
    pairs: Array<{ user: string; chatProjectId: string }>,
  ): Promise<Array<{ user: string; chatProjectId: string }>>;
}

/**
 * The signature of `ConversationMethods['bulkSaveConvos']`, with the result typed as the
 * neutral summary the store reports. Assignable to the method's declared type.
 */
export type BulkSaveConvos = (
  conversations: Array<Record<string, unknown>>,
) => Promise<ConvoBulkUpsertResult>;

/** Builds `bulkSaveConvos` on `store`, which it shares: pass the steps of one instance. */
export function createBulkSaveConvos(
  store: BulkSaveConvosStore,
  deps: BulkSaveConvosDeps,
): BulkSaveConvos {
  return async function bulkSaveConvos(conversations) {
    try {
      /**
       * Validate project ownership before persisting (mirrors saveConvo). Bulk
       * paths like import/duplicate/fork can carry a chatProjectId that does not
       * belong to the user; persisting it would create an orphan assignment that
       * is hidden from both the project and the unassigned filter.
       */
      const candidatePairs = new Map<string, { user: string; chatProjectId: string }>();
      for (const convo of conversations) {
        if (typeof convo.user === 'string' && typeof convo.chatProjectId === 'string') {
          candidatePairs.set(`${convo.user}:${convo.chatProjectId}`, {
            user: convo.user,
            chatProjectId: convo.chatProjectId,
          });
        }
      }

      const ownedProjects = new Set<string>();
      if (candidatePairs.size > 0) {
        const owned = await deps.listOwnedChatProjectIds([...candidatePairs.values()]);
        for (const project of owned) {
          ownedProjects.add(`${project.user}:${project.chatProjectId}`);
        }
      }

      /**
       * Capture each conversation's existing project so a bulk move (import that
       * overwrites an existing (user, conversationId), duplicate/fork) also refreshes
       * the project it leaves, not just the one it joins. One batched read keeps this
       * O(1) in round-trips regardless of batch size.
       */
      const previousProjectByConversation = new Map<string, string>();
      const conversationPairs = conversations
        .filter((c) => typeof c.user === 'string' && typeof c.conversationId === 'string')
        .map((c) => ({ user: c.user as string, conversationId: c.conversationId as string }));
      if (conversationPairs.length > 0) {
        const existing = await store.listConvoProjectAssignments(conversationPairs);
        for (const doc of existing) {
          if (doc.chatProjectId) {
            previousProjectByConversation.set(
              `${doc.user}:${doc.conversationId}`,
              doc.chatProjectId,
            );
          }
        }
      }

      const affectedProjectStats = new Map<string, { user: string; projectId: string }>();
      const upserts = conversations.map((convo): ConvoBulkUpsert => {
        const { codeEnvironmentMode, codeWorkspaces, ...sanitized } = convo;
        /* Read state belongs to the reader who lived through the replies, so an import never
           carries one in: the rows arrive unseen-free and unread-free. */
        delete sanitized.lastResponseAt;
        delete sanitized.lastResponseMessageId;
        delete sanitized.lastResponseIsManual;
        delete sanitized.isMarkedUnread;
        delete sanitized.lastSeenAt;
        delete sanitized.codeApprovalMode;
        delete sanitized.initial_agent_id;
        delete sanitized.toolApprovalAllows;
        stripFields(sanitized, LANE_PRIVATE_FIELDS);
        delete sanitized.codeEnvironmentRevision;
        stripActorCheckpointFields(sanitized);
        if (typeof sanitized.user === 'string' && typeof sanitized.chatProjectId === 'string') {
          if (ownedProjects.has(`${sanitized.user}:${sanitized.chatProjectId}`)) {
            affectedProjectStats.set(`${sanitized.user}:${sanitized.chatProjectId}`, {
              user: sanitized.user,
              projectId: sanitized.chatProjectId,
            });
          } else {
            sanitized.chatProjectId = null;
          }
        }
        if (typeof sanitized.user === 'string' && typeof sanitized.conversationId === 'string') {
          const previousProjectId = previousProjectByConversation.get(
            `${sanitized.user}:${sanitized.conversationId}`,
          );
          const newProjectId =
            typeof sanitized.chatProjectId === 'string' ? sanitized.chatProjectId : null;
          if (previousProjectId && previousProjectId !== newProjectId) {
            affectedProjectStats.set(`${sanitized.user}:${previousProjectId}`, {
              user: sanitized.user,
              projectId: previousProjectId,
            });
          }
        }
        return {
          /* The records are untyped and not validated here; callers always supply strings, and
             any other value reaches the store as given, as it reached the query before. */
          user: sanitized.user as string,
          conversationId: sanitized.conversationId as string,
          set: sanitized,
          setOnInsert: {
            initial_agent_id: null,
            ...(codeEnvironmentMode != null && { codeEnvironmentMode }),
            ...(codeWorkspaces != null && { codeWorkspaces }),
          },
        };
      });

      const result = await store.bulkUpsertConvos(upserts);
      await Promise.all(
        [...affectedProjectStats.values()].map(({ user, projectId }) =>
          store.refreshChatProjectStats(user, projectId),
        ),
      );
      return result;
    } catch (error) {
      logger.error('[bulkSaveConvos] Error saving conversations in bulk', error);
      throw new Error('Failed to save conversations in bulk.');
    }
  };
}

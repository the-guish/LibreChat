/**
 * `searchConversation`, written once on the database-neutral "searchConversation steps" of the
 * conversation store.
 *
 * The method's public signature still takes a MongoDB projection string. This module maps the
 * strings callers pass onto the store's neutral projection choice and rejects any other, so any
 * adapter that implements the step gets the same `searchConversation`. Nothing here may import
 * `mongoose` or touch a model.
 *
 * {@link SearchConversationStore} repeats the step signature of `ConversationStore`
 * (`~/ports/conversation`) instead of picking it, because that port imports
 * `~/methods/conversation`, which builds its `searchConversation` from this module.
 * `searchConversation.spec.ts` beside this file fails the typecheck if the two drift.
 */
import type { ConvoByIdProjection, IConversation } from '~/types';
import logger from '~/config/winston';

/** The conversation-store operation `searchConversation` is written on; signature as in the port. */
export interface SearchConversationStore {
  getConvoByIdAcrossUsers(
    conversationId: string,
    projection: ConvoByIdProjection,
  ): Promise<IConversation | null>;
}

/** The signature of `ConversationMethods['searchConversation']`. */
export type SearchConversation = (
  conversationId: string,
  fieldsToSelect?: string | null,
) => Promise<IConversation | null>;

/** The default projection: only the fields an ownership check reads. */
const OWNERSHIP_FIELDS = 'conversationId user';

/** Maps the projection strings callers pass onto the neutral choice; throws on any other. */
function toProjection(fieldsToSelect: string | null): ConvoByIdProjection {
  switch (fieldsToSelect) {
    case OWNERSHIP_FIELDS:
      return 'ownership';
    case '-messages':
      return 'withoutMessages';
    case null:
      return 'full';
    default:
      throw new Error(
        `searchConversation does not support the projection ${JSON.stringify(fieldsToSelect)}; ` +
          `pass '${OWNERSHIP_FIELDS}' (the default), '-messages' or null.`,
      );
  }
}

/**
 * Builds `searchConversation` on `store`. Finds a conversation by id regardless of its user;
 * `fieldsToSelect: null` returns the full document so one read can serve the whole request.
 */
export function createSearchConversation(store: SearchConversationStore): SearchConversation {
  return async function searchConversation(conversationId, fieldsToSelect = OWNERSHIP_FIELDS) {
    const projection = toProjection(fieldsToSelect);
    try {
      return await store.getConvoByIdAcrossUsers(conversationId, projection);
    } catch (error) {
      logger.error('[searchConversation] Error searching conversation', error);
      throw new Error('Error searching conversation');
    }
  };
}

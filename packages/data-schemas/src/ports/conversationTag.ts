/**
 * Conversation tag store port: the tags a user files conversations under (the bookmarks of the
 * conversation list), each with a position in the user's ordering and a count of the user's
 * conversations that carry it. Nothing here may import `mongoose`. Signatures are those of
 * `ConversationTagMethods` (`~/methods/conversationTag`) with each tag stated as a
 * `ConversationTagRecord`; `conversationTag.spec.ts` fails the typecheck if the MongoDB
 * methods stop satisfying them.
 *
 * A tag is unique per user by its name. Renaming or deleting a tag renames or removes it on the
 * user's conversations as well. Failures are thrown as errors whose message names the
 * operation, except in `bulkIncrementTagCounts`, which logs them.
 *
 * `deleteConversationTags` is not in this port: it takes a raw MongoDB filter (account erasure
 * passes `{ user }`).
 *
 * Known leak kept for now so callers stay unchanged: `ConversationTagRecord` carries the
 * record's ObjectId (`_id`).
 */
import type { ConversationTagRecord } from '~/types';
import { listPortMethods } from './common';

export interface ConversationTagStore {
  /** The user's tags, in position order. */
  getConversationTags(user: string): Promise<ConversationTagRecord[]>;
  /**
   * Creates the user's tag last in position order, or resolves to the existing one of that
   * name unchanged. With `addToConversation` and a `conversationId`, the new tag starts at a
   * count of one and is added to that conversation.
   */
  createConversationTag(
    user: string,
    data: {
      tag: string;
      description?: string;
      addToConversation?: boolean;
      conversationId?: string;
    },
  ): Promise<ConversationTagRecord | null>;
  /**
   * Renames, re-describes or moves the user's tag `oldTag` (moving shifts the tags between its
   * old and new positions) and resolves to it updated, or `null` when the user has no such tag.
   * Throws when the new name is already a tag of the user's.
   */
  updateConversationTag(
    user: string,
    oldTag: string,
    data: { tag?: string; description?: string; position?: number },
  ): Promise<ConversationTagRecord | null>;
  /**
   * Deletes the user's tag, removes it from their conversations and closes the gap in the
   * ordering; resolves to the deleted tag, or `null` when there was none.
   */
  deleteConversationTag(user: string, tag: string): Promise<ConversationTagRecord | null>;
  /** Adds one to the count of each of the user's existing tags named (each name once). */
  bulkIncrementTagCounts(user: string, tags: string[]): Promise<void>;
  /**
   * Sets the conversation's tags to `tags`, creating tags the user does not have yet and
   * adjusting the counts of the tags added and removed; resolves to the conversation's tags.
   * Throws when the user has no such conversation.
   */
  updateTagsForConversation(
    user: string,
    conversationId: string,
    tags: string[],
  ): Promise<string[]>;
}

/** Every method of {@link ConversationTagStore}, for adapters and conformance checks. */
export const CONVERSATION_TAG_STORE_METHODS: ReadonlyArray<keyof ConversationTagStore> =
  listPortMethods<ConversationTagStore>({
    getConversationTags: true,
    createConversationTag: true,
    updateConversationTag: true,
    deleteConversationTag: true,
    bulkIncrementTagCounts: true,
    updateTagsForConversation: true,
  });

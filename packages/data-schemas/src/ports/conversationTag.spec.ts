import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { ConversationTagMethods } from '~/methods/conversationTag';
import type { ConversationTagStore } from './conversationTag';
import { createConversationTagMethods } from '~/methods/conversationTag';
import { CONVERSATION_TAG_STORE_METHODS } from './conversationTag';

/**
 * Conversation tag methods left out of the port, each with the reason: none. The criteria of
 * `deleteConversationTags` are stated in the store query language; the other methods'
 * signatures are database-neutral but for the tags they resolve, typed as mongoose lean
 * documents, which the port states as `ConversationTagRecord`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<ConversationTagStore, ConversationTagMethods>>,
  Assert<EveryMethodPlaced<ConversationTagStore, ConversationTagMethods, Excluded>>,
  Assert<ExclusionsHold<ConversationTagStore, Excluded>>,
];

describe('ConversationTagStore port', () => {
  const methods = createConversationTagMethods(mongoose);

  it('matches the MongoDB conversation tag methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(CONVERSATION_TAG_STORE_METHODS).size).toBe(
      CONVERSATION_TAG_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...CONVERSATION_TAG_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB conversation tag methods', () => {
    const store: ConversationTagStore = methods;
    for (const name of CONVERSATION_TAG_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

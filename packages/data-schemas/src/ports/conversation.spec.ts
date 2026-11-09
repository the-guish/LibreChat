import mongoose from 'mongoose';
import type { ConversationMethods } from '~/methods/conversation';
import type { ConversationStore } from './conversation';
import { createConversationMethods } from '~/methods/conversation';
import { CONVERSATION_STORE_METHODS } from './conversation';

/*
 * Type-level conformance. These lines fail `npm run typecheck`, not Jest, when the port
 * and the MongoDB methods drift apart.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Conversation methods deliberately left out of the port; see the header of `./conversation`. */
type ExcludedFromPort = 'saveConvo' | 'deleteConvos' | 'bulkSaveConvos' | 'searchConversation';

/** Every port method exists on the MongoDB methods with exactly the same signature. */
type SignaturesMatch = Assert<
  Equals<
    { [K in keyof ConversationStore]: ConversationStore[K] },
    { [K in keyof ConversationStore]: ConversationMethods[K] }
  >
>;
/** Every conversation method is either in the port or explicitly excluded from it. */
type EveryMethodPlaced = Assert<
  Equals<keyof ConversationMethods, keyof ConversationStore | ExcludedFromPort>
>;
/** The excluded methods really are excluded. */
type ExclusionsHold = Assert<Equals<Extract<keyof ConversationStore, ExcludedFromPort>, never>>;

describe('ConversationStore port', () => {
  it('matches the MongoDB conversation methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: [SignaturesMatch, EveryMethodPlaced, ExclusionsHold] = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(CONVERSATION_STORE_METHODS).size).toBe(CONVERSATION_STORE_METHODS.length);
  });

  it('is satisfied by the MongoDB conversation methods', () => {
    const store: ConversationStore = createConversationMethods(mongoose);
    for (const name of CONVERSATION_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

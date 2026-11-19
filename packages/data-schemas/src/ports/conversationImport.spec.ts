import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ConversationImportStore } from './conversationImport';
import type { ConversationImportMethods } from '~/methods/import';
import { CONVERSATION_IMPORT_STORE_METHODS } from './conversationImport';
import { createConversationImportMethods } from '~/methods/import';

/**
 * Conversation import methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<ConversationImportStore, ConversationImportMethods>>,
  Assert<EveryMethodPlaced<ConversationImportStore, ConversationImportMethods, Excluded>>,
  Assert<ExclusionsHold<ConversationImportStore, Excluded>>,
];

describe('ConversationImportStore port', () => {
  const methods = createConversationImportMethods(mongoose);

  it('matches the MongoDB conversation import methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(CONVERSATION_IMPORT_STORE_METHODS).size).toBe(
      CONVERSATION_IMPORT_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...CONVERSATION_IMPORT_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB conversation import methods', () => {
    const store: ConversationImportStore = methods;
    for (const name of CONVERSATION_IMPORT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

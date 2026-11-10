import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ChatProjectMethods } from '~/methods/chatProject';
import type { ChatProjectStore } from './chatProject';
import { createChatProjectMethods } from '~/methods/chatProject';
import { CHAT_PROJECT_STORE_METHODS } from './chatProject';

/**
 * Chat project methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral and copied verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<ChatProjectStore, ChatProjectMethods>>,
  Assert<EveryMethodPlaced<ChatProjectStore, ChatProjectMethods, Excluded>>,
  Assert<ExclusionsHold<ChatProjectStore, Excluded>>,
];

describe('ChatProjectStore port', () => {
  const methods = createChatProjectMethods(mongoose);

  it('matches the MongoDB chat project methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(CHAT_PROJECT_STORE_METHODS).size).toBe(CHAT_PROJECT_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...CHAT_PROJECT_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB chat project methods', () => {
    const store: ChatProjectStore = methods;
    for (const name of CHAT_PROJECT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

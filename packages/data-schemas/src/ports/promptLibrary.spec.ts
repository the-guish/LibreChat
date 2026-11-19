import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { PromptLibraryStore } from './promptLibrary';
import type { PromptMethods } from '~/methods/prompt';
import { PROMPT_LIBRARY_STORE_METHODS } from './promptLibrary';
import { createPromptMethods } from '~/methods/prompt';

/**
 * Prompt methods left out of the port, each with the reason: none. The criteria and updates of
 * `getPromptGroups`, `getAllPromptGroups`, `getPrompts`, `getPrompt`, `getPromptGroup` and
 * `updatePromptGroup` are stated in the store query language; the other methods' signatures are
 * database-neutral but for ids typed `Types.ObjectId`, which the port states as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<PromptLibraryStore, PromptMethods>>,
  Assert<EveryMethodPlaced<PromptLibraryStore, PromptMethods, Excluded>>,
  Assert<ExclusionsHold<PromptLibraryStore, Excluded>>,
];

describe('PromptLibraryStore port', () => {
  const methods = createPromptMethods(mongoose, {
    removeAllPermissions: async () => undefined,
    getSoleOwnedResourceIds: async () => [],
    getUserPrincipals: async () => [],
    findAccessibleResources: async () => [],
    findPublicResourceIds: async () => [],
  });

  it('matches the MongoDB prompt methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(PROMPT_LIBRARY_STORE_METHODS).size).toBe(PROMPT_LIBRARY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...PROMPT_LIBRARY_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB prompt methods', () => {
    const store: PromptLibraryStore = methods;
    for (const name of PROMPT_LIBRARY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

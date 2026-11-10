import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { SubagentContentMethods } from '~/methods/subagentContent';
import type { SubagentContentStore } from './subagentContent';
import { createSubagentContentMethods } from '~/methods/subagentContent';
import { SUBAGENT_CONTENT_STORE_METHODS } from './subagentContent';

/**
 * Subagent content methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim. (The module's
 * standalone `prepareSubagentContentDeletion` is not one of the factory's methods.)
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<SubagentContentStore, SubagentContentMethods>>,
  Assert<EveryMethodPlaced<SubagentContentStore, SubagentContentMethods, Excluded>>,
  Assert<ExclusionsHold<SubagentContentStore, Excluded>>,
];

describe('SubagentContentStore port', () => {
  const methods = createSubagentContentMethods(mongoose);

  it('matches the MongoDB subagent content methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SUBAGENT_CONTENT_STORE_METHODS).size).toBe(
      SUBAGENT_CONTENT_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...SUBAGENT_CONTENT_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB subagent content methods', () => {
    const store: SubagentContentStore = methods;
    for (const name of SUBAGENT_CONTENT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

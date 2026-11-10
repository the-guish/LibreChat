import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { AgentCategoryMethods } from '~/methods/agentCategory';
import type { AgentCategoryStore } from './agentCategory';
import { createAgentCategoryMethods } from '~/methods/agentCategory';
import { AGENT_CATEGORY_STORE_METHODS } from './agentCategory';

/**
 * Agent category methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<AgentCategoryStore, AgentCategoryMethods>>,
  Assert<EveryMethodPlaced<AgentCategoryStore, AgentCategoryMethods, Excluded>>,
  Assert<ExclusionsHold<AgentCategoryStore, Excluded>>,
];

describe('AgentCategoryStore port', () => {
  const methods = createAgentCategoryMethods(mongoose);

  it('matches the MongoDB agent category methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(AGENT_CATEGORY_STORE_METHODS).size).toBe(AGENT_CATEGORY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...AGENT_CATEGORY_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB agent category methods', () => {
    const store: AgentCategoryStore = methods;
    for (const name of AGENT_CATEGORY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

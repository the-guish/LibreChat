import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { AssistantMethods } from '~/methods/assistant';
import type { AssistantStore } from './assistant';
import { createAssistantMethods } from '~/methods/assistant';
import { ASSISTANT_STORE_METHODS } from './assistant';

/**
 * Assistant methods left out of the port, each with the reason: none. `getAssistant` and
 * `getAssistants` take projections the port states in the store query language; every other
 * method's signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AssistantStore, AssistantMethods>>,
  Assert<EveryMethodPlaced<AssistantStore, AssistantMethods, Excluded>>,
  Assert<ExclusionsHold<AssistantStore, Excluded>>,
];

describe('AssistantStore port', () => {
  const methods = createAssistantMethods(mongoose);

  it('matches the MongoDB assistant methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(ASSISTANT_STORE_METHODS).size).toBe(ASSISTANT_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...ASSISTANT_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB assistant methods', () => {
    const store: AssistantStore = methods;
    for (const name of ASSISTANT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

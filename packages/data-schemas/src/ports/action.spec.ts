import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ActionMethods } from '~/methods/action';
import type { ActionStore } from './action';
import { createActionMethods } from '~/methods/action';
import { ACTION_STORE_METHODS } from './action';

/**
 * Action methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<ActionStore, ActionMethods>>,
  Assert<EveryMethodPlaced<ActionStore, ActionMethods, Excluded>>,
  Assert<ExclusionsHold<ActionStore, Excluded>>,
];

describe('ActionStore port', () => {
  const methods = createActionMethods(mongoose);

  it('matches the MongoDB action methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(ACTION_STORE_METHODS).size).toBe(ACTION_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...ACTION_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB action methods', () => {
    const store: ActionStore = methods;
    for (const name of ACTION_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

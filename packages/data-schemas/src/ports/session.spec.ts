import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { SessionMethods } from '~/methods/session';
import type { SessionStore } from './session';
import { createSessionMethods } from '~/methods/session';
import { SESSION_STORE_METHODS } from './session';

/**
 * Session methods left out of the port, each with the reason:
 * - `SessionError`: the error class the methods throw, not a store operation. A store throws
 *   it; callers may test for it.
 *
 * Every other method's signature is already database-neutral, so the port copies them
 * verbatim.
 */
const EXCLUDED = ['SessionError'] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<SessionStore, SessionMethods>>,
  Assert<EveryMethodPlaced<SessionStore, SessionMethods, Excluded>>,
  Assert<ExclusionsHold<SessionStore, Excluded>>,
];

describe('SessionStore port', () => {
  const methods = createSessionMethods(mongoose);

  it('matches the MongoDB session methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SESSION_STORE_METHODS).size).toBe(SESSION_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...SESSION_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB session methods', () => {
    const store: SessionStore = methods;
    for (const name of SESSION_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

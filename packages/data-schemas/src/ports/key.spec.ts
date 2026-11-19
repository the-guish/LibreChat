import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { KeyMethods } from '~/methods/key';
import type { UserKeyStore } from './key';
import { createKeyMethods } from '~/methods/key';
import { USER_KEY_STORE_METHODS } from './key';

/**
 * User key methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<UserKeyStore, KeyMethods>>,
  Assert<EveryMethodPlaced<UserKeyStore, KeyMethods, Excluded>>,
  Assert<ExclusionsHold<UserKeyStore, Excluded>>,
];

describe('UserKeyStore port', () => {
  const methods = createKeyMethods(mongoose);

  it('matches the MongoDB user key methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(USER_KEY_STORE_METHODS).size).toBe(USER_KEY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...USER_KEY_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB user key methods', () => {
    const store: UserKeyStore = methods;
    for (const name of USER_KEY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

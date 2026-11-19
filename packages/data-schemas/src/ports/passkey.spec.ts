import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { PasskeyMethods } from '~/methods/passkey';
import type { PasskeyStore } from './passkey';
import { createPasskeyMethods } from '~/methods/passkey';
import { PASSKEY_STORE_METHODS } from './passkey';

/**
 * Passkey methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for the driver's `DeleteResult`, which the port states as
 * `DeleteCount`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<PasskeyStore, PasskeyMethods>>,
  Assert<EveryMethodPlaced<PasskeyStore, PasskeyMethods, Excluded>>,
  Assert<ExclusionsHold<PasskeyStore, Excluded>>,
];

describe('PasskeyStore port', () => {
  const methods = createPasskeyMethods(mongoose);

  it('matches the MongoDB passkey methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(PASSKEY_STORE_METHODS).size).toBe(PASSKEY_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...PASSKEY_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB passkey methods', () => {
    const store: PasskeyStore = methods;
    for (const name of PASSKEY_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

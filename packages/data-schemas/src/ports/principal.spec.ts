import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { PrincipalMethods } from '~/methods/principal';
import type { PrincipalStore } from './principal';
import { createPrincipalMethods } from '~/methods/principal';
import { PRINCIPAL_STORE_METHODS } from './principal';

/**
 * Principal methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<PrincipalStore, PrincipalMethods>>,
  Assert<EveryMethodPlaced<PrincipalStore, PrincipalMethods, Excluded>>,
  Assert<ExclusionsHold<PrincipalStore, Excluded>>,
];

describe('PrincipalStore port', () => {
  const methods = createPrincipalMethods(mongoose);

  it('matches the MongoDB principal methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(PRINCIPAL_STORE_METHODS).size).toBe(PRINCIPAL_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...PRINCIPAL_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB principal methods', () => {
    const store: PrincipalStore = methods;
    for (const name of PRINCIPAL_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

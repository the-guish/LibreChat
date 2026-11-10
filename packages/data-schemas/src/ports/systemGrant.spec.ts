import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { SystemGrantMethods } from '~/methods/systemGrant';
import type { SystemGrantStore } from './systemGrant';
import { createSystemGrantMethods } from '~/methods/systemGrant';
import { SYSTEM_GRANT_STORE_METHODS } from './systemGrant';

/**
 * System grant methods left out of the port, each with the reason:
 * - `grantCapability`: its optional trailing parameter is a MongoDB `ClientSession`.
 * - `revokeCapability`: its optional trailing parameter is a MongoDB `ClientSession`.
 * - `deleteGrantsForPrincipal`: its options take a MongoDB `ClientSession`.
 *
 * The other methods' signatures are database-neutral but for principal ids typed
 * `Types.ObjectId`, which the port states as `IdLike`.
 */
const EXCLUDED = ['grantCapability', 'revokeCapability', 'deleteGrantsForPrincipal'] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<SystemGrantStore, SystemGrantMethods>>,
  Assert<EveryMethodPlaced<SystemGrantStore, SystemGrantMethods, Excluded>>,
  Assert<ExclusionsHold<SystemGrantStore, Excluded>>,
];

describe('SystemGrantStore port', () => {
  const methods = createSystemGrantMethods(mongoose);

  it('matches the MongoDB system grant methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SYSTEM_GRANT_STORE_METHODS).size).toBe(SYSTEM_GRANT_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...SYSTEM_GRANT_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB system grant methods', () => {
    const store: SystemGrantStore = methods;
    for (const name of SYSTEM_GRANT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

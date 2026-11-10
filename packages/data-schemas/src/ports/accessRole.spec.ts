import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { AccessRoleMethods } from '~/methods/accessRole';
import type { AccessRoleStore } from './accessRole';
import { createAccessRoleMethods } from '~/methods/accessRole';
import { ACCESS_ROLE_STORE_METHODS } from './accessRole';

/**
 * Access role methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for role ids typed `Types.ObjectId`, which the port states
 * as `IdLike`, and the driver's `DeleteResult`, which it states as `DeleteCount`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<AccessRoleStore, AccessRoleMethods>>,
  Assert<EveryMethodPlaced<AccessRoleStore, AccessRoleMethods, Excluded>>,
  Assert<ExclusionsHold<AccessRoleStore, Excluded>>,
];

describe('AccessRoleStore port', () => {
  const methods = createAccessRoleMethods(mongoose);

  it('matches the MongoDB access role methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(ACCESS_ROLE_STORE_METHODS).size).toBe(ACCESS_ROLE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...ACCESS_ROLE_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB access role methods', () => {
    const store: AccessRoleStore = methods;
    for (const name of ACCESS_ROLE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

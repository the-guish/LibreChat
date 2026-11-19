import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { RoleMethods } from '~/methods/role';
import type { RoleStore } from './role';
import { createRoleMethods } from '~/methods/role';
import { ROLE_STORE_METHODS } from './role';

/**
 * Role methods left out of the port: none. `getRoleByName` and `findRolesByNames` state their
 * projection (`fieldsToSelect`) in the store query language.
 *
 * Every other method's signature is already database-neutral, so the port copies them
 * verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<RoleStore, RoleMethods>>,
  Assert<EveryMethodPlaced<RoleStore, RoleMethods, Excluded>>,
  Assert<ExclusionsHold<RoleStore, Excluded>>,
];

describe('RoleStore port', () => {
  const methods = createRoleMethods(mongoose);

  it('matches the MongoDB role methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(ROLE_STORE_METHODS).size).toBe(ROLE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...ROLE_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB role methods', () => {
    const store: RoleStore = methods;
    for (const name of ROLE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { UserGroupMethods } from '~/methods/userGroup';
import type { UserGroupStore } from './userGroup';
import { createUserGroupMethods } from '~/methods/userGroup';
import { USER_GROUP_STORE_METHODS } from './userGroup';

/**
 * User group methods left out of the port, each with the reason:
 * - `calculateRelevanceScore`, `sortPrincipalsByRelevance`: pure ranking helpers for principal
 *   search results; they read and write nothing.
 *
 * The other methods' signatures are database-neutral but for ids typed `Types.ObjectId`, which
 * the port states as `IdLike`, the optional MongoDB `ClientSession` most of them take last,
 * which the port leaves out because no caller passes one, and the projections, criteria and
 * updates of `findGroupById`, `findGroupByExternalId`, `findGroupByQuery`, `updateGroupById`
 * and `bulkUpdateGroups`, which the port states in the store query language.
 */
const EXCLUDED = ['calculateRelevanceScore', 'sortPrincipalsByRelevance'] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<UserGroupStore, UserGroupMethods>>,
  Assert<EveryMethodPlaced<UserGroupStore, UserGroupMethods, Excluded>>,
  Assert<ExclusionsHold<UserGroupStore, Excluded>>,
];

describe('UserGroupStore port', () => {
  const methods = createUserGroupMethods(mongoose);

  it('matches the MongoDB user group methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(USER_GROUP_STORE_METHODS).size).toBe(USER_GROUP_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...USER_GROUP_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB user group methods', () => {
    const store: UserGroupStore = methods;
    for (const name of USER_GROUP_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

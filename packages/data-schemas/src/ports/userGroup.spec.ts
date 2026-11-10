import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { UserGroupMethods } from '~/methods/userGroup';
import type { UserGroupStore } from './userGroup';
import { createUserGroupMethods } from '~/methods/userGroup';
import { USER_GROUP_STORE_METHODS } from './userGroup';

/**
 * User group methods left out of the port, each with the reason:
 * - `findGroupById`: its second parameter is a raw MongoDB projection, its third a session.
 * - `findGroupByExternalId`: its third parameter is a raw MongoDB projection, its fourth a
 *   session.
 * - `findGroupByQuery`: its first parameter is a raw MongoDB filter, its second a session.
 * - `updateGroupById`: its second parameter is a raw `$set` document, its third a session.
 * - `bulkUpdateGroups`: it takes a raw MongoDB filter, a raw update and a session, and
 *   resolves to the driver's `UpdateWriteOpResult`.
 * - `calculateRelevanceScore`, `sortPrincipalsByRelevance`: pure ranking helpers for principal
 *   search results; they read and write nothing.
 *
 * The other methods' signatures are database-neutral but for ids typed `Types.ObjectId`, which
 * the port states as `IdLike`, and the optional MongoDB `ClientSession` most of them take last,
 * which the port leaves out because no caller passes one.
 */
const EXCLUDED = [
  'findGroupById',
  'findGroupByExternalId',
  'findGroupByQuery',
  'updateGroupById',
  'bulkUpdateGroups',
  'calculateRelevanceScore',
  'sortPrincipalsByRelevance',
] as const;
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

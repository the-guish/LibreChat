import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { UserMethods } from '~/methods/user';
import type { UserStore } from './user';
import { createUserMethods } from '~/methods/user';
import { USER_STORE_METHODS } from './user';

/**
 * User methods left out of the port, each with the reason:
 * - `findUser`: its first parameter is a raw MongoDB filter (`FilterQuery<IUser>`), its second
 *   a projection.
 * - `findUsers`: a raw MongoDB filter, a projection and a sort record.
 * - `countUsers`: its parameter is a raw MongoDB filter.
 * - `updateUser`: its third parameter (`expectedState`) is a raw MongoDB filter.
 * - `getUserById`: its second parameter is a projection.
 * - `searchUsers`: its `fieldsToSelect` is a projection, and it resolves to hydrated-document
 *   fields (`collection`, `db`, `schema`, ...) typed with mongoose classes.
 *
 * The other methods' signatures are database-neutral but for the id `createUser` resolves to
 * (`Types.ObjectId`), which the port states as `IdLike`.
 */
const EXCLUDED = [
  'findUser',
  'findUsers',
  'countUsers',
  'updateUser',
  'getUserById',
  'searchUsers',
] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<UserStore, UserMethods>>,
  Assert<EveryMethodPlaced<UserStore, UserMethods, Excluded>>,
  Assert<ExclusionsHold<UserStore, Excluded>>,
];

describe('UserStore port', () => {
  const methods = createUserMethods(mongoose);

  it('matches the MongoDB user methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(USER_STORE_METHODS).size).toBe(USER_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...USER_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB user methods', () => {
    const store: UserStore = methods;
    for (const name of USER_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

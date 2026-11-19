import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ResourceLockMethods } from '~/methods/resourceLock';
import type { ResourceLockStore } from './resourceLock';
import { createResourceLockMethods } from '~/methods/resourceLock';
import { RESOURCE_LOCK_STORE_METHODS } from './resourceLock';

/**
 * Resource lock methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<ResourceLockStore, ResourceLockMethods>>,
  Assert<EveryMethodPlaced<ResourceLockStore, ResourceLockMethods, Excluded>>,
  Assert<ExclusionsHold<ResourceLockStore, Excluded>>,
];

describe('ResourceLockStore port', () => {
  const methods = createResourceLockMethods(mongoose);

  it('matches the MongoDB resource lock methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(RESOURCE_LOCK_STORE_METHODS).size).toBe(RESOURCE_LOCK_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...RESOURCE_LOCK_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB resource lock methods', () => {
    const store: ResourceLockStore = methods;
    for (const name of RESOURCE_LOCK_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

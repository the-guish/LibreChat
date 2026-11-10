import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ShareMethods } from '~/methods/share';
import type { SharedLinkStore } from './share';
import { createShareMethods } from '~/methods/share';
import { SHARED_LINK_STORE_METHODS } from './share';

/**
 * Share methods left out of the port, each with the reason: none. Every method's signature is
 * already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<SharedLinkStore, ShareMethods>>,
  Assert<EveryMethodPlaced<SharedLinkStore, ShareMethods, Excluded>>,
  Assert<ExclusionsHold<SharedLinkStore, Excluded>>,
];

describe('SharedLinkStore port', () => {
  const methods = createShareMethods(mongoose);

  it('matches the MongoDB share methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SHARED_LINK_STORE_METHODS).size).toBe(SHARED_LINK_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...SHARED_LINK_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB share methods', () => {
    const store: SharedLinkStore = methods;
    for (const name of SHARED_LINK_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

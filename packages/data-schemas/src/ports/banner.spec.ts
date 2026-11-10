import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { BannerMethods } from '~/methods/banner';
import type { BannerStore } from './banner';
import { createBannerMethods } from '~/methods/banner';
import { BANNER_STORE_METHODS } from './banner';

/**
 * Banner methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<BannerStore, BannerMethods>>,
  Assert<EveryMethodPlaced<BannerStore, BannerMethods, Excluded>>,
  Assert<ExclusionsHold<BannerStore, Excluded>>,
];

describe('BannerStore port', () => {
  const methods = createBannerMethods(mongoose);

  it('matches the MongoDB banner methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(BANNER_STORE_METHODS).size).toBe(BANNER_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...BANNER_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB banner methods', () => {
    const store: BannerStore = methods;
    for (const name of BANNER_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

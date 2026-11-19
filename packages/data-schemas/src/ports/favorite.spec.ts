import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ToolFavoriteMethods } from '~/methods/favorite';
import type { ToolFavoriteStore } from './favorite';
import { createToolFavoriteMethods } from '~/methods/favorite';
import { TOOL_FAVORITE_STORE_METHODS } from './favorite';

/**
 * Tool favorite methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<ToolFavoriteStore, ToolFavoriteMethods>>,
  Assert<EveryMethodPlaced<ToolFavoriteStore, ToolFavoriteMethods, Excluded>>,
  Assert<ExclusionsHold<ToolFavoriteStore, Excluded>>,
];

describe('ToolFavoriteStore port', () => {
  const methods = createToolFavoriteMethods(mongoose);

  it('matches the MongoDB tool favorite methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(TOOL_FAVORITE_STORE_METHODS).size).toBe(TOOL_FAVORITE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...TOOL_FAVORITE_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB tool favorite methods', () => {
    const store: ToolFavoriteStore = methods;
    for (const name of TOOL_FAVORITE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

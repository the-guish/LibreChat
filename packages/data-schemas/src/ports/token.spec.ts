import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { TokenMethods } from '~/methods/token';
import type { TokenStore } from './token';
import { createTokenMethods } from '~/methods/token';
import { TOKEN_STORE_METHODS } from './token';

/**
 * Token methods left out of the port, each with the reason:
 * - `findToken`: its second parameter is a raw MongoDB query options object (`QueryOptions`);
 *   callers pass `{ sort: { createdAt: -1 } }`.
 *
 * The other methods' signatures are database-neutral but for user ids typed `Types.ObjectId`,
 * which the port states as `IdLike`.
 */
const EXCLUDED = ['findToken'] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<TokenStore, TokenMethods>>,
  Assert<EveryMethodPlaced<TokenStore, TokenMethods, Excluded>>,
  Assert<ExclusionsHold<TokenStore, Excluded>>,
];

describe('TokenStore port', () => {
  const methods = createTokenMethods(mongoose);

  it('matches the MongoDB token methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(TOKEN_STORE_METHODS).size).toBe(TOKEN_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...TOKEN_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB token methods', () => {
    const store: TokenStore = methods;
    for (const name of TOKEN_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

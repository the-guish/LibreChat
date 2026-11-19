import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { TokenListMethods } from '~/methods/tokenList';
import type { TokenListStore } from './tokenList';
import { createTokenListMethods } from '~/methods/tokenList';
import { TOKEN_LIST_STORE_METHODS } from './tokenList';

/**
 * Token list methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<TokenListStore, TokenListMethods>>,
  Assert<EveryMethodPlaced<TokenListStore, TokenListMethods, Excluded>>,
  Assert<ExclusionsHold<TokenListStore, Excluded>>,
];

describe('TokenListStore port', () => {
  const methods = createTokenListMethods(mongoose);

  it('matches the MongoDB token list methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(TOKEN_LIST_STORE_METHODS).size).toBe(TOKEN_LIST_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...TOKEN_LIST_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB token list methods', () => {
    const store: TokenListStore = methods;
    for (const name of TOKEN_LIST_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

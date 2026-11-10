import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { SpendTokensMethods } from '~/methods/spendTokens';
import type { SpendTokensStore } from './spendTokens';
import { createSpendTokensMethods } from '~/methods/spendTokens';
import { SPEND_TOKENS_STORE_METHODS } from './spendTokens';

/**
 * Token spending methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for user ids typed `Types.ObjectId`, which the port states
 * as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<SpendTokensStore, SpendTokensMethods>>,
  Assert<EveryMethodPlaced<SpendTokensStore, SpendTokensMethods, Excluded>>,
  Assert<ExclusionsHold<SpendTokensStore, Excluded>>,
];

describe('SpendTokensStore port', () => {
  const methods = createSpendTokensMethods(mongoose, {
    createTransaction: async () => undefined,
    createStructuredTransaction: async () => undefined,
  });

  it('matches the MongoDB token spending methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SPEND_TOKENS_STORE_METHODS).size).toBe(SPEND_TOKENS_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...SPEND_TOKENS_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB token spending methods', () => {
    const store: SpendTokensStore = methods;
    for (const name of SPEND_TOKENS_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

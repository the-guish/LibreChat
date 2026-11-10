import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { TransactionMethods } from '~/methods/transaction';
import type { TokenTransactionStore } from './tokenTransaction';
import { TOKEN_TRANSACTION_STORE_METHODS } from './tokenTransaction';
import { createTransactionMethods } from '~/methods/transaction';

/**
 * Token transaction methods left out of the port, each with the reason:
 * - `getTransactions`: its parameter is a raw MongoDB filter on transactions; callers pass
 *   `{ user, context: 'message', conversationId }`.
 * - `deleteTransactions`: its parameter is a raw MongoDB filter on transactions, and it
 *   resolves to the driver's `DeleteResult`; account erasure passes `{ user }`.
 * - `deleteBalances`: its parameter is a raw MongoDB filter on balances, and it resolves to the
 *   driver's `DeleteResult`; account erasure passes `{ user }` (an ObjectId).
 *
 * The other methods' signatures are database-neutral but for the transaction's user id typed
 * `Types.ObjectId`, which the port states as `IdLike`.
 */
const EXCLUDED = ['getTransactions', 'deleteTransactions', 'deleteBalances'] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<TokenTransactionStore, TransactionMethods>>,
  Assert<EveryMethodPlaced<TokenTransactionStore, TransactionMethods, Excluded>>,
  Assert<ExclusionsHold<TokenTransactionStore, Excluded>>,
];

describe('TokenTransactionStore port', () => {
  const methods = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });

  it('matches the MongoDB token transaction methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(TOKEN_TRANSACTION_STORE_METHODS).size).toBe(
      TOKEN_TRANSACTION_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...TOKEN_TRANSACTION_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB token transaction methods', () => {
    const store: TokenTransactionStore = methods;
    for (const name of TOKEN_TRANSACTION_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

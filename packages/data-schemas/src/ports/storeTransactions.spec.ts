import mongoose from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { MongoStoreTransactionMethods } from '~/adapters/mongo/storeTransactions';
import type { StoreTransactions } from './storeTransactions';
import type { StoreTransaction } from './common';
import { createMongoStoreTransactionMethods } from '~/adapters/mongo/storeTransactions';
import { STORE_TRANSACTIONS_METHODS } from './storeTransactions';

/** Every MongoDB store transaction method is in the port. */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/**
 * A MongoDB session is a valid {@link StoreTransaction}, so the MongoDB methods that take a
 * session satisfy the ports that take a store transaction in its place.
 */
type SessionIsStoreTransaction = [ClientSession] extends [StoreTransaction] ? true : false;

/**
 * The callback a port caller writes, typed against the port, is one the MongoDB method accepts
 * (checked one way, as a function-typed property: the method hands it a session or `undefined`).
 */
type PortCallbackAccepted = Parameters<StoreTransactions['transaction']>[0] extends Parameters<
  MongoStoreTransactionMethods['transaction']
>[0]
  ? true
  : false;

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<StoreTransactions, MongoStoreTransactionMethods>>,
  Assert<EveryMethodPlaced<StoreTransactions, MongoStoreTransactionMethods, Excluded>>,
  Assert<ExclusionsHold<StoreTransactions, Excluded>>,
  Assert<SessionIsStoreTransaction>,
  Assert<PortCallbackAccepted>,
];

describe('StoreTransactions port', () => {
  const methods = createMongoStoreTransactionMethods(mongoose);

  it('matches the MongoDB store transaction methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(STORE_TRANSACTIONS_METHODS).size).toBe(STORE_TRANSACTIONS_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...STORE_TRANSACTIONS_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB store transaction methods', () => {
    const store: StoreTransactions = methods;
    for (const name of STORE_TRANSACTIONS_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

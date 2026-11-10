/**
 * Token transaction store port: the ledger of what model calls cost (and what refills and
 * adjustments credit) and the token-credit balances it moves, with the reservations that hold
 * credits for in-flight requests. Nothing here may import `mongoose`. Signatures are those of
 * `TransactionMethods` (`~/methods/transaction`) with the transaction's user id stated as
 * `IdLike`; `tokenTransaction.spec.ts` fails the typecheck if the MongoDB methods stop
 * satisfying them. (These are billing transactions, not database transactions.)
 *
 * A user's balance is their oldest balance record. A transaction's value is its raw token
 * amount times the model's rate (prompt, completion, cache write or read); a balance update
 * that would take the credits below zero leaves them at zero.
 *
 * Not in this port, because each takes a raw MongoDB filter: `getTransactions`,
 * `deleteTransactions` and `deleteBalances`.
 *
 * Known leaks kept for now so callers stay unchanged: `IBalance` extends mongoose's `Document`
 * (its `user` is an ObjectId).
 */
import type {
  TxData,
  IBalance,
  IBalanceUpdate,
  TransactionData,
  TransactionResult,
  BalanceReservationResult,
  BalanceReservationRequest,
  BalanceReservationRelease,
  BalanceReservationRenewal,
} from '~/types';
import type { WithIdLike } from './common';
import { listPortMethods } from './common';

/** {@link TxData} with its user id stated as `IdLike`. */
export type TokenTransactionTxData = WithIdLike<TxData, 'user'>;

export interface TokenTransactionStore {
  /**
   * Adds `incrementValue` (negative to spend) to the user's credits, applying `setValues` as
   * well, creating the balance record when there is none; resolves to it updated.
   */
  updateBalance(params: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }): Promise<IBalance>;
  /** Stores the transactions as given, without touching any balance. */
  bulkInsertTransactions(docs: TransactionData[]): Promise<void>;
  /**
   * The user's balance, or `null` when they have none; a reset that is due is applied first
   * unless `applyReset` is `false`. With `includeReservedCredits`, `reservedCredits` is the
   * total of the reservations that have not expired.
   */
  findBalanceByUser(
    user: string,
    options?: { includeReservedCredits?: boolean; applyReset?: boolean },
  ): Promise<IBalance | null>;
  /**
   * Sets the fields on the user's balance, creating it when there is none (`insertOnly` fields
   * apply only then); resolves to it as stored.
   */
  upsertBalanceFields(
    user: string,
    fields: IBalanceUpdate,
    insertOnly?: IBalanceUpdate,
  ): Promise<IBalance | null>;
  /**
   * Records the transaction (unless transactions are disabled or `rawAmount` is NaN) and, with
   * the balance enabled, applies its value to the user's balance; resolves to the result only
   * then.
   */
  createTransaction(txData: TokenTransactionTxData): Promise<TransactionResult | undefined>;
  /**
   * Holds `amount` credits against the user's balance until released or `expiresAt`, applying a
   * due auto-refill first; resolves whether they were held and the balance left. `null` when the
   * user has no balance and no `initialBalance` is given.
   */
  reserveBalance(request: BalanceReservationRequest): Promise<BalanceReservationResult | null>;
  /** Extends a reservation's expiry; one already released or expired stays gone. */
  renewBalanceReservation(params: BalanceReservationRenewal): Promise<void>;
  /** Releases a reservation; releasing an unknown or expired one is a no-op. */
  releaseBalanceReservation(params: BalanceReservationRelease): Promise<void>;
  /**
   * As {@link createTransaction}, for a prompt split into input, cache write (5-minute and
   * 1-hour) and cache read tokens, each at its own rate.
   */
  createStructuredTransaction(
    txData: TokenTransactionTxData,
  ): Promise<TransactionResult | undefined>;
}

/** Every method of {@link TokenTransactionStore}, for adapters and conformance checks. */
export const TOKEN_TRANSACTION_STORE_METHODS: ReadonlyArray<keyof TokenTransactionStore> =
  listPortMethods<TokenTransactionStore>({
    updateBalance: true,
    bulkInsertTransactions: true,
    findBalanceByUser: true,
    upsertBalanceFields: true,
    createTransaction: true,
    reserveBalance: true,
    renewBalanceReservation: true,
    releaseBalanceReservation: true,
    createStructuredTransaction: true,
  });

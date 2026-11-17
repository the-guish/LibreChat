/**
 * The token transaction store's database-neutral rules (`TokenTransactionStore`,
 * `~/ports/tokenTransaction`), shared by every backend: the MongoDB methods (`./transaction`) and
 * the PostgreSQL store (`adapters/postgres/stores/tokenTransaction.ts`). The pure valuation of a
 * transaction at the model's rates (prompt, completion, cache write and read; incomplete
 * completions charged 15% more), and the balance protocol written once on the storage steps of
 * {@link BalanceLedgerSteps}: the credit update's retry loop, the balance upsert keyed by the
 * user id, the fenced auto-refill and its ledger marker, the reservation admission, renewal,
 * release and pruning, the balance reading and the transaction writes. Filters and updates are
 * stated in the store query language. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { isBalanceRefillDue } from 'librechat-data-provider';
import type {
  IBalance,
  IBalanceUpdate,
  TransactionResult,
  IBalanceReservation,
  BalanceReservationResult,
  BalanceReservationRequest,
  BalanceReservationRelease,
  BalanceReservationRenewal,
} from '~/types';
import type { TokenTransactionStore, TokenTransactionTxData } from '~/ports/tokenTransaction';
import type { IdLike } from '~/ports/common';
import logger from '~/config/winston';

/** What an incomplete (cancelled) completion is charged, as a factor of its value. */
export const CANCEL_RATE = 1.15;
/** Attempts of one reservation before it gives up (each lost attempt re-reads). */
export const MAX_RESERVATION_ATTEMPTS = 10;
/** Attempts of one credit update before it gives up. */
export const MAX_BALANCE_UPDATE_ATTEMPTS = 10;
/** Every balance read resolves a user to their oldest record, so duplicate records stay inert. */
export const OLDEST_BALANCE_FIRST = { _id: 1 } as const;
/** The hidden balance fields a reservation reads. */
export const BALANCE_ADMISSION_FIELDS = '+reservations +reservedCredits +pendingRefill';

export type MultiplierParams = {
  model?: string;
  valueKey?: string;
  tokenType?: 'prompt' | 'completion';
  inputTokenCount?: number;
  endpointTokenConfig?: Record<string, Record<string, number>>;
};

export type CacheMultiplierParams = {
  cacheType?: 'write' | 'read' | 'write1h';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>>;
  inputTokenCount?: number;
};

/** The pricing helpers of `tx` the valuation runs on. */
export interface TransactionPricing {
  getMultiplier(params: MultiplierParams): number;
  getCacheMultiplier(params: CacheMultiplierParams): number | null;
}

/** The fields of a transaction the valuation reads and writes. */
export interface LedgerTransaction {
  user?: unknown;
  valueKey?: string;
  tokenType?: 'prompt' | 'completion' | 'credits';
  model?: string;
  endpointTokenConfig?: Record<string, Record<string, number>> | null;
  inputTokenCount?: number;
  rawAmount?: number;
  context?: string;
  rate?: number;
  tokenValue?: number;
  rateDetail?: Record<string, number>;
  inputTokens?: number;
  writeTokens?: number;
  /** Subset of `writeTokens` written to the 1-hour cache */
  write1hTokens?: number;
  readTokens?: number;
}

/** Sets the rate and value of a transaction from its raw amount at the model's rate. */
export function calculateTokenValue(txn: LedgerTransaction, pricing: TransactionPricing): void {
  const { valueKey, tokenType, model, endpointTokenConfig, inputTokenCount } = txn;
  const multiplier = Math.abs(
    pricing.getMultiplier({
      valueKey,
      tokenType: tokenType as 'prompt' | 'completion' | undefined,
      model,
      endpointTokenConfig: endpointTokenConfig ?? undefined,
      inputTokenCount,
    }),
  );
  txn.rate = multiplier;
  txn.tokenValue = (txn.rawAmount ?? 0) * multiplier;
  if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
    txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * CANCEL_RATE);
    txn.rate = (txn.rate ?? 0) * CANCEL_RATE;
  }
}

/**
 * Sets the rate, value and raw amount of a structured transaction: a prompt split into input,
 * cache write (5-minute and 1-hour) and cache read tokens, each at its own rate, or a completion.
 */
export function calculateStructuredTokenValue(
  txn: LedgerTransaction,
  pricing: TransactionPricing,
): void {
  if (!txn.tokenType) {
    txn.tokenValue = txn.rawAmount;
    return;
  }

  const { model, endpointTokenConfig, inputTokenCount } = txn;
  const etConfig = endpointTokenConfig ?? undefined;

  if (txn.tokenType === 'prompt') {
    const inputMultiplier = pricing.getMultiplier({
      tokenType: 'prompt',
      model,
      endpointTokenConfig: etConfig,
      inputTokenCount,
    });
    const writeMultiplier =
      pricing.getCacheMultiplier({
        cacheType: 'write',
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      }) ?? inputMultiplier;
    const readMultiplier =
      pricing.getCacheMultiplier({
        cacheType: 'read',
        model,
        endpointTokenConfig: etConfig,
        inputTokenCount,
      }) ?? inputMultiplier;

    const inputAbs = Math.abs(txn.inputTokens ?? 0);
    const writeAbs = Math.abs(txn.writeTokens ?? 0);
    const write1hAbs = Math.min(Math.abs(txn.write1hTokens ?? 0), writeAbs);
    const readAbs = Math.abs(txn.readTokens ?? 0);
    const write1hMultiplier =
      write1hAbs > 0
        ? (pricing.getCacheMultiplier({
            cacheType: 'write1h',
            model,
            endpointTokenConfig: etConfig,
            inputTokenCount,
          }) ?? writeMultiplier)
        : writeMultiplier;

    txn.rateDetail = {
      input: inputMultiplier,
      write: writeMultiplier,
      read: readMultiplier,
      ...(write1hAbs > 0 && { write1h: write1hMultiplier }),
    };

    const totalPromptTokens = inputAbs + writeAbs + readAbs;
    const promptValue =
      inputAbs * Math.abs(inputMultiplier) +
      (writeAbs - write1hAbs) * Math.abs(writeMultiplier) +
      write1hAbs * Math.abs(write1hMultiplier) +
      readAbs * Math.abs(readMultiplier);

    txn.rate = totalPromptTokens > 0 ? promptValue / totalPromptTokens : Math.abs(inputMultiplier);

    txn.tokenValue = -(
      inputAbs * inputMultiplier +
      (writeAbs - write1hAbs) * writeMultiplier +
      write1hAbs * write1hMultiplier +
      readAbs * readMultiplier
    );

    txn.rawAmount = -totalPromptTokens;
  } else if (txn.tokenType === 'completion') {
    const multiplier = pricing.getMultiplier({
      tokenType: txn.tokenType,
      model,
      endpointTokenConfig: etConfig,
      inputTokenCount,
    });
    txn.rate = Math.abs(multiplier);
    txn.tokenValue = -Math.abs(txn.rawAmount ?? 0) * multiplier;
    txn.rawAmount = -Math.abs(txn.rawAmount ?? 0);
  }

  if (txn.context && txn.tokenType === 'completion' && txn.context === 'incomplete') {
    txn.tokenValue = Math.ceil((txn.tokenValue ?? 0) * CANCEL_RATE);
    txn.rate = (txn.rate ?? 0) * CANCEL_RATE;
    if (txn.rateDetail) {
      txn.rateDetail = Object.fromEntries(
        Object.entries(txn.rateDetail).map(([k, v]) => [k, v * CANCEL_RATE]),
      );
    }
  }
}

/**
 * The update that adds `incrementValue` to `currentCredits` (never below zero) and applies
 * `setValues`: the write of one credit update, guarded by the backend on the credits it read.
 */
export function balanceCreditUpdate(
  currentCredits: number,
  incrementValue: number,
  setValues?: IBalanceUpdate,
): { $set: Record<string, unknown> } {
  const newCredits = Math.max(0, currentCredits + incrementValue);
  return { $set: { tokenCredits: newCredits, ...(setValues ?? {}) } };
}

/** A filter or update in the store query language. */
export type BalanceQuery = Record<string, unknown>;

/** What one attempt of a credit update did. */
export type BalanceCreditOutcome =
  | { status: 'updated'; balance: IBalance }
  /** The user has no balance record. */
  | { status: 'missing' }
  /** The credits changed between the read and the guarded write. */
  | { status: 'conflict' };

/** An applied auto-refill whose ledger transaction has not been confirmed as recorded. */
export interface LedgerPendingRefill {
  transactionId: IdLike;
  rawAmount: number;
  context?: 'autoRefill' | 'balanceReset';
}

/** The storage steps the balance protocol runs on, each one atomic on its own. */
export interface BalanceLedgerSteps {
  /** The user's oldest balance record (with the hidden fields `select` un-hides), or `null`. */
  findOldestBalance(user: string, select?: string): Promise<IBalance | null>;
  /**
   * Updates the first balance matching `filter` (the oldest with `oldestFirst`), inserting one
   * with `upsert` when none matches; resolves it updated, or `null`.
   */
  findOneAndUpdateBalance(
    filter: BalanceQuery,
    update: BalanceQuery,
    options?: { oldestFirst?: boolean; upsert?: boolean },
  ): Promise<IBalance | null>;
  /** Updates one balance matching `filter`, resolving how many matched (0 or 1). */
  updateOneBalance(
    filter: BalanceQuery,
    update: BalanceQuery,
    options?: { arrayFilters?: BalanceQuery[] },
  ): Promise<{ matchedCount: number }>;
  /**
   * Applies each update to one balance matching its filter, each atomic on its own and none
   * stopping the others (an unordered bulk write).
   */
  updateEachBalance(updates: Array<{ filter: BalanceQuery; update: BalanceQuery }>): Promise<void>;
  /**
   * One attempt at adding `incrementValue` to the credits of the user's oldest balance (never
   * below zero, see {@link balanceCreditUpdate}), applying `setValues`, without losing a
   * concurrent update.
   */
  addCredits(
    user: string,
    incrementValue: number,
    setValues?: IBalanceUpdate,
  ): Promise<BalanceCreditOutcome>;
  /** A new transaction id (the ledger marker of an auto-refill fixes it in advance). */
  newTransactionId(): IdLike;
  /** A transaction built from `data`, not stored yet; the valuation sets its values. */
  buildTransaction(data: Record<string, unknown>): LedgerTransaction;
  /** Stores a transaction `buildTransaction` built. */
  saveTransaction(transaction: LedgerTransaction): Promise<void>;
  /** Whether `error` is the backend's duplicate-key error. */
  isDuplicateKey(error: unknown): boolean;
}

/** The balance methods of the port the protocol implements. */
export type BalanceLedgerMethods = Pick<
  TokenTransactionStore,
  | 'updateBalance'
  | 'findBalanceByUser'
  | 'upsertBalanceFields'
  | 'initializeNullBalanceCredits'
  | 'setBalanceCredits'
  | 'createTransaction'
  | 'reserveBalance'
  | 'renewBalanceReservation'
  | 'releaseBalanceReservation'
  | 'createStructuredTransaction'
>;

/** The balance protocol on `steps`, valuing transactions with `pricing`. */
export function createBalanceLedgerOnSteps(
  steps: BalanceLedgerSteps,
  pricing: TransactionPricing,
): BalanceLedgerMethods {
  /**
   * Updates a user's token balance, retrying a lost attempt with a backoff.
   * Always returns an IBalance or throws after exhausting retries.
   */
  async function updateBalance({
    user,
    incrementValue,
    setValues,
  }: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }): Promise<IBalance> {
    let delay = 50;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_BALANCE_UPDATE_ATTEMPTS; attempt++) {
      try {
        const outcome = await steps.addCredits(user, incrementValue, setValues);
        if (outcome.status === 'updated') {
          return outcome.balance;
        }
        if (outcome.status === 'missing') {
          await upsertBalanceRecord(user, {}, { tokenCredits: 0 });
          continue;
        }
        lastError = new Error(`Concurrency conflict for user ${user} on attempt ${attempt}.`);
      } catch (error) {
        logger.error(`[updateBalance] Error during attempt ${attempt} for user ${user}:`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < MAX_BALANCE_UPDATE_ATTEMPTS) {
        const jitter = Math.random() * delay * 0.5;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay = Math.min(delay * 2, 2000);
      }
    }

    logger.error(
      `[updateBalance] Failed to update balance for user ${user} after ${MAX_BALANCE_UPDATE_ATTEMPTS} attempts.`,
    );
    throw (
      lastError ??
      new Error(
        `Failed to update balance for user ${user} after maximum retries due to persistent conflicts.`,
      )
    );
  }

  /**
   * Records the ledger transaction of an applied auto-refill, then clears its marker. The
   * transaction id is fixed when the refill is applied, so replaying a marker left by a failed or
   * interrupted attempt records the transaction at most once.
   */
  async function settleAutoRefill(
    balanceId: unknown,
    user: unknown,
    { transactionId, rawAmount, context }: LedgerPendingRefill,
  ): Promise<boolean> {
    try {
      const transaction = steps.buildTransaction({
        _id: transactionId,
        user,
        tokenType: 'credits',
        context: context ?? 'autoRefill',
        rawAmount,
      });
      calculateTokenValue(transaction, pricing);
      await steps.saveTransaction(transaction);
    } catch (error) {
      if (!steps.isDuplicateKey(error)) {
        logger.error('[Balance.reserve] Failed to record auto-refill transaction', error);
        return false;
      }
    }

    try {
      await steps.updateOneBalance(
        { _id: balanceId, 'pendingRefill.transactionId': transactionId },
        { $unset: { pendingRefill: 1 } },
      );
      return true;
    } catch (error) {
      logger.error('[Balance.reserve] Failed to clear recorded auto-refill', error);
      return false;
    }
  }

  /**
   * Applies a due auto-refill with a write fenced on every value the refill decision read, and
   * leaves a ledger marker in that same write. Returns false when the fence missed.
   */
  async function applyAutoRefill(record: IBalance, now: Date): Promise<boolean> {
    const reset = record.refillMode === 'reset';
    const credits = reset
      ? record.refillAmount
      : Math.max(0, (record.tokenCredits ?? 0) + record.refillAmount);
    const pendingRefill: LedgerPendingRefill = {
      transactionId: steps.newTransactionId(),
      rawAmount: reset ? credits - (record.tokenCredits ?? 0) : record.refillAmount,
      ...(reset ? { context: 'balanceReset' as const } : {}),
    };
    const result = await steps.updateOneBalance(
      {
        _id: record._id,
        tokenCredits: record.tokenCredits ?? null,
        reservedCredits: record.reservedCredits ?? null,
        lastRefill: record.lastRefill ?? null,
        pendingRefill: null,
        autoRefillEnabled: record.autoRefillEnabled,
        refillAmount: record.refillAmount,
        refillMode: record.refillMode ?? null,
        refillIntervalValue: record.refillIntervalValue ?? null,
        refillIntervalUnit: record.refillIntervalUnit ?? null,
      },
      {
        $set: {
          tokenCredits: credits,
          lastRefill: now,
          pendingRefill,
        },
      },
    );
    if (result.matchedCount !== 1) {
      return false;
    }
    logger.debug('[Balance.reserve] Auto-refill applied', {
      user: record.user,
      rawAmount: record.refillAmount,
    });
    await settleAutoRefill(record._id, record.user, pendingRefill);
    return true;
  }

  /**
   * Removes reservations and their credits from the running total, one atomic update per
   * reservation sent together, so each is removed only while it is still held at the amount read
   * and the rest proceed when one has changed. With `expiredBy`, a reservation is removed only
   * while it is still expired at that instant, so one renewed after it was read survives.
   */
  async function removeReservations(
    filter: BalanceQuery,
    reservations: Array<Pick<IBalanceReservation, 'id' | 'amount'>>,
    expiredBy?: Date,
  ): Promise<void> {
    const expiry = expiredBy ? { expiresAt: { $lte: expiredBy } } : {};
    await steps.updateEachBalance(
      reservations.map(({ id, amount }) => ({
        filter: { ...filter, reservations: { $elemMatch: { id, amount, ...expiry } } },
        update: { $pull: { reservations: { id } }, $inc: { reservedCredits: -amount } },
      })),
    );
  }

  /**
   * Applies `fields` to the user's balance record, creating the record when the user has none.
   * A created record is keyed by the user id, so creators racing on a missing record converge on
   * one record instead of each inserting their own; `insertOnly` applies only on creation.
   */
  async function upsertBalanceRecord(
    user: string,
    fields: IBalanceUpdate,
    insertOnly: IBalanceUpdate = {},
  ): Promise<IBalance | null> {
    const { user: _fieldsUser, ...set } = fields;
    const setOnInsert = Object.fromEntries(
      Object.entries(insertOnly).filter(([key]) => key !== 'user' && !(key in set)),
    );
    const updatesExisting = Object.keys(set).length > 0;

    const existing = updatesExisting
      ? await steps.findOneAndUpdateBalance({ user }, { $set: set }, { oldestFirst: true })
      : await steps.findOldestBalance(user);
    if (existing) {
      return existing;
    }

    const create = () =>
      steps.findOneAndUpdateBalance(
        { _id: user },
        { ...(updatesExisting ? { $set: set } : {}), $setOnInsert: { ...setOnInsert, user } },
        { upsert: true },
      );
    try {
      return await create();
    } catch (error) {
      if (!steps.isDuplicateKey(error)) {
        throw error;
      }
      return create();
    }
  }

  /**
   * Admits one request against the credits that in-flight requests have not reserved, and holds
   * its amount until released or expired.
   *
   * Admission is one conditional `$push`/`$inc`: it matches only while `tokenCredits` is at least
   * the value read and `reservedCredits` still leaves room for the amount, so concurrent
   * admissions of a funded balance all commit, and an admission that lost the credits re-reads.
   * A due auto-refill is applied first by its own fenced write, at most once per admission, so a
   * refill interval that is due again the instant it is applied still refills once. Reset mode
   * replaces the allowance whenever due, even before exhaustion, while retaining reservations.
   * Returns null when the user has no balance record and no `initialBalance` was given.
   */
  async function reserveBalance({
    user,
    reservationId,
    amount,
    expiresAt,
    initialBalance,
    refillPolicy,
  }: BalanceReservationRequest): Promise<BalanceReservationResult | null> {
    let delay = 10;
    let refilled = false;

    for (let attempt = 1; attempt <= MAX_RESERVATION_ATTEMPTS; attempt++) {
      const record = await steps.findOldestBalance(user, BALANCE_ADMISSION_FIELDS);
      if (!record) {
        if (!initialBalance) {
          return null;
        }
        await upsertBalanceRecord(user, {}, initialBalance);
        continue;
      }

      if (
        refillPolicy != null &&
        (record.autoRefillEnabled !== refillPolicy.autoRefillEnabled ||
          (refillPolicy.autoRefillEnabled === true &&
            ((record.refillMode ?? 'add') !== (refillPolicy.refillMode ?? 'add') ||
              record.refillAmount !== refillPolicy.refillAmount ||
              record.refillIntervalValue !== refillPolicy.refillIntervalValue ||
              record.refillIntervalUnit !== refillPolicy.refillIntervalUnit)))
      ) {
        await upsertBalanceRecord(user, refillPolicy);
        continue;
      }

      const now = new Date();
      const refillSettled =
        record.pendingRefill == null ||
        (await settleAutoRefill(record._id, record.user, record.pendingRefill));

      const expired = (record.reservations ?? []).filter(
        (reservation) => reservation.expiresAt <= now,
      );
      if (expired.length > 0) {
        await removeReservations({ _id: record._id }, expired, now);
        continue;
      }

      const credits = record.tokenCredits ?? 0;
      const balance = credits - (record.reservedCredits ?? 0);
      if (
        refillSettled &&
        !refilled &&
        (record.refillMode === 'reset' || balance - amount <= 0) &&
        isBalanceRefillDue(record, now)
      ) {
        refilled = await applyAutoRefill(record, now);
        continue;
      }

      const reserved = balance >= amount;
      if (!reserved || !(amount > 0)) {
        return { reserved, balance };
      }

      const held = Math.ceil(amount);
      let result: { matchedCount: number };
      try {
        result = await steps.updateOneBalance(
          {
            _id: record._id,
            tokenCredits: { $gte: credits },
            $or: [
              { reservedCredits: { $lte: credits - amount } },
              { reservedCredits: { $exists: false } },
            ],
          },
          {
            $push: { reservations: { id: reservationId, amount: held, expiresAt } },
            $inc: { reservedCredits: held },
          },
        );
      } catch (error) {
        /** The write may have committed before its acknowledgement was lost; the caller never
         * receives a handle to release it, so remove it here rather than leave it to expire. */
        await removeReservations({ _id: record._id }, [{ id: reservationId, amount: held }]).catch(
          (cleanupError) => {
            logger.error('[Balance.reserve] Failed to remove an unacknowledged reservation', {
              user,
              error: cleanupError,
            });
          },
        );
        throw error;
      }
      if (result.matchedCount === 1) {
        return { reserved, balance };
      }

      if (attempt < MAX_RESERVATION_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * delay));
        delay = Math.min(delay * 2, 500);
      }
    }

    throw new Error(`Balance reservation for user ${user} exceeded its retry bound.`);
  }

  /** Extends an in-flight reservation's expiry; a reservation already released or pruned stays gone. */
  async function renewBalanceReservation({
    user,
    reservationId,
    expiresAt,
  }: BalanceReservationRenewal): Promise<void> {
    await steps.updateOneBalance(
      { user, 'reservations.id': reservationId },
      { $set: { 'reservations.$[held].expiresAt': expiresAt } },
      { arrayFilters: [{ 'held.id': reservationId }] },
    );
  }

  /** Releases an in-flight reservation; releasing an unknown or already pruned id is a no-op. */
  async function releaseBalanceReservation({
    user,
    reservationId,
    amount,
  }: BalanceReservationRelease): Promise<void> {
    if (!(amount > 0)) {
      return;
    }
    await removeReservations({ user }, [{ id: reservationId, amount: Math.ceil(amount) }]);
  }

  /** The result of a transaction applied to the balance. */
  const transactionResult = (
    transaction: LedgerTransaction,
    incrementValue: number,
    balance: IBalance,
  ): TransactionResult =>
    ({
      rate: transaction.rate as number,
      user: String(transaction.user),
      balance: balance.tokenCredits,
      [transaction.tokenType as string]: incrementValue,
    }) as TransactionResult;

  /**
   * Creates a transaction and updates the balance.
   */
  async function createTransaction(
    _txData: TokenTransactionTxData,
  ): Promise<TransactionResult | undefined> {
    const { balance, transactions, ...txData } = _txData;
    if (txData.rawAmount != null && isNaN(txData.rawAmount)) {
      return;
    }

    if (transactions?.enabled === false) {
      return;
    }

    const transaction = steps.buildTransaction(txData);
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;
    calculateTokenValue(transaction, pricing);

    await steps.saveTransaction(transaction);
    if (!balance?.enabled) {
      return;
    }

    const incrementValue = transaction.tokenValue as number;
    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return transactionResult(transaction, incrementValue, balanceResponse);
  }

  /**
   * Creates a structured transaction and updates the balance.
   */
  async function createStructuredTransaction(
    _txData: TokenTransactionTxData,
  ): Promise<TransactionResult | undefined> {
    const { balance, transactions, ...txData } = _txData;
    if (transactions?.enabled === false) {
      return;
    }

    const transaction = steps.buildTransaction(txData);
    transaction.endpointTokenConfig = txData.endpointTokenConfig;
    transaction.inputTokenCount = txData.inputTokenCount;
    transaction.write1hTokens = txData.write1hTokens;

    calculateStructuredTokenValue(transaction, pricing);

    await steps.saveTransaction(transaction);

    if (!balance?.enabled) {
      return;
    }

    const incrementValue = transaction.tokenValue as number;

    const balanceResponse = await updateBalance({
      user: transaction.user as string,
      incrementValue,
    });

    return transactionResult(transaction, incrementValue, balanceResponse);
  }

  /**
   * Retrieves a user's balance record. With `includeReservedCredits`, `reservedCredits` is the
   * total of the reservations that have not expired, so a reservation left by a crashed request
   * stops counting at its expiry even before a reservation write prunes it. A due reset is
   * applied before returning the reading; inactive periods do not accumulate allowances.
   */
  async function findBalanceByUser(
    user: string,
    options?: { includeReservedCredits?: boolean; applyReset?: boolean },
  ): Promise<IBalance | null> {
    const read = () =>
      steps.findOldestBalance(
        user,
        options?.includeReservedCredits ? '+reservations +pendingRefill' : '+pendingRefill',
      );
    let record = await read();
    if (!record) {
      return null;
    }
    if (
      options?.applyReset !== false &&
      record.refillMode === 'reset' &&
      (record.pendingRefill != null || isBalanceRefillDue(record, new Date()))
    ) {
      // Reuse the fenced admission path without holding any credits for a balance read.
      await reserveBalance({ user, reservationId: '', amount: 0, expiresAt: new Date() });
      record = await read();
      if (!record) {
        return null;
      }
    }
    const now = new Date();
    const { reservations, reservedCredits: _held, pendingRefill: _pending, ...balance } = record;
    if (!options?.includeReservedCredits) {
      return balance as IBalance;
    }
    const reservedCredits = (reservations ?? []).reduce(
      (sum, reservation) => (reservation.expiresAt > now ? sum + reservation.amount : sum),
      0,
    );
    return { ...balance, reservedCredits } as IBalance;
  }

  /** Upserts balance fields for a user; `insertOnly` fields apply only when the record is created. */
  async function upsertBalanceFields(
    user: string,
    fields: IBalanceUpdate,
    insertOnly?: IBalanceUpdate,
  ): Promise<IBalance | null> {
    const record = await upsertBalanceRecord(user, fields, insertOnly);
    if (record?.refillMode === 'reset' && isBalanceRefillDue(record, new Date())) {
      return findBalanceByUser(user);
    }
    return record;
  }

  /**
   * Sets the starting credits (and `sync`'s fields, when it has any) on the user's oldest balance
   * record only while its `tokenCredits` is still `null` (or absent): a compare-and-set, never an
   * upsert. Resolves to the record updated, or `null` when no record matched.
   */
  async function initializeNullBalanceCredits(
    user: string,
    tokenCredits: number,
    sync?: IBalanceUpdate,
  ): Promise<IBalance | null> {
    return steps.findOneAndUpdateBalance(
      { user, tokenCredits: null },
      { $set: { tokenCredits, ...(sync && Object.keys(sync).length > 0 ? sync : {}) } },
      { oldestFirst: true },
    );
  }

  /**
   * Sets the user's credits to `tokenCredits` on their balance record, creating the record when
   * they have none (as `upsertBalanceFields` does, but without applying a reset that is due), for
   * the `set-balance` script. Resolves to the record as stored.
   */
  async function setBalanceCredits(user: string, tokenCredits: number): Promise<IBalance | null> {
    return upsertBalanceRecord(user, { tokenCredits });
  }

  return {
    updateBalance,
    findBalanceByUser,
    upsertBalanceFields,
    initializeNullBalanceCredits,
    setBalanceCredits,
    createTransaction,
    reserveBalance,
    renewBalanceReservation,
    releaseBalanceReservation,
    createStructuredTransaction,
  };
}

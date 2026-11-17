import type { AnyBulkWriteOperation, FilterQuery, Model } from 'mongoose';
import type {
  BalanceReservationRequest,
  BalanceReservationRenewal,
  BalanceReservationRelease,
  BalanceReservationResult,
  IBalanceUpdate,
  TransactionData,
  TransactionResult,
  IBalance,
  TxData,
} from '~/types';
import type { MultiplierParams, CacheMultiplierParams } from './transactionRules';
import type { ITransaction } from '~/schema/transaction';
import type { IdLike } from '~/ports/common';
import {
  balanceCreditUpdate,
  OLDEST_BALANCE_FIRST,
  createBalanceLedgerOnSteps,
} from './transactionRules';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import logger from '~/config/winston';

export type { TxData, TransactionResult } from '~/types/transaction';

export function createTransactionMethods(
  mongoose: typeof import('mongoose'),
  txMethods: {
    getMultiplier: (params: MultiplierParams) => number;
    getCacheMultiplier: (params: CacheMultiplierParams) => number | null;
  },
): {
  updateBalance: ({
    user,
    incrementValue,
    setValues,
  }: {
    user: string;
    incrementValue: number;
    setValues?: IBalanceUpdate;
  }) => Promise<IBalance>;
  bulkInsertTransactions: (docs: TransactionData[]) => Promise<void>;
  findBalanceByUser: (
    user: string,
    options?: { includeReservedCredits?: boolean; applyReset?: boolean },
  ) => Promise<IBalance | null>;
  upsertBalanceFields: (
    user: string,
    fields: IBalanceUpdate,
    insertOnly?: IBalanceUpdate,
  ) => Promise<IBalance | null>;
  initializeNullBalanceCredits: (
    user: string,
    tokenCredits: number,
    sync?: IBalanceUpdate,
  ) => Promise<IBalance | null>;
  setBalanceCredits: (user: string, tokenCredits: number) => Promise<IBalance | null>;
  findBalanceCreditsByUsers: (
    userIds: IdLike[],
  ) => Promise<Array<{ user: string; tokenCredits: number | null }>>;
  getTransactions: (filter: FilterQuery<ITransaction>) => Promise<ITransaction[]>;
  deleteTransactions: (
    filter: FilterQuery<ITransaction>,
  ) => Promise<import('mongodb').DeleteResult>;
  deleteBalances: (filter: FilterQuery<IBalance>) => Promise<import('mongodb').DeleteResult>;
  createTransaction: (_txData: TxData) => Promise<TransactionResult | undefined>;
  reserveBalance: (request: BalanceReservationRequest) => Promise<BalanceReservationResult | null>;
  renewBalanceReservation: (params: BalanceReservationRenewal) => Promise<void>;
  releaseBalanceReservation: (params: BalanceReservationRelease) => Promise<void>;
  createStructuredTransaction: (_txData: TxData) => Promise<TransactionResult | undefined>;
} {
  const Balance = () => mongoose.models.Balance as Model<IBalance>;
  const Transaction = () => mongoose.models.Transaction;

  const ledger = createBalanceLedgerOnSteps(
    {
      findOldestBalance(user, select) {
        const query = Balance().findOne({ user }).sort(OLDEST_BALANCE_FIRST);
        return (select ? query.select(select) : query).lean<IBalance>();
      },
      findOneAndUpdateBalance(filter, update, options = {}) {
        return Balance()
          .findOneAndUpdate(filter, update, {
            new: true,
            ...(options.oldestFirst ? { sort: OLDEST_BALANCE_FIRST } : {}),
            ...(options.upsert ? { upsert: true } : {}),
          })
          .lean<IBalance>();
      },
      updateOneBalance(filter, update, options) {
        return options?.arrayFilters
          ? Balance().updateOne(filter, update, { arrayFilters: options.arrayFilters })
          : Balance().updateOne(filter, update);
      },
      async updateEachBalance(updates) {
        const removals: AnyBulkWriteOperation<IBalance>[] = updates.map(({ filter, update }) => ({
          updateOne: { filter, update },
        }));
        await tenantSafeBulkWrite(Balance(), removals as AnyBulkWriteOperation[], {
          ordered: false,
        });
      },
      async addCredits(user, incrementValue, setValues) {
        const currentBalanceDoc = await Balance()
          .findOne({ user })
          .sort(OLDEST_BALANCE_FIRST)
          .lean<IBalance>();
        if (!currentBalanceDoc) {
          return { status: 'missing' };
        }
        const currentCredits = currentBalanceDoc.tokenCredits;
        const updatedBalance = await Balance()
          .findOneAndUpdate(
            { _id: currentBalanceDoc._id, tokenCredits: currentCredits },
            balanceCreditUpdate(currentCredits, incrementValue, setValues),
            { new: true },
          )
          .lean<IBalance>();
        return updatedBalance
          ? { status: 'updated', balance: updatedBalance }
          : { status: 'conflict' };
      },
      newTransactionId: () => new mongoose.Types.ObjectId(),
      buildTransaction(data) {
        const TransactionModel = Transaction();
        return new TransactionModel(data);
      },
      async saveTransaction(transaction) {
        await (transaction as { save(): Promise<unknown> }).save();
      },
      isDuplicateKey: (error) =>
        error instanceof Error && 'code' in error && (error as { code: number }).code === 11000,
    },
    txMethods,
  );

  /**
   * Queries and retrieves transactions based on a given filter.
   */
  async function getTransactions(filter: FilterQuery<ITransaction>): Promise<ITransaction[]> {
    try {
      return await Transaction().find(filter).lean<ITransaction[]>();
    } catch (error) {
      logger.error('Error querying transactions:', error);
      throw error;
    }
  }

  /**
   * Each listed user's credits: the `tokenCredits` of their oldest balance record (`null` when it
   * has none), one entry per user who has a balance record, in no particular order.
   */
  async function findBalanceCreditsByUsers(
    userIds: IdLike[],
  ): Promise<Array<{ user: string; tokenCredits: number | null }>> {
    const users = userIds.map(
      (id) => new mongoose.Types.ObjectId(typeof id === 'string' ? id : id.toHexString()),
    );
    const rows = await Balance().aggregate<{ _id: unknown; tokenCredits?: number | null }>([
      { $match: { user: { $in: users } } },
      { $sort: OLDEST_BALANCE_FIRST },
      { $group: { _id: '$user', tokenCredits: { $first: '$tokenCredits' } } },
    ]);
    return rows.map((row) => ({ user: String(row._id), tokenCredits: row.tokenCredits ?? null }));
  }

  /** Deletes transactions matching a filter. */
  async function deleteTransactions(
    filter: FilterQuery<ITransaction>,
  ): Promise<import('mongodb').DeleteResult> {
    return Transaction().deleteMany(filter);
  }

  /** Deletes balance records matching a filter. */
  async function deleteBalances(
    filter: FilterQuery<IBalance>,
  ): Promise<import('mongodb').DeleteResult> {
    return Balance().deleteMany(filter);
  }

  async function bulkInsertTransactions(docs: TransactionData[]): Promise<void> {
    if (!docs.length) {
      return;
    }
    try {
      await Transaction().insertMany(docs);
    } catch (error) {
      logger.error('[bulkInsertTransactions] Error inserting transaction docs:', error);
      throw error;
    }
  }

  return {
    updateBalance: ledger.updateBalance,
    bulkInsertTransactions,
    findBalanceByUser: ledger.findBalanceByUser,
    upsertBalanceFields: ledger.upsertBalanceFields,
    initializeNullBalanceCredits: ledger.initializeNullBalanceCredits,
    setBalanceCredits: ledger.setBalanceCredits,
    findBalanceCreditsByUsers,
    getTransactions,
    deleteTransactions,
    deleteBalances,
    createTransaction: ledger.createTransaction,
    reserveBalance: ledger.reserveBalance,
    renewBalanceReservation: ledger.renewBalanceReservation,
    releaseBalanceReservation: ledger.releaseBalanceReservation,
    createStructuredTransaction: ledger.createStructuredTransaction,
  };
}

export type TransactionMethods = ReturnType<typeof createTransactionMethods>;

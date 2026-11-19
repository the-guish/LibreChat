import type { SpendTxData, TransactionResult } from '~/types/transaction';
import type { TxData } from './transaction';
import { createSpendTokensOnSteps } from './spendTokensRules';

export type { SpendTxData } from '~/types/transaction';

export function createSpendTokensMethods(
  _mongoose: typeof import('mongoose'),
  transactionMethods: {
    createTransaction: (txData: TxData) => Promise<TransactionResult | undefined>;
    createStructuredTransaction: (txData: TxData) => Promise<TransactionResult | undefined>;
  },
): {
  spendTokens: (
    txData: SpendTxData,
    tokenUsage: { promptTokens?: number; completionTokens?: number },
  ) => Promise<void>;
  spendStructuredTokens: (
    txData: SpendTxData,
    tokenUsage: {
      promptTokens?: { input?: number; write?: number; write1h?: number; read?: number };
      completionTokens?: number;
    },
  ) => Promise<{
    prompt: TransactionResult | undefined;
    completion: TransactionResult | undefined;
  }>;
} {
  return createSpendTokensOnSteps(transactionMethods);
}

export type SpendTokensMethods = ReturnType<typeof createSpendTokensMethods>;

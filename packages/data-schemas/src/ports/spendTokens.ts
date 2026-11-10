/**
 * Token spending port: records what a model call cost, as prompt and completion transactions
 * against the user's balance. Nothing here may import `mongoose`. Signatures are those of
 * `SpendTokensMethods` (`~/methods/spendTokens`) with the user id stated as `IdLike`;
 * `spendTokens.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Neither method throws: a failed transaction is logged and leaves the result undefined.
 */
import type { SpendTxData, TransactionResult } from '~/types';
import type { WithIdLike } from './common';
import { listPortMethods } from './common';

/** {@link SpendTxData} with its user id stated as `IdLike`. */
export type SpendTokensTxData = WithIdLike<SpendTxData, 'user'>;

export interface SpendTokensStore {
  /**
   * Records a prompt transaction for `promptTokens` and a completion transaction for
   * `completionTokens`, each only when given.
   */
  spendTokens(
    txData: SpendTokensTxData,
    tokenUsage: { promptTokens?: number; completionTokens?: number },
  ): Promise<void>;
  /**
   * Records a structured prompt transaction (input, cache write, 1-hour cache write and cache
   * read tokens) and a completion transaction, each only when non-zero; resolves to both
   * results.
   */
  spendStructuredTokens(
    txData: SpendTokensTxData,
    tokenUsage: {
      promptTokens?: { input?: number; write?: number; write1h?: number; read?: number };
      completionTokens?: number;
    },
  ): Promise<{
    prompt: TransactionResult | undefined;
    completion: TransactionResult | undefined;
  }>;
}

/** Every method of {@link SpendTokensStore}, for adapters and conformance checks. */
export const SPEND_TOKENS_STORE_METHODS: ReadonlyArray<keyof SpendTokensStore> =
  listPortMethods<SpendTokensStore>({
    spendTokens: true,
    spendStructuredTokens: true,
  });

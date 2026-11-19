/**
 * The token spending store's database-neutral rules (`SpendTokensStore`, `~/ports/spendTokens`),
 * shared by every backend: the MongoDB methods (`./spendTokens`) and the PostgreSQL store
 * (`adapters/postgres/stores/spendTokens.ts`). Both methods are written once here on the
 * transaction writes of the token transaction store: a prompt and a completion transaction per
 * call, negative counts treated as zero, failures logged and never thrown. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import type { SpendTokensStore, SpendTokensTxData } from '~/ports/spendTokens';
import type { TokenTransactionTxData } from '~/ports/tokenTransaction';
import type { TransactionResult } from '~/types/transaction';
import logger from '~/config/winston';

/** The transaction writes the spending methods record through. */
export interface SpendTokensSteps {
  createTransaction(txData: TokenTransactionTxData): Promise<TransactionResult | undefined>;
  createStructuredTransaction(
    txData: TokenTransactionTxData,
  ): Promise<TransactionResult | undefined>;
}

/** The two methods of the port on the transaction writes of `transactionMethods`. */
export function createSpendTokensOnSteps(transactionMethods: SpendTokensSteps): SpendTokensStore {
  /**
   * Creates up to two transactions to record the spending of tokens.
   */
  async function spendTokens(
    txData: SpendTokensTxData,
    tokenUsage: { promptTokens?: number; completionTokens?: number },
  ): Promise<void> {
    const { promptTokens, completionTokens } = tokenUsage;
    logger.debug(
      `[spendTokens] conversationId: ${txData.conversationId}${
        txData?.context ? ` | Context: ${txData?.context}` : ''
      } | Token usage: `,
      { promptTokens, completionTokens },
    );
    let prompt: TransactionResult | undefined, completion: TransactionResult | undefined;
    const normalizedPromptTokens = Math.max(promptTokens ?? 0, 0);
    try {
      if (promptTokens !== undefined) {
        prompt = await transactionMethods.createTransaction({
          ...txData,
          tokenType: 'prompt',
          rawAmount: promptTokens === 0 ? 0 : -normalizedPromptTokens,
          inputTokenCount: normalizedPromptTokens,
        });
      }

      if (completionTokens !== undefined) {
        completion = await transactionMethods.createTransaction({
          ...txData,
          tokenType: 'completion',
          rawAmount: completionTokens === 0 ? 0 : -Math.max(completionTokens, 0),
          inputTokenCount: normalizedPromptTokens,
        });
      }

      if (prompt || completion) {
        logger.debug('[spendTokens] Transaction data record against balance:', {
          user: txData.user,
          prompt: prompt?.prompt,
          promptRate: prompt?.rate,
          completion: completion?.completion,
          completionRate: completion?.rate,
          balance: completion?.balance ?? prompt?.balance,
        });
      } else {
        logger.debug('[spendTokens] No transactions incurred against balance');
      }
    } catch (err) {
      logger.error('[spendTokens]', err);
    }
  }

  /**
   * Creates transactions to record the spending of structured tokens.
   */
  async function spendStructuredTokens(
    txData: SpendTokensTxData,
    tokenUsage: {
      promptTokens?: { input?: number; write?: number; write1h?: number; read?: number };
      completionTokens?: number;
    },
  ): Promise<{
    prompt: TransactionResult | undefined;
    completion: TransactionResult | undefined;
  }> {
    const { promptTokens, completionTokens } = tokenUsage;
    logger.debug(
      `[spendStructuredTokens] conversationId: ${txData.conversationId}${
        txData?.context ? ` | Context: ${txData?.context}` : ''
      } | Token usage: `,
      { promptTokens, completionTokens },
    );
    let prompt: TransactionResult | undefined, completion: TransactionResult | undefined;
    try {
      if (promptTokens) {
        const input = Math.max(promptTokens.input ?? 0, 0);
        const write = Math.max(promptTokens.write ?? 0, 0);
        const write1h = Math.min(Math.max(promptTokens.write1h ?? 0, 0), write);
        const read = Math.max(promptTokens.read ?? 0, 0);
        const totalInputTokens = input + write + read;
        prompt = await transactionMethods.createStructuredTransaction({
          ...txData,
          tokenType: 'prompt',
          inputTokens: -input,
          writeTokens: -write,
          ...(write1h > 0 && { write1hTokens: -write1h }),
          readTokens: -read,
          inputTokenCount: totalInputTokens,
        });
      }

      if (completionTokens) {
        const totalInputTokens = promptTokens
          ? Math.max(promptTokens.input ?? 0, 0) +
            Math.max(promptTokens.write ?? 0, 0) +
            Math.max(promptTokens.read ?? 0, 0)
          : undefined;
        completion = await transactionMethods.createTransaction({
          ...txData,
          tokenType: 'completion',
          rawAmount: -Math.max(completionTokens, 0),
          inputTokenCount: totalInputTokens,
        });
      }

      if (prompt || completion) {
        logger.debug('[spendStructuredTokens] Transaction data record against balance:', {
          user: txData.user,
          prompt: prompt?.prompt,
          promptRate: prompt?.rate,
          completion: completion?.completion,
          completionRate: completion?.rate,
          balance: completion?.balance ?? prompt?.balance,
        });
      } else {
        logger.debug('[spendStructuredTokens] No transactions incurred against balance');
      }
    } catch (err) {
      logger.error('[spendStructuredTokens]', err);
    }

    return { prompt, completion };
  }

  return { spendTokens, spendStructuredTokens };
}

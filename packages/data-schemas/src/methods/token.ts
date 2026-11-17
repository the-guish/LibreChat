import type { QueryOptions } from 'mongoose';
import {
  newTokenRecord,
  findTokenFilter,
  updateTokenWrite,
  tokenReplacement,
  deleteTokensFilter,
} from './tokenRules';
import { IToken, TokenCreateData, TokenQuery, TokenUpdateData, TokenDeleteResult } from '~/types';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

// Factory function that takes mongoose instance and returns the methods
export function createTokenMethods(mongoose: typeof import('mongoose')): {
  findToken: (query: TokenQuery, options?: QueryOptions) => Promise<IToken | null>;
  createToken: (tokenData: TokenCreateData) => Promise<IToken>;
  replaceTokenIfCurrent: (
    scope: string,
    expectedToken: string | null,
    tokenData: TokenCreateData,
  ) => Promise<boolean>;
  updateToken: (query: TokenQuery, updateData: TokenUpdateData) => Promise<IToken | null>;
  deleteTokens: (query: TokenQuery) => Promise<TokenDeleteResult>;
} {
  let indexPromise: Promise<unknown> | null = null;

  function ensureIndexes(): Promise<unknown> {
    if (!indexPromise) {
      indexPromise = createIndexesWithRetry(mongoose.models.Token).catch((error: unknown) => {
        indexPromise = null;
        throw error;
      });
    }
    return indexPromise;
  }

  /**
   * Creates a new Token instance.
   */
  async function createToken(tokenData: TokenCreateData): Promise<IToken> {
    try {
      const Token = mongoose.models.Token;
      return await Token.create(newTokenRecord(tokenData));
    } catch (error) {
      logger.debug('An error occurred while creating token', {
        type: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  /**
   * Atomically replaces the scoped token only when it still matches the token
   * observed by the caller. A null expectation succeeds only when the scope is absent.
   */
  async function replaceTokenIfCurrent(
    scope: string,
    expectedToken: string | null,
    tokenData: TokenCreateData,
  ): Promise<boolean> {
    try {
      const Token = mongoose.models.Token;
      await ensureIndexes();
      const { filter, update, upsert } = tokenReplacement(scope, expectedToken, tokenData);

      try {
        const replacedToken = await Token.findOneAndUpdate(filter, update, {
          new: true,
          upsert,
          runValidators: true,
          setDefaultsOnInsert: true,
        });
        return replacedToken !== null;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return false;
        }
        throw error;
      }
    } catch (error) {
      logger.debug('An error occurred while conditionally replacing token', {
        type: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  /**
   * Updates a Token document that matches the provided query.
   */
  async function updateToken(
    query: TokenQuery,
    updateData: TokenUpdateData,
  ): Promise<IToken | null> {
    try {
      const Token = mongoose.models.Token;
      const { filter, update } = updateTokenWrite(query, updateData);
      return await Token.findOneAndUpdate(filter, update, { new: true });
    } catch (error) {
      logger.debug('An error occurred while updating token', {
        type: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  /** Deletes all Token documents matching every provided field (AND semantics). */
  async function deleteTokens(query: TokenQuery): Promise<TokenDeleteResult> {
    try {
      const Token = mongoose.models.Token;
      const filter = deleteTokensFilter(query);
      return await Token.deleteMany(filter);
    } catch (error) {
      logger.debug('An error occurred while deleting tokens', {
        type: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  /**
   * Finds a Token document that matches the provided query.
   * Email is automatically normalized to lowercase for case-insensitive matching.
   */
  async function findToken(query: TokenQuery, options?: QueryOptions): Promise<IToken | null> {
    try {
      const Token = mongoose.models.Token;
      const token = await Token.findOne(findTokenFilter(query), null, options).lean();

      return token as IToken | null;
    } catch (error) {
      logger.debug('An error occurred while finding token', {
        type: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  // Return all methods
  return {
    findToken,
    createToken,
    replaceTokenIfCurrent,
    updateToken,
    deleteTokens,
  };
}

export type TokenMethods = ReturnType<typeof createTokenMethods>;

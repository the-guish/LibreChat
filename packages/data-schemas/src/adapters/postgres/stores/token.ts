/**
 * The PostgreSQL `TokenStore` (`~/ports/token`) on the `tokens` table, through the collection
 * primitive, with the lookups, deletes and compare-and-set of `~/methods/tokenRules`. Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * `metadata` is a `Map` of `Mixed` in a `json` column: the credential set selector
 * (`metadata.credential_set_id`) is a subpath into it, and records hand it out as a plain object
 * (MongoDB's hydrated documents hand out a `Map`; callers accept either). A regular expression
 * `identifier` is matched as one. The scope's unique index comes with the migrations, so a
 * racing insert into an empty scope loses on it.
 */
import type { PostgresStoreContext } from './context';
import type { TokenStore } from '~/ports/token';
import type { IToken } from '~/types';
import {
  newTokenRecord,
  findTokenFilter,
  updateTokenWrite,
  tokenReplacement,
  deleteTokensFilter,
} from '~/methods/tokenRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import logger from '~/config/winston';
import { asRecord } from './context';

type TokenRecord = IToken & Record<string, unknown>;

/** Logs a failure of `what` by its type only (token values never reach the log), and rethrows. */
function logged(what: string, error: unknown): never {
  logger.debug(`An error occurred while ${what}`, {
    type: error instanceof Error ? error.name : typeof error,
  });
  throw error;
}

/** `data` with a `Map` metadata as the plain object a `json` column stores. */
function withPlainMetadata<T extends { metadata?: unknown }>(data: T): T {
  return data.metadata instanceof Map
    ? { ...data, metadata: Object.fromEntries(data.metadata) }
    : data;
}

export function createPostgresTokenStore(context: PostgresStoreContext): TokenStore {
  const tokens = () => context.collections().collection<TokenRecord>('tokens');

  const store: TokenStore = {
    async findToken(query, options) {
      try {
        return await tokens().findOne(
          findTokenFilter(query),
          options?.sort ? { sort: options.sort } : {},
        );
      } catch (error) {
        return logged('finding token', error);
      }
    },

    async createToken(tokenData) {
      try {
        return await tokens().insertOne(asRecord(withPlainMetadata(newTokenRecord(tokenData))));
      } catch (error) {
        return logged('creating token', error);
      }
    },

    async replaceTokenIfCurrent(scope, expectedToken, tokenData) {
      try {
        const { filter, update, upsert } = tokenReplacement(scope, expectedToken, tokenData);
        try {
          const replacedToken = await tokens().findOneAndUpdate(filter, update, {
            returnDocument: 'after',
            upsert,
            runValidators: true,
          });
          return replacedToken !== null;
        } catch (error) {
          if (error instanceof StoreDuplicateKeyError) {
            return false;
          }
          throw error;
        }
      } catch (error) {
        return logged('conditionally replacing token', error);
      }
    },

    async updateToken(query, updateData) {
      try {
        const { filter, update } = updateTokenWrite(query, updateData);
        const { expiresIn: _expiresIn, ...declared } = withPlainMetadata(update);
        return await tokens().findOneAndUpdate(filter, declared, { returnDocument: 'after' });
      } catch (error) {
        return logged('updating token', error);
      }
    },

    async deleteTokens(query) {
      try {
        return await tokens().deleteMany(deleteTokensFilter(query));
      } catch (error) {
        return logged('deleting tokens', error);
      }
    },
  };
  return store;
}

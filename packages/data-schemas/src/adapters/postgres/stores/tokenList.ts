/**
 * The PostgreSQL `TokenListStore` (`~/ports/tokenList`) on the `tokens` table, through the
 * collection primitive. Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { TokenListStore } from '~/ports/tokenList';
import type { PostgresStoreContext } from './context';
import type { IToken } from '~/types';

/** A user holds a handful of tokens of one type at most; the bound keeps a read cheap regardless. */
const MAX_TOKENS_OF_USER = 100;

export function createPostgresTokenListStore(context: PostgresStoreContext): TokenListStore {
  const tokens = () => context.collections().collection<IToken & Record<string, unknown>>('tokens');
  const store: TokenListStore = {
    async findTokensOfUser(query) {
      /** Unexpired rows, the most recently written first (as on MongoDB). */
      return tokens().find(
        { userId: query.userId, type: query.type, expiresAt: { $gt: new Date() } },
        { sort: { createdAt: -1 }, limit: MAX_TOKENS_OF_USER },
      );
    },
  };
  return store;
}

/**
 * Token store port: the single-purpose tokens kept for users (email verification, password
 * reset, invitations, OAuth credentials and the like). Nothing here may import `mongoose`.
 * Signatures are those of `TokenMethods` (`~/methods/token`) with ids stated as `IdLike`, and
 * `findToken`'s read options stated in the store query language (`./query`); `token.spec.ts`
 * fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Every query field given must match (AND); an email is matched trimmed and lowercased, and
 * `metadataCredentialSetId` matches the token's `metadata.credential_set_id`.
 *
 * Known leaks kept for now so callers stay unchanged: `IToken` extends mongoose's `Document`,
 * and a query's `identifier` may be a `RegExp`, which the MongoDB adapter matches as a regular
 * expression (callers pass one to select every token of an action, `^[^:]+:<actionId>$`).
 */
import type {
  IToken,
  TokenCreateData,
  TokenQuery,
  TokenUpdateData,
  TokenDeleteResult,
} from '~/types';
import type { WithIdLike } from './common';
import type { StoreSort } from './query';
import { listPortMethods } from './common';

/** {@link TokenQuery} with its user id stated as `IdLike`. */
export type TokenStoreQuery = WithIdLike<TokenQuery, 'userId'>;
/** {@link TokenCreateData} with its user id stated as `IdLike`. */
export type TokenStoreCreateData = WithIdLike<TokenCreateData, 'userId'>;

export interface TokenStore {
  /**
   * The first token matching the query, in `options.sort` order when given (callers pass
   * `{ sort: { createdAt: -1 } }` to read the newest one), or `null`.
   */
  findToken(query: TokenStoreQuery, options?: { sort?: StoreSort }): Promise<IToken | null>;
  /** Stores a token that expires `expiresIn` seconds from now. */
  createToken(tokenData: TokenStoreCreateData): Promise<IToken>;
  /**
   * Replaces the token of `scope` only while it is still `expectedToken`; with `expectedToken`
   * `null`, creates it only while the scope has none. Resolves whether the write happened.
   */
  replaceTokenIfCurrent(
    scope: string,
    expectedToken: string | null,
    tokenData: TokenStoreCreateData,
  ): Promise<boolean>;
  /**
   * Updates the first token matching the query and resolves to it updated, or `null`. An
   * `expiresIn` (seconds from now) sets `expiresAt`.
   */
  updateToken(query: TokenStoreQuery, updateData: TokenUpdateData): Promise<IToken | null>;
  /** Deletes every token matching the query; at least one field is required. */
  deleteTokens(query: TokenStoreQuery): Promise<TokenDeleteResult>;
}

/** Every method of {@link TokenStore}, for adapters and conformance checks. */
export const TOKEN_STORE_METHODS: ReadonlyArray<keyof TokenStore> = listPortMethods<TokenStore>({
  findToken: true,
  createToken: true,
  replaceTokenIfCurrent: true,
  updateToken: true,
  deleteTokens: true,
});

/**
 * Token list store port: listing the tokens a user holds. Nothing here may import `mongoose`.
 * Signatures are copied verbatim from `TokenListMethods` (`~/methods/tokenList`);
 * `tokenList.spec.ts` fails the typecheck if the two drift.
 */
import type { IToken } from '~/types';
import { listPortMethods } from './common';

export interface TokenListStore {
  /**
   * The unexpired tokens of one type a user holds, such as one per connected provider host,
   * newest first and at most a hundred.
   */
  findTokensOfUser(query: { userId: string; type: string }): Promise<IToken[]>;
}

/** Every method of {@link TokenListStore}, for adapters and conformance checks. */
export const TOKEN_LIST_STORE_METHODS: ReadonlyArray<keyof TokenListStore> =
  listPortMethods<TokenListStore>({
    findTokensOfUser: true,
  });

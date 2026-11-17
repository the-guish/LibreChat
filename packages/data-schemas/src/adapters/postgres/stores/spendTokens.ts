/**
 * The PostgreSQL `SpendTokensStore` (`~/ports/spendTokens`, the `tokenSpending` store): the
 * spending rules of `~/methods/spendTokensRules` on the transaction writes of the PostgreSQL
 * token transaction store (`./tokenTransaction`), which the composition hands in. It reads and
 * writes no table of its own. Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { TokenSpendingFactoryDeps } from '~/compose/types';
import type { SpendTokensStore } from '~/ports/spendTokens';
import { createSpendTokensOnSteps } from '~/methods/spendTokensRules';

export function createPostgresSpendTokensStore(deps: TokenSpendingFactoryDeps): SpendTokensStore {
  const store: SpendTokensStore = createSpendTokensOnSteps(deps);
  return store;
}

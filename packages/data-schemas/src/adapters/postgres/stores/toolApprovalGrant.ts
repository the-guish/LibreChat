/**
 * The PostgreSQL `ToolApprovalGrantStore` (`~/ports/toolApprovalGrant`): the grant rules of
 * `~/methods/toolApprovalGrantRules` on the `toolapprovalgrants` and `tokens` tables, through the
 * collection primitive. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The validated upsert is the primitive's (`runValidators`); a duplicate key from a racing
 * upsert is retried as a plain update by the rules, as on MongoDB.
 */
import type { StoredGrant, StoredGrantToken } from '~/methods/toolApprovalGrantRules';
import type { ToolApprovalGrantStore } from '~/ports/toolApprovalGrant';
import type { PostgresStoreContext } from './context';
import {
  GRANT_FIELDS,
  GRANT_TOKEN_FIELDS,
  createToolApprovalGrantStorage,
} from '~/methods/toolApprovalGrantRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';

export function createPostgresToolApprovalGrantStore(
  context: PostgresStoreContext,
): ToolApprovalGrantStore {
  const grants = () => context.collections().collection('toolapprovalgrants');
  const tokens = () => context.collections().collection('tokens');
  const store: ToolApprovalGrantStore = createToolApprovalGrantStorage({
    findGrants: async (filter) =>
      (await grants().find(filter, { projection: GRANT_FIELDS })) as unknown as StoredGrant[],
    findTokens: async (filter) =>
      (await tokens().find(filter, {
        projection: GRANT_TOKEN_FIELDS,
      })) as unknown as StoredGrantToken[],
    updateGrant: (filter, update, options) =>
      grants().updateOne(filter, update, { upsert: options.upsert, runValidators: true }),
    isDuplicateKey: (error) => error instanceof StoreDuplicateKeyError,
  });
  return store;
}

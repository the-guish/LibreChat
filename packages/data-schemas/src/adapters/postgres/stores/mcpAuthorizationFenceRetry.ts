/**
 * The PostgreSQL `MCPAuthorizationFenceRetryStore` (`~/ports/mcpAuthorizationFenceRetry`): the
 * durable fence retries on the raw `mcp_authorization_fence_retries` table, through the collection
 * primitive in raw mode (the table has no model, tenant policy or timestamps; MongoDB writes it
 * through the driver). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * A retry's id is its key (`mcpAuthorizationFenceRetryId`), so the upsert is keyed by the primary
 * key and racing upserts converge on one row; the delete and the deferral match the exact version,
 * the deferral is a `$max` on the row (a compare-and-set that only moves the time forward). The
 * listing reads every tenant: the table carries the tenant as data, not as a policy.
 */
import type {
  MCPAuthorizationFenceRetryStore,
  MCPAuthorizationFenceRetryStoreRecord,
} from '~/ports/mcpAuthorizationFenceRetry';
import type { PostgresStoreContext } from './context';
import {
  mcpAuthorizationFenceRetryId as retryId,
  MCP_AUTHORIZATION_FENCE_RETRY_COLLECTION,
} from '~/methods/mcpAuthorizationFenceRetryRules';

type RetryRecord = MCPAuthorizationFenceRetryStoreRecord & Record<string, unknown>;

export function createPostgresMCPAuthorizationFenceRetryStore(
  context: PostgresStoreContext,
): MCPAuthorizationFenceRetryStore {
  const retries = () =>
    context.collections().raw<RetryRecord>(MCP_AUTHORIZATION_FENCE_RETRY_COLLECTION);

  const store: MCPAuthorizationFenceRetryStore = {
    async upsert({ scope, tenantId, version, now }) {
      await retries().updateOne(
        { _id: retryId(scope, tenantId, version) },
        {
          $set: {
            userId: String(scope.userId),
            serverName: scope.serverName,
            tenantId: tenantId ?? null,
            version,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    },

    async deleteVersion({ scope, tenantId, version }) {
      await retries().deleteOne({ _id: retryId(scope, tenantId, version), version });
    },

    async deferVersion({ scope, tenantId, version, updatedAt }) {
      await retries().updateOne(
        { _id: retryId(scope, tenantId, version), version },
        { $max: { updatedAt } },
      );
    },

    async list(limit) {
      return retries().find({}, { sort: { updatedAt: 1, _id: 1 }, limit });
    },
  };
  return store;
}

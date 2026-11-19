/**
 * The MCP authorization fence retry store's database-neutral rules
 * (`MCPAuthorizationFenceRetryStore`, `~/ports/mcpAuthorizationFenceRetry`), shared by every
 * backend: the MongoDB storage (`./mcpAuthorizationFenceRetry`) and the PostgreSQL store
 * (`adapters/postgres/stores/mcpAuthorizationFenceRetry.ts`). A retry's record id is its key
 * (tenant, user, server and version), so both backends key the same retry alike. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import type { MCPAuthorizationFenceRetryScope } from '~/types/mcpAuthorizationFenceRetry';

/** The table (MongoDB: collection) the retries are kept in. */
export const MCP_AUTHORIZATION_FENCE_RETRY_COLLECTION = 'mcp_authorization_fence_retries';

/** The record id of the retry of `version` for the scope in the tenant (none: `''`). */
export function mcpAuthorizationFenceRetryId(
  scope: MCPAuthorizationFenceRetryScope,
  tenantId: string | null | undefined,
  version: string,
): string {
  return JSON.stringify([tenantId ?? '', String(scope.userId), scope.serverName, version]);
}

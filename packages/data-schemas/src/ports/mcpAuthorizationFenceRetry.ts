/**
 * MCP authorization fence retry store port: the durable retries an MCP authorization fence
 * leaves when invalidating a user's recovery generation for a server fails, replayed by a
 * background worker until it succeeds. Nothing here may import `mongoose`.
 *
 * The port is the database-neutral storage contract the retry service in `@librechat/api`
 * (`mcp/authorizationRetry.ts`) programs against, moved here so a store can be declared for it;
 * that module re-exports it as `MCPAuthorizationFenceRetryStorage` and its record as
 * `MCPAuthorizationFenceRetryRecord`. `createMCPAuthorizationFenceRetryStorage`
 * (`~/methods/mcpAuthorizationFenceRetry`) satisfies it (its `list` returns the stored records,
 * with their id and creation time as well); `mcpAuthorizationFenceRetry.spec.ts` fails the
 * typecheck if the two drift.
 *
 * A retry is keyed by tenant, user, server and version: upserting the same key again only
 * refreshes it, and `deleteVersion`/`deferVersion` touch only the retry of that exact version.
 * `list` reads across tenants, oldest `updatedAt` first.
 */
import type { MCPAuthorizationFenceRetryScope } from '~/types/mcpAuthorizationFenceRetry';
import { listPortMethods } from './common';

/** A pending retry as the store hands it out. */
export interface MCPAuthorizationFenceRetryStoreRecord extends MCPAuthorizationFenceRetryScope {
  tenantId?: string | null;
  version: string;
  updatedAt: Date;
}

export interface MCPAuthorizationFenceRetryStore {
  /** Records (or refreshes) the retry of `version` for the scope, with `now` as its update time. */
  upsert(input: {
    scope: MCPAuthorizationFenceRetryScope;
    tenantId?: string | null;
    version: string;
    now: Date;
  }): Promise<void>;
  /** Removes the retry of exactly `version` for the scope, if any. */
  deleteVersion(input: {
    scope: MCPAuthorizationFenceRetryScope;
    tenantId?: string | null;
    version: string;
  }): Promise<void>;
  /** Pushes the retry of exactly `version` back to `updatedAt`, unless it is already later. */
  deferVersion(input: {
    scope: MCPAuthorizationFenceRetryScope;
    tenantId?: string | null;
    version: string;
    updatedAt: Date;
  }): Promise<void>;
  /** Up to `limit` pending retries of every tenant, oldest `updatedAt` first. */
  list(limit: number): Promise<readonly MCPAuthorizationFenceRetryStoreRecord[]>;
}

/** Every method of {@link MCPAuthorizationFenceRetryStore}, for adapters and conformance checks. */
export const MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS: ReadonlyArray<
  keyof MCPAuthorizationFenceRetryStore
> = listPortMethods<MCPAuthorizationFenceRetryStore>({
  upsert: true,
  deleteVersion: true,
  deferVersion: true,
  list: true,
});

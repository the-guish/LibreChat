/**
 * `mcp_authorization_fence_retries` (`methods/mcpAuthorizationFenceRetry.ts`), declared for the
 * PostgreSQL mapping only (docs/postgres-port/PHASE4.md §1.4, §1.6): never registered as a model.
 * `createdAt`/`updatedAt` are written by the storage itself (`$setOnInsert`, `$max`), so the
 * schema declares them as dates rather than with `timestamps`.
 */
import { Schema } from 'mongoose';

/** One durable fence retry (`MCPAuthorizationFenceRetryRecord`). */
export const mcpAuthorizationFenceRetrySchema: Schema = new Schema(
  {
    _id: { type: String },
    userId: String,
    serverName: String,
    tenantId: String,
    version: String,
    createdAt: Date,
    updatedAt: Date,
  },
  { versionKey: false },
);
mcpAuthorizationFenceRetrySchema.index({ updatedAt: 1 }, { name: 'updatedAt_1' });

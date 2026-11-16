/**
 * The raw collections of the PostgreSQL schema (docs/postgres-port/PHASE4.md §1.4, §1.6 item 5):
 * collections the data layer reads and writes through the driver rather than a mongoose model,
 * declared as mongoose schemas so the generator maps them by the same rules as the models. They
 * are never registered as models; mongoose is used offline here, for introspection (D2).
 */
import type { Schema } from 'mongoose';
import {
  browserSetupBudgetSchema,
  browserSetupRequestSchema,
  browserSetupSessionSchema,
} from './browserSetup';
import {
  codeEnvironmentTombstoneSchema,
  codeEnvironmentReconciliationSchema,
} from './codeEnvironment';
import { checkpointStorageSchema, checkpointDeletionSchema } from './checkpoint';
import { mcpAuthorizationFenceRetrySchema } from './mcpAuthorizationFenceRetry';
import { credentialMarkerSchema } from './credentialMarker';
import { keyValueEntrySchema } from './keyValue';

/** A raw collection: its name, schema, and where its documents are written. */
export interface RawCollection {
  collection: string;
  schema: Schema;
  /** The columns keying the table, for a table without `_id`. */
  primaryKey?: string[];
  /** The module that reads and writes it. */
  owner: string;
}

/** Every raw collection, in table order. */
export const RAW_COLLECTIONS: readonly RawCollection[] = [
  {
    collection: 'browser_setup_sessions',
    schema: browserSetupSessionSchema,
    owner: 'methods/browserSetup.ts',
  },
  {
    collection: 'browser_setup_budget',
    schema: browserSetupBudgetSchema,
    owner: 'methods/browserSetup.ts',
  },
  {
    collection: 'browser_setup_requests',
    schema: browserSetupRequestSchema,
    owner: 'methods/browserSetup.ts',
  },
  {
    collection: 'code_environment_tombstones',
    schema: codeEnvironmentTombstoneSchema,
    owner: 'methods/codeEnvironment.ts',
  },
  {
    collection: 'code_environment_reconciliation',
    schema: codeEnvironmentReconciliationSchema,
    owner: 'methods/codeEnvironment.ts',
  },
  {
    collection: 'mcp_authorization_fence_retries',
    schema: mcpAuthorizationFenceRetrySchema,
    owner: 'methods/mcpAuthorizationFenceRetry.ts',
  },
  {
    collection: 'librechatCredentialMetadata',
    schema: credentialMarkerSchema,
    owner: 'adapters/mongo/credentialMarker.ts',
  },
  {
    collection: 'agent_checkpoint_stores',
    schema: checkpointStorageSchema,
    owner: 'adapters/mongo/checkpointSaver.ts',
  },
  {
    collection: 'agent_checkpoint_deletions',
    schema: checkpointDeletionSchema,
    owner: 'adapters/mongo/checkpointStore.ts',
  },
  {
    collection: 'key_value_entries',
    schema: keyValueEntrySchema,
    primaryKey: ['store', 'key'],
    owner: 'the PostgreSQL key-value store (I1)',
  },
];

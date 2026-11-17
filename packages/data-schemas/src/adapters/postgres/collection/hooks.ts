/**
 * Collection hooks (docs/postgres-port/PHASE4.md §1.9 "Hooks"): the mongoose middleware of the
 * schemas, re-expressed for the collection primitive, which runs no mongoose middleware (the schema
 * engine only builds documents). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * | Collection             | Mongoose middleware                                   | Hook here                                   |
 * | ---------------------- | ----------------------------------------------------- | ------------------------------------------- |
 * | `users`, `groups`      | `applySearchTokens` (`models/plugins/searchTokens.ts`) | tokens on insert; `withSearchTokens` on updates (element tables) |
 * | `auditlogs`            | append-only `pre` hooks (`schema/auditLog.ts`)        | updates, deletes, `insertMany` and bulk writes refused with the same message |
 * | `mcpservers`           | `pre('validate')` normalization (`schema/mcpServer.ts`) | `normalizedServerName` on insert             |
 * | `conversations`, `messages` | `mongoMeili` hooks (MeiliSearch indexing)   | the search hooks of `../search.ts` (I3), added by the backend when MeiliSearch is configured |
 *
 * Hooks run in document mode only: the raw mode (e2e facade, contract `seedRaw`, the copy tool)
 * bypasses them, as the driver bypasses mongoose middleware.
 */
import { normalizeServerName } from 'librechat-data-provider';
import type { SearchTokenField } from '~/utils/search';
import type { StoreTransaction } from '~/ports/common';
import type { PgRecord } from './types';
import {
  withSearchTokens,
  computeSearchTokens,
  USER_SEARCH_TOKEN_FIELDS,
  GROUP_SEARCH_TOKEN_FIELDS,
} from '~/utils/search';

/** What an update hook is told about the update. */
export interface UpdateHookContext {
  /** The filter (before tenant scoping). */
  filter: PgRecord;
  upsert: boolean;
  /**
   * Whether `afterWrite` follows this write: a tracked write (see `PgUpdateOptions.writeHooks`;
   * `findOneAndUpdate` by default, as mongoose's query middleware sees its document).
   */
  tracked?: boolean;
}

/** What an insert hook is told about the insert. */
export interface InsertHookContext {
  /** The document the caller gave (before the engine built it). */
  input: PgRecord;
  /** Whether `afterWrite` follows this insert (`insertOne`, as mongoose's `save` middleware). */
  tracked: boolean;
}

/** The transaction a write ran in, when the caller gave one (after-write work waits for it). */
export interface WriteHookContext {
  tx?: StoreTransaction;
}

/** The record a tracked write wrote. */
export interface WrittenRecord {
  /** Its key (`_id`). */
  key: string;
  /** An insert: the record as stored. */
  record?: PgRecord;
  /** An insert: the document the caller gave. */
  input?: PgRecord;
}

/** The hooks of one collection; every member is optional. */
export interface CollectionHooks {
  /** Before the engine builds an inserted document (mongoose's `pre('validate')`). */
  beforeBuild?(input: PgRecord): PgRecord;
  /** On the document built for an insert, before it is stored (mongoose's `pre('save')`). */
  beforeInsert?(record: PgRecord, context?: InsertHookContext): void;
  /** Before `insertMany` (mongoose's `pre('insertMany')`): may refuse. */
  beforeInsertMany?(): void;
  /** Returns the update to apply (mongoose's update query middleware); may refuse. */
  beforeUpdate?(update: PgRecord, context: UpdateHookContext): PgRecord;
  /** Before a delete (mongoose's delete query middleware): may refuse. */
  beforeDelete?(): void;
  /** Before a bulk write (mongoose's `pre('bulkWrite')`): may refuse. */
  beforeBulk?(): void;
  /**
   * After a tracked write (mongoose's `post('save')` and `post('findOneAndUpdate')`), once per
   * record it wrote; the primitive awaits it after the operation (a caller's transaction may
   * still be open: `context.tx`).
   */
  afterWrite?(written: WrittenRecord, context: WriteHookContext): void | Promise<void>;
  /**
   * After every delete in document mode: `columns` are returned by the delete statements and
   * handed to `run` with the deleted rows once the operation is done (a caller's transaction may
   * still be open: `context.tx`).
   */
  afterDelete?: {
    readonly columns: readonly string[];
    run(rows: PgRecord[], context: WriteHookContext): void | Promise<void>;
  };
}

/** The hooks maintaining derived search-token arrays (`applySearchTokens`). */
export function searchTokenHooks(fields: readonly SearchTokenField[]): CollectionHooks {
  return {
    beforeInsert(record) {
      for (const field of fields) {
        record[field.tokens] = computeSearchTokens(field.kind, record[field.source]);
      }
    },
    beforeUpdate: (update, context) =>
      withSearchTokens(fields, update, { upsert: context.upsert, filter: context.filter }),
  };
}

/** The message `schema/auditLog.ts` refuses mutations with. */
export const AUDIT_LOG_APPEND_ONLY_MESSAGE =
  'AuditLog is append-only — updates and deletes are forbidden';

const refuseAuditMutation = (): never => {
  throw new Error(AUDIT_LOG_APPEND_ONLY_MESSAGE);
};

/** The audit log's append-only rule: single inserts only. */
export const AUDIT_LOG_HOOKS: CollectionHooks = {
  beforeInsertMany: refuseAuditMutation,
  beforeUpdate: refuseAuditMutation,
  beforeDelete: refuseAuditMutation,
  beforeBulk: refuseAuditMutation,
};

/** `mcpServerSchema.pre('validate')`: the normalized server name follows the server name. */
export const MCP_SERVER_HOOKS: CollectionHooks = {
  beforeBuild(input) {
    if (typeof input.serverName !== 'string') {
      return input;
    }
    return { ...input, normalizedServerName: normalizeServerName(input.serverName) };
  },
};

/**
 * The hooks of the production collections. `conversations` and `messages` carry the MeiliSearch
 * flags as plain columns: the indexing hooks come with the search sync (I3).
 */
export const DEFAULT_COLLECTION_HOOKS: Readonly<Record<string, CollectionHooks>> = {
  users: searchTokenHooks(USER_SEARCH_TOKEN_FIELDS),
  groups: searchTokenHooks(GROUP_SEARCH_TOKEN_FIELDS),
  auditlogs: AUDIT_LOG_HOOKS,
  mcpservers: MCP_SERVER_HOOKS,
};

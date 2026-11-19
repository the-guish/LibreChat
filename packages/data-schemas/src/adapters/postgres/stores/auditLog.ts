/**
 * The PostgreSQL `AuditLogStore` (`~/ports/auditLog`) on the `auditlogs` table: the chain rules of
 * `~/methods/auditLogRules` on the collection primitive, plus one hand-written statement (the
 * append lock). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - Appends: each attempt is one transaction that takes a transaction-level advisory lock on the
 *   chain (`pg_advisory_xact_lock`), reads the tail and inserts the sealed entry, so appends to
 *   one chain are serialized and never race for a `seq`. The unique `{ chainKey, seq }` index
 *   stays the backstop: a duplicate key is retried by the rules, as on MongoDB.
 * - The export stream and the verification read the chain by keyset pages of 500 on `seq` (an
 *   async generator, no cursor held across awaits; PHASE4.md §4 "Cursors and streaming").
 * - The retention purge deletes through the raw collection, which bypasses the append-only hooks
 *   (`collection/hooks.ts`), as MongoDB's purge goes through the driver; the chain key scopes it.
 *   The audit log carries no tenant plugin (the chain key is the tenant boundary).
 */
import { sql } from 'kysely';
import type { StoredAuditEntry, SealedAuditEntry } from '~/methods/auditLogRules';
import type { AuditLogStore, AuditLogStoreEntryInput } from '~/ports/auditLog';
import type { PostgresStoreContext } from './context';
import type { IAuditLog } from '~/types';
import {
  auditChainKey,
  planAuditLogPage,
  toAuditLogPage,
  toAuditWireEntry,
  streamAuditEntries,
  auditLogEntryFilter,
  buildAuditLogFilter,
  purgeAuditLogOnSteps,
  recordAuditEntryOnSteps,
  verifyAuditChainEntries,
} from '~/methods/auditLogRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { asRecord, runStoreSql } from './context';

/** Rows per keyset page of the export and the verification. */
const PAGE_SIZE = 500;

/** The advisory lock key space of the chain locks (`hashtextextended(<prefix><chainKey>, 0)`). */
const CHAIN_LOCK_PREFIX = 'librechat:auditlogs:';

type AuditRecord = StoredAuditEntry & Record<string, unknown>;

export function createPostgresAuditLogStore(context: PostgresStoreContext): AuditLogStore {
  const auditLogs = () => context.collections().collection<AuditRecord>('auditlogs');

  /** Every entry matching `filter`, in `seq` order, read by keyset pages. */
  async function* entriesBySeq(
    filter: Record<string, unknown>,
    direction: 1 | -1,
  ): AsyncGenerator<StoredAuditEntry> {
    let after: number | undefined;
    for (;;) {
      const page = await auditLogs().find(
        after === undefined
          ? filter
          : { $and: [filter, { seq: direction === 1 ? { $gt: after } : { $lt: after } }] },
        { sort: { seq: direction }, limit: PAGE_SIZE },
      );
      yield* page;
      if (page.length < PAGE_SIZE) {
        return;
      }
      after = page[page.length - 1].seq;
    }
  }

  const store: AuditLogStore = {
    async recordAuditEntry(input, options) {
      const appended = await recordAuditEntryOnSteps(input, options, {
        append: (chainKey, seal) =>
          context.transactions.transaction(async (tx) => {
            await runStoreSql(
              context,
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${CHAIN_LOCK_PREFIX + chainKey}, 0))`,
              tx,
            );
            const tail = await auditLogs().findOne(
              { chainKey },
              { sort: { seq: -1 }, projection: 'seq hash', tx },
            );
            const sealed: SealedAuditEntry = seal(tail ? { seq: tail.seq, hash: tail.hash } : null);
            return auditLogs().insertOne(asRecord(sealed), { tx });
          }),
        isDuplicateKey: (error) => error instanceof StoreDuplicateKeyError,
      });
      return appended as unknown as IAuditLog | null;
    },

    async listAuditLogPage(tenantId, filters) {
      const { base, paged, limit, offset } = planAuditLogPage(tenantId, filters);
      const [rowsPlusOne, total] = await Promise.all([
        auditLogs().find(paged, {
          sort: { seq: -1 },
          limit: limit + 1,
          ...(offset > 0 ? { skip: offset } : {}),
        }),
        auditLogs().count(base),
      ]);
      return toAuditLogPage(rowsPlusOne, total, limit);
    },

    async findAuditLogEntry(tenantId, id) {
      const query = auditLogEntryFilter(tenantId, id);
      if (!query) return null;
      const doc = await auditLogs().findOne(query);
      return doc ? toAuditWireEntry(doc) : null;
    },

    async streamAuditLogEntries(tenantId, filters, onEntry, options) {
      const query = buildAuditLogFilter(auditChainKey(tenantId), filters);
      return streamAuditEntries(entriesBySeq(query, -1), onEntry, options);
    },

    async verifyAuditChain(tenantId, options) {
      const chainKey = auditChainKey(tenantId);
      return verifyAuditChainEntries(chainKey, entriesBySeq({ chainKey }, 1), options);
    },

    async purgeAuditLogEntries(tenantId, options) {
      return purgeAuditLogOnSteps(tenantId, options, {
        async findFirst(chainKey, since) {
          const first = await auditLogs().findOne(
            { chainKey, ...(since ? { createdAt: { $gte: since } } : {}) },
            { sort: { seq: 1 }, projection: 'seq prevHash' },
          );
          return first ? { seq: first.seq, prevHash: first.prevHash } : null;
        },
        async deletePrefix(chainKey, belowSeq) {
          const result = await context
            .collections()
            .raw('auditlogs')
            .deleteMany(
              belowSeq !== undefined ? { chainKey, seq: { $lt: belowSeq } } : { chainKey },
            );
          return result.deletedCount;
        },
        /** The purge's own entry names no ids (`audit-retention`, the audit log). */
        record: (input) => store.recordAuditEntry(input as AuditLogStoreEntryInput),
      });
    },
  };
  return store;
}

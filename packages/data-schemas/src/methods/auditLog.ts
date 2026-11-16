import type { FilterQuery, Model } from 'mongoose';
import type {
  AdminAuditLogEntry,
  AuditChainVerification,
  AuditLogFilters,
  AuditLogPage,
  IAuditLog,
  PurgeAuditLogOptions,
  PurgeAuditLogResult,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
  VerifyAuditChainOptions,
} from '~/types';
import type { IndexBuildOptions } from '~/utils/retry';
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
} from './auditLogRules';
import { createIndexesWithRetry } from '~/utils/retry';

export {
  auditChainKey,
  AUDIT_SCHEMA_VERSION,
  MAX_AUDIT_LOG_LIMIT,
  MAX_AUDIT_EXPORT_ROWS,
  MAX_AUDIT_VERIFY_ROWS,
} from './auditLogRules';

export interface AuditLogMethods {
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<IAuditLog | null>;
  listAuditLogPage: (
    tenantId: string | undefined,
    filters: AuditLogFilters,
  ) => Promise<AuditLogPage>;
  findAuditLogEntry: (
    tenantId: string | undefined,
    id: string,
  ) => Promise<AdminAuditLogEntry | null>;
  streamAuditLogEntries: (
    tenantId: string | undefined,
    filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
    onEntry: (entry: AdminAuditLogEntry) => void | Promise<void>,
    options?: { isCancelled?: () => boolean; maxRows?: number },
  ) => Promise<{ count: number; truncated: boolean }>;
  verifyAuditChain: (
    tenantId: string | undefined,
    options?: VerifyAuditChainOptions,
  ) => Promise<AuditChainVerification>;
  purgeAuditLogEntries: (
    tenantId: string | undefined,
    options: PurgeAuditLogOptions,
  ) => Promise<PurgeAuditLogResult>;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** The chain's rules (hashing, filters, verification, purge plan) are in `./auditLogRules`. */
function buildFilter(
  chainKey: string,
  filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
): FilterQuery<IAuditLog> {
  return buildAuditLogFilter(chainKey, filters) as FilterQuery<IAuditLog>;
}

/** Longest wait on the request path for a peer's index build before an append fails open. */
const AUDIT_INDEX_BUILD_DEADLINE_MS = 10_000;

export interface AuditLogMethodOptions {
  /** Overrides for the append index build; tests shorten its polling and deadline. */
  indexBuild?: IndexBuildOptions;
}

export function createAuditLogMethods(
  mongoose: typeof import('mongoose'),
  options: AuditLogMethodOptions = {},
): AuditLogMethods {
  function model(): Model<IAuditLog> {
    return mongoose.models.AuditLog as Model<IAuditLog>;
  }

  /**
   * The read-then-create append only serializes concurrent writers when the
   * unique `{ chainKey, seq }` index exists. With `MONGO_AUTO_INDEX=false`, or
   * during the startup window before a background build finishes, two writers
   * could insert the same `seq` with no duplicate-key error and silently fork
   * the chain. Build the indexes once before the first append so serialization
   * never depends on a background build — letting Mongoose's own background
   * build settle first, so the two never overlap on a single-build engine. The
   * wait for a peer's build is bounded, because this runs on the request path:
   * past the deadline the append fails open below instead of holding the
   * request. Memoized; reset on failure so a later write retries.
   */
  let indexPromise: Promise<unknown> | null = null;
  function ensureIndexes(): Promise<unknown> {
    if (!indexPromise) {
      indexPromise = createIndexesWithRetry(model(), {
        peerBuildDeadlineMs: AUDIT_INDEX_BUILD_DEADLINE_MS,
        ...options.indexBuild,
      }).catch((err) => {
        indexPromise = null;
        throw err;
      });
    }
    return indexPromise;
  }

  async function recordAuditEntry(
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ): Promise<IAuditLog | null> {
    const AuditLog = model();
    return recordAuditEntryOnSteps(input, options, {
      beforeAttempt: ensureIndexes,
      async append(chainKey, seal) {
        const last = await AuditLog.findOne({ chainKey })
          .sort({ seq: -1 })
          .select('seq hash')
          .lean<{ seq: number; hash: string }>();
        return AuditLog.create(seal(last));
      },
      isDuplicateKey: isDuplicateKeyError,
    });
  }

  async function listAuditLogPage(
    tenantId: string | undefined,
    filters: AuditLogFilters,
  ): Promise<AuditLogPage> {
    const AuditLog = model();
    const { base, paged, limit, offset } = planAuditLogPage(tenantId, filters);

    let pageQuery = AuditLog.find(paged as FilterQuery<IAuditLog>)
      .sort({ seq: -1 })
      .limit(limit + 1);
    if (offset > 0) pageQuery = pageQuery.skip(offset);

    const [rowsPlusOne, total] = await Promise.all([
      pageQuery.lean<IAuditLog[]>(),
      AuditLog.countDocuments(base as FilterQuery<IAuditLog>),
    ]);

    return toAuditLogPage(rowsPlusOne, total, limit);
  }

  async function findAuditLogEntry(
    tenantId: string | undefined,
    id: string,
  ): Promise<AdminAuditLogEntry | null> {
    const query = auditLogEntryFilter(tenantId, id);
    if (!query) return null;
    const AuditLog = model();
    const doc = await AuditLog.findOne(query as FilterQuery<IAuditLog>).lean<IAuditLog>();
    return doc ? toAuditWireEntry(doc) : null;
  }

  async function streamAuditLogEntries(
    tenantId: string | undefined,
    filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
    onEntry: (entry: AdminAuditLogEntry) => void | Promise<void>,
    options?: { isCancelled?: () => boolean; maxRows?: number },
  ): Promise<{ count: number; truncated: boolean }> {
    const AuditLog = model();
    const query = buildFilter(auditChainKey(tenantId), filters);
    const cursor = AuditLog.find(query)
      .sort({ seq: -1 })
      .lean<IAuditLog[]>()
      .cursor({ batchSize: 500 });

    try {
      return await streamAuditEntries(cursor, onEntry, options);
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }

  async function verifyAuditChain(
    tenantId: string | undefined,
    options?: VerifyAuditChainOptions,
  ): Promise<AuditChainVerification> {
    const AuditLog = model();
    const chainKey = auditChainKey(tenantId);
    const cursor = AuditLog.find({ chainKey })
      .sort({ seq: 1 })
      .lean<IAuditLog[]>()
      .cursor({ batchSize: 500 });

    try {
      return await verifyAuditChainEntries(chainKey, cursor, options);
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }

  async function purgeAuditLogEntries(
    tenantId: string | undefined,
    options: PurgeAuditLogOptions,
  ): Promise<PurgeAuditLogResult> {
    const AuditLog = model();
    return purgeAuditLogOnSteps(tenantId, options, {
      findFirst: (chainKey, since) =>
        AuditLog.findOne({ chainKey, ...(since ? { createdAt: { $gte: since } } : {}) })
          .sort({ seq: 1 })
          .select('seq prevHash')
          .lean<{ seq: number; prevHash: string }>(),
      async deletePrefix(chainKey, belowSeq) {
        const deleteFilter: FilterQuery<IAuditLog> =
          belowSeq !== undefined ? { chainKey, seq: { $lt: belowSeq } } : { chainKey };
        /**
         * Retention purge is the one privileged path that removes audit rows. It
         * intentionally uses the raw driver to bypass the append-only Mongoose hooks
         * (the model blocks every delete). Tenant isolation is applied via `chainKey`.
         */
        // eslint-disable-next-line no-restricted-syntax -- privileged retention purge; append-only hooks block deleteMany, tenant scoped via chainKey
        const result = await AuditLog.collection.deleteMany(deleteFilter);
        return result.deletedCount ?? 0;
      },
      record: (input) => recordAuditEntry(input as RecordAuditEntryInput),
    });
  }

  return {
    recordAuditEntry,
    listAuditLogPage,
    findAuditLogEntry,
    streamAuditLogEntries,
    verifyAuditChain,
    purgeAuditLogEntries,
  };
}

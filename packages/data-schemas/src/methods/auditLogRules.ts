/**
 * The audit log's database-neutral rules (`AuditLogStore`, `~/ports/auditLog`), shared by every
 * backend: the MongoDB methods (`./auditLog`) and the PostgreSQL store
 * (`adapters/postgres/stores/auditLog.ts`). Nothing here may import `mongoose` or the MongoDB
 * driver.
 *
 * - The chain: chain keys, the canonical entry hash, how an appended entry is normalized and
 *   sealed onto the tail of its chain, the append loop (`recordAuditEntryOnSteps`: retries a
 *   racing append that lost the `{ chainKey, seq }` unique key, fails open unless `failClosed`).
 * - Reads: the filter of the listing, export and verification reads (in the store query
 *   language), the page limits, the wire shape, the export loop and the chain verification over a
 *   stream of entries in `seq` order.
 * - The retention purge's plan: delete only a contiguous `seq` prefix, mint a checkpoint only when
 *   rows went, then audit the purge itself.
 *
 * A backend supplies the storage steps (the tail read, the insert, the ordered entry streams, the
 * prefix delete).
 */
import { createHash } from 'node:crypto';
import type {
  AuditLog,
  AuditContext,
  AuditMetadata,
  AuditLogFilters,
  AuditLogPage,
  AdminAuditLogEntry,
  AuditChainVerification,
  PurgeAuditLogOptions,
  PurgeAuditLogResult,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
  VerifyAuditChainOptions,
} from '~/types';
import { AUDIT_ACTION_CATEGORY } from '~/types/admin';
import logger from '~/config/winston';

/** Sentinel `chainKey` for platform-level (non-tenant) audit entries. */
export const PLATFORM_CHAIN_KEY = '__platform__';

/** Genesis link: the `prevHash` of the first entry in any chain. */
export const GENESIS_HASH: string = '0'.repeat(64);

const DEFAULT_LIMIT = 100;
export const MAX_AUDIT_LOG_LIMIT = 500;
/**
 * Upper bound on rows emitted by the CSV export stream. At 100k rows per tenant
 * per export request, a careless admin script (or a hostile auditor) can keep a
 * cursor and a Node worker busy without saturating either; beyond that, exports
 * should be sliced by `from`/`to`.
 */
export const MAX_AUDIT_EXPORT_ROWS = 100_000;
/**
 * Upper bound on rows verified in a single HTTP-triggered integrity check. Full
 * offline jobs can pass a larger value explicitly when needed.
 */
export const MAX_AUDIT_VERIFY_ROWS = 100_000;
/** Record-format version stamped on every new entry. */
export const AUDIT_SCHEMA_VERSION = 1;
const MAX_SEARCH_LENGTH = 200;
/**
 * Retries when concurrent appends race for the same `seq`. Generous because a
 * lost append on the default fail-open path means a silently missing audit row;
 * with jittered backoff this resolves contention well beyond any realistic burst
 * of parallel admin writes.
 */
const MAX_APPEND_RETRIES = 12;
/** Base unit (ms) for jittered backoff between duplicate-key retries. */
const APPEND_BACKOFF_MS = 5;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function regexFilter(value: string): { $regex: string; $options: string } {
  return { $regex: escapeRegex(value), $options: 'i' };
}

function oneOrIn<T>(values: T[]): T | { $in: T[] } {
  return values.length === 1 ? values[0] : { $in: values };
}

function idToString(id: string | { toString(): string }): string {
  return typeof id === 'string' ? id : id.toString();
}

/** Distinguishes tenant chains from the platform chain so a tenant whose id is
 * literally the platform sentinel cannot share the platform's audit chain. */
const TENANT_CHAIN_PREFIX = 'tenant:';

/** Tenant scope → chain key. Blank/whitespace tenant is the platform chain;
 * tenant ids are namespaced so they can never collide with `PLATFORM_CHAIN_KEY`. */
export function auditChainKey(tenantId?: string): string {
  return typeof tenantId === 'string' && tenantId.trim().length > 0
    ? `${TENANT_CHAIN_PREFIX}${tenantId}`
    : PLATFORM_CHAIN_KEY;
}

function normalizeTenantId(tenantId?: string): string | undefined {
  return typeof tenantId === 'string' && tenantId.trim().length > 0 ? tenantId : undefined;
}

/** Drop undefined values; collapse an empty map to `undefined` so the field is
 * omitted entirely (and hashes identically on read-back). */
function normalizeMetadata(metadata?: AuditMetadata): AuditMetadata | undefined {
  if (!metadata) return undefined;
  const out: AuditMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeContext(context?: AuditContext): AuditContext | undefined {
  if (!context) return undefined;
  const out: AuditContext = {};
  if (context.requestId) out.requestId = context.requestId;
  if (context.ip) out.ip = context.ip;
  if (context.userAgent) out.userAgent = context.userAgent;
  if (context.sessionId) out.sessionId = context.sessionId;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Deterministic JSON: object keys sorted recursively so two semantically equal
 * entries always serialize to the same string. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/** Fields covered by the per-entry hash. Mirrors the stored shape so write-time
 * and verify-time recomputation agree exactly. */
export interface HashableAuditEntry {
  schemaVersion: number;
  category: AuditLog['category'];
  action: AuditLog['action'];
  outcome: AuditLog['outcome'];
  severity: AuditLog['severity'];
  actor: AuditLog['actor'];
  target: AuditLog['target'];
  metadata?: AuditMetadata;
  context?: AuditContext;
  tenantId?: string;
  chainKey: string;
  seq: number;
  prevHash: string;
  createdAt: Date;
}

/** The SHA-256 of an entry's canonical content. */
export function computeAuditEntryHash(entry: HashableAuditEntry): string {
  const canonical = {
    v: entry.schemaVersion,
    category: entry.category,
    action: entry.action,
    outcome: entry.outcome,
    severity: entry.severity,
    actor: {
      type: entry.actor.type,
      id: entry.actor.id ?? null,
      name: entry.actor.name,
    },
    target: {
      type: entry.target.type,
      id: entry.target.id ?? null,
      name: entry.target.name ?? null,
    },
    metadata: entry.metadata ?? null,
    context: entry.context
      ? {
          requestId: entry.context.requestId ?? null,
          ip: entry.context.ip ?? null,
          userAgent: entry.context.userAgent ?? null,
          sessionId: entry.context.sessionId ?? null,
        }
      : null,
    tenantId: entry.tenantId ?? null,
    chainKey: entry.chainKey,
    seq: entry.seq,
    prevHash: entry.prevHash,
    createdAt: entry.createdAt.toISOString(),
  };
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

/** A stored entry as a read returns it (its `_id` as the backend's id or its string). */
export type StoredAuditEntry = AuditLog & { _id: { toString(): string } | string };

/** The admin API's shape of a stored entry. */
export function toAuditWireEntry(doc: StoredAuditEntry): AdminAuditLogEntry {
  const entry: AdminAuditLogEntry = {
    id: doc._id.toString(),
    schemaVersion: doc.schemaVersion,
    category: doc.category,
    action: doc.action,
    outcome: doc.outcome,
    severity: doc.severity,
    actor: {
      type: doc.actor.type,
      name: doc.actor.name,
      ...(doc.actor.id != null ? { id: doc.actor.id } : {}),
    },
    target: {
      type: doc.target.type,
      ...(doc.target.id != null ? { id: doc.target.id } : {}),
      ...(doc.target.name != null ? { name: doc.target.name } : {}),
    },
    integrity: { seq: doc.seq, hash: doc.hash, prevHash: doc.prevHash },
    timestamp: doc.createdAt.toISOString(),
  };
  if (doc.metadata != null) entry.metadata = doc.metadata;
  const context = normalizeContext(doc.context);
  if (context) entry.context = context;
  if (doc.tenantId != null) entry.tenantId = doc.tenantId;
  return entry;
}

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_AUDIT_LOG_LIMIT);
}

/**
 * Builds the `find` filter for audit-log queries (store query language). Chain scoping is always
 * applied first and uses the compound `{ chainKey, ... }` indexes. The substring
 * regex filters (`actor.name`, `target.name`, `metadata.capability`, `search`)
 * are case-insensitive and cannot use a B-tree index: within the chain slice
 * they degrade to a partition scan. The primary listing combines `chainKey` with
 * `seq`/`createdAt` pagination, so the scan stays bounded by the date window.
 */
export function buildAuditLogFilter(
  chainKey: string,
  filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
): Record<string, unknown> {
  const query: Record<string, unknown> = { chainKey };

  if (filters.category && filters.category.length > 0) {
    query.category = oneOrIn(filters.category);
  }
  if (filters.action && filters.action.length > 0) {
    query.action = oneOrIn(filters.action);
  }
  if (filters.outcome && filters.outcome.length > 0) {
    query.outcome = oneOrIn(filters.outcome);
  }
  if (filters.severity && filters.severity.length > 0) {
    query.severity = oneOrIn(filters.severity);
  }
  if (filters.actorType) {
    query['actor.type'] = filters.actorType;
  }
  if (filters.actorQuery) {
    query['actor.name'] = regexFilter(filters.actorQuery);
  }
  if (filters.targetType) {
    query['target.type'] = filters.targetType;
  }
  if (filters.targetQuery) {
    query['target.name'] = regexFilter(filters.targetQuery);
  }
  if (filters.capability) {
    query['metadata.capability'] = regexFilter(filters.capability);
  }
  if (filters.from || filters.to) {
    const createdAt: { $gte?: Date; $lte?: Date } = {};
    if (filters.from) createdAt.$gte = filters.from;
    if (filters.to) createdAt.$lte = filters.to;
    query.createdAt = createdAt;
  }
  if (filters.search && filters.search.length > 0) {
    const safe = regexFilter(filters.search.slice(0, MAX_SEARCH_LENGTH));
    query.$or = [
      { 'actor.name': safe },
      { 'target.name': safe },
      { action: safe },
      { 'metadata.capability': safe },
    ];
  }

  return query;
}

/* ------------------------------------------------------------------------------------------ */
/* Appends                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** An entry normalized for its chain, before it is sealed onto the chain's tail. */
export interface PreparedAuditEntry {
  action: AuditLog['action'];
  category: AuditLog['category'];
  outcome: AuditLog['outcome'];
  severity: AuditLog['severity'];
  actor: AuditLog['actor'];
  target: AuditLog['target'];
  metadata?: AuditMetadata;
  context?: AuditContext;
  tenantId?: string;
  chainKey: string;
}

/** The stored fields of an appended entry (what the insert writes). */
export type SealedAuditEntry = Omit<AuditLog, 'metadata' | 'context' | 'tenantId'> &
  Partial<Pick<AuditLog, 'metadata' | 'context' | 'tenantId'>>;

/** The tail of a chain: its last entry's `seq` and `hash`. */
export interface AuditChainTail {
  seq: number;
  hash: string;
}

/** Input whose actor and target ids may be any id (stored as their strings). */
export type AuditEntryInput = Omit<RecordAuditEntryInput, 'actor' | 'target'> & {
  actor: Omit<RecordAuditEntryInput['actor'], 'id'> & { id?: string | { toString(): string } };
  target: Omit<RecordAuditEntryInput['target'], 'id'> & { id?: string | { toString(): string } };
};

/** The input normalized: chain key, category, outcome and severity defaults, ids as strings. */
export function prepareAuditEntry(input: AuditEntryInput): PreparedAuditEntry {
  const tenantId = normalizeTenantId(input.tenantId);
  const chainKey = auditChainKey(input.tenantId);
  const category = input.category ?? AUDIT_ACTION_CATEGORY[input.action];
  const outcome = input.outcome ?? 'success';
  const severity =
    input.severity ?? (outcome === 'failure' || outcome === 'denied' ? 'warning' : 'info');
  const actor = {
    type: input.actor.type,
    name: input.actor.name,
    ...(input.actor.id != null ? { id: idToString(input.actor.id) } : {}),
  };
  const target = {
    type: input.target.type,
    ...(input.target.id != null ? { id: idToString(input.target.id) } : {}),
    ...(input.target.name != null ? { name: input.target.name } : {}),
  };
  const metadata = normalizeMetadata(input.metadata);
  const context = normalizeContext(input.context);
  return {
    action: input.action,
    category,
    outcome,
    severity,
    actor,
    target,
    metadata,
    context,
    tenantId,
    chainKey,
  };
}

/** The entry sealed onto `tail` (`null`: the chain is empty) at `createdAt`. */
export function sealAuditEntry(
  entry: PreparedAuditEntry,
  tail: AuditChainTail | null,
  createdAt: Date,
): SealedAuditEntry {
  const prevSeq = tail?.seq ?? 0;
  const prevHash = tail?.hash ?? GENESIS_HASH;
  const seq = prevSeq + 1;
  const { action, category, outcome, severity, actor, target, metadata, context } = entry;
  const { tenantId, chainKey } = entry;
  const hash = computeAuditEntryHash({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    category,
    action,
    outcome,
    severity,
    actor,
    target,
    metadata,
    context,
    tenantId,
    chainKey,
    seq,
    prevHash,
    createdAt,
  });
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    category,
    action,
    outcome,
    severity,
    actor,
    target,
    ...(metadata !== undefined && { metadata }),
    ...(context !== undefined && { context }),
    ...(tenantId !== undefined && { tenantId }),
    chainKey,
    seq,
    prevHash,
    hash,
    createdAt,
  };
}

/** The storage steps of an append. */
export interface AuditAppendSteps<R> {
  /** Runs before each attempt (MongoDB: the unique `{ chainKey, seq }` index is built). */
  beforeAttempt?(): Promise<unknown>;
  /**
   * Reads the tail of `chainKey` and inserts `seal(tail)` (the time is read in `seal`); rejects
   * with a duplicate-key error when another append took that `seq` first.
   */
  append(chainKey: string, seal: (tail: AuditChainTail | null) => SealedAuditEntry): Promise<R>;
  isDuplicateKey(error: unknown): boolean;
}

/**
 * Appends an entry to its chain: retries an append that lost the race for its `seq` (jittered
 * backoff), and on any other failure, or once the retries are spent, logs a structured trail and
 * resolves `null` (fail-open) unless `options.failClosed`.
 */
export async function recordAuditEntryOnSteps<R>(
  input: AuditEntryInput,
  options: RecordAuditEntryOptions | undefined,
  steps: AuditAppendSteps<R>,
): Promise<R | null> {
  const entry = prepareAuditEntry(input);
  const { category, outcome, chainKey, tenantId, actor, target } = entry;

  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    try {
      /** Guarantee the unique seq index exists before serializing on it. */
      await steps.beforeAttempt?.();
      return await steps.append(chainKey, (tail) => sealAuditEntry(entry, tail, new Date()));
    } catch (err) {
      if (steps.isDuplicateKey(err) && attempt < MAX_APPEND_RETRIES - 1) {
        /** Jittered backoff de-correlates racing writers before they recompute
         * the tail `seq`, so the next attempt is very unlikely to collide. */
        await sleep(Math.floor(Math.random() * APPEND_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      /**
       * Fail-open by default: a failed write must never block the privileged
       * operation, so it returns null and leaves a structured forensic trail.
       * Callers that require a durable record pass `failClosed` to surface the
       * failure instead.
       */
      logger.error('[auditLog] failed to record audit entry', {
        action: input.action,
        category,
        outcome,
        chainKey,
        tenantId,
        actorId: actor.id ?? null,
        actorType: actor.type,
        targetType: target.type,
        targetId: target.id ?? null,
        /** Name and driver code only: the message can echo query text or connection details. */
        errName: err instanceof Error ? err.name : typeof err,
        errCode: (err as { code?: unknown } | null)?.code ?? null,
      });
      if (options?.failClosed) {
        throw err instanceof Error ? err : new Error('Failed to record audit entry');
      }
      return null;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------ */
/* Reads                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** The reads of one listing page. */
export interface AuditLogPagePlan {
  /** The filter of the matching entries (the `total`). */
  base: Record<string, unknown>;
  /** `base` past the cursor (the page's rows). */
  paged: Record<string, unknown>;
  limit: number;
  /** Rows to skip (only without a cursor). */
  offset: number;
}

/** What one page of `listAuditLogPage` reads: by `seq` descending, `limit + 1` rows. */
export function planAuditLogPage(
  tenantId: string | undefined,
  filters: AuditLogFilters,
): AuditLogPagePlan {
  const chainKey = auditChainKey(tenantId);
  const limit = clampLimit(filters.limit);
  const base = buildAuditLogFilter(chainKey, filters);

  const cursorSeq =
    typeof filters.cursor === 'number' && Number.isFinite(filters.cursor)
      ? filters.cursor
      : undefined;
  const paged = cursorSeq !== undefined ? { ...base, seq: { $lt: cursorSeq } } : base;
  const offset =
    cursorSeq === undefined && filters.offset && filters.offset > 0
      ? Math.floor(filters.offset)
      : 0;
  return { base, paged, limit, offset };
}

/** The page of `rowsPlusOne` (at most `limit + 1` rows) with `total` matching entries. */
export function toAuditLogPage(
  rowsPlusOne: StoredAuditEntry[],
  total: number,
  limit: number,
): AuditLogPage {
  const hasMore = rowsPlusOne.length > limit;
  const rows = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1].seq : null;
  return { entries: rows.map(toAuditWireEntry), total, nextCursor };
}

/** The filter of one entry by id in the caller's chain, or `null` for an id that is not one. */
export function auditLogEntryFilter(
  tenantId: string | undefined,
  id: string,
): Record<string, unknown> | null {
  if (!OBJECT_ID_RE.test(id)) return null;
  return { _id: id, chainKey: auditChainKey(tenantId) };
}

/**
 * The export loop: hands each entry of `entries` (the export filter's entries by `seq`
 * descending) to `onEntry`, stopping when cancelled or past `maxRows` (a truncation only when at
 * least one more row exists).
 */
export async function streamAuditEntries(
  entries: AsyncIterable<StoredAuditEntry>,
  onEntry: (entry: AdminAuditLogEntry) => void | Promise<void>,
  options?: { isCancelled?: () => boolean; maxRows?: number },
): Promise<{ count: number; truncated: boolean }> {
  const isCancelled = options?.isCancelled;
  const maxRows = options?.maxRows;
  let count = 0;
  let truncated = false;
  for await (const doc of entries) {
    if (isCancelled?.()) {
      break;
    }
    if (maxRows != null && count >= maxRows) {
      /** The cap fired only because at least one more row exists beyond it,
       * so this is a genuine truncation — an exact-cap match exhausts the
       * cursor naturally and never reaches here. */
      truncated = true;
      break;
    }
    await onEntry(toAuditWireEntry(doc));
    count++;
  }
  return { count, truncated };
}

/**
 * Verifies the chain `chainKey` from `entries` (every entry of the chain by `seq` ascending):
 * contiguous sequence, hash links and entry hashes; a chain that does not start at seq 1 only
 * against a matching trusted checkpoint. Stops at the first failure, when cancelled, or past
 * `maxRows`.
 */
export async function verifyAuditChainEntries(
  chainKey: string,
  entries: AsyncIterable<StoredAuditEntry>,
  options?: VerifyAuditChainOptions,
): Promise<AuditChainVerification> {
  const trustedCheckpoint = options?.trustedCheckpoint;
  const isCancelled = options?.isCancelled;
  const maxRows = options?.maxRows;
  let prevHash = GENESIS_HASH;
  let expectedSeq: number | null = null;
  let firstSeq: number | null = null;
  let lastSeq = 0;
  let checked = 0;

  for await (const doc of entries) {
    if (isCancelled?.()) {
      return {
        ok: false,
        chainKey,
        checked,
        reason: 'verification cancelled',
        range: firstSeq !== null ? { firstSeq, lastSeq } : undefined,
      };
    }
    if (maxRows != null && checked >= maxRows) {
      return {
        ok: false,
        chainKey,
        checked,
        brokenAt: doc.seq,
        reason: `verification row limit exceeded (${maxRows})`,
        range: firstSeq !== null ? { firstSeq, lastSeq } : { firstSeq: doc.seq, lastSeq: doc.seq },
      };
    }
    if (firstSeq === null) {
      firstSeq = doc.seq;
      expectedSeq = doc.seq;
      /**
       * A non-genesis start (firstSeq > 1) means a prefix is gone. Only a
       * matching trusted checkpoint proves it was an authorized retention
       * purge; otherwise this is an attacker deleting the oldest rows, so we
       * must NOT silently trust the first row's prevHash.
       */
      if (doc.seq === 1) {
        prevHash = GENESIS_HASH;
      } else if (
        trustedCheckpoint &&
        trustedCheckpoint.throughSeq === doc.seq - 1 &&
        trustedCheckpoint.prevHash === doc.prevHash
      ) {
        prevHash = doc.prevHash;
      } else {
        return {
          ok: false,
          chainKey,
          checked,
          brokenAt: doc.seq,
          reason: trustedCheckpoint
            ? 'checkpoint mismatch: purged prefix does not match the trusted checkpoint'
            : `non-genesis start at seq ${doc.seq}: prefix purged or deleted (supply a trusted checkpoint to verify)`,
          range: { firstSeq, lastSeq: doc.seq },
        };
      }
    }
    if (doc.seq !== expectedSeq) {
      return {
        ok: false,
        chainKey,
        checked,
        brokenAt: expectedSeq ?? doc.seq,
        reason: `sequence gap: expected ${expectedSeq}, found ${doc.seq}`,
        range: { firstSeq, lastSeq },
      };
    }
    if (doc.prevHash !== prevHash) {
      return {
        ok: false,
        chainKey,
        checked,
        brokenAt: doc.seq,
        reason: 'broken hash link',
        range: { firstSeq, lastSeq },
      };
    }
    if (computeAuditEntryHash(doc) !== doc.hash) {
      return {
        ok: false,
        chainKey,
        checked,
        brokenAt: doc.seq,
        reason: 'hash mismatch',
        range: { firstSeq, lastSeq },
      };
    }
    prevHash = doc.hash;
    lastSeq = doc.seq;
    expectedSeq = doc.seq + 1;
    checked++;
  }

  return {
    ok: true,
    chainKey,
    checked,
    range: firstSeq !== null ? { firstSeq, lastSeq } : undefined,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Retention purge                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** The storage steps of a retention purge. */
export interface AuditPurgeSteps {
  /**
   * The first entry of `chainKey` by `seq` (with `createdAt` on or after `since`, when given), or
   * `null`.
   */
  findFirst(chainKey: string, since?: Date): Promise<{ seq: number; prevHash: string } | null>;
  /**
   * Deletes the entries of `chainKey` below `seq` (every entry when `undefined`), bypassing the
   * append-only guard; resolves how many went.
   */
  deletePrefix(chainKey: string, belowSeq: number | undefined): Promise<number>;
  /** Appends the purge's own entry (`recordAuditEntry`). */
  record(input: AuditEntryInput): Promise<unknown>;
}

/**
 * The retention purge: deletes the contiguous `seq` prefix older than `options.before`, audits
 * the purge, and returns the checkpoint `verifyAuditChain` needs to accept the new start.
 */
export async function purgeAuditLogOnSteps(
  tenantId: string | undefined,
  options: PurgeAuditLogOptions,
  steps: AuditPurgeSteps,
): Promise<PurgeAuditLogResult> {
  if (!options.confirm) return { deletedCount: 0 };
  if (!(options.before instanceof Date) || Number.isNaN(options.before.getTime())) {
    throw new Error('purgeAuditLogEntries: `before` must be a valid Date');
  }
  const chainKey = auditChainKey(tenantId);

  /**
   * Translate the date intent into a contiguous `seq` boundary before deleting.
   * `createdAt` is app-generated, so under multi-instance clock skew a later
   * `seq` can carry an earlier timestamp; a raw date delete could then remove
   * an interior row and permanently break verification. Instead, find the
   * earliest entry that must be retained (the first by `seq` whose `createdAt`
   * is on/after `before`) and delete only the strictly-lower `seq` prefix. This
   * never deletes past a retained entry, so the remaining chain stays
   * contiguous even with skew (it may retain a few old rows, which is safe).
   */
  const firstRetained = await steps.findFirst(chainKey, options.before);
  const deletedCount = await steps.deletePrefix(chainKey, firstRetained?.seq);

  logger.warn('[auditLog] retention purge executed', {
    chainKey,
    before: options.before.toISOString(),
    deletedCount,
  });

  /**
   * Only a purge that actually removed rows may mint a trust boundary. A no-op
   * purge returning a checkpoint for the current first entry would let a caller
   * legitimize a prefix this purge never authorized (e.g. one an attacker
   * deleted), so `verifyAuditChain` could be tricked into accepting it.
   */
  if (deletedCount === 0) {
    return { deletedCount: 0 };
  }

  const newFirst = await steps.findFirst(chainKey);

  /** The purge itself is audited after the checkpoint is read, so the new
   * entry cannot shift the boundary; a failed write is logged, not thrown. */
  try {
    await steps.record({
      action: 'audit.purged',
      severity: 'critical',
      actor: { type: 'system', name: 'audit-retention' },
      target: { type: 'audit_log' },
      metadata: {
        deletedCount,
        before: options.before.toISOString(),
        ...(newFirst ? { throughSeq: newFirst.seq - 1 } : {}),
      },
      tenantId,
    });
  } catch (err) {
    logger.error('[auditLog] failed to record retention purge', {
      chainKey,
      deletedCount,
      error: err instanceof Error ? err.name : 'unknown error',
    });
  }

  return {
    deletedCount,
    /** Boundary for `verifyAuditChain`: the new earliest entry resumes the
     * chain at `seq`, so the purged prefix ran through `seq - 1` and its last
     * hash is this entry's `prevHash`. Callers persist this to later prove the
     * purge was authorized. */
    checkpoint: newFirst
      ? { throughSeq: newFirst.seq - 1, prevHash: newFirst.prevHash }
      : undefined,
  };
}

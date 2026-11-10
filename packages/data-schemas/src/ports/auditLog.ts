/**
 * Audit log store port: the append-only, hash-chained record of privileged actions, one chain
 * per tenant plus the platform's. Nothing here may import `mongoose`. Signatures are those of
 * `AuditLogMethods` (`~/methods/auditLog`) with actor and target ids stated as `IdLike`;
 * `auditLog.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Every entry links to the previous entry of its chain (`seq`, `prevHash`) and carries a hash
 * of its canonical content, so a missing, reordered or altered entry fails `verifyAuditChain`.
 * Entries are never updated or deleted, except by a confirmed retention purge of the oldest
 * ones. Any store keeps that. Reads address the chain of `tenantId` (blank: the platform's).
 *
 * Known leak kept for now so callers stay unchanged: `IAuditLog` extends mongoose's `Document`
 * (its `_id` is an ObjectId).
 */
import type {
  AuditLogPage,
  AuditLogFilters,
  AuditActorInput,
  AuditTargetInput,
  AdminAuditLogEntry,
  AuditChainVerification,
  IAuditLog,
  PurgeAuditLogOptions,
  PurgeAuditLogResult,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
  VerifyAuditChainOptions,
} from '~/types';
import type { WithIdLike } from './common';
import { listPortMethods } from './common';

/** {@link RecordAuditEntryInput} with its actor and target ids stated as `IdLike`. */
export type AuditLogStoreEntryInput = Omit<RecordAuditEntryInput, 'actor' | 'target'> & {
  actor: WithIdLike<AuditActorInput, 'id'>;
  target: WithIdLike<AuditTargetInput, 'id'>;
};

export interface AuditLogStore {
  /**
   * Appends an entry to the chain of its tenant, retrying when a concurrent append takes its
   * `seq`. A failed write resolves `null` (logged), or throws with `failClosed`.
   */
  recordAuditEntry(
    input: AuditLogStoreEntryInput,
    options?: RecordAuditEntryOptions,
  ): Promise<IAuditLog | null>;
  /** A page of the chain's entries matching the filters, newest first, with their total. */
  listAuditLogPage(tenantId: string | undefined, filters: AuditLogFilters): Promise<AuditLogPage>;
  /** The chain's entry `id`, or `null`. */
  findAuditLogEntry(tenantId: string | undefined, id: string): Promise<AdminAuditLogEntry | null>;
  /**
   * Hands each of the chain's entries matching the filters to `onEntry`, newest first, until
   * `isCancelled` or `maxRows`; `truncated` when rows remained past `maxRows`.
   */
  streamAuditLogEntries(
    tenantId: string | undefined,
    filters: Omit<AuditLogFilters, 'offset' | 'limit' | 'cursor'>,
    onEntry: (entry: AdminAuditLogEntry) => void | Promise<void>,
    options?: { isCancelled?: () => boolean; maxRows?: number },
  ): Promise<{ count: number; truncated: boolean }>;
  /**
   * Recomputes the chain from its first entry and reports the first break. A chain that no
   * longer starts at `seq` 1 verifies only from a trusted checkpoint.
   */
  verifyAuditChain(
    tenantId: string | undefined,
    options?: VerifyAuditChainOptions,
  ): Promise<AuditChainVerification>;
  /**
   * With `confirm`, deletes the chain's oldest entries up to the first created at or after
   * `before`, so the chain stays contiguous; a purge that removed entries resolves the
   * checkpoint verification needs from then on.
   */
  purgeAuditLogEntries(
    tenantId: string | undefined,
    options: PurgeAuditLogOptions,
  ): Promise<PurgeAuditLogResult>;
}

/** Every method of {@link AuditLogStore}, for adapters and conformance checks. */
export const AUDIT_LOG_STORE_METHODS: ReadonlyArray<keyof AuditLogStore> =
  listPortMethods<AuditLogStore>({
    recordAuditEntry: true,
    listAuditLogPage: true,
    findAuditLogEntry: true,
    streamAuditLogEntries: true,
    verifyAuditChain: true,
    purgeAuditLogEntries: true,
  });

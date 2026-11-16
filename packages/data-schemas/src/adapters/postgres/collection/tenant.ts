/**
 * The collection primitive's binding of the engine-neutral tenant policy (`~/tenant/policy`;
 * docs/postgres-port/PHASE4.md §1.8), for the collections whose schemas carry the tenant-isolation
 * plugin. It makes the same decisions `models/plugins/tenantIsolation.ts` makes for mongoose. Must
 * not import `mongoose`, `mongodb` or `bson`.
 *
 * - Reads, counts, updates and deletes AND `tenantFilter(resolveTenantScope(...))` into their
 *   filter (a plain column predicate): the active tenant when scoped, nothing under the system
 *   sentinel or without a context (strict mode refuses the latter).
 * - Updates are sanitized (`sanitizeTenantMutation`, `guard`): outside the system scope a
 *   caller-supplied `tenantId` naming another tenant is refused, a matching one stripped; an update
 *   left empty matches nothing and never upserts.
 * - Inserts are stamped (`stampTenantOnDocument`).
 * - Merged reads draw from one partition: {@link tenantPartitionFilter}.
 */
import type { PgFilter, PgRecord } from './types';
import {
  tenantFilter,
  tenantPartition,
  currentTenantScope,
  resolveTenantScope,
  stampTenantOnDocument,
  sanitizeTenantMutation,
} from '~/tenant/policy';

/** `filter` restricted to the active tenant (as given when no restriction applies). */
export function scopeTenantFilter(operation: string, filter: PgFilter): PgFilter {
  const restriction = tenantFilter(resolveTenantScope(operation));
  if (!restriction) {
    return filter;
  }
  return Object.keys(filter).length === 0 ? restriction : { $and: [filter, restriction] };
}

/** The update to apply under the active scope; `null` when sanitizing emptied it. */
export function scopeTenantUpdate(update: PgRecord): PgRecord | null {
  const scope = currentTenantScope();
  if (scope.kind === 'system') {
    return update;
  }
  const result = sanitizeTenantMutation(scope, update, 'guard');
  return result.emptied ? null : result.update;
}

/** Stamps the active tenant onto a document being inserted (in place). */
export function stampTenant(operation: string, document: PgRecord): void {
  stampTenantOnDocument(resolveTenantScope(operation), document);
}

/** The filter of a single-partition read (see `tenantPartition`). */
export type TenantPartitionStoreFilter =
  | { tenantId: string }
  | { $or: [{ tenantId: { $exists: false } }, { tenantId: { $in: [null, ''] } }] };

/**
 * The filter of a read that merges several records into one answer: the active tenant's records
 * when scoped, otherwise only the tenantless ones (missing, `null` or `''`). Strict mode refuses a
 * read without a tenant context. The same filter as the mongoose binding's
 * `tenantPartitionFilter`.
 */
export function tenantPartitionFilter(operation: string): TenantPartitionStoreFilter {
  const tenantId = tenantPartition(resolveTenantScope(operation));
  if (tenantId != null) {
    return { tenantId };
  }
  return { $or: [{ tenantId: { $exists: false } }, { tenantId: { $in: [null, ''] } }] };
}

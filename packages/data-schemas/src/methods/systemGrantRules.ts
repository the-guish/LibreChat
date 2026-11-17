/**
 * The system grant rules every backend's `SystemGrantStore` shares (docs/postgres-port/PHASE4.md
 * §4, "Domain rules"): which capabilities satisfy a capability check (implications and config
 * sections), the grant scopes and tenant conditions of the reads, the principal conditions, the
 * listing limits and the scope key of the unique index. Filters are stated in the store query
 * language. Nothing here may import `mongoose`.
 */
import { PrincipalType } from 'librechat-data-provider';
import type { SystemCapability } from '~/types/admin';
import type { StoreFilter } from '~/ports/query';
import { SystemCapabilities, CapabilityImplications } from '~/admin/capabilities';

/**
 * Precomputed reverse map: for each capability, which broader capabilities imply it.
 * Built once at module load so `hasCapabilityForPrincipals` avoids O(N×M) per call.
 */
type BaseSystemCapability = (typeof SystemCapabilities)[keyof typeof SystemCapabilities];
const reverseImplications: Partial<Record<BaseSystemCapability, BaseSystemCapability[]>> = {};
for (const [broad, implied] of Object.entries(CapabilityImplications)) {
  for (const cap of implied as BaseSystemCapability[]) {
    (reverseImplications[cap] ??= []).push(broad as BaseSystemCapability);
  }
}

const baseCapabilityValues = new Set<string>(Object.values(SystemCapabilities));

/** The broader capabilities that imply `capability` (none for most). */
export function getImplyingCapabilities(capability: string): readonly string[] {
  return reverseImplications[capability as keyof typeof reverseImplications] ?? [];
}

/**
 * For a section/assignment capability like `manage:configs:endpoints` or
 * `assign:configs:user`, returns all capabilities that subsume it:
 * the direct parent (`manage:configs`), any base capability that implies
 * the parent via `reverseImplications` (`read:configs` is implied by
 * `manage:configs`, so `read:configs:endpoints` is satisfied by holding
 * `manage:configs`), and, for a `read:configs:<section>` capability, the
 * same-section `manage:configs:<section>` grant (manage implies read at
 * the section level too, mirroring the broad-level implication).
 */
export function getParentCapabilities(capability: string): string[] {
  const lastColon = capability.lastIndexOf(':');
  if (lastColon === -1) {
    return [];
  }
  const parent = capability.slice(0, lastColon);
  const parents: string[] = [];
  if (baseCapabilityValues.has(parent)) {
    parents.push(parent);
    const implied = reverseImplications[parent as keyof typeof reverseImplications];
    if (implied) {
      parents.push(...implied);
    }
  }
  if (parent === SystemCapabilities.READ_CONFIGS) {
    parents.push(`manage:configs:${capability.slice(lastColon + 1)}`);
  }
  return parents;
}

/** The capability condition of a check of `capability`: it, or any capability that implies it. */
export function capabilityCondition(capability: SystemCapability): string | { $in: string[] } {
  const allMatches = [
    capability,
    ...getImplyingCapabilities(capability),
    ...getParentCapabilities(capability),
  ];
  return allMatches.length > 1 ? { $in: allMatches } : capability;
}

/** Every capability whose grant satisfies one of `capabilities` (`getHeldCapabilities`' read). */
export function heldCapabilityCandidates(capabilities: readonly SystemCapability[]): string[] {
  return [
    ...new Set<string>([
      ...capabilities,
      ...capabilities.flatMap((cap) => getImplyingCapabilities(cap)),
      ...capabilities.flatMap(getParentCapabilities),
    ]),
  ];
}

/** The capabilities among `capabilities` that the `held` grants satisfy. */
export function resolveHeldCapabilities(
  capabilities: readonly SystemCapability[],
  held: ReadonlySet<string>,
): Set<SystemCapability> {
  const result = new Set<SystemCapability>();
  for (const cap of capabilities) {
    if (held.has(cap)) {
      result.add(cap);
      continue;
    }
    if (getImplyingCapabilities(cap).some((imp) => held.has(imp))) {
      result.add(cap);
      continue;
    }
    if (getParentCapabilities(cap).some((p) => held.has(p))) {
      result.add(cap);
    }
  }
  return result;
}

/** The capabilities a config read accepts: broad or per section, read or manage. */
export const CONFIG_READ_ACCESS_PATTERN: RegExp = /^(?:read|manage):configs(?::\w+)?$/;

/** The grants of exactly one scope: `tenantId`'s, or the platform-level ones without it. */
export function grantScope(tenantId?: string): StoreFilter {
  return tenantId != null ? { tenantId } : { tenantId: { $exists: false } };
}

/** The grants a read sees: with `tenantId`, that tenant's and the platform-level ones. */
export function tenantCondition(tenantId?: string): StoreFilter {
  return tenantId != null
    ? { $and: [{ $or: [{ tenantId }, { tenantId: { $exists: false } }] }] }
    : { tenantId: { $exists: false } };
}

/**
 * The principal conditions of a grant read: public principals and principals without an id are
 * skipped, and each id is normalized by the backend (`normalize`).
 */
export function grantPrincipalConditions<Id, Normalized>(
  principals: ReadonlyArray<{ principalType: PrincipalType; principalId?: Id }>,
  normalize: (principalId: Id, principalType: PrincipalType) => Normalized,
): Array<{ principalType: PrincipalType; principalId: Normalized }> {
  return principals
    .filter(
      (p): p is typeof p & { principalId: Id } =>
        p.principalType !== PrincipalType.PUBLIC && p.principalId != null,
    )
    .map((p) => ({
      principalType: p.principalType,
      principalId: normalize(p.principalId, p.principalType),
    }));
}

export const GRANTS_DEFAULT_LIMIT = 50;
export const GRANTS_MAX_LIMIT = 200;

/** The page size of `listGrants`: 50 by default, held to 1..200. */
export function grantsPageLimit(limit?: number): number {
  return Math.min(GRANTS_MAX_LIMIT, Math.max(1, limit ?? GRANTS_DEFAULT_LIMIT));
}

/** The filter of `listGrants` and `countGrants`. */
export function grantListFilter(options?: {
  tenantId?: string;
  principalTypes?: PrincipalType[];
}): StoreFilter {
  return {
    ...(options?.principalTypes?.length && { principalType: { $in: options.principalTypes } }),
    ...tenantCondition(options?.tenantId),
  } as StoreFilter;
}

/** One grant per principal, capability and tenant scope (the unique index); platform-level is ''. */
export function grantScopeKey(grant: { capability: string; tenantId?: string | null }): string {
  return `${grant.tenantId ?? ''}\u0000${grant.capability}`;
}

/** How many times `seedSystemGrants` tries, and the delay before retry `attempt` (from 1). */
export const SEED_SYSTEM_GRANTS_ATTEMPTS = 3;
export function seedSystemGrantsRetryDelay(attempt: number): number {
  return 1000 * Math.pow(2, attempt - 1);
}

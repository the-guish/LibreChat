/**
 * System grant store port: the system capabilities (admin panel access, config management,
 * user and group administration, ...) granted to roles, groups and users, platform-wide or in
 * one tenant. Nothing here may import `mongoose`. Signatures are those of `SystemGrantMethods`
 * (`~/methods/systemGrant`) with principal ids stated as `IdLike`; `systemGrant.spec.ts` fails
 * the typecheck if the MongoDB methods stop satisfying them.
 *
 * A user or group principal is addressed by id (a string form must be a valid id, or the call
 * throws), a role by name; public principals hold no grants. A read with `tenantId` sees that
 * tenant's grants and the platform-level ones; without it, only the platform-level ones. A
 * capability check also accepts any capability that implies the one asked for (`manage`
 * implies `read`, a broad capability implies its sections).
 *
 * Sessions: `grantCapability` and `revokeCapability` also take an optional trailing MongoDB
 * `ClientSession`, and `deleteGrantsForPrincipal` a `session` option. No caller passes one, so the
 * port states them without it; a MongoDB method still satisfies the narrower signature.
 *
 * Known leak kept for now so callers stay unchanged: `ISystemGrant` extends mongoose's
 * `Document` (its `_id` is an ObjectId), and `SystemGrantMove` holds `ISystemGrant`s.
 */
import type { PrincipalType } from 'librechat-data-provider';
import type { ISystemGrant, SystemGrantMove } from '~/types';
import type { SystemCapability } from '~/types/admin';
import type { IdLike } from './common';
import { listPortMethods } from './common';

/** A principal whose grants a read considers; public principals and missing ids are skipped. */
export interface SystemGrantStorePrincipal {
  principalType: PrincipalType;
  principalId?: IdLike;
}

export interface SystemGrantStore {
  /**
   * Grants the ADMIN role every system capability at platform level, leaving existing grants
   * unchanged; safe to run concurrently. Retries transient failures, then logs and resolves.
   */
  seedSystemGrants(): Promise<void>;
  /**
   * Grants the capability to the principal in one scope: `tenantId`'s, or without it platform
   * level. Insert-only: re-granting a held capability changes nothing (`grantedAt` and
   * `grantedBy` keep recording the original grant). Resolves to the grant and whether this call
   * created it; a concurrent grant of the same capability resolves `created: false`.
   */
  grantCapability(params: {
    principalType: PrincipalType;
    principalId: IdLike;
    capability: SystemCapability;
    tenantId?: string;
    grantedBy?: IdLike;
  }): Promise<{ grant: ISystemGrant | null; created: boolean }>;
  /**
   * Revokes the principal's grant of the capability in exactly one scope (`tenantId`'s, or
   * without it the platform-level one) and resolves how many grants it removed (0 or 1).
   */
  revokeCapability(params: {
    principalType: PrincipalType;
    principalId: IdLike;
    capability: SystemCapability;
    tenantId?: string;
  }): Promise<{ deletedCount: number }>;
  /** Whether any of the principals holds the capability or one that implies it. */
  hasCapabilityForPrincipals(params: {
    principals: SystemGrantStorePrincipal[];
    capability: SystemCapability;
    tenantId?: string;
  }): Promise<boolean>;
  /** Whether any of the principals holds some config-read capability, broad or per section. */
  hasAnyConfigReadAccess(params: {
    principals: SystemGrantStorePrincipal[];
    tenantId?: string;
  }): Promise<boolean>;
  /** The capabilities among `capabilities` that any of the principals holds or holds by implication. */
  getHeldCapabilities(params: {
    principals: SystemGrantStorePrincipal[];
    capabilities: SystemCapability[];
    tenantId?: string;
  }): Promise<Set<SystemCapability>>;
  /**
   * A page of the grants visible in the scope, optionally of the principal types only, ordered
   * by principal type then capability. `limit` defaults to 50 and is held to 1..200.
   */
  listGrants(options?: {
    tenantId?: string;
    principalTypes?: PrincipalType[];
    limit?: number;
    offset?: number;
  }): Promise<ISystemGrant[]>;
  /** How many grants `listGrants` would page through. */
  countGrants(options?: { tenantId?: string; principalTypes?: PrincipalType[] }): Promise<number>;
  /** Every grant the principal holds that is visible in the scope. */
  getCapabilitiesForPrincipal(params: {
    principalType: PrincipalType;
    principalId: IdLike;
    tenantId?: string;
  }): Promise<ISystemGrant[]>;
  /** Every grant any of the principals holds that is visible in the scope. */
  getCapabilitiesForPrincipals(params: {
    principals: Array<{ principalType: PrincipalType; principalId: IdLike }>;
    tenantId?: string;
  }): Promise<ISystemGrant[]>;
  /**
   * The principal's grants of exactly one scope: `tenantId`'s, or without it the platform-level
   * ones (the grants a principal's deletion removes).
   */
  findGrantsForPrincipal(
    principalType: PrincipalType,
    principalId: IdLike,
    options?: { tenantId?: string },
  ): Promise<ISystemGrant[]>;
  /**
   * Removes the principal's grants of exactly one scope (as `findGrantsForPrincipal`) and
   * resolves to them as they were, so a cascade can audit each removal.
   */
  deleteGrantsForPrincipal(
    principalType: PrincipalType,
    principalId: IdLike,
    options?: { tenantId?: string },
  ): Promise<ISystemGrant[]>;
  /**
   * Re-keys a principal's grants of one scope (as `findGrantsForPrincipal`) to another id of the
   * same type (a role rename). A grant the target already holds in the same scope is removed
   * from the source instead. Resolves to what changed, as it was before: the grants re-keyed
   * and the superseded grants whose removal was confirmed. A move that fails part-way is undone
   * before the error is rethrown.
   */
  moveGrantsToPrincipal(
    principalType: PrincipalType,
    fromPrincipalId: IdLike,
    toPrincipalId: IdLike,
    options?: { tenantId?: string },
  ): Promise<SystemGrantMove>;
  /**
   * Undoes a `moveGrantsToPrincipal`, and only what it changed: each re-keyed grant goes back
   * while it is still on the target, and each superseded grant is re-created while the target
   * still holds the grant that superseded it.
   */
  restoreMovedGrants(
    principalType: PrincipalType,
    fromPrincipalId: IdLike,
    toPrincipalId: IdLike,
    move: SystemGrantMove,
  ): Promise<void>;
}

/** Every method of {@link SystemGrantStore}, for adapters and conformance checks. */
export const SYSTEM_GRANT_STORE_METHODS: ReadonlyArray<keyof SystemGrantStore> =
  listPortMethods<SystemGrantStore>({
    seedSystemGrants: true,
    grantCapability: true,
    revokeCapability: true,
    hasCapabilityForPrincipals: true,
    hasAnyConfigReadAccess: true,
    getHeldCapabilities: true,
    listGrants: true,
    countGrants: true,
    getCapabilitiesForPrincipal: true,
    getCapabilitiesForPrincipals: true,
    findGrantsForPrincipal: true,
    deleteGrantsForPrincipal: true,
    moveGrantsToPrincipal: true,
    restoreMovedGrants: true,
  });

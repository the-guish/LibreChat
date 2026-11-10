/**
 * ACL entry store port: the permission bits principals (users, groups, roles, the public) hold
 * on resources (agents, prompt groups, MCP servers, ...), and the reads permission checks and
 * cascades make of them. Nothing here may import `mongoose`. Signatures are those of
 * `AclEntryMethods` (`~/methods/aclEntry`) with ids stated as `IdLike`; `aclEntry.spec.ts` fails
 * the typecheck if the MongoDB methods stop satisfying them.
 *
 * A permission check matches when an entry's bits include every required bit. A public
 * principal is matched by type alone; the others by type and id. Resource ids come back as the
 * ids the store generated.
 *
 * Not in this port, because their signatures take a session (one callers pass, or one ahead of
 * other parameters), a raw MongoDB filter, bulk-write operations or a pipeline:
 * `findEntriesByPrincipalsAndResource`, `grantPermission`, `modifyPermissionBits`,
 * `deleteAclEntries`, `replaceRoleBits`, `bulkWriteAclEntries` and `aggregateAclEntries`.
 *
 * Sessions: `findEntriesByResource` also takes an optional trailing MongoDB `ClientSession`. No
 * caller passes one, so the port states it without it; a MongoDB method still satisfies the
 * narrower signature.
 *
 * Known leaks kept for now so callers stay unchanged: `IAclEntry` extends mongoose's `Document`
 * (its ids are ObjectIds), and the MongoDB adapter stores principal ids untyped (an ObjectId for
 * a user or group, the name for a role) and matches a principal id as given, without casting it.
 * Pass a user's or group's id as the id value the store handed out (as `getUserPrincipals`
 * returns it), not its string form; this holds for `principalsList`, `deletePrincipalAclEntries`
 * and `getSoleOwnedResourceIds`.
 */
import type { PrincipalType } from 'librechat-data-provider';
import type { IAclEntry } from '~/types';
import type { IdLike } from './common';
import { listPortMethods } from './common';

/** A principal whose entries a read considers; `principalId` is ignored for the public. */
export interface AclStorePrincipal {
  principalType: string;
  principalId?: IdLike;
}

export interface AclEntryStore {
  /** Every entry on the resource, of every principal. */
  findEntriesByResource(resourceType: string, resourceId: IdLike): Promise<IAclEntry[]>;
  /** Whether any of the principals holds every bit of `permissionBit` on the resource. */
  hasPermission(
    principalsList: AclStorePrincipal[],
    resourceType: string,
    resourceId: IdLike,
    permissionBit: number,
  ): Promise<boolean>;
  /** The union of the bits the principals hold on the resource; 0 when they hold none. */
  getEffectivePermissions(
    principalsList: AclStorePrincipal[],
    resourceType: string,
    resourceId: IdLike,
  ): Promise<number>;
  /**
   * The union of the bits the principals hold on each of the resources, keyed by the
   * stringified resource id; a resource on which they hold nothing is absent.
   */
  getEffectivePermissionsForResources(
    principalsList: AclStorePrincipal[],
    resourceType: string,
    resourceIds: IdLike[],
  ): Promise<Map<string, number>>;
  /**
   * The ids of the resources of the type on which any of the principals holds every bit of
   * `requiredPermBit`, each once. With `resourceIds`, only those are considered (an empty
   * array matches nothing). With `readPrimary`, the read must see every committed write (no
   * lagging replica), for results that will be cached.
   */
  findAccessibleResources(
    principalsList: AclStorePrincipal[],
    resourceType: string,
    requiredPermBit: number,
    resourceIds?: IdLike[],
    readPrimary?: boolean,
  ): Promise<IdLike[]>;
  /**
   * Removes every entry the principal holds. A role, keyed by a name every tenant reuses, loses
   * only its entries in the caller's tenant partition: the active tenant's, or outside a tenant
   * only platform-level ones.
   */
  deletePrincipalAclEntries(principal: {
    principalType: PrincipalType;
    principalId: IdLike;
  }): Promise<void>;
  /**
   * Re-keys a principal's entries in the caller's tenant partition to another id (a role
   * rename) and resolves to the ids of the entries it moved; with `ids`, moves only those (how
   * a caller undoes a move). Entries keep their identity and bits. A move that fails part-way
   * is undone before the error is rethrown.
   */
  moveAclEntriesToPrincipal(
    principalType: PrincipalType,
    fromPrincipalId: string,
    toPrincipalId: string,
    options?: { ids?: readonly string[] },
  ): Promise<string[]>;
  /**
   * The ids of the resources of the type on which the public holds every bit of
   * `requiredPermissions`; `resourceIds` and `readPrimary` as for `findAccessibleResources`.
   */
  findPublicResourceIds(
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: IdLike[],
    readPrimary?: boolean,
  ): Promise<IdLike[]>;
  /**
   * The earliest user owner (every owner bit, by grant time, then creation, then id) of each of
   * the resources, both keyed and valued by stringified id. An id that is not one the store
   * generated, or a resource without a user owner, is absent.
   */
  getFirstOwnerIdsByResource(
    resourceType: string,
    resourceIds: IdLike[],
  ): Promise<Map<string, string>>;
  /**
   * The ids of the resources of the types on which the user holds DELETE and no other
   * principal does.
   */
  getSoleOwnedResourceIds(
    userObjectId: IdLike,
    resourceTypes: string | string[],
  ): Promise<IdLike[]>;
}

/** Every method of {@link AclEntryStore}, for adapters and conformance checks. */
export const ACL_ENTRY_STORE_METHODS: ReadonlyArray<keyof AclEntryStore> =
  listPortMethods<AclEntryStore>({
    findEntriesByResource: true,
    hasPermission: true,
    getEffectivePermissions: true,
    getEffectivePermissionsForResources: true,
    findAccessibleResources: true,
    deletePrincipalAclEntries: true,
    moveAclEntriesToPrincipal: true,
    findPublicResourceIds: true,
    getFirstOwnerIdsByResource: true,
    getSoleOwnedResourceIds: true,
  });

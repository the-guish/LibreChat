/**
 * ACL entry store port: the permission bits principals (users, groups, roles, the public) hold
 * on resources (agents, prompt groups, MCP servers, ...), and the reads permission checks and
 * cascades make of them. Nothing here may import `mongoose`. Signatures are those of
 * `AclEntryMethods` (`~/methods/aclEntry`) with ids stated as `IdLike`, sessions as
 * `StoreTransaction` and the driver's results as neutral counts; `aclEntry.spec.ts` fails the
 * typecheck if the MongoDB methods stop satisfying them.
 *
 * A permission check matches when an entry's bits include every required bit. A public
 * principal is matched by type alone; the others by type and id. Resource ids come back as the
 * ids the store generated.
 *
 * Criteria and changes callers pass (`deleteAclEntries`, `replaceRoleBits`,
 * `bulkWriteAclEntries`) are stated in the store query language (`./query`).
 *
 * Not in this port: `aggregateAclEntries`, which takes a MongoDB aggregation pipeline. Its two
 * former callers' `$lookup` pipelines are stated here as named reads, which those callers now
 * use: `listResourcePermissionPrincipals` (the permissions controller's `getResourcePermissions`)
 * and `listUserPermissionHolders` (`enrichRemoteAgentPrincipals` in `packages/api`). No
 * production code calls `aggregateAclEntries` any more.
 *
 * The named reads join other records to entries (access roles, users, groups); the MongoDB
 * adapter does it with `$lookup` stages, another adapter is free to use joins. Their rows carry
 * the joined user and group records whole (`AclJoinedPrincipalRecord`): every stored field,
 * hidden ones included, from any tenant (only the entries are scoped to the active tenant), so
 * the caller picks the fields it shows and checks the record's tenant. Rows come in no
 * particular order (MongoDB returns them in the order its match yields them); callers that need
 * one sort them.
 *
 * Transactions: the methods that take a `session` (a parameter, or a key of their options) join
 * the {@link StoreTransaction} it names, one that `DataStore.transactions.transaction` handed
 * out; without one, each write commits on its own. A read made in a transaction sees the
 * transaction's own writes, and one made outside it, when asked to or before a guarded write,
 * comes from the write authority (no lagging replica).
 *
 * Known leaks kept for now so callers stay unchanged: `IAclEntry` extends mongoose's `Document`
 * (its ids are ObjectIds), the named reads' rows type their ids (entry, user or group principal,
 * joined record) as ObjectIds, and the MongoDB adapter stores principal ids untyped (an ObjectId
 * for a user or group, the name for a role) and matches a principal id as given, without casting
 * it.
 * Pass a user's or group's id as the id value the store handed out (as `getUserPrincipals`
 * returns it), not its string form; this holds for `principalsList`, `deletePrincipalAclEntries`
 * and `getSoleOwnedResourceIds`.
 */
import type { PrincipalType } from 'librechat-data-provider';
import type { IdLike, DeleteCount, UpdateCount, BulkWriteCount, StoreTransaction } from './common';
import type { AclResourcePermissionPrincipal, AclUserPermissionHolder, IAclEntry } from '~/types';
import type { StoreFieldValues, StoreFilter, StoreUpdateOperators } from './query';
import { listPortMethods } from './common';

/** A principal whose entries a read considers; `principalId` is ignored for the public. */
export interface AclStorePrincipal {
  principalType: string;
  principalId?: IdLike;
}

/**
 * One principal's role replacement on a resource, for `replaceRoleBits`: `filter` names the
 * principal's entry (by identity only, never by permission bits), `insert` holds the identity
 * fields an entry created for it gets, `roleBits` the requested role's bits (only the role bits
 * of it are written) and `metadata` the fields written together with the bits.
 */
export interface AclRoleBitsStoreWrite {
  filter: StoreFilter;
  insert: StoreFieldValues;
  roleBits: number;
  metadata: StoreFieldValues;
}

/** One write of `bulkWriteAclEntries`: an update of the first, or of every, matching entry. */
export type AclEntryStoreBulkWrite =
  | { updateOne: AclEntryStoreBulkUpdate }
  | { updateMany: AclEntryStoreBulkUpdate };

/**
 * The entries an update of `bulkWriteAclEntries` changes, how, and whether it may insert one. An
 * entry is a flat record, so the update takes the field operators of the store query language
 * only (`$set`, `$unset`, `$setOnInsert`), never plain fields or array operators.
 */
export interface AclEntryStoreBulkUpdate {
  filter: StoreFilter;
  update: Pick<StoreUpdateOperators, '$set' | '$unset' | '$setOnInsert'>;
  /** Inserts an entry built from the filter's equalities and the update when none matches. */
  upsert?: boolean;
}

export interface AclEntryStore {
  /** Every entry on the resource, of every principal. */
  findEntriesByResource(
    resourceType: string,
    resourceId: IdLike,
    session?: StoreTransaction,
  ): Promise<IAclEntry[]>;
  /**
   * The entries the principals hold on the resource (a public principal by type alone). With
   * `readPrimary` and no transaction, the read sees every committed write.
   */
  findEntriesByPrincipalsAndResource(
    principalsList: AclStorePrincipal[],
    resourceType: string,
    resourceId: IdLike,
    session?: StoreTransaction,
    readPrimary?: boolean,
  ): Promise<IAclEntry[]>;
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
   * Sets the principal's bits on the resource to `permBits`, stamping the grant time and, when
   * given, `grantedBy`, `roleId` and `expiredAt` (other fields are kept), and resolves to the
   * entry as written; creates the entry when the principal has none. `principalId` is ignored
   * (and may be `null`) for the public principal; a user's or group's id given as a string is
   * stored as the id it names.
   */
  grantPermission(
    principalType: string,
    principalId: IdLike | null,
    resourceType: string,
    resourceId: IdLike,
    permBits: number,
    grantedBy?: IdLike,
    session?: StoreTransaction,
    roleId?: IdLike,
    expiredAt?: Date,
  ): Promise<IAclEntry | null>;
  /**
   * Adds `addBits` to and then removes `removeBits` from the principal's bits on the resource,
   * with a write guarded by the bits it read (retried up to `maxAttempts` times, the configured
   * permission write bound by default, before it throws), and resolves to the entry as written;
   * `null` when the principal holds no entry. Never creates one.
   */
  modifyPermissionBits(
    principalType: string,
    principalId: IdLike | null,
    resourceType: string,
    resourceId: IdLike,
    addBits?: number | null,
    removeBits?: number | null,
    session?: StoreTransaction,
    maxAttempts?: number,
  ): Promise<IAclEntry | null>;
  /**
   * Removes every entry matching the filter. The criteria are matched as given: principal ids
   * are not cast (see the known leaks above).
   */
  deleteAclEntries(
    filter: StoreFilter,
    options?: { session?: StoreTransaction },
  ): Promise<DeleteCount>;
  /**
   * Sets the expiry of every entry on the resource, of every principal: to `expiredAt` when it is
   * a `Date`, otherwise removes it (the entries no longer expire).
   */
  setResourceEntriesExpiration(
    resourceType: string,
    resourceId: IdLike,
    expiredAt: Date | null,
  ): Promise<UpdateCount>;
  /**
   * Replaces the role bits of each principal's entries (every entry its filter matches, each
   * once, with a write guarded by what it read) and keeps the other bits; a principal without
   * an entry gets one with only the role bits. Resolves to the indexes of the writes that
   * created their entry. Writes are applied in order and one by one: a failure leaves the
   * earlier ones applied unless a transaction rolls them back, and the rethrown error carries
   * `completedEntries` and `transactional`.
   */
  replaceRoleBits(
    writes: AclRoleBitsStoreWrite[],
    options?: { session?: StoreTransaction; maxAttempts?: number },
  ): Promise<{ upsertedWrites: Set<number> }>;
  /**
   * Applies the updates, in order unless `ordered` is `false` (then a failing one does not stop
   * the others). Tenant ids in updates are ignored, and the active tenant's is added to every
   * filter and insert.
   */
  bulkWriteAclEntries(
    ops: AclEntryStoreBulkWrite[],
    options?: { session?: StoreTransaction; ordered?: boolean },
  ): Promise<BulkWriteCount>;
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
  /**
   * Every entry on the resource (of every principal type, the public included), one row each,
   * with the entry's id, `principalType`, `principalId` and `permBits` as stored, and:
   * - `accessRoleId`: the `accessRoleId` of the access role the entry's `roleId` names;
   * - `userInfo`: the user whose id is the entry's `principalId`;
   * - `groupInfo`: the group whose id is the entry's `principalId`.
   *
   * A field whose source is missing (no `principalId` or `roleId`, no such role, user or group)
   * is absent from the row, never `null`. Users and groups are looked up by id whatever the
   * entry's principal type; ids the store generates are never shared between a user and a
   * group, so an adapter may look users up for user entries and groups for group entries only.
   * Reads ACL entries, access roles, users and groups; joined records as described in the
   * header (whole, unscoped, unordered rows). A `resourceId` given as a stringified id matches
   * the resource with that id.
   */
  listResourcePermissionPrincipals(
    resourceType: string,
    resourceId: IdLike,
  ): Promise<AclResourcePermissionPrincipal[]>;
  /**
   * The user entries on the resource whose bits include every bit of `requiredPermBits` (a
   * `requiredPermBits` that is not an integer made of known permission bits matches nothing,
   * and so does a stored value above them), one row each, with the entry's id, its
   * `principalId` as stored and `userInfo`, the user whose id that is (absent, never `null`,
   * when there is none). Reads ACL entries and users; the joined record as described in the
   * header (whole, unscoped, unordered rows). A `resourceId` given as a stringified id matches
   * the resource with that id.
   */
  listUserPermissionHolders(
    resourceType: string,
    resourceId: IdLike,
    requiredPermBits: number,
  ): Promise<AclUserPermissionHolder[]>;
}

/** Every method of {@link AclEntryStore}, for adapters and conformance checks. */
export const ACL_ENTRY_STORE_METHODS: ReadonlyArray<keyof AclEntryStore> =
  listPortMethods<AclEntryStore>({
    findEntriesByResource: true,
    findEntriesByPrincipalsAndResource: true,
    hasPermission: true,
    getEffectivePermissions: true,
    getEffectivePermissionsForResources: true,
    grantPermission: true,
    modifyPermissionBits: true,
    findAccessibleResources: true,
    deleteAclEntries: true,
    setResourceEntriesExpiration: true,
    deletePrincipalAclEntries: true,
    replaceRoleBits: true,
    bulkWriteAclEntries: true,
    moveAclEntriesToPrincipal: true,
    findPublicResourceIds: true,
    getFirstOwnerIdsByResource: true,
    getSoleOwnedResourceIds: true,
    listResourcePermissionPrincipals: true,
    listUserPermissionHolders: true,
  });

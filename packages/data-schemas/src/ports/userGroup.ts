/**
 * User group store port: the groups users belong to (local groups and groups synced from an
 * identity provider such as Entra ID). Nothing here may import `mongoose`. Signatures are those
 * of `UserGroupMethods` (`~/methods/userGroup`) with ids stated as `IdLike`; `userGroup.spec.ts`
 * fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * A group's members are member keys (a user's external id when it has one, else the user id).
 * Every membership change drops the cached group memberships of the members it touched; any
 * store keeps that.
 *
 * Not in this port, because their signatures take a raw MongoDB filter or update
 * (`findGroupByQuery`, `updateGroupById`, `bulkUpdateGroups`) or a projection (`findGroupById`,
 * `findGroupByExternalId`). `calculateRelevanceScore` and `sortPrincipalsByRelevance` are pure
 * ranking helpers, not storage.
 *
 * Sessions: every method here but `removeUserFromAllGroups` and `updateGroupFieldsTracked` also
 * takes an optional trailing MongoDB `ClientSession`. No caller passes one (the Entra ID group
 * sync forwards a session slot to `findGroupsByExternalIds` and `upsertGroupByExternalId`, but
 * it is always `null`), so the port states them without it; a MongoDB method still satisfies the
 * narrower signature.
 *
 * Known leaks kept for now so callers stay unchanged: `IGroup` and `IUser` extend mongoose's
 * `Document` (their `_id` is an ObjectId), and `createGroup` and `upsertGroupByExternalId` take a
 * `Partial<IGroup>`.
 */
import type { PrincipalType, TPrincipalSearchResult } from 'librechat-data-provider';
import type { IGroup, IUser } from '~/types';
import type { IdLike } from './common';
import { listPortMethods } from './common';

/** Where a group comes from: created locally, or synced from Entra ID. */
export type UserGroupSource = 'entra' | 'local';

/** One of the principals a user acts as: themselves, their role, their groups, the public. */
export interface UserGroupStorePrincipal {
  principalType: PrincipalType;
  /** Absent for the public; a role's name; else the id the store generated. */
  principalId?: IdLike;
}

export interface UserGroupStore {
  /**
   * The groups of the source with any of the external ids, each read with only its
   * `idOnTheSource` (for telling which ids have no group yet). `source` defaults to `'entra'`.
   */
  findGroupsByExternalIds(idsOnTheSource: string[], source?: UserGroupSource): Promise<IGroup[]>;
  /**
   * Up to `limit` (default 20) groups matching `namePattern` by word prefix: each of its words
   * begins a word of the name or email. Only the source's groups when one is given; none when the
   * pattern has nothing to match.
   */
  findGroupsByNamePattern(
    namePattern: string,
    source?: UserGroupSource | null,
    limit?: number,
  ): Promise<IGroup[]>;
  /** Creates the group and resolves to it as stored. */
  createGroup(groupData: Partial<IGroup>): Promise<IGroup>;
  /**
   * Sets the fields on the group of the source with the external id, creating it when there is
   * none (safe against a concurrent create of the same group), and resolves to it as stored.
   */
  upsertGroupByExternalId(
    idOnTheSource: string,
    source: UserGroupSource,
    updateData: Partial<IGroup>,
  ): Promise<IGroup | null>;
  /**
   * Adds the user's member key to the group's members. Resolves to the user (only its id and
   * `idOnTheSource` are read), the group as it is after the call (`null` when there is no such
   * group) and whether this call added the member. Throws when there is no such user.
   */
  addUserToGroup(
    userId: IdLike,
    groupId: IdLike,
  ): Promise<{ user: IUser; group: IGroup | null; changed: boolean }>;
  /** Removes the user's member key from the group's members; resolves and throws as `addUserToGroup`. */
  removeUserFromGroup(
    userId: IdLike,
    groupId: IdLike,
  ): Promise<{ user: IUser; group: IGroup | null; changed: boolean }>;
  /** Removes `userId` from the members of every group that lists it. */
  removeUserFromAllGroups(userId: IdLike): Promise<void>;
  /**
   * Sets the given fields on the group and reports, from the write itself, whether any value
   * changed and which fields did; an empty `data` writes nothing. Resolves `null` when there is
   * no such group.
   */
  updateGroupFieldsTracked(
    groupId: IdLike,
    data: Partial<Pick<IGroup, 'name' | 'description' | 'email' | 'avatar'>>,
  ): Promise<{ group: IGroup; changed: boolean; changedFields: string[] } | null>;
  /**
   * The principals the user acts as, for permission checks: the user, their role (when set),
   * each group listing their member key, and the public, in that order. Pass `role` and
   * `idOnTheSource` when known to spare a read of the user; `null` means known to be absent,
   * and only `undefined` is looked up. Group memberships are read in the caller's tenant and may
   * be served from the membership cache. A `userId` string must be a valid id, or the call throws.
   */
  getUserPrincipals(params: {
    userId: IdLike;
    role?: string | null;
    idOnTheSource?: string | null;
  }): Promise<UserGroupStorePrincipal[]>;
  /**
   * Users and groups matching `searchPattern` by word prefix (as `findGroupsByNamePattern`),
   * and roles whose name contains it (case-insensitive), up to `limitPerType` (default 10) of
   * each type, unranked; only the types in `typeFilter` when one is given. None for a blank
   * pattern.
   */
  searchPrincipals(
    searchPattern: string,
    limitPerType?: number,
    typeFilter?: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null,
  ): Promise<TPrincipalSearchResult[]>;
  /**
   * A page of the groups, of the source and with `search` in the name, email or description
   * (case-insensitive) when given, ordered by name. `limit` defaults to 50, `offset` to 0.
   */
  listGroups(filter?: {
    source?: UserGroupSource;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<IGroup[]>;
  /** How many groups `listGroups` would page through. */
  countGroups(filter?: { source?: UserGroupSource; search?: string }): Promise<number>;
  /** Deletes the group and resolves to it as it was, or `null` when there is no such group. */
  deleteGroup(groupId: IdLike): Promise<IGroup | null>;
  /** Removes the member key from the group's members and resolves to the group as after the call. */
  removeMemberById(groupId: IdLike, memberId: string): Promise<IGroup | null>;
  /**
   * Removes the member key from the group's members, as is (no user is looked up). Resolves to
   * the group as it is after the call (`null` when there is no such group) and whether this call
   * removed the member.
   */
  removeMemberByIdTracked(
    groupId: IdLike,
    memberId: string,
  ): Promise<{ group: IGroup | null; changed: boolean }>;
}

/** Every method of {@link UserGroupStore}, for adapters and conformance checks. */
export const USER_GROUP_STORE_METHODS: ReadonlyArray<keyof UserGroupStore> =
  listPortMethods<UserGroupStore>({
    findGroupsByExternalIds: true,
    findGroupsByNamePattern: true,
    createGroup: true,
    upsertGroupByExternalId: true,
    addUserToGroup: true,
    removeUserFromGroup: true,
    removeUserFromAllGroups: true,
    updateGroupFieldsTracked: true,
    getUserPrincipals: true,
    searchPrincipals: true,
    listGroups: true,
    countGroups: true,
    deleteGroup: true,
    removeMemberById: true,
    removeMemberByIdTracked: true,
  });

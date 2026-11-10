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
 * Most group methods are not in this port yet: their signatures take a session (all of the
 * reads, creates and membership writes, `getUserPrincipals` included), a raw MongoDB filter or
 * update (`findGroupByQuery`, `updateGroupById`, `bulkUpdateGroups`) or a projection
 * (`findGroupById`, `findGroupByExternalId`). `calculateRelevanceScore` and
 * `sortPrincipalsByRelevance` are pure ranking helpers, not storage.
 *
 * Known leak kept for now so callers stay unchanged: `IGroup` extends mongoose's `Document`
 * (its `_id` is an ObjectId).
 */
import type { IdLike } from './common';
import type { IGroup } from '~/types';
import { listPortMethods } from './common';

export interface UserGroupStore {
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
}

/** Every method of {@link UserGroupStore}, for adapters and conformance checks. */
export const USER_GROUP_STORE_METHODS: ReadonlyArray<keyof UserGroupStore> =
  listPortMethods<UserGroupStore>({
    removeUserFromAllGroups: true,
    updateGroupFieldsTracked: true,
  });

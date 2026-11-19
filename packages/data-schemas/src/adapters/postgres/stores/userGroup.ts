/**
 * The PostgreSQL `UserGroupStore` (`~/ports/userGroup`): the groups on the `groups` table (member
 * keys as a `text[]` column, search tokens in element tables kept by the primitive's hooks) and
 * the principal reads over `users` and `roles`, through the collection primitive, with the
 * membership cache and search rules of `~/methods/userGroupRules`. The pure ranking helpers
 * (`calculateRelevanceScore`, `sortPrincipalsByRelevance`) are served too. Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * Membership changes match on the member key (`$ne` before `$addToSet`, the key before
 * `$pullAll`/`$pull`) in single-record guarded updates (§3.5), so a match is exactly one real
 * change even when identical requests overlap; the pre-image reads (`returnDocument: 'before'`)
 * name the members a wholesale write replaced. The port's methods take no transaction, so cache
 * invalidation runs right after each write. Ids are the store's hex strings, and group ids in
 * principals and in the cache are those strings.
 */
import { PrincipalType } from 'librechat-data-provider';
import type { TPrincipalSearchResult } from 'librechat-data-provider';
import type { UserGroupFactoryDeps } from '~/compose/types';
import type { UserGroupStore } from '~/ports/userGroup';
import type { PostgresStoreContext } from './context';
import type { IGroup, IUser } from '~/types';
import type { IdLike } from '~/ports/common';
import {
  roleSearchFilter,
  buildGroupListFilter,
  createMemberGroupsCache,
  calculateRelevanceScore,
  sortPrincipalsByRelevance,
  roleToTPrincipalSearchResult,
  PRINCIPAL_SEARCH_USER_FIELDS,
  collectMemberIdsFromGroupUpdate,
  userRecordToTPrincipalSearchResult,
  transformGroupToTPrincipalSearchResult,
} from '~/methods/userGroupRules';
import { buildUserSearchFilter, buildGroupSearchFilter } from '~/utils/search';
import { toIdColumn } from '../values';
import { asRecord } from './context';

/** The `userGroups` module: the store plus the pure ranking helpers. */
export type PostgresUserGroupModule = UserGroupStore & {
  calculateRelevanceScore: typeof calculateRelevanceScore;
  sortPrincipalsByRelevance: typeof sortPrincipalsByRelevance;
};

/** An id value (a hex string or an id object) as its string, as MongoDB's `toString()`. */
const idText = (id: IdLike): string => (typeof id === 'string' ? id : id.toHexString());

/** A store id value inside an update (an id object) as its hex; `undefined` for anything else. */
const idObjectString = (value: unknown): string | undefined =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { toHexString?: unknown }).toHexString === 'function'
    ? toIdColumn(value)
    : undefined;

export function createPostgresUserGroupStore(
  context: PostgresStoreContext,
  deps: UserGroupFactoryDeps = {},
): PostgresUserGroupModule {
  const groups = () => context.collections().collection('groups');
  const users = () => context.collections().collection('users');
  const roles = () => context.collections().collection('roles');
  const asGroup = (record: unknown) => record as IGroup | null;
  const asGroups = (records: unknown) => records as IGroup[];

  const memberGroupsCache = createMemberGroupsCache<string>(deps, {
    queryGroupIds: async (memberId) =>
      (await groups().find({ memberIds: memberId }, { projection: '_id' })).map((group) =>
        String(group._id),
      ),
    toGroupId: (groupId) => groupId,
  });
  const { invalidateMemberGroupsCache, clearMemberGroupsCache } = memberGroupsCache;

  async function findGroupById(groupId: IdLike, projection: Record<string, 0 | 1> = {}) {
    return asGroup(await groups().findOne({ _id: groupId }, { projection }));
  }

  async function findGroupByExternalId(
    idOnTheSource: string,
    source: 'entra' | 'local' = 'entra',
    projection: Record<string, 0 | 1> = {},
  ) {
    return asGroup(await groups().findOne({ idOnTheSource, source }, { projection }));
  }

  async function findGroupsByNamePattern(
    namePattern: string,
    source: 'entra' | 'local' | null = null,
    limit: number = 20,
  ): Promise<IGroup[]> {
    const filter = buildGroupSearchFilter(namePattern);
    if (!filter) {
      return [];
    }
    return asGroups(await groups().find({ ...filter, ...(source ? { source } : {}) }, { limit }));
  }

  /** The user a membership change names (its member key), or a thrown error. */
  async function memberOf(userId: IdLike): Promise<{ user: IUser; memberKey: string }> {
    const user = (await users().findOne(
      { _id: userId },
      { projection: 'idOnTheSource' },
    )) as IUser | null;
    if (!user) {
      throw new Error(`User not found: ${idText(userId)}`);
    }
    return { user, memberKey: user.idOnTheSource || idText(userId) };
  }

  async function removeMemberByIdTracked(groupId: IdLike, memberId: string) {
    const changedGroup = await groups().findOneAndUpdate(
      { _id: groupId, memberIds: memberId },
      { $pull: { memberIds: memberId } },
      { returnDocument: 'after' },
    );
    const group = asGroup(changedGroup ?? (await groups().findOne({ _id: groupId })));
    await invalidateMemberGroupsCache([memberId]);
    return { group, changed: changedGroup != null };
  }

  const store: PostgresUserGroupModule = {
    findGroupById,
    findGroupByExternalId,

    async findGroupByQuery(filter) {
      return asGroup(await groups().findOne(filter));
    },

    async updateGroupById(groupId, data) {
      if (data.memberIds === undefined) {
        return asGroup(
          await groups().findOneAndUpdate(
            { _id: groupId },
            { $set: data },
            { returnDocument: 'after' },
          ),
        );
      }
      /** The pre-image names the members replaced, so they are invalidated too. */
      const previous = asGroup(
        await groups().findOneAndUpdate(
          { _id: groupId },
          { $set: data },
          { returnDocument: 'before' },
        ),
      );
      const nextMemberIds = Array.isArray(data.memberIds)
        ? data.memberIds.flatMap((memberId) => {
            if (typeof memberId === 'string') {
              return [memberId];
            }
            const id = idObjectString(memberId);
            return id === undefined ? [] : [id];
          })
        : [];
      await invalidateMemberGroupsCache([...(previous?.memberIds ?? []), ...nextMemberIds]);
      return previous ? await findGroupById(groupId) : null;
    },

    async bulkUpdateGroups(filter, update) {
      const result = await groups().updateMany(filter, update);
      if (result.modifiedCount === 0 && result.upsertedCount === 0) {
        return result;
      }
      const { memberIds, indeterminate } = collectMemberIdsFromGroupUpdate(
        update as Record<string, unknown>,
        idObjectString,
      );
      if (indeterminate) {
        await clearMemberGroupsCache();
      } else if (memberIds.length > 0) {
        await invalidateMemberGroupsCache(memberIds);
      }
      return result;
    },

    async findGroupsByExternalIds(idsOnTheSource, source = 'entra') {
      return asGroups(
        await groups().find(
          { idOnTheSource: { $in: idsOnTheSource }, source },
          { projection: { idOnTheSource: 1, _id: 0 } },
        ),
      );
    },

    findGroupsByNamePattern,

    async createGroup(groupData) {
      const group = await groups().insertOne(asRecord(groupData));
      await invalidateMemberGroupsCache(groupData.memberIds ?? []);
      return group as unknown as IGroup;
    },

    async upsertGroupByExternalId(idOnTheSource, source, updateData) {
      const filter = { idOnTheSource, source };
      if (updateData.memberIds === undefined) {
        return asGroup(
          await groups().findOneAndUpdate(
            filter,
            { $set: asRecord(updateData) },
            { upsert: true, returnDocument: 'after' },
          ),
        );
      }
      /** The pre-image names members added concurrently before the `$set`, to invalidate them. */
      const previous = asGroup(
        await groups().findOneAndUpdate(
          filter,
          { $set: asRecord(updateData) },
          { upsert: true, returnDocument: 'before' },
        ),
      );
      await invalidateMemberGroupsCache([
        ...(previous?.memberIds ?? []),
        ...(updateData.memberIds ?? []),
      ]);
      return findGroupByExternalId(idOnTheSource, source);
    },

    async addUserToGroup(userId, groupId) {
      const { user, memberKey } = await memberOf(userId);
      /** Matches only while the member is absent: a match is exactly one real change. */
      const changedGroup = await groups().findOneAndUpdate(
        { _id: groupId, memberIds: { $ne: memberKey } },
        { $addToSet: { memberIds: memberKey } },
        { returnDocument: 'after' },
      );
      const group = asGroup(changedGroup ?? (await groups().findOne({ _id: groupId })));
      await invalidateMemberGroupsCache([memberKey]);
      return { user, group, changed: changedGroup != null };
    },

    async removeUserFromGroup(userId, groupId) {
      const { user, memberKey } = await memberOf(userId);
      const changedGroup = await groups().findOneAndUpdate(
        { _id: groupId, memberIds: memberKey },
        { $pullAll: { memberIds: [memberKey] } },
        { returnDocument: 'after' },
      );
      const group = asGroup(changedGroup ?? (await groups().findOne({ _id: groupId })));
      await invalidateMemberGroupsCache([memberKey]);
      return { user, group, changed: changedGroup != null };
    },

    async removeUserFromAllGroups(userId) {
      const memberKey = idText(userId);
      await groups().updateMany({ memberIds: memberKey }, { $pullAll: { memberIds: [memberKey] } });
      await invalidateMemberGroupsCache([memberKey]);
    },

    async updateGroupFieldsTracked(groupId, data) {
      const entries = Object.entries(data);
      const unchanged = async () => {
        const current = asGroup(await groups().findOne({ _id: groupId }));
        return current ? { group: current, changed: false, changedFields: [] as string[] } : null;
      };
      if (entries.length === 0) {
        return unchanged();
      }
      /** Matches only a group that differs; the pre-image names exactly the fields changed. */
      const previous = await groups().findOneAndUpdate(
        { _id: groupId, $or: entries.map(([key, value]) => ({ [key]: { $ne: value } })) },
        { $set: data },
        { returnDocument: 'before' },
      );
      if (!previous) {
        return unchanged();
      }
      const changedFields = entries
        .filter(([key, value]) => previous[key] !== value)
        .map(([key]) => key);
      const group = asGroup((await groups().findOne({ _id: groupId })) ?? previous) as IGroup;
      return { group, changed: true, changedFields };
    },

    async getUserPrincipals({ userId, role, idOnTheSource }) {
      /** A string `userId` must be a valid id (as MongoDB's ObjectId cast requires). */
      const userStoreId = toIdColumn(userId);
      const principals: Array<{ principalType: PrincipalType; principalId?: string }> = [
        { principalType: PrincipalType.USER, principalId: userStoreId },
      ];
      let userRole = role;
      let memberIdOnTheSource = idOnTheSource;
      /** Single fallback lookup, only for whichever identity fields the caller omitted. */
      if (userRole === undefined || memberIdOnTheSource === undefined) {
        const user = (await users().findOne(
          { _id: userStoreId },
          { projection: 'role idOnTheSource' },
        )) as Pick<IUser, 'role' | 'idOnTheSource'> | null;
        if (userRole === undefined) {
          userRole = user?.role;
        }
        if (memberIdOnTheSource === undefined) {
          memberIdOnTheSource = user?.idOnTheSource ?? null;
        }
      }
      if (userRole && userRole.trim()) {
        principals.push({ principalType: PrincipalType.ROLE, principalId: userRole });
      }
      /** `memberIds` stores `idOnTheSource` for external users, else the raw user id. */
      const memberId = memberIdOnTheSource || idText(userId);
      for (const groupId of await memberGroupsCache.getMemberGroupIds(memberId)) {
        principals.push({ principalType: PrincipalType.GROUP, principalId: groupId });
      }
      principals.push({ principalType: PrincipalType.PUBLIC });
      return principals;
    },

    async searchPrincipals(searchPattern, limitPerType = 10, typeFilter = null) {
      if (!searchPattern || searchPattern.trim().length === 0) {
        return [];
      }
      const trimmedPattern = searchPattern.trim();
      const searches: Array<Promise<TPrincipalSearchResult[]>> = [];
      const userFilter = buildUserSearchFilter(trimmedPattern);
      if (userFilter && (!typeFilter || typeFilter.includes(PrincipalType.USER))) {
        searches.push(
          users()
            .find(userFilter, { projection: PRINCIPAL_SEARCH_USER_FIELDS, limit: limitPerType })
            .then((found) => (found as unknown as IUser[]).map(userRecordToTPrincipalSearchResult)),
        );
      }
      if (!typeFilter || typeFilter.includes(PrincipalType.GROUP)) {
        searches.push(
          findGroupsByNamePattern(trimmedPattern, null, limitPerType).then((found) =>
            found.map(transformGroupToTPrincipalSearchResult),
          ),
        );
      }
      if (!typeFilter || typeFilter.includes(PrincipalType.ROLE)) {
        searches.push(
          roles()
            .find(roleSearchFilter(trimmedPattern), { projection: 'name', limit: limitPerType })
            .then((found) => (found as Array<{ name: string }>).map(roleToTPrincipalSearchResult)),
        );
      }
      return (await Promise.all(searches)).flat();
    },

    async listGroups(filter = {}) {
      return asGroups(
        await groups().find(buildGroupListFilter(filter), {
          sort: { name: 1 },
          skip: filter.offset ?? 0,
          limit: filter.limit ?? 50,
        }),
      );
    },

    async countGroups(filter = {}) {
      return groups().count(buildGroupListFilter(filter));
    },

    async deleteGroup(groupId) {
      const group = asGroup(await groups().findOneAndDelete({ _id: groupId }));
      await invalidateMemberGroupsCache(group?.memberIds ?? []);
      return group;
    },

    async removeMemberById(groupId, memberId) {
      return (await removeMemberByIdTracked(groupId, memberId)).group;
    },

    removeMemberByIdTracked,

    calculateRelevanceScore: (item, searchPattern) => calculateRelevanceScore(item, searchPattern),
    sortPrincipalsByRelevance: (results) => sortPrincipalsByRelevance(results),
  };
  return store;
}

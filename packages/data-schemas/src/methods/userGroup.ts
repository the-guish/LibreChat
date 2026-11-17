import { Types } from 'mongoose';
import { AsyncLocalStorage } from 'async_hooks';
import { PrincipalType } from 'librechat-data-provider';
import type { TPrincipalSearchResult } from 'librechat-data-provider';
import type { Model, ClientSession, FilterQuery } from 'mongoose';
import type { MemberGroupsCacheDeps } from './userGroupRules';
import type { IGroup, IRole, IUser } from '~/types';
import {
  roleSearchFilter,
  buildGroupListFilter,
  createMemberGroupsCache,
  calculateRelevanceScore as scorePrincipal,
  sortPrincipalsByRelevance as sortPrincipals,
  roleToTPrincipalSearchResult,
  PRINCIPAL_SEARCH_USER_FIELDS,
  userRecordToTPrincipalSearchResult,
  transformGroupToTPrincipalSearchResult,
  collectMemberIdsFromGroupUpdate as collectUpdatedMemberIds,
} from './userGroupRules';
import { buildUserSearchFilter, buildGroupSearchFilter } from '~/utils/search';

export type UserGroupDeps = MemberGroupsCacheDeps;

type DeferredInvalidation = {
  /** ALS snapshot (tenant scoping) captured where the mutation ran. */
  run: (invalidate: () => Promise<void>) => Promise<void>;
  invalidate: () => Promise<void>;
};

/** One queue and one set of lifecycle hooks per session, so many mutations in one
 * transaction cannot trip the emitter's max-listeners warning. */
const sessionInvalidations = new WeakMap<ClientSession, DeferredInvalidation[]>();
const hookedSessions = new WeakSet<ClientSession>();

async function drainSessionInvalidations(session: ClientSession): Promise<void> {
  const queue = sessionInvalidations.get(session);
  if (!queue) {
    return;
  }
  sessionInvalidations.delete(session);
  await Promise.all(queue.map((entry) => entry.run(entry.invalidate).catch(() => undefined)));
}

function hookSessionLifecycle(session: ClientSession): void {
  if (hookedSessions.has(session)) {
    return;
  }
  hookedSessions.add(session);

  const commitTransaction = session.commitTransaction.bind(session);
  session.commitTransaction = async (
    ...args: Parameters<ClientSession['commitTransaction']>
  ): Promise<void> => {
    await commitTransaction(...args);
    await drainSessionInvalidations(session);
  };

  const abortTransaction = session.abortTransaction.bind(session);
  session.abortTransaction = async (
    ...args: Parameters<ClientSession['abortTransaction']>
  ): Promise<void> => {
    try {
      await abortTransaction(...args);
    } finally {
      sessionInvalidations.delete(session);
    }
  };

  session.once('ended', () => {
    sessionInvalidations.delete(session);
  });
}

/**
 * Runs cache invalidation immediately, or defers it to commit for transactional
 * writes. Mid-transaction invalidation would let concurrent readers re-cache pre-commit
 * state with no later correction; deferring keeps the existing entry serving the
 * still-committed old memberships until the transaction commits. Aborts discard the queue.
 */
export function runAfterTransaction(
  session: ClientSession | undefined,
  invalidate: () => Promise<void>,
): Promise<void> {
  if (!session?.inTransaction()) {
    return invalidate();
  }
  const deferred: DeferredInvalidation = { run: AsyncLocalStorage.snapshot(), invalidate };
  const queue = sessionInvalidations.get(session);
  if (queue) {
    queue.push(deferred);
    return Promise.resolve();
  }
  const newQueue: DeferredInvalidation[] = [deferred];
  sessionInvalidations.set(session, newQueue);
  hookSessionLifecycle(session);
  return Promise.resolve();
}

export function createUserGroupMethods(
  mongoose: typeof import('mongoose'),
  deps: UserGroupDeps = {},
): {
  findGroupById: (
    groupId: string | Types.ObjectId,
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findGroupByExternalId: (
    idOnTheSource: string,
    source?: 'entra' | 'local',
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findGroupsByExternalIds: (
    idsOnTheSource: string[],
    source?: 'entra' | 'local',
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  findGroupsByNamePattern: (
    namePattern: string,
    source?: 'entra' | 'local' | null,
    limit?: number,
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  createGroup: (groupData: Partial<IGroup>, session?: ClientSession) => Promise<IGroup>;
  upsertGroupByExternalId: (
    idOnTheSource: string,
    source: 'entra' | 'local',
    updateData: Partial<IGroup>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  addUserToGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null; changed: boolean }>;
  removeUserFromGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null; changed: boolean }>;
  removeUserFromAllGroups: (userId: string | Types.ObjectId) => Promise<void>;
  findGroupByQuery: (
    filter: Record<string, unknown>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  /** Sets scalar fields and reports atomically whether any value actually changed. */
  updateGroupFieldsTracked: (
    groupId: string | Types.ObjectId,
    data: Partial<Pick<IGroup, 'name' | 'description' | 'email' | 'avatar'>>,
  ) => Promise<{ group: IGroup; changed: boolean; changedFields: string[] } | null>;
  updateGroupById: (
    groupId: string | Types.ObjectId,
    data: Record<string, unknown>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  bulkUpdateGroups: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
  ) => Promise<import('mongoose').UpdateWriteOpResult>;
  getUserPrincipals: (
    params: {
      userId: string | Types.ObjectId;
      role?: string | null;
      idOnTheSource?: string | null;
    },
    session?: ClientSession,
  ) => Promise<Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>>;
  searchPrincipals: (
    searchPattern: string,
    limitPerType?: number,
    typeFilter?: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null,
    session?: ClientSession,
  ) => Promise<TPrincipalSearchResult[]>;
  calculateRelevanceScore: (item: TPrincipalSearchResult, searchPattern: string) => number;
  sortPrincipalsByRelevance: <
    T extends { _searchScore?: number; type: string; name?: string; email?: string },
  >(
    results: T[],
  ) => T[];
  listGroups: (
    filter?: {
      source?: 'local' | 'entra';
      search?: string;
      limit?: number;
      offset?: number;
    },
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  countGroups: (
    filter?: { source?: 'local' | 'entra'; search?: string },
    session?: ClientSession,
  ) => Promise<number>;
  deleteGroup: (
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  removeMemberById: (
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  removeMemberByIdTracked: (
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ) => Promise<{ group: IGroup | null; changed: boolean }>;
} {
  async function queryGroupIds(
    memberId: string,
    session?: ClientSession,
    readPrimary = false,
  ): Promise<Types.ObjectId[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const groupsQuery = Group.find({ memberIds: memberId }, { _id: 1 });
    if (session) {
      groupsQuery.session(session);
    }
    if (readPrimary && !session) {
      /**
       * Cache builds must not capture a lagging secondary's pre-mutation state for the
       * full TTL (`secondaryPreferred` deployments); uncached reads keep the connection
       * default, where staleness is bounded by replication lag as before.
       */
      groupsQuery.read('primary');
    }
    const groups = await groupsQuery.lean<Array<Pick<IGroup, '_id'>>>();
    return groups.map((group) => group._id);
  }

  /** The membership cache (`./userGroupRules`) over the group reads above. */
  const memberGroupsCache = createMemberGroupsCache<Types.ObjectId>(deps, {
    queryGroupIds: (memberId, readPrimary) => queryGroupIds(memberId, undefined, readPrimary),
    toGroupId: (groupId) => new Types.ObjectId(groupId),
  });

  /**
   * Resolves group ids for a member key (`idOnTheSource` for external users, else the
   * raw user id), cached per member. Session-scoped reads bypass the cache entirely.
   */
  async function getMemberGroupIds(
    memberId: string,
    session?: ClientSession,
  ): Promise<Types.ObjectId[]> {
    if (session) {
      return queryGroupIds(memberId, session);
    }
    return memberGroupsCache.getMemberGroupIds(memberId);
  }

  const { invalidateMemberGroupsCache, clearMemberGroupsCache } = memberGroupsCache;

  /** A store id value (an ObjectId) as its string; `undefined` for anything else. */
  const objectIdString = (value: unknown): string | undefined =>
    value instanceof Types.ObjectId ? value.toString() : undefined;

  const collectMemberIdsFromGroupUpdate = (update: Record<string, unknown>) =>
    collectUpdatedMemberIds(update, objectIdString);

  /** Calculate relevance score for a search result (`./userGroupRules`). */
  function calculateRelevanceScore(item: TPrincipalSearchResult, searchPattern: string): number {
    return scorePrincipal(item, searchPattern);
  }

  /** Sort principals by relevance score and type priority (`./userGroupRules`). */
  function sortPrincipalsByRelevance<
    T extends { _searchScore?: number; type: string; name?: string; email?: string },
  >(results: T[]): T[] {
    return sortPrincipals(results);
  }

  /**
   * Find a group by its ID
   * @param groupId - The group ID
   * @param projection - Optional projection of fields to return
   * @param session - Optional MongoDB session for transactions
   * @returns The group document or null if not found
   */
  async function findGroupById(
    groupId: string | Types.ObjectId,
    projection: Record<string, 0 | 1> = {},
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.findOne({ _id: groupId }, projection);
    if (session) {
      query.session(session);
    }
    return await query.lean<IGroup>();
  }

  /**
   * Find a group by its external ID (e.g., Entra ID)
   * @param idOnTheSource - The external ID
   * @param source - The source ('entra' or 'local')
   * @param projection - Optional projection of fields to return
   * @param session - Optional MongoDB session for transactions
   * @returns The group document or null if not found
   */
  async function findGroupByExternalId(
    idOnTheSource: string,
    source: 'entra' | 'local' = 'entra',
    projection: Record<string, 0 | 1> = {},
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.findOne({ idOnTheSource, source }, projection);
    if (session) {
      query.session(session);
    }
    return await query.lean<IGroup>();
  }

  /**
   * Find multiple groups by their external IDs (e.g., Entra IDs) in a single query
   * @param idsOnTheSource - Array of external IDs
   * @param source - The source ('entra' or 'local')
   * @param session - Optional MongoDB session for transactions
   * @returns Array of group documents
   */
  async function findGroupsByExternalIds(
    idsOnTheSource: string[],
    source: 'entra' | 'local' = 'entra',
    session?: ClientSession,
  ): Promise<IGroup[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.find(
      { idOnTheSource: { $in: idsOnTheSource }, source },
      { idOnTheSource: 1, _id: 0 },
    );
    if (session) {
      query.session(session);
    }
    return await query.lean<IGroup[]>();
  }

  /**
   * Find groups by word prefix of name or email (see `buildGroupSearchFilter`)
   * @param namePattern - The name pattern to search for
   * @param source - Optional source filter ('entra', 'local', or null for all)
   * @param limit - Maximum number of results to return
   * @param session - Optional MongoDB session for transactions
   * @returns Array of matching groups
   */
  async function findGroupsByNamePattern(
    namePattern: string,
    source: 'entra' | 'local' | null = null,
    limit: number = 20,
    session?: ClientSession,
  ): Promise<IGroup[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const filter = buildGroupSearchFilter(namePattern);
    if (!filter) {
      return [];
    }
    const query: Record<string, unknown> = { ...filter };

    if (source) {
      query.source = source;
    }

    const dbQuery = Group.find(query).limit(limit);
    if (session) {
      dbQuery.session(session);
    }
    return await dbQuery.lean<IGroup[]>();
  }

  /**
   * Create a new group
   * @param groupData - Group data including name, source, and optional idOnTheSource
   * @param session - Optional MongoDB session for transactions
   * @returns The created group
   */
  async function createGroup(groupData: Partial<IGroup>, session?: ClientSession): Promise<IGroup> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = session ? { session } : {};
    const group = await Group.create([groupData], options).then((groups) => groups[0]);
    await runAfterTransaction(session, () =>
      invalidateMemberGroupsCache(groupData.memberIds ?? []),
    );
    return group;
  }

  /**
   * Update or create a group by external ID
   * @param idOnTheSource - The external ID
   * @param source - The source ('entra' or 'local')
   * @param updateData - Data to update or set if creating
   * @param session - Optional MongoDB session for transactions
   * @returns The updated or created group
   */
  async function upsertGroupByExternalId(
    idOnTheSource: string,
    source: 'entra' | 'local',
    updateData: Partial<IGroup>,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = {
      new: true,
      upsert: true,
      ...(session ? { session } : {}),
    };

    if (updateData.memberIds === undefined) {
      return await Group.findOneAndUpdate({ idOnTheSource, source }, { $set: updateData }, options);
    }
    /** Atomic pre-image (`new: false`) so members added concurrently before the $set are invalidated too. */
    const previous = await Group.findOneAndUpdate(
      { idOnTheSource, source },
      { $set: updateData },
      { ...options, new: false },
    ).lean<IGroup>();
    await runAfterTransaction(session, () =>
      invalidateMemberGroupsCache([
        ...(previous?.memberIds ?? []),
        ...(updateData.memberIds ?? []),
      ]),
    );
    return await findGroupByExternalId(idOnTheSource, source, {}, session);
  }

  /**
   * Add a user to a group
   * Only updates Group.memberIds (one-way relationship)
   * Note: memberIds stores idOnTheSource values, not ObjectIds
   *
   * @param userId - The user ID
   * @param groupId - The group ID to add
   * @param session - Optional MongoDB session for transactions
   * @returns The user and updated group documents
   */
  async function addUserToGroup(
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<{ user: IUser; group: IGroup | null; changed: boolean }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const options = { new: true, ...(session ? { session } : {}) };

    const user = await User.findById(userId, 'idOnTheSource', options).lean<{
      idOnTheSource?: string;
      _id: Types.ObjectId;
    }>();
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const userIdOnTheSource = user.idOnTheSource || userId.toString();
    /** The filter makes the update match only when the member is absent, so a match
     * is exactly one real change even when identical requests overlap. */
    const changedGroup = await Group.findOneAndUpdate(
      { _id: groupId, memberIds: { $ne: userIdOnTheSource } },
      { $addToSet: { memberIds: userIdOnTheSource } },
      options,
    ).lean<IGroup>();
    const updatedGroup =
      changedGroup ??
      (await Group.findById(groupId, null, session ? { session } : {}).lean<IGroup>());
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([userIdOnTheSource]));

    return { user: user as IUser, group: updatedGroup, changed: changedGroup != null };
  }

  /**
   * Remove a user from a group
   * Only updates Group.memberIds (one-way relationship)
   * Note: memberIds stores idOnTheSource values, not ObjectIds
   *
   * @param userId - The user ID
   * @param groupId - The group ID to remove
   * @param session - Optional MongoDB session for transactions
   * @returns The user and updated group documents
   */
  async function removeUserFromGroup(
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<{ user: IUser; group: IGroup | null; changed: boolean }> {
    const User = mongoose.models.User as Model<IUser>;
    const Group = mongoose.models.Group as Model<IGroup>;

    const options = { new: true, ...(session ? { session } : {}) };

    const user = await User.findById(userId, 'idOnTheSource', options).lean<{
      idOnTheSource?: string;
      _id: Types.ObjectId;
    }>();
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const userIdOnTheSource = user.idOnTheSource || userId.toString();
    const changedGroup = await Group.findOneAndUpdate(
      { _id: groupId, memberIds: userIdOnTheSource },
      { $pullAll: { memberIds: [userIdOnTheSource] } },
      options,
    ).lean<IGroup>();
    const updatedGroup =
      changedGroup ??
      (await Group.findById(groupId, null, session ? { session } : {}).lean<IGroup>());
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([userIdOnTheSource]));

    return { user: user as IUser, group: updatedGroup, changed: changedGroup != null };
  }

  /**
   * Get a list of all principal identifiers for a user (user ID + group IDs + public).
   * For use in permission checks.
   *
   * Tenant filtering for group memberships is handled automatically by the
   * `applyTenantIsolation` Mongoose plugin on the Group schema. The
   * `tenantContextMiddleware` (chained by `requireJwtAuth` after passport auth)
   * sets the ALS context, so the `memberIds` group query below is scoped to the
   * requesting tenant. No explicit tenantId parameter is needed.
   *
   * IMPORTANT: This relies on the ALS tenant context being active. If this
   * function is called outside a request context (e.g. startup, background jobs),
   * group queries will be unscoped. In strict mode, the Mongoose plugin will
   * reject such queries.
   *
   * Ref: #12091 (resolved by tenant context middleware in requireJwtAuth)
   *
   * Pass `role` and `idOnTheSource` from the already-loaded request user to skip
   * the fallback user lookup entirely, reducing the hot path to a single indexed,
   * `_id`-projected group query. `idOnTheSource: null` means "known to be absent"
   * (local user) and also avoids the lookup; only `undefined` triggers it.
   *
   * Group memberships are additionally cached per member key (USER_PRINCIPALS
   * namespace) when a cache is injected; membership mutations in this module
   * invalidate the affected keys. Role resolution is never cached.
   *
   * @param params - Parameters object
   * @param params.userId - The user ID
   * @param params.role - Optional user role (looked up when `undefined`)
   * @param params.idOnTheSource - Optional external member id (looked up when `undefined`)
   * @param session - Optional MongoDB session for transactions
   * @returns Array of principal objects with type and id
   */
  async function getUserPrincipals(
    params: {
      userId: string | Types.ObjectId;
      role?: string | null;
      idOnTheSource?: string | null;
    },
    session?: ClientSession,
  ): Promise<Array<{ principalType: PrincipalType; principalId?: string | Types.ObjectId }>> {
    const { userId, role, idOnTheSource } = params;
    /** `userId` must be an `ObjectId` for USER principal since ACL entries store `ObjectId`s */
    const userObjectId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const principals: Array<{
      principalType: PrincipalType;
      principalId?: string | Types.ObjectId;
    }> = [{ principalType: PrincipalType.USER, principalId: userObjectId }];

    let userRole = role;
    let memberIdOnTheSource = idOnTheSource;

    /** Single fallback lookup, only for whichever identity fields the caller omitted. */
    if (userRole === undefined || memberIdOnTheSource === undefined) {
      const User = mongoose.models.User as Model<IUser>;
      const query = User.findById(userId).select('role idOnTheSource');
      if (session) {
        query.session(session);
      }
      const user = await query.lean<Pick<IUser, 'role' | 'idOnTheSource'>>();
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
    const memberId = memberIdOnTheSource || userId.toString();
    const groupIds = await getMemberGroupIds(memberId, session);
    for (const groupId of groupIds) {
      principals.push({ principalType: PrincipalType.GROUP, principalId: groupId });
    }

    principals.push({ principalType: PrincipalType.PUBLIC });

    return principals;
  }

  /**
   * Search for principals: users and groups by word prefix (see `buildSearchTokenFilter`),
   * roles by name
   * Returns combined results in TPrincipalSearchResult format without sorting
   * @param searchPattern - The pattern to search for
   * @param limitPerType - Maximum number of results to return
   * @param typeFilter - Optional array of types to filter by, or null for all types
   * @param session - Optional MongoDB session for transactions
   * @returns Array of principals in TPrincipalSearchResult format
   */
  async function searchPrincipals(
    searchPattern: string,
    limitPerType: number = 10,
    typeFilter: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null = null,
    session?: ClientSession,
  ): Promise<TPrincipalSearchResult[]> {
    if (!searchPattern || searchPattern.trim().length === 0) {
      return [];
    }

    const trimmedPattern = searchPattern.trim();
    const promises: Promise<TPrincipalSearchResult[]>[] = [];

    const userFilter = buildUserSearchFilter(trimmedPattern);
    if (userFilter && (!typeFilter || typeFilter.includes(PrincipalType.USER))) {
      const User = mongoose.models.User as Model<IUser>;
      const userQuery = User.find(userFilter)
        .select(PRINCIPAL_SEARCH_USER_FIELDS)
        .limit(limitPerType);

      if (session) {
        userQuery.session(session);
      }

      promises.push(
        userQuery.lean<IUser[]>().then((users) => users.map(userRecordToTPrincipalSearchResult)),
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    if (!typeFilter || typeFilter.includes(PrincipalType.GROUP)) {
      promises.push(
        findGroupsByNamePattern(trimmedPattern, null, limitPerType, session).then((groups) =>
          groups.map(transformGroupToTPrincipalSearchResult),
        ),
      );
    } else {
      promises.push(Promise.resolve([]));
    }

    if (!typeFilter || typeFilter.includes(PrincipalType.ROLE)) {
      const Role = mongoose.models.Role as Model<IRole>;
      if (Role) {
        const roleQuery = Role.find(roleSearchFilter(trimmedPattern))
          .select('name')
          .limit(limitPerType);

        if (session) {
          roleQuery.session(session);
        }

        promises.push(
          roleQuery
            .lean<Array<{ name: string }>>()
            .then((roles) => roles.map(roleToTPrincipalSearchResult)),
        );
      }
    } else {
      promises.push(Promise.resolve([]));
    }

    const results = await Promise.all(promises);
    const combined = results.flat();
    return combined;
  }

  /**
   * Removes a user from all groups they belong to.
   * @param userId - The user ID (or ObjectId) of the member to remove
   */
  async function removeUserFromAllGroups(userId: string | Types.ObjectId): Promise<void> {
    const Group = mongoose.models.Group as Model<IGroup>;
    await Group.updateMany({ memberIds: userId }, { $pullAll: { memberIds: [userId] } });
    await invalidateMemberGroupsCache([userId]);
  }

  /**
   * Finds a single group matching the given filter.
   * @param filter - MongoDB filter query
   */
  async function findGroupByQuery(
    filter: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = Group.findOne(filter);
    if (session) {
      query.session(session);
    }
    return query.lean<IGroup>();
  }

  /**
   * Updates a group by its ID.
   * @param groupId - The group's ObjectId
   * @param data - Fields to set via $set
   */
  async function updateGroupFieldsTracked(
    groupId: string | Types.ObjectId,
    data: Partial<Pick<IGroup, 'name' | 'description' | 'email' | 'avatar'>>,
  ): Promise<{ group: IGroup; changed: boolean; changedFields: string[] } | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const entries = Object.entries(data);
    const unchanged = async () => {
      const current = await Group.findById(groupId).lean<IGroup>();
      return current ? { group: current, changed: false, changedFields: [] as string[] } : null;
    };
    if (entries.length === 0) {
      return unchanged();
    }
    /** The filter matches only a group that differs, and the pre-image names exactly the fields
     * this write changed, so overlapping identical requests record one change. */
    const previous = await Group.findOneAndUpdate(
      { _id: groupId, $or: entries.map(([key, value]) => ({ [key]: { $ne: value } })) },
      { $set: data },
      { new: false },
    ).lean<IGroup>();
    if (!previous) {
      return unchanged();
    }
    const changedFields = entries
      .filter(([key, value]) => (previous as unknown as Record<string, unknown>)[key] !== value)
      .map(([key]) => key);
    const group = (await Group.findById(groupId).lean<IGroup>()) ?? previous;
    return { group, changed: true, changedFields };
  }

  async function updateGroupById(
    groupId: string | Types.ObjectId,
    data: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = { new: true, ...(session ? { session } : {}) };
    if (data.memberIds === undefined) {
      return Group.findByIdAndUpdate(groupId, { $set: data }, options).lean<IGroup>();
    }
    /** Atomic pre-image (`new: false`) so members added concurrently before the $set are invalidated too. */
    const previous = await Group.findByIdAndUpdate(
      groupId,
      { $set: data },
      {
        ...options,
        new: false,
      },
    ).lean<IGroup>();
    const nextMemberIds = Array.isArray(data.memberIds)
      ? data.memberIds.filter(
          (memberId): memberId is string | Types.ObjectId =>
            typeof memberId === 'string' || memberId instanceof Types.ObjectId,
        )
      : [];
    await runAfterTransaction(session, () =>
      invalidateMemberGroupsCache([...(previous?.memberIds ?? []), ...nextMemberIds]),
    );
    return previous ? await findGroupById(groupId, {}, session) : null;
  }

  /**
   * Bulk-updates groups matching a filter.
   * @param filter - MongoDB filter query
   * @param update - Update operations
   * @param options - Optional query options (e.g., { session })
   */
  async function bulkUpdateGroups(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<import('mongoose').UpdateWriteOpResult> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const result = await Group.updateMany(filter, update, options || {});
    if (result.modifiedCount === 0 && result.upsertedCount === 0) {
      return result;
    }
    const { memberIds, indeterminate } = collectMemberIdsFromGroupUpdate(update);
    if (indeterminate) {
      await runAfterTransaction(options?.session, () => clearMemberGroupsCache());
    } else if (memberIds.length > 0) {
      await runAfterTransaction(options?.session, () => invalidateMemberGroupsCache(memberIds));
    }
    return result;
  }

  const buildGroupQuery = (filter: {
    source?: 'local' | 'entra';
    search?: string;
  }): FilterQuery<IGroup> => buildGroupListFilter(filter) as FilterQuery<IGroup>;

  /**
   * List groups with optional source, search, and pagination filters.
   * Results are sorted by name.
   * @param filter - Optional filter with source, search, limit, and offset fields
   * @param session - Optional MongoDB session for transactions
   */
  async function listGroups(
    filter: {
      source?: 'local' | 'entra';
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
    session?: ClientSession,
  ): Promise<IGroup[]> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = buildGroupQuery(filter);
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    return await Group.find(query)
      .sort({ name: 1 })
      .skip(offset)
      .limit(limit)
      .session(session ?? null)
      .lean<IGroup[]>();
  }

  /**
   * Count groups matching optional source and search filters.
   * @param filter - Optional filter with source and search fields
   * @param session - Optional MongoDB session for transactions
   */
  async function countGroups(
    filter: { source?: 'local' | 'entra'; search?: string } = {},
    session?: ClientSession,
  ): Promise<number> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const query = buildGroupQuery(filter);
    return await Group.countDocuments(query).session(session ?? null);
  }

  /**
   * Delete a group by its ID.
   * @param groupId - The group's ObjectId
   * @param session - Optional MongoDB session for transactions
   */
  async function deleteGroup(
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = session ? { session } : {};
    const group = await Group.findByIdAndDelete(groupId, options).lean<IGroup>();
    await runAfterTransaction(session, () => invalidateMemberGroupsCache(group?.memberIds ?? []));
    return group;
  }

  /**
   * Remove a member from a group by raw memberId string ($pull from memberIds).
   * Unlike removeUserFromGroup, this does not look up the user first.
   * @param groupId - The group's ObjectId
   * @param memberId - The raw memberId string to remove (ObjectId or idOnTheSource)
   * @param session - Optional MongoDB session for transactions
   */
  async function removeMemberByIdTracked(
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ): Promise<{ group: IGroup | null; changed: boolean }> {
    const Group = mongoose.models.Group as Model<IGroup>;
    const options = { new: true, ...(session ? { session } : {}) };
    const changedGroup = await Group.findOneAndUpdate(
      { _id: groupId, memberIds: memberId },
      { $pull: { memberIds: memberId } },
      options,
    ).lean<IGroup>();
    const group =
      changedGroup ??
      (await Group.findById(groupId, null, session ? { session } : {}).lean<IGroup>());
    await runAfterTransaction(session, () => invalidateMemberGroupsCache([memberId]));
    return { group, changed: changedGroup != null };
  }

  async function removeMemberById(
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ): Promise<IGroup | null> {
    return (await removeMemberByIdTracked(groupId, memberId, session)).group;
  }

  return {
    findGroupById,
    findGroupByExternalId,
    findGroupsByExternalIds,
    findGroupsByNamePattern,
    createGroup,
    upsertGroupByExternalId,
    addUserToGroup,
    removeUserFromGroup,
    removeUserFromAllGroups,
    findGroupByQuery,
    updateGroupById,
    updateGroupFieldsTracked,
    bulkUpdateGroups,
    getUserPrincipals,
    searchPrincipals,
    calculateRelevanceScore,
    sortPrincipalsByRelevance,
    listGroups,
    countGroups,
    deleteGroup,
    removeMemberById,
    removeMemberByIdTracked,
  };
}

export type UserGroupMethods = ReturnType<typeof createUserGroupMethods>;

/**
 * The user group rules every backend's `UserGroupStore` shares (docs/postgres-port/PHASE4.md §4,
 * "Domain rules"): the per-member cache of group memberships (`getUserPrincipals`' hot path) with
 * its build deduplication and invalidation, which member keys an update touches, the principal
 * search result shapes and their ranking, and the group listing filter. Nothing here may import
 * `mongoose`: each backend supplies the membership read and its id type.
 */
import { CacheKeys, PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { TPrincipalSearchResult } from 'librechat-data-provider';
import type { CacheStore, IGroup, IUser } from '~/types';
import type { StoreFilter } from '~/ports/query';
import { isValidObjectIdString } from '~/utils/objectId';
import { scopedCacheKey } from '~/config/tenantContext';
import { scoreSearchMatch } from '~/utils/search';
import { escapeRegExp } from '~/utils/string';

/** What the membership cache is built with (the `userGroups` module's dependencies). */
export interface MemberGroupsCacheDeps {
  /** Returns the USER_PRINCIPALS cache store when principal caching is enabled. */
  getCache?: (key: string) => CacheStore | undefined;
  /** Notified after membership caches are invalidated (dependent access caches). */
  onMemberGroupsInvalidated?: () => void | Promise<void>;
}

/** The storage steps of the membership cache, in the backend's id type `Id`. */
export interface MemberGroupsCacheSteps<Id> {
  /**
   * The ids of the groups listing `memberId` (in the caller's tenant). `readPrimary`: the read
   * fills the cache, so it must see every committed write (no lagging replica).
   */
  queryGroupIds(memberId: string, readPrimary: boolean): Promise<Id[]>;
  /** A cached group id (24-hex) as the id the store hands out. */
  toGroupId(hex: string): Id;
}

/** The membership cache of one `userGroups` module instance. */
export interface MemberGroupsCache<Id> {
  /**
   * The group ids of a member key (`idOnTheSource` for external users, else the raw user id),
   * cached per member; `bypassCache` reads the store directly (a read inside a transaction).
   */
  getMemberGroupIds(memberId: string, options?: { bypassCache?: boolean }): Promise<Id[]>;
  /** Drops the cached memberships of the member keys (base and tenant-scoped variants). */
  invalidateMemberGroupsCache(
    memberIds: ReadonlyArray<{ toString(): string } | undefined | null>,
  ): Promise<void>;
  /** Clears the whole membership cache (when the affected members cannot be enumerated). */
  clearMemberGroupsCache(): Promise<void>;
}

type PendingGroupLookup = { promise: Promise<unknown[]>; markStale: () => void };

/** Same-process dedup of concurrent cache builds, keyed by scoped member cache key. */
const pendingGroupLookups = new Map<string, PendingGroupLookup>();
const GROUP_LOCK_POLL_MS = 50;
/** Above this many member keys, invalidation clears the namespace instead of fanning out deletes. */
const INVALIDATION_CLEAR_THRESHOLD = 1000;
/** Fallback delay for the second invalidation pass when the store sets none. */
const DEFAULT_STALE_EVICTION_DELAY_MS = 3000;

const isCachedGroupId = (value: unknown): value is string =>
  typeof value === 'string' && isValidObjectIdString(value);

/** The membership cache over `steps`, with the module's dependencies. */
export function createMemberGroupsCache<Id extends { toString(): string }>(
  deps: MemberGroupsCacheDeps,
  steps: MemberGroupsCacheSteps<Id>,
): MemberGroupsCache<Id> {
  const getPrincipalsCache = (): CacheStore | undefined =>
    deps.getCache?.(CacheKeys.USER_PRINCIPALS);

  async function readCachedGroupIds(
    cache: CacheStore,
    cacheKey: string,
  ): Promise<Id[] | undefined> {
    try {
      const cached = await cache.get(cacheKey);
      if (Array.isArray(cached) && cached.every(isCachedGroupId)) {
        return cached.map((groupId) => steps.toGroupId(groupId));
      }
    } catch {
      /** Cache failures must not block permission checks. */
    }
    return undefined;
  }

  /**
   * Resolves group ids for a member key (`idOnTheSource` for external users, else the
   * raw user id), cached per member. Concurrent same-process misses share one build;
   * Redis-backed stores also dedupe cross-process builds via a short-lived lock.
   * Session-scoped reads bypass the cache entirely.
   */
  async function getMemberGroupIds(
    memberId: string,
    options: { bypassCache?: boolean } = {},
  ): Promise<Id[]> {
    const cache = options.bypassCache ? undefined : getPrincipalsCache();
    if (!cache) {
      return steps.queryGroupIds(memberId, false);
    }

    const cacheKey = scopedCacheKey(memberId);
    const fastPath = await readCachedGroupIds(cache, cacheKey);
    if (fastPath) {
      return fastPath;
    }

    const pending = pendingGroupLookups.get(cacheKey);
    if (pending) {
      return pending.promise as Promise<Id[]>;
    }

    /** Invalidation flips this so an in-flight build skips its now-stale cache write. */
    let stale = false;
    /**
     * The `_LOCK` prefix keeps raw lock keys disjoint from Keyv data keys
     * (always `USER_PRINCIPALS:<key>`), even for member ids ending in `:lock`.
     */
    const lockKey = `${CacheKeys.USER_PRINCIPALS}_LOCK:${cacheKey}`;
    const lookup = (async (): Promise<Id[]> => {
      let lockToken: string | null | undefined;
      try {
        if (cache.acquireLock) {
          let lockFailed = false;
          try {
            lockToken = await cache.acquireLock(lockKey);
          } catch {
            lockFailed = true;
          }
          if (!lockToken && !lockFailed) {
            const waitUntil = Date.now() + Math.max(cache.lockWaitMs ?? 0, 0);
            while (Date.now() < waitUntil) {
              await new Promise((resolve) => setTimeout(resolve, GROUP_LOCK_POLL_MS));
              const cached = await readCachedGroupIds(cache, cacheKey);
              if (cached) {
                return cached;
              }
              /**
               * Re-attempt the lock each tick: a holder whose write was invalidated away
               * (or that crashed) never fills the key, so take over the build as soon as
               * the lock frees instead of sleeping out the full wait budget.
               */
              try {
                lockToken = await cache.acquireLock(lockKey);
              } catch {
                break;
              }
              if (lockToken) {
                break;
              }
            }
          }
          if (lockToken) {
            /** Another process may have filled the key between the fast-path miss and the lock. */
            const cached = await readCachedGroupIds(cache, cacheKey);
            if (cached) {
              return cached;
            }
          }
        }

        const groupIds = await steps.queryGroupIds(memberId, true);
        if (!stale) {
          try {
            await cache.set(
              cacheKey,
              groupIds.map((groupId) => groupId.toString()),
            );
          } catch {
            /** Cache failures must not block permission checks. */
          }
        }
        return groupIds;
      } finally {
        if (lockToken) {
          try {
            await cache.releaseLock?.(lockKey, lockToken);
          } catch {
            /** Lock cleanup failures expire via the lock TTL. */
          }
        }
      }
    })();

    /**
     * Registered synchronously (no await between the pending check and this set) so every
     * concurrent same-process caller attaches to this single flow instead of starting its own.
     */
    pendingGroupLookups.set(cacheKey, {
      promise: lookup,
      markStale: () => {
        stale = true;
      },
    });
    try {
      return await lookup;
    } finally {
      if (pendingGroupLookups.get(cacheKey)?.promise === lookup) {
        pendingGroupLookups.delete(cacheKey);
      }
    }
  }

  async function dropMemberKeys(cache: CacheStore, cacheKeys: Set<string>): Promise<void> {
    for (const cacheKey of cacheKeys) {
      const pending = pendingGroupLookups.get(cacheKey);
      if (pending) {
        pending.markStale();
        pendingGroupLookups.delete(cacheKey);
      }
    }
    try {
      await Promise.all([...cacheKeys].map((cacheKey) => cache.delete?.(cacheKey)));
    } catch {
      /** Cache failures must not block membership updates. */
    }
  }

  /**
   * Cross-process builds cannot see this process's stale flags, so a build in another
   * container that read pre-mutation state can re-cache it after the first delete.
   * A delayed second pass evicts such rewrites on stores shared across processes,
   * independent of build locking; the store supplies the delay budget.
   */
  function scheduleSecondInvalidation(cache: CacheStore, secondPass: () => Promise<void>): void {
    if (!cache.crossProcess) {
      return;
    }
    const graceMs = Math.max(cache.staleEvictionDelayMs ?? DEFAULT_STALE_EVICTION_DELAY_MS, 0);
    const timer = setTimeout(() => {
      secondPass().catch(() => undefined);
    }, graceMs);
    timer.unref?.();
  }

  /**
   * Notifies dependent access caches after memberships have been evicted, never
   * before: a dependent rebuild that runs first would read the stale membership
   * and cache its derived IDs under the freshly bumped generation, surviving
   * the membership eviction that should have prevented them.
   */
  const notifyMemberGroupsInvalidated = async (): Promise<void> => {
    try {
      await deps.onMemberGroupsInvalidated?.();
    } catch {
      /** Dependent cache invalidation must not block membership updates. */
    }
  };

  /**
   * Drops cached group memberships for the given member keys (both base and
   * tenant-scoped variants) after a membership mutation. In-flight builds are
   * marked stale (skipping their cache write) and unregistered so later reads
   * start a fresh build instead of joining a pre-mutation one. Failures are
   * non-fatal; the cache TTL bounds any residual staleness (e.g. mutations
   * running under a different tenant context than the member's reads).
   */
  async function invalidateMemberGroupsCache(
    memberIds: ReadonlyArray<{ toString(): string } | undefined | null>,
  ): Promise<void> {
    const cache = getPrincipalsCache();
    if (!cache?.delete) {
      await notifyMemberGroupsInvalidated();
      return;
    }
    const cacheKeys = new Set<string>();
    for (const memberId of memberIds) {
      if (!memberId) {
        continue;
      }
      const baseKey = memberId.toString();
      cacheKeys.add(baseKey);
      cacheKeys.add(scopedCacheKey(baseKey));
    }
    if (cacheKeys.size === 0) {
      return;
    }
    if (cacheKeys.size > INVALIDATION_CLEAR_THRESHOLD && cache.clear) {
      return clearMemberGroupsCache();
    }
    const evict = async (): Promise<void> => {
      await dropMemberKeys(cache, cacheKeys);
      await notifyMemberGroupsInvalidated();
    };
    await evict();
    scheduleSecondInvalidation(cache, evict);
  }

  /** Clears the whole membership cache when affected members cannot be enumerated. */
  async function clearMemberGroupsCache(): Promise<void> {
    const cache = getPrincipalsCache();
    if (!cache?.clear) {
      await notifyMemberGroupsInvalidated();
      return;
    }
    const clearAll = async (): Promise<void> => {
      for (const pending of pendingGroupLookups.values()) {
        pending.markStale();
      }
      pendingGroupLookups.clear();
      try {
        await cache.clear?.();
      } catch {
        /** Cache failures must not block membership updates. */
      }
      await notifyMemberGroupsInvalidated();
    };
    await clearAll();
    scheduleSecondInvalidation(cache, clearAll);
  }

  return { getMemberGroupIds, invalidateMemberGroupsCache, clearMemberGroupsCache };
}

/**
 * Extracts member ids referenced by a group update; indeterminate when they cannot be
 * enumerated. `idString` names a store id value (the backend's id type) as its string, and is
 * `undefined` for anything else.
 */
export function collectMemberIdsFromGroupUpdate(
  update: Record<string, unknown>,
  idString: (value: unknown) => string | undefined,
): {
  memberIds: string[];
  indeterminate: boolean;
} {
  if (Array.isArray(update)) {
    /** Aggregation-pipeline updates: affected members cannot be statically enumerated. */
    return { memberIds: [], indeterminate: true };
  }
  const memberIds: string[] = [];

  const collect = (value: unknown): boolean => {
    if (typeof value === 'string') {
      memberIds.push(value);
      return true;
    }
    const id = idString(value);
    if (id !== undefined) {
      memberIds.push(id);
      return true;
    }
    if (Array.isArray(value)) {
      return value.every(collect);
    }
    if (value !== null && typeof value === 'object') {
      const modifiers = value as { $each?: unknown; $in?: unknown };
      if (Array.isArray(modifiers.$each)) {
        return modifiers.$each.every(collect);
      }
      if (Array.isArray(modifiers.$in)) {
        return modifiers.$in.every(collect);
      }
    }
    return false;
  };

  let indeterminate = false;
  for (const [operator, operand] of Object.entries(update)) {
    const touchesMembers =
      operator === 'memberIds' ||
      (operand !== null &&
        typeof operand === 'object' &&
        'memberIds' in (operand as Record<string, unknown>));
    if (!touchesMembers) {
      continue;
    }
    if (operator === '$addToSet' || operator === '$push' || operator === '$pull') {
      indeterminate = !collect((operand as Record<string, unknown>).memberIds) || indeterminate;
    } else if (operator === '$pullAll') {
      const values = (operand as Record<string, unknown>).memberIds;
      indeterminate = !Array.isArray(values) || !values.every(collect) || indeterminate;
    } else {
      /** Wholesale replacement ($set, $unset, direct assignment): affected members are unknown. */
      indeterminate = true;
    }
  }

  return { memberIds, indeterminate };
}

/**
 * Calculate relevance score for a search result
 * @param item - The search result item
 * @param searchPattern - The search pattern
 * @returns Relevance score (0-100)
 */
export function calculateRelevanceScore(
  item: TPrincipalSearchResult,
  searchPattern: string,
): number {
  /** The fields each search matches on; a group's description is not one of them */
  const values =
    item.type === PrincipalType.USER
      ? [item.name, item.email, item.username]
      : [item.name, item.email];
  return scoreSearchMatch(values, searchPattern);
}

/**
 * Sort principals by relevance score and type priority
 * @param results - Array of results with _searchScore property
 * @returns Sorted array
 */
export function sortPrincipalsByRelevance<
  T extends { _searchScore?: number; type: string; name?: string; email?: string },
>(results: T[]): T[] {
  return results.sort((a, b) => {
    if (b._searchScore !== a._searchScore) {
      return (b._searchScore || 0) - (a._searchScore || 0);
    }
    if (a.type !== b.type) {
      return a.type === PrincipalType.USER ? -1 : 1;
    }
    const aName = a.name || a.email || '';
    const bName = b.name || b.email || '';
    return aName.localeCompare(bName);
  });
}

/** The user fields `searchPrincipals` reads. */
export const PRINCIPAL_SEARCH_USER_FIELDS =
  'name email username avatar provider idOnTheSource role';

/**
 * Transform user object to TPrincipalSearchResult format
 * @param user - User object from database
 * @returns Transformed user result
 */
export function transformUserToTPrincipalSearchResult(
  user: Pick<
    IUser,
    'id' | 'name' | 'email' | 'username' | 'avatar' | 'provider' | 'idOnTheSource' | 'role'
  >,
): TPrincipalSearchResult {
  return {
    id: user.id,
    type: PrincipalType.USER,
    name: user.name || user.email,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    provider: user.provider,
    source: 'local',
    idOnTheSource: user.idOnTheSource || user.id,
    isAdmin: user.role === SystemRoles.ADMIN,
  };
}

/** A user record `searchPrincipals` read, as a search result. */
export function userRecordToTPrincipalSearchResult(user: IUser): TPrincipalSearchResult {
  return transformUserToTPrincipalSearchResult({
    id: user._id?.toString() || '',
    name: user.name,
    email: user.email,
    username: user.username,
    avatar: user.avatar,
    provider: user.provider,
    idOnTheSource: user.idOnTheSource,
    role: user.role,
  });
}

/**
 * Transform group object to TPrincipalSearchResult format
 * @param group - Group object from database
 * @returns Transformed group result
 */
export function transformGroupToTPrincipalSearchResult(group: IGroup): TPrincipalSearchResult {
  return {
    id: group._id?.toString(),
    type: PrincipalType.GROUP,
    name: group.name,
    email: group.email,
    avatar: group.avatar,
    description: group.description,
    source: group.source || 'local',
    memberCount: group.memberIds ? group.memberIds.length : 0,
    idOnTheSource: group.idOnTheSource || group._id?.toString(),
  };
}

/** The roles `searchPrincipals` finds for a trimmed pattern: names containing it, any case. */
export function roleSearchFilter(trimmedPattern: string): StoreFilter {
  return { name: new RegExp(escapeRegExp(trimmedPattern), 'i') };
}

/** A role record `searchPrincipals` read, as a search result. */
export function roleToTPrincipalSearchResult(role: { name: string }): TPrincipalSearchResult {
  return {
    /** Role name as ID */
    id: role.name,
    type: PrincipalType.ROLE,
    name: role.name,
    source: 'local' as const,
    idOnTheSource: role.name,
    isAdmin: role.name === SystemRoles.ADMIN,
  };
}

/** The filter of `listGroups` and `countGroups`. */
export function buildGroupListFilter(filter: {
  source?: 'local' | 'entra';
  search?: string;
}): StoreFilter {
  const query: Record<string, unknown> = {};
  if (filter.source) {
    query.source = filter.source;
  }
  if (filter.search) {
    const regex = new RegExp(escapeRegExp(filter.search), 'i');
    query.$or = [{ name: regex }, { email: regex }, { description: regex }];
  }
  return query as StoreFilter;
}

/**
 * The prompt library's domain rules, shared by the MongoDB methods (`./prompt`) and the
 * PostgreSQL store (`adapters/postgres/stores/prompt.ts`; docs/postgres-port/PHASE4.md §8, S8):
 * the listing criteria (the system categories, the escaped name search), the page and limit
 * rules, the keyset cursor over use count, update time and id, the shape of a listing page, and
 * the per-user prompt group access sets with their tenant-generation cache. Nothing here may
 * import `mongoose` or the MongoDB driver: ids are whatever the backend hands out (`Id`), revived
 * from the cache's hex strings by the backend's `reviveId`.
 */
import { randomUUID } from 'crypto';
import {
  CacheKeys,
  PermissionBits,
  ResourceType,
  SystemCategories,
  Time,
} from 'librechat-data-provider';
import type { CacheStore } from '~/types';
import { isValidObjectIdString } from '~/utils/objectId';
import { scopedCacheKey } from '~/config/tenantContext';
import { escapeRegExp } from '~/utils/string';
import logger from '~/config/winston';

/** The fields `getAllPromptGroups` selects. */
export const PROMPT_GROUP_ALL_LIST_FIELDS =
  'name numberOfGenerations oneliner category author authorName createdAt updatedAt command productionId source sourcePromptName sourceProjectId sourceDestination';

/** The fields `getPromptGroups` and `getListPromptGroupsByAccess` select. */
export const PROMPT_GROUP_LIST_FIELDS =
  'name numberOfGenerations oneliner category productionId author authorName createdAt updatedAt command source sourcePromptName sourceProjectId sourceDestination';

/** The order of every group listing: most used first, then most recently updated, then by id. */
export const PROMPT_GROUP_LIST_SORT = { numberOfGenerations: -1, updatedAt: -1, _id: 1 } as const;

/**
 * Turns the unscoped listings' criteria into a filter, in place: `name` becomes a
 * case-insensitive substring match with its special characters taken literally; the system
 * categories `MY_PROMPTS` and `SHARED_PROMPTS` (or none) select every category and `NO_CATEGORY`
 * the groups without one.
 */
export function applyPromptGroupListCriteria(
  query: Record<string, unknown>,
  name: string | undefined,
): Record<string, unknown> {
  if (name) {
    query.name = new RegExp(escapeRegExp(name), 'i');
  }
  if (!query.category) {
    delete query.category;
  } else if (query.category === SystemCategories.MY_PROMPTS) {
    delete query.category;
  } else if (query.category === SystemCategories.NO_CATEGORY) {
    query.category = '';
  } else if (query.category === SystemCategories.SHARED_PROMPTS) {
    delete query.category;
  }
  return query;
}

/** The page `getPromptGroups` reads: page numbers and sizes below one read as one. */
export function promptGroupPage(
  pageNumber: number | string,
  pageSize: number | string,
): { pageNumber: number; pageSize: number; skip: number; limit: number } {
  const validatedPageNumber = Math.max(parseInt(String(pageNumber), 10), 1);
  const validatedPageSize = Math.max(parseInt(String(pageSize), 10), 1);
  return {
    pageNumber: validatedPageNumber,
    pageSize: validatedPageSize,
    skip: (validatedPageNumber - 1) * validatedPageSize,
    limit: validatedPageSize,
  };
}

/** The page size of `getListPromptGroupsByAccess`: 1 to 100 (20 when unparsable), or none. */
export function promptGroupListLimit(limit: unknown): number | null {
  const isPaginated = limit !== null && limit !== undefined;
  return isPaginated ? Math.min(Math.max(1, parseInt(String(limit)) || 20), 100) : null;
}

/** A position in the access listing's order, as its cursor carries it. */
export interface PromptGroupCursor {
  numberOfGenerations: number;
  updatedAt: string;
  _id: string;
}

/**
 * The cursor `after` names, or `null` (logging a warning) when it is missing, legacy or
 * malformed: the listing then reads its first page.
 */
export function parsePromptGroupCursor(after: unknown): PromptGroupCursor | null {
  if (!after || typeof after !== 'string' || after === 'undefined' || after === 'null') {
    return null;
  }
  try {
    const cursor = JSON.parse(Buffer.from(after, 'base64').toString('utf8'));
    const { numberOfGenerations = 0, updatedAt, _id } = cursor;
    if (
      typeof numberOfGenerations !== 'number' ||
      !Number.isFinite(numberOfGenerations) ||
      typeof updatedAt !== 'string' ||
      Number.isNaN(new Date(updatedAt).getTime()) ||
      typeof _id !== 'string' ||
      !isValidObjectIdString(_id)
    ) {
      logger.warn('[getListPromptGroupsByAccess] Invalid cursor fields, skipping cursor condition');
      return null;
    }
    return { numberOfGenerations, updatedAt, _id };
  } catch (error) {
    logger.warn('Invalid cursor:', (error as Error).message);
    return null;
  }
}

/** The groups after `cursor` in the listing's order, with its id given as the backend's id. */
export function promptGroupCursorCondition<Id>(
  cursor: PromptGroupCursor,
  toId: (hex: string) => Id,
): Record<string, unknown> {
  const { numberOfGenerations, updatedAt, _id } = cursor;
  return {
    $or: [
      { numberOfGenerations: { $lt: numberOfGenerations } },
      {
        numberOfGenerations,
        updatedAt: { $lt: new Date(updatedAt) },
      },
      {
        numberOfGenerations,
        updatedAt: new Date(updatedAt),
        _id: { $gt: toId(_id) },
      },
    ],
  };
}

/**
 * The access listing's page from the groups read (one more than the page size when paginated,
 * each with its production prompt): the page with authors as strings, whether more follow, the
 * cursor after the page, and its first and last ids.
 */
export function promptGroupListPage(
  promptGroups: Array<Record<string, unknown>>,
  normalizedLimit: number | null,
): {
  object: 'list';
  data: Record<string, unknown>[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
  after: string | null;
} {
  const hasMore = normalizedLimit ? promptGroups.length > normalizedLimit : false;
  const data = (normalizedLimit ? promptGroups.slice(0, normalizedLimit) : promptGroups).map(
    (group) => {
      if (group.author) {
        group.author = (group.author as { toString(): string }).toString();
      }
      return group;
    },
  );

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0 && normalizedLimit) {
    const lastGroup = promptGroups[normalizedLimit - 1];
    nextCursor = Buffer.from(
      JSON.stringify({
        numberOfGenerations: lastGroup.numberOfGenerations,
        updatedAt: (lastGroup.updatedAt as Date).toISOString(),
        _id: (lastGroup._id as { toString(): string }).toString(),
      }),
    ).toString('base64');
  }

  const idString = (group: Record<string, unknown>) =>
    (group._id as { toString(): string }).toString();
  return {
    object: 'list' as const,
    data,
    first_id: data.length > 0 ? idString(data[0]) : null,
    last_id: data.length > 0 ? idString(data[data.length - 1]) : null,
    has_more: hasMore,
    after: nextCursor,
  };
}

/** In-flight access ID builds, so concurrent same-process misses share one resolution. */
const pendingAccessLookups = new Map<
  string,
  { generationKey: string; promise: Promise<string[]>; markStale: () => void }
>();
/** Tenant generation markers whose failed invalidation makes cache reads unsafe. */
const bypassedAccessGenerationKeys = new Set<string>();

const ACCESS_GENERATION_KEY = 'access:generation';

function isCachedIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((id) => typeof id === 'string' && isValidObjectIdString(id))
  );
}

/**
 * Reads the tenant's invalidation generation. Cached entries are keyed by it, so a
 * bump orphans every previous entry for this tenant without touching other tenants.
 * A missing marker (fresh tenant, or evicted under a Redis eviction policy) is
 * reinitialized to a fresh never-before-used value rather than falling back to
 * zero, where an evicted era's orphaned entry could still be read. Resolves
 * undefined when the marker cannot be read: guessing a generation then could
 * serve an orphaned entry, so callers must bypass the cache.
 */
async function readAccessGeneration(cache: CacheStore): Promise<string | undefined> {
  const generationKey = scopedCacheKey(ACCESS_GENERATION_KEY);
  if (bypassedAccessGenerationKeys.has(generationKey)) {
    return undefined;
  }
  try {
    const value = await cache.get(generationKey);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value.toString();
    }
    const initialized = randomUUID();
    await cache.set(generationKey, initialized, Time.ONE_DAY);
    return initialized;
  } catch {
    return undefined;
  }
}

/** The storage steps the prompt group access sets are built on, with the backend's id type. */
export interface PromptGroupAccessSteps<Id extends { toString(): string }, Principal> {
  /** Returns a cache store for the given key, or nothing (the sets are then always rebuilt). */
  getCache?: (key: string) => CacheStore | undefined;
  /** Resolves ACL principals for a user. */
  getUserPrincipals: (params: { userId: string; role?: string }) => Promise<Principal[]>;
  /** Finds resource IDs accessible to a set of principals. */
  findAccessibleResources: (
    principalsList: Principal[],
    resourceType: string,
    requiredPermBit: number,
    resourceIds: undefined,
    readPrimary: boolean,
  ) => Promise<Id[]>;
  /** Finds publicly accessible resource IDs. */
  findPublicResourceIds: (
    resourceType: string,
    requiredPermissions: number,
    resourceIds: undefined,
    readPrimary: boolean,
  ) => Promise<Id[]>;
  /** The ids of the groups the user authored, read so that every committed write is seen. */
  getOwnedPromptGroupIds: (author: string, readPrimary: boolean) => Promise<Id[]>;
  /** The backend's id for a cached hex string. */
  reviveId: (hex: string) => Id;
}

/** The access sets of `getPromptGroupAccessContext`. */
export interface PromptGroupAccessContext<Id> {
  accessibleIds: Id[];
  publiclyAccessibleIds: Id[];
  ownedPromptGroupIds: Id[];
}

/**
 * `getPromptGroupAccessContext` and `invalidatePromptGroupAccessContext` on the backend's steps:
 * the user's, the public and the owned group id sets, cached per tenant generation in the
 * PROMPT_GROUPS_ACCESS namespace when the host gives a cache.
 */
export function createPromptGroupAccess<Id extends { toString(): string }, Principal>(
  steps: PromptGroupAccessSteps<Id, Principal>,
): {
  getPromptGroupAccessContext(params: {
    userId: string;
    role?: string;
  }): Promise<PromptGroupAccessContext<Id>>;
  invalidatePromptGroupAccessContext(): Promise<void>;
} {
  /**
   * Resolves one prompt group ID set from the PROMPT_GROUPS_ACCESS cache, building
   * it on miss. Entries are stored as hex strings and revived to ids on read;
   * concurrent same-process misses share a single build, which invalidation marks
   * stale so a pre-mutation build never writes its IDs back into the cache.
   */
  async function resolveCachedIds(
    cacheKey: string,
    generationKey: string,
    build: () => Promise<Id[]>,
  ): Promise<Id[]> {
    const cache = steps.getCache?.(CacheKeys.PROMPT_GROUPS_ACCESS);
    if (!cache) {
      return build();
    }

    try {
      const cached = await cache.get(cacheKey);
      if (isCachedIdArray(cached)) {
        return cached.map((id) => steps.reviveId(id));
      }
    } catch {
      /** Cache failures must not block access resolution. */
    }

    const pending = pendingAccessLookups.get(cacheKey);
    if (pending) {
      const ids = await pending.promise;
      return ids.map((id) => steps.reviveId(id));
    }

    let stale = false;
    const lookup = (async () => {
      const ids = await build();
      if (!stale) {
        try {
          await cache.set(
            cacheKey,
            ids.map((id) => id.toString()),
          );
        } catch {
          /** Cache write failures only cost a rebuild on the next request. */
        }
      }
      return ids.map((id) => id.toString());
    })();

    pendingAccessLookups.set(cacheKey, {
      generationKey,
      promise: lookup,
      markStale: () => {
        stale = true;
      },
    });
    try {
      const ids = await lookup;
      return ids.map((id) => steps.reviveId(id));
    } finally {
      if (pendingAccessLookups.get(cacheKey)?.promise === lookup) {
        pendingAccessLookups.delete(cacheKey);
      }
    }
  }

  /**
   * Resolves the prompt group access ID sets shared by the list endpoints:
   * user-accessible, publicly accessible, and user-owned group IDs.
   *
   * The public set is identical for every user of a tenant and the per-user sets
   * only change on prompt or permission mutations. Hosts may cache all three in
   * the PROMPT_GROUPS_ACCESS namespace to spare overlapping requests the repeated
   * ACL queries. Hosts that cannot guarantee shared invalidation can use a no-op
   * store so authorization IDs are always rebuilt.
   */
  async function getPromptGroupAccessContext({
    userId,
    role,
  }: {
    userId: string;
    role?: string;
  }): Promise<PromptGroupAccessContext<Id>> {
    const cache = steps.getCache?.(CacheKeys.PROMPT_GROUPS_ACCESS);
    /**
     * Keys carry the tenant's invalidation generation, so a bump orphans every
     * cached set for this tenant, including late writes from in-flight builds,
     * without clearing other tenants' entries in the shared namespace. Builds
     * read the primary so a lagging secondary cannot pin pre-mutation IDs for
     * the full TTL.
     */
    const generationKey = scopedCacheKey(ACCESS_GENERATION_KEY);
    const generation = cache ? await readAccessGeneration(cache) : '0';
    const buildAccessible = async (): Promise<Id[]> => {
      const principalsList = await steps.getUserPrincipals({ userId, role });
      if (principalsList.length === 0) {
        return [];
      }
      return steps.findAccessibleResources(
        principalsList,
        ResourceType.PROMPTGROUP,
        PermissionBits.VIEW,
        undefined,
        true,
      );
    };
    const buildPublic = () =>
      steps.findPublicResourceIds(ResourceType.PROMPTGROUP, PermissionBits.VIEW, undefined, true);
    const buildOwned = () => steps.getOwnedPromptGroupIds(userId, true);

    if (generation === undefined) {
      /** The marker could not be read; guessing a generation could serve an orphaned entry */
      const [accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds] = await Promise.all([
        buildAccessible(),
        buildPublic(),
        buildOwned(),
      ]);
      return { accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds };
    }

    const scopedKey = (key: string) => scopedCacheKey(`access:${generation}:${key}`);

    const accessibleIds = await resolveCachedIds(
      scopedKey(`user:${userId}:${role ?? ''}`),
      generationKey,
      buildAccessible,
    );

    const [publiclyAccessibleIds, ownedPromptGroupIds] = await Promise.all([
      resolveCachedIds(scopedKey('public'), generationKey, buildPublic),
      resolveCachedIds(scopedKey(`owned:${userId}`), generationKey, buildOwned),
    ]);

    return { accessibleIds, publiclyAccessibleIds, ownedPromptGroupIds };
  }

  /**
   * Invalidates all cached prompt group access ID sets for the active tenant after
   * a mutation that can change them (group create/delete, permission grants/revokes,
   * membership changes). Bumping the generation orphans cached entries and any
   * writes still in flight from pre-mutation builds, including in other processes
   * sharing the store, while other tenants' entries stay intact. In-flight builds
   * in this process are additionally marked stale so they skip their cache write.
   * The old generation marker is removed before its replacement is written. If
   * neither operation succeeds, reads bypass this tenant's cache and the mutation
   * rejects instead of allowing the old authorization era to remain authoritative.
   */
  async function invalidatePromptGroupAccessContext(): Promise<void> {
    const generationKey = scopedCacheKey(ACCESS_GENERATION_KEY);
    for (const [cacheKey, pending] of pendingAccessLookups) {
      if (pending.generationKey !== generationKey) {
        continue;
      }
      pending.markStale();
      pendingAccessLookups.delete(cacheKey);
    }
    const cache = steps.getCache?.(CacheKeys.PROMPT_GROUPS_ACCESS);
    if (!cache) {
      return;
    }
    let markerRemoved = false;
    if (cache.delete) {
      try {
        const deleteResult = await cache.delete(generationKey);
        markerRemoved = deleteResult !== false;
        if (!markerRemoved) {
          logger.warn('The previous prompt group access generation was not removed');
        }
      } catch (error) {
        logger.warn('Failed to remove the previous prompt group access generation', error);
      }
    }
    try {
      /**
       * A collision-resistant token cannot repeat an evicted era or be restored
       * by a delayed initializer that selected a different token before this write.
       */
      /**
       * Keep the marker longer than derived entries so normal expiry does not
       * orphan a warm cache era and force avoidable access-query rebuilds.
       */
      const setResult = await cache.set(generationKey, randomUUID(), Time.ONE_DAY);
      if (setResult === false) {
        throw new Error('Prompt group access generation write failed');
      }
      bypassedAccessGenerationKeys.delete(generationKey);
    } catch (error) {
      if (markerRemoved) {
        bypassedAccessGenerationKeys.delete(generationKey);
        logger.warn('Failed to restore the removed prompt group access generation', error);
        return;
      }
      bypassedAccessGenerationKeys.add(generationKey);
      logger.warn('Failed to invalidate prompt group access cache', error);
      throw error;
    }
  }

  return { getPromptGroupAccessContext, invalidatePromptGroupAccessContext };
}

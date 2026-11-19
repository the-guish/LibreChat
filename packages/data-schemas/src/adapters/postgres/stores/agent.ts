/**
 * The PostgreSQL `AgentStore` (`~/ports/agent`) on the `agents` table, through the collection
 * primitive, with the version, listing and cleanup rules of `~/methods/agentRules` (the MongoDB
 * methods' own) and the code environment reference leases of
 * `~/methods/codeEnvironmentReferenceRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - **Typed storage** (§1.4): `versions`, `edges`, `tool_resources`, `model_parameters`,
 *   `avatar`, `support_contact`, `subagents` and `tool_options` are `json`, so their key order is
 *   kept, which `isDuplicateVersion` depends on (it compares object fields by their serialized
 *   form). `tool_resources.<resource>.file_ids` writes (`$addToSet`, `$push`, `$pullAll`,
 *   `$unset`) and the `versions` `$push` are subpath writes into `json`: tier 2,
 *   read-modify-write under the row lock. `tools`, `skills`, `mcpServerNames` and the other
 *   string arrays are `text[]` (tier 1). `edges.from`/`edges.to` filters are lax jsonpath on
 *   `edges::jsonb`, served by the GIN index on `edges`.
 * - **Version counts** (`getAgentWithVersionCount`, the management listing) are
 *   `json_array_length(versions)` in hand-written SQL through `storeWhere`, so the history is
 *   never transferred; the records are read through the primitive without it.
 * - **Listings**: the date orders are primitive reads with the shared cursor conditions; the
 *   popularity order counts favorites with `GROUP BY` over the `users__favorites` child table
 *   (scoped to the active tenant) and pages with the shared popularity rules; the author order
 *   (MongoDB's `$lookup` aggregation) reads the matching agents, then their owner ACL entries and
 *   the owners in raw mode (one batched read per table, any tenant, matched to the agent's tenant
 *   afterwards, as the aggregation does) and sorts and pages in JavaScript with MongoDB's
 *   operators (`$trim`'s whitespace, `$toLower`'s ASCII folding, binary string order).
 * - **Graph edge cleanup**: `_id`-ordered keyset pages of graphs and a compare-and-set per graph
 *   in its own transaction: the row is locked (`SELECT ... FOR UPDATE`), its edges are read in
 *   the next statement and compared with the ones the page read (MongoDB's exact equality), and
 *   only then written.
 * - **Code environment references**: an agent write naming a registered environment reserves a
 *   lease on its `codeenvironments` row (`pendingAgentReferences` child table) for the write's
 *   duration, refused for an environment being removed or retired (`code_environment_tombstones`),
 *   on the storage steps of the code environment store (`createPostgresCodeEnvironmentReferenceSteps`).
 * - Skills (`skills`), actions (through `getActions`), ACL entries (`aclentries`) and favorites
 *   (`users`) are read and written on their tables through the primitive.
 */
import { PermissionBits, PrincipalType, ResourceType } from 'librechat-data-provider';
import type {
  AgentSortCursor,
  AgentEdgeCleanupSteps,
  AgentFavoriteCount,
} from '~/methods/agentRules';
import type { PgCollection, PgFilter, PgRecord } from '../collection';
import type { IAgent, AgentListSortOption } from '~/types';
import type { AgentFactoryDeps } from '~/compose/types';
import type { PostgresStoreContext } from './context';
import type { AgentStore } from '~/ports/agent';
import type { IdLike } from '~/ports/common';
import {
  agentIdsByTenant,
  AGENT_SORT_CONFIG,
  agentListEnvelope,
  agentAvatarFilter,
  prepareAgentCreate,
  prepareAgentUpdate,
  prepareAgentRevert,
  normalizeAgentList,
  readAgentSortCursor,
  agentManagementPage,
  finalizeListedAgent,
  AUTHOR_SORT_SENTINEL,
  agentManagementMatch,
  encodeAgentSortCursor,
  sharedResourceFileIds,
  agentResourceFilesPull,
  listAgentsByPopularity,
  removeAgentIdsFromEdges,
  toolResourceFilesFilter,
  toolResourceFilesPullAll,
  agentUpdateEnvironmentIds,
  codeEnvironmentReferences,
  buildAgentSortCursorCondition,
  AGENT_OWNER_CONTACT_RESOLVED_FIELD,
} from '~/methods/agentRules';
import { withCodeEnvironmentReferencesSteps } from '~/methods/codeEnvironmentReferenceRules';
import { createPostgresCodeEnvironmentReferenceSteps } from './codeEnvironment';
import { evictAuthUserDocsForUsers, isAuthUserDocCacheEnabled } from '~/utils/eviction';
import { OWNER_ACL_PERMISSION_BIT_SUPERSETS } from '~/methods/aclEntryRules';
import { isValidObjectIdString } from '~/utils/objectId';
import { runStoreSql, storeWhere } from './context';
import { valuesEqual } from '../evaluator';
import logger from '~/config/winston';
import { sql } from '../query/sql';

/** An agent as the primitive reads it. */
type AgentRow = PgRecord & IAgent & { updatedAt?: Date; createdAt?: Date };

const asAgent = (record: PgRecord | null): IAgent | null => record as unknown as IAgent | null;

/** MongoDB's `$trim` whitespace (`\0`, the ASCII spaces, NBSP and the Unicode spaces). */
const MONGO_TRIM_WHITESPACE = new Set([
  0x0000, 0x0020, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
]);

/** `$trim` of a string value, `''` for anything else (the aggregation's `trimStringOrEmpty`). */
function trimStringOrEmpty(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const chars = [...value];
  let start = 0;
  let end = chars.length;
  while (start < end && MONGO_TRIM_WHITESPACE.has(chars[start].codePointAt(0) as number)) {
    start++;
  }
  while (end > start && MONGO_TRIM_WHITESPACE.has(chars[end - 1].codePointAt(0) as number)) {
    end--;
  }
  return chars.slice(start, end).join('');
}

/** `$toLower`: ASCII letters only, as MongoDB folds (`Émile` keeps its `É`). */
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** MongoDB's string order: binary UTF-8, which is code point order. */
function compareBinary(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference =
      (left[index].codePointAt(0) as number) - (right[index].codePointAt(0) as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/** A trimmed name usable on the card: non-empty and not email-shaped. */
const isValidDisplayName = (value: string): boolean => value !== '' && !value.includes('@');

/** The value a `$lookup`-joined field holds when missing: `null` (the aggregation's `$ifNull`). */
const orNull = (value: unknown): unknown => (value === undefined ? null : value);

/** MongoDB's order of the (`grantedAt`, `createdAt`) keys of ACL entries: `null` first. */
function compareNullableDates(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : null;
  const right = b instanceof Date ? b.getTime() : null;
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left - right;
}

/** Whether ACL entry `a` precedes `b` by (`grantedAt`, `createdAt`, `_id`). */
function isEarlierAclEntry(a: PgRecord, b: PgRecord): boolean {
  const granted = compareNullableDates(orNull(a.grantedAt), orNull(b.grantedAt));
  if (granted !== 0) return granted < 0;
  const created = compareNullableDates(orNull(a.createdAt), orNull(b.createdAt));
  if (created !== 0) return created < 0;
  return String(a._id) < String(b._id);
}

export function createPostgresAgentStore(
  context: PostgresStoreContext,
  deps: AgentFactoryDeps,
): AgentStore {
  const { removeAllPermissions, getActions, getSoleOwnedResourceIds, isExternalSkillId } = deps;
  const agents = (): PgCollection<AgentRow> => context.collections().collection<AgentRow>('agents');
  const users = () => context.collections().collection('users');

  /** Drops the allowlist ids whose skill no longer exists here or in the external registry. */
  async function pruneSkills(skillIds: string[]): Promise<string[]> {
    const candidates = [
      ...new Set(skillIds.filter(isValidObjectIdString).map((id) => id.toLowerCase())),
    ];
    if (candidates.length === 0) {
      return [];
    }
    const docs = await context
      .collections()
      .collection('skills')
      .find(
        { _id: { $in: candidates }, deletingAt: { $exists: false } },
        { projection: { _id: 1 } },
      );
    const existing = new Set(docs.map((doc) => String(doc._id)));
    return candidates.filter((id) => existing.has(id) || isExternalSkillId?.(id) === true);
  }

  /** The reference leases on the `codeenvironments` rows (S9's store module writes them). */
  const referenceSteps = createPostgresCodeEnvironmentReferenceSteps(context);

  /**
   * After a write whose reference lease was lost: puts the agent back as it was before the
   * write (MongoDB's `replaceOne` without timestamps), while the written state still stands;
   * otherwise only drops the lost reference.
   */
  async function restoreAgentAfterReferenceLoss(
    agentAfterWrite: IAgent | null,
    originalAgent: AgentRow,
    lostEnvironmentId: string,
  ): Promise<void> {
    if (agentAfterWrite == null) return;
    const { updatedAt } = agentAfterWrite as IAgent & { updatedAt: Date };
    const { _id, ...fields } = originalAgent;
    const unset = Object.fromEntries(
      Object.keys(agentAfterWrite)
        .filter((key) => key !== '_id' && !(key in fields))
        .map((key) => [key, 1]),
    );
    const restored = await agents().updateOne(
      {
        _id: String(agentAfterWrite._id),
        $or: [
          { code_environment_id: lostEnvironmentId },
          { code_environment_ids: lostEnvironmentId },
        ],
        updatedAt,
      },
      { $set: fields, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
      { timestamps: false },
    );
    if (restored.matchedCount === 0) {
      await agents().updateOne(
        { _id: String(agentAfterWrite._id), code_environment_id: lostEnvironmentId },
        { $unset: { code_environment_id: 1 } },
      );
      await agents().updateOne(
        { _id: String(agentAfterWrite._id), code_environment_ids: lostEnvironmentId },
        { $pull: { code_environment_ids: lostEnvironmentId } },
      );
    }
  }

  /** The graph edge cleanup on `agents`: keyset pages, one locked compare-and-set per graph. */
  const edgeSteps: AgentEdgeCleanupSteps<string> = {
    async findGraphs(filter, limit) {
      return (await agents().find(filter, {
        projection: { _id: 1, edges: 1 },
        sort: { _id: 1 },
        limit,
      })) as unknown as Array<{ _id: string; edges?: IAgent['edges'] }>;
    },
    async compareAndSetEdges(writes) {
      let matched = 0;
      for (const write of writes) {
        const written = await context.transactions.transaction(async (tx) => {
          const locked = await runStoreSql<{ _id: string }>(
            context,
            sql`SELECT t._id FROM agents t WHERE ${storeWhere(context, 'agents', { _id: write._id }, { operation: 'bulkWrite' })} FOR UPDATE`,
            tx,
          );
          if (locked.rows.length === 0) {
            return false;
          }
          const current = await agents().findOne(
            { _id: write._id },
            { projection: { edges: 1 }, tx },
          );
          if (current == null || !valuesEqual(current.edges, write.edges)) {
            return false;
          }
          await agents().updateOne({ _id: write._id }, { $set: { edges: write.next } }, { tx });
          return true;
        });
        if (written) {
          matched++;
        }
      }
      return matched;
    },
  };

  /** Users whose favorites match, read only when their cached auth documents need evicting. */
  async function findFavoriteHolders(filter: PgFilter): Promise<string[]> {
    if (!isAuthUserDocCacheEnabled()) {
      return [];
    }
    const ids = await users().distinct('_id', filter);
    return ids.map(String);
  }

  /** How many versions each agent has, by `_id`, without reading the history. */
  async function versionCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const { rows } = await runStoreSql<{ _id: string; version: number }>(
      context,
      sql`SELECT t._id AS "_id", CASE WHEN json_typeof(t."versions") = 'array' THEN json_array_length(t."versions") ELSE 0 END AS "version" FROM agents t WHERE ${storeWhere(context, 'agents', { _id: { $in: ids } })}`,
    );
    return new Map(rows.map((row) => [row._id, Number(row.version)]));
  }

  const getAgent = (async (
    filter: PgFilter,
    projection: PgRecord | string = { versions: 0 },
  ): Promise<IAgent | null> =>
    asAgent(
      await agents().findOne(filter, { projection: projection as Record<string, 0 | 1> }),
    )) as AgentStore['getAgent'];

  async function updateAgent(
    filter: PgFilter,
    update: Record<string, unknown>,
    options: {
      updatingUserId?: string | null;
      forceVersion?: boolean;
      skipVersioning?: boolean;
    } = {},
  ): Promise<IAgent | null> {
    const updateData = update;
    let suppressedVersionEntry = false;

    const currentAgent = await agents().findOne(filter);
    const currentRevision = currentAgent?.updatedAt;
    if (currentAgent) {
      ({ suppressedVersionEntry } = await prepareAgentUpdate(currentAgent, updateData, options, {
        pruneSkills,
        getActions: (actionIds) => getActions({ actionId: actionIds }, true),
        toUserId: (userId) => userId.toLowerCase(),
        onActionsError: (error) => {
          logger.error('Error fetching actions for hash generation:', error);
        },
      }));
    }

    const nextEnvironmentIds = agentUpdateEnvironmentIds(updateData);
    const updatedAgent = await withCodeEnvironmentReferencesSteps(
      referenceSteps,
      nextEnvironmentIds,
      async () =>
        asAgent(
          await agents().findOneAndUpdate(
            currentAgent == null || nextEnvironmentIds.length === 0
              ? filter
              : { ...filter, _id: String(currentAgent._id), updatedAt: currentRevision },
            updateData,
            { returnDocument: 'after' },
          ),
        ),
      async (agentAfterUpdate, lostEnvironmentId) => {
        if (agentAfterUpdate == null || currentAgent == null) return;
        await restoreAgentAfterReferenceLoss(agentAfterUpdate, currentAgent, lostEnvironmentId);
      },
    );

    /** `version` answers "was a version recorded" for a suppressed entry (see the port). */
    if (updatedAgent && suppressedVersionEntry) {
      (updatedAgent as IAgent & { version?: number }).version = updatedAgent.versions?.length ?? 0;
    }
    return updatedAgent;
  }

  /** The `author` order: MongoDB's owner-joining aggregation, computed in JavaScript. */
  async function listAgentsByAuthor(params: {
    baseQuery: Record<string, unknown>;
    projection: Record<string, 1>;
    isPaginated: boolean;
    normalizedLimit: number | null;
    readCursor: () => AgentSortCursor | null;
    finalize: (agent: Record<string, unknown>) => Record<string, unknown>;
  }) {
    const { baseQuery, projection, isPaginated, normalizedLimit } = params;
    const sort: AgentListSortOption = 'author';
    const extra = ['tenantId', 'authorName'].filter((field) => !(field in projection));
    const matched = (await agents().find(baseQuery, {
      projection: { ...projection, tenantId: 1, authorName: 1 },
    })) as Array<Record<string, unknown>>;
    const tenantOf = (record: Record<string, unknown>) => orNull(record.tenantId);

    const agentIds = matched.map((agent) => String(agent._id));
    const entries =
      agentIds.length > 0
        ? await context
            .collections()
            .raw('aclentries')
            .find(
              {
                resourceId: { $in: agentIds },
                resourceType: ResourceType.AGENT,
                principalType: PrincipalType.USER,
                permBits: { $in: [...OWNER_ACL_PERMISSION_BIT_SUPERSETS] },
              },
              {
                projection: {
                  _id: 1,
                  resourceId: 1,
                  principalId: 1,
                  tenantId: 1,
                  grantedAt: 1,
                  createdAt: 1,
                },
              },
            )
        : [];
    const ownerEntries = new Map<string, PgRecord>();
    const tenantByAgent = new Map(matched.map((agent) => [String(agent._id), tenantOf(agent)]));
    for (const entry of entries) {
      const resourceId = String(entry.resourceId);
      if (orNull(entry.tenantId) !== tenantByAgent.get(resourceId)) {
        continue;
      }
      const current = ownerEntries.get(resourceId);
      if (current == null || isEarlierAclEntry(entry, current)) {
        ownerEntries.set(resourceId, entry);
      }
    }
    const ownerIdOf = (agent: Record<string, unknown>): unknown =>
      ownerEntries.get(String(agent._id))?.principalId ?? agent.author;
    const ownerIds = [
      ...new Set(
        matched
          .map((agent) => ownerIdOf(agent))
          .filter((id): id is string => typeof id === 'string' && isValidObjectIdString(id))
          .map((id) => id.toLowerCase()),
      ),
    ];
    const owners =
      ownerIds.length > 0
        ? await context
            .collections()
            .raw('users')
            .find(
              { _id: { $in: ownerIds } },
              { projection: { _id: 1, name: 1, username: 1, tenantId: 1 } },
            )
        : [];
    const ownersById = new Map(owners.map((owner) => [String(owner._id), owner]));

    const rows = matched.map((agent) => {
      const ownerId = ownerIdOf(agent);
      const owner = typeof ownerId === 'string' ? ownersById.get(ownerId.toLowerCase()) : undefined;
      const ownerUser = owner != null && orNull(owner.tenantId) === tenantOf(agent) ? owner : null;
      const contact = agent.support_contact;
      const contactField = (field: string): unknown =>
        contact != null && typeof contact === 'object' && !Array.isArray(contact)
          ? (contact as Record<string, unknown>)[field]
          : undefined;
      const supportName = trimStringOrEmpty(contactField('name'));
      const supportEmail = trimStringOrEmpty(contactField('email'));
      const ownerName = trimStringOrEmpty(ownerUser?.name);
      const ownerUsername = trimStringOrEmpty(ownerUser?.username);
      const authorName = trimStringOrEmpty(agent.authorName);
      let authorDisplayName = AUTHOR_SORT_SENTINEL;
      if (supportName !== '') authorDisplayName = supportName;
      else if (supportEmail !== '') authorDisplayName = supportEmail;
      else if (isValidDisplayName(ownerName)) authorDisplayName = ownerName;
      else if (isValidDisplayName(ownerUsername)) authorDisplayName = ownerUsername;
      else if (isValidDisplayName(authorName)) authorDisplayName = authorName;
      let ownerContact: { name: string } | null = null;
      if (supportName === '' && supportEmail === '' && ownerUser != null) {
        const ownerDisplayName = [ownerName, ownerUsername, authorName].find(isValidDisplayName);
        ownerContact = ownerDisplayName != null ? { name: ownerDisplayName } : null;
      }
      const row: Record<string, unknown> = { ...agent };
      for (const field of extra) {
        delete row[field];
      }
      row.authorDisplayName = authorDisplayName;
      row.authorSortKey = asciiLower(authorDisplayName);
      row.owner_contact = ownerContact;
      return row;
    });

    const decodedCursor = params.readCursor();
    const { direction, tieBreakDirection } = AGENT_SORT_CONFIG[sort];
    const keyOf = (row: Record<string, unknown>) => row.authorSortKey as string;
    const idOf = (row: Record<string, unknown>) => String(row._id);
    const afterCursor = decodedCursor
      ? rows.filter((row) => {
          const order = compareBinary(keyOf(row), decodedCursor.primary) * direction;
          if (order !== 0) return order > 0;
          const secondary = decodedCursor.secondary.toLowerCase();
          return tieBreakDirection === 1 ? idOf(row) > secondary : idOf(row) < secondary;
        })
      : rows;
    afterCursor.sort((a, b) => {
      const order = compareBinary(keyOf(a), keyOf(b)) * direction;
      if (order !== 0) return order;
      if (idOf(a) === idOf(b)) return 0;
      return (idOf(a) < idOf(b) ? -1 : 1) * tieBreakDirection;
    });
    const limited =
      isPaginated && normalizedLimit ? afterCursor.slice(0, normalizedLimit + 1) : afterCursor;

    const hasMore = isPaginated && normalizedLimit ? limited.length > normalizedLimit : false;
    const trimmed = isPaginated && normalizedLimit ? limited.slice(0, normalizedLimit) : limited;
    const data = trimmed.map((agent) => {
      if (agent.owner_contact == null) {
        delete agent.owner_contact;
      }
      agent[AGENT_OWNER_CONTACT_RESOLVED_FIELD] = true;
      return params.finalize(agent);
    });

    let nextCursor: string | null = null;
    if (isPaginated && hasMore && data.length > 0 && normalizedLimit) {
      nextCursor = encodeAgentSortCursor(sort, limited[normalizedLimit - 1]);
    }
    return agentListEnvelope(data, hasMore, nextCursor);
  }

  const store: AgentStore = {
    getAgent,

    async getAgentName(id, tenantId) {
      const agent = await getAgent(
        { id, tenantId: tenantId ?? null },
        { name: 1, tenantId: 1, _id: 0 },
      );
      if ((agent?.tenantId ?? undefined) !== tenantId) return undefined;
      return agent?.name || undefined;
    },

    async getAgentVersions(filter) {
      const result = await agents().findOne(filter, { projection: { versions: 1, _id: 0 } });
      if (!result) {
        return null;
      }
      return result.versions ?? [];
    },

    /** The first match's `_id` and history length in one statement, then the record without it. */
    async getAgentWithVersionCount(filter) {
      const { rows } = await runStoreSql<{ _id: string; version: number }>(
        context,
        sql`SELECT t._id AS "_id", CASE WHEN json_typeof(t."versions") = 'array' THEN json_array_length(t."versions") ELSE 0 END AS "version" FROM agents t WHERE ${storeWhere(context, 'agents', filter)} ORDER BY t._id LIMIT 1`,
      );
      const [first] = rows;
      if (first == null) {
        return null;
      }
      const agent = await agents().findOne({ _id: first._id }, { projection: { versions: 0 } });
      if (agent == null) {
        return null;
      }
      return { ...agent, version: Number(first.version) } as unknown as IAgent & {
        version: number;
      };
    },

    async getAgents(filter, select) {
      return (await agents().find(
        filter,
        select != null ? { projection: select } : {},
      )) as IAgent[];
    },

    async resolveAgentGraphAccess(access) {
      return (await deps.getUserPrincipals(access)) as unknown as Awaited<
        ReturnType<AgentStore['resolveAgentGraphAccess']>
      >;
    },

    async getAgentGraphNodes(ids, access) {
      if (ids.length === 0) {
        return [];
      }
      const found = await agents().find(
        { id: { $in: ids } },
        {
          projection: {
            _id: 1,
            id: 1,
            provider: 1,
            model: 1,
            tools: 1,
            mcpServerNames: 1,
            agent_ids: 1,
            edges: 1,
            subagents: 1,
          },
        },
      );
      let visible = found;
      if (access != null) {
        const principals = access as unknown as Parameters<typeof deps.findAccessibleResources>[0];
        const resourceIds = await deps.findAccessibleResources(
          principals,
          ResourceType.AGENT,
          PermissionBits.VIEW,
          found.map((agent) => agent._id as unknown as IdLike) as never,
        );
        const allowed = new Set(resourceIds.map(String));
        visible = found.filter((agent) => allowed.has(String(agent._id)));
      }
      return visible.map(
        ({ id, provider, model, tools, mcpServerNames, agent_ids, edges, subagents }) => ({
          id,
          provider,
          model,
          tools,
          mcpServerNames,
          agent_ids,
          edges,
          subagents,
        }),
      );
    },

    async getAgentIdsByMCPServerName(serverName) {
      const found = await agents().find({ mcpServerNames: serverName }, { projection: { _id: 1 } });
      return found.map((agent) => agent._id as unknown as IdLike);
    },

    async getAgentsWithMCPServerNames() {
      return (await agents().find(
        { mcpServerNames: { $type: 'string' } },
        { projection: { mcpServerNames: 1 } },
      )) as Array<Pick<IAgent, '_id' | 'mcpServerNames'>>;
    },

    async getAgentModelSummaries(agentIds) {
      return (await agents().find(
        { _id: { $in: agentIds } },
        { projection: { id: 1, name: 1, description: 1, provider: 1, author: 1, createdAt: 1 } },
      )) as unknown as Awaited<ReturnType<AgentStore['getAgentModelSummaries']>>;
    },

    async countPromotedAgents() {
      return await agents().count({ is_promoted: true });
    },

    async getListAgentsByAccess(params) {
      const { after = null, includeExecutionConfig = false } = params;
      const { isPaginated, normalizedLimit, sort, baseQuery, projection } = normalizeAgentList(
        params,
        (author) => author,
      );
      const finalize = (agent: Record<string, unknown>) =>
        finalizeListedAgent(agent, includeExecutionConfig);
      const readCursor = () => readAgentSortCursor(after, sort);

      if (sort === 'popular') {
        return await listAgentsByPopularity<string>(
          { baseQuery, projection, normalizedLimit, readCursor, finalize },
          {
            async countFavorites(): Promise<AgentFavoriteCount[]> {
              const where = storeWhere(context, 'users', {
                'favorites.agentId': { $exists: true },
              });
              const { rows } = await runStoreSql<AgentFavoriteCount>(
                context,
                sql`SELECT t."tenantId" AS "tenantId", f."agentId" AS "agentId", count(DISTINCT t._id)::integer AS "favoriteCount" FROM users t JOIN "users__favorites" f ON f._parent = t._id WHERE ${where} AND f."agentId" IS NOT NULL GROUP BY t."tenantId", f."agentId"`,
              );
              return rows.map((row) => ({ ...row, favoriteCount: Number(row.favoriteCount) }));
            },
            async findFavoritedRows(filter) {
              return (await agents().find(filter, {
                projection: { _id: 1, id: 1, tenantId: 1 },
              })) as unknown as Array<{ _id: string; id: string; tenantId?: string | null }>;
            },
            async findAgents(filter, select) {
              return (await agents().find(filter, { projection: select })) as Array<
                Record<string, unknown>
              >;
            },
            async findTail(filter, select, limit) {
              return (await agents().find(filter, {
                projection: select,
                sort: { _id: 1 },
                ...(limit != null ? { limit } : {}),
              })) as Array<Record<string, unknown>>;
            },
            toId: (hex) => hex.toLowerCase(),
          },
        );
      }

      if (sort === 'author') {
        return await listAgentsByAuthor({
          baseQuery,
          projection,
          isPaginated,
          normalizedLimit,
          readCursor,
          finalize,
        });
      }

      const { field: dateField, direction: dir, tieBreakDirection } = AGENT_SORT_CONFIG[sort];
      let finalQuery: Record<string, unknown> = baseQuery;
      const decodedCursor = readCursor();
      if (decodedCursor) {
        const cursorCondition = buildAgentSortCursorCondition(
          sort,
          decodedCursor,
          decodedCursor.secondary.toLowerCase(),
        );
        finalQuery =
          Object.keys(baseQuery).length > 0
            ? { $and: [{ ...baseQuery }, cursorCondition] }
            : { ...cursorCondition };
      }
      const found = (await agents().find(finalQuery, {
        projection,
        sort: { [dateField]: dir, _id: tieBreakDirection },
        ...(isPaginated && normalizedLimit ? { limit: normalizedLimit + 1 } : {}),
      })) as Array<Record<string, unknown>>;

      const hasMore = isPaginated && normalizedLimit ? found.length > normalizedLimit : false;
      const data = (isPaginated && normalizedLimit ? found.slice(0, normalizedLimit) : found).map(
        finalize,
      );
      let nextCursor: string | null = null;
      if (isPaginated && hasMore && data.length > 0 && normalizedLimit) {
        nextCursor = encodeAgentSortCursor(sort, found[normalizedLimit - 1]);
      }
      return agentListEnvelope(data, hasMore, nextCursor);
    },

    async getAgentManagementListByAccess({ accessibleIds, tenantId, limit, after = null }) {
      const match = agentManagementMatch({ accessibleIds, tenantId, after }, (hex) =>
        hex.toLowerCase(),
      );
      const page = (await agents().find(match, {
        projection: { versions: 0 },
        sort: { updatedAt: -1, _id: 1 },
        limit: limit + 1,
      })) as Array<AgentRow & { updatedAt: Date; createdAt: Date }>;
      const counts = await versionCounts(page.map((agent) => String(agent._id)));
      const withCounts = page.map((agent) => ({
        ...agent,
        version: counts.get(String(agent._id)) ?? 0,
      }));
      return agentManagementPage(withCounts, limit) as unknown as Awaited<
        ReturnType<AgentStore['getAgentManagementListByAccess']>
      >;
    },

    async getSharedResourceFileIds({ file_ids, excludeAgentObjectId, excludeToolResource }) {
      if (!file_ids || file_ids.length === 0) {
        return [];
      }
      const found = await agents().find(toolResourceFilesFilter(file_ids), {
        projection: { _id: 1, tool_resources: 1 },
      });
      return sharedResourceFileIds(found, file_ids, excludeAgentObjectId, excludeToolResource);
    },

    async createAgent(agentData) {
      const initialAgentData = await prepareAgentCreate(agentData, pruneSkills);
      return await withCodeEnvironmentReferencesSteps(
        referenceSteps,
        codeEnvironmentReferences(agentData),
        async () => (await agents().insertOne(initialAgentData)) as unknown as IAgent,
        async (createdAgent) => {
          await agents().deleteOne({ _id: String(createdAgent._id) });
        },
      );
    },

    updateAgent: (filter, update, options) =>
      updateAgent(filter, update as Record<string, unknown>, options),

    /** No update time and no version: maintenance must not advance list cursors. */
    async updateAgentAvatar({ id, avatar, previousAvatar }) {
      const result = await agents().updateOne(
        agentAvatarFilter(id, previousAvatar),
        { $set: { avatar } },
        { timestamps: false },
      );
      return result.matchedCount > 0;
    },

    async addAgentResourceFile({ agent_id, tool_resource, file_id, updatingUserId }) {
      const searchParameter = { id: agent_id };
      const agent = await getAgent(searchParameter);
      if (!agent) {
        throw new Error('Agent not found for adding resource file');
      }
      const fileIdsPath = `tool_resources.${tool_resource}.file_ids`;
      await agents().updateOne(
        { id: agent_id, [fileIdsPath]: { $exists: false } },
        { $set: { [fileIdsPath]: [] } },
      );
      const updatedAgent = await updateAgent(
        searchParameter,
        { $addToSet: { tools: tool_resource, [fileIdsPath]: file_id } },
        { updatingUserId },
      );
      if (updatedAgent) {
        return updatedAgent;
      }
      throw new Error('Agent not found for adding resource file');
    },

    async removeAgentResourceFiles({ agent_id, files }) {
      const searchParameter = { id: agent_id };
      const agentAfterPull = asAgent(
        await agents().findOneAndUpdate(searchParameter, agentResourceFilesPull(files), {
          returnDocument: 'after',
        }),
      );
      if (!agentAfterPull) {
        const agentExists = await getAgent(searchParameter);
        if (!agentExists) {
          throw new Error('Agent not found for removing resource files');
        }
        throw new Error('Failed to update agent during file removal (pull step)');
      }
      return agentAfterPull;
    },

    async removeAgentResourceFilesFromAllAgents({ file_ids }) {
      if (!file_ids || file_ids.length === 0) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      const result = await agents().updateMany(
        toolResourceFilesFilter(file_ids),
        toolResourceFilesPullAll(file_ids),
      );
      return { matchedCount: result.matchedCount ?? 0, modifiedCount: result.modifiedCount ?? 0 };
    },

    async revertAgentVersion(filter, versionIndex) {
      const agent = await agents().findOne(filter);
      if (!agent) {
        throw new Error('Agent not found');
      }
      if (!agent.versions || !agent.versions[versionIndex]) {
        throw new Error(`Version ${versionIndex} not found`);
      }
      const originalRevision = agent.updatedAt;
      const { revertToVersion, revertUpdate } = await prepareAgentRevert(
        agent.versions[versionIndex] as Record<string, unknown>,
        pruneSkills,
      );
      const revertedAgent = await withCodeEnvironmentReferencesSteps(
        referenceSteps,
        codeEnvironmentReferences(revertToVersion),
        async () =>
          asAgent(
            await agents().findOneAndUpdate(
              { ...filter, _id: String(agent._id), updatedAt: originalRevision },
              revertUpdate,
              { returnDocument: 'after' },
            ),
          ),
        async (agentAfterRevert, lostEnvironmentId) => {
          if (agentAfterRevert == null) {
            return;
          }
          await restoreAgentAfterReferenceLoss(agentAfterRevert, agent, lostEnvironmentId);
        },
      );
      if (!revertedAgent) {
        throw new Error('Agent not found');
      }
      return revertedAgent;
    },

    async deleteAgent(filter) {
      const agent = asAgent(await agents().findOneAndDelete(filter));
      if (agent) {
        const deletedAgent = agent as unknown as { id: string; tenantId?: string };
        await Promise.all([
          removeAllPermissions({ resourceType: ResourceType.AGENT, resourceId: agent._id }),
          removeAllPermissions({ resourceType: ResourceType.REMOTE_AGENT, resourceId: agent._id }),
        ]);
        try {
          await removeAgentIdsFromEdges(edgeSteps, [deletedAgent.id], deletedAgent.tenantId);
        } catch (error) {
          logger.error('[deleteAgent] Error removing agent from handoff edges', error);
        }
        try {
          const favoritesFilter = {
            ...(deletedAgent.tenantId !== undefined ? { tenantId: deletedAgent.tenantId } : {}),
            'favorites.agentId': deletedAgent.id,
          };
          const holders = await findFavoriteHolders(favoritesFilter);
          await users().updateMany(favoritesFilter, {
            $pull: { favorites: { agentId: deletedAgent.id } },
          });
          await evictAuthUserDocsForUsers(deps.getCache, holders);
        } catch (error) {
          logger.error('[deleteAgent] Error removing agent from user favorites', error);
        }
      }
      return agent;
    },

    async removeAgentFromUserFavorites(resourceId, userIds) {
      const agent = await agents().findOne(
        { _id: resourceId },
        { projection: { id: 1, tenantId: 1 } },
      );
      if (!agent) {
        return;
      }
      await users().updateMany(
        {
          _id: { $in: userIds },
          ...(agent.tenantId !== undefined ? { tenantId: agent.tenantId } : {}),
          'favorites.agentId': agent.id,
        },
        { $pull: { favorites: { agentId: agent.id } } },
      );
      await evictAuthUserDocsForUsers(deps.getCache, userIds);
    },

    async deleteUserAgents(userId) {
      try {
        if (!isValidObjectIdString(userId)) {
          throw new Error(`Invalid user id: ${userId}`);
        }
        const aclEntries = context.collections().collection('aclentries');
        const agentResourceTypes = [ResourceType.AGENT, ResourceType.REMOTE_AGENT];
        const soleOwnedObjectIds = (
          await getSoleOwnedResourceIds(userId as never, agentResourceTypes)
        ).map(String);

        const authoredAgents = await agents().find(
          { author: userId },
          { projection: { id: 1, _id: 1, tenantId: 1 } },
        );
        const migratedEntries =
          authoredAgents.length > 0
            ? await aclEntries.find(
                {
                  resourceType: { $in: agentResourceTypes },
                  resourceId: { $in: authoredAgents.map((a) => String(a._id)) },
                },
                { projection: { resourceId: 1 } },
              )
            : [];
        const migratedIds = new Set(migratedEntries.map((e) => String(e.resourceId)));
        const legacyAgents = authoredAgents.filter((a) => !migratedIds.has(String(a._id)));

        const soleOwnedAgents =
          soleOwnedObjectIds.length > 0
            ? await agents().find(
                { _id: { $in: soleOwnedObjectIds } },
                { projection: { id: 1, _id: 1, tenantId: 1 } },
              )
            : [];

        const allAgents = [...soleOwnedAgents, ...legacyAgents];
        /** Sole-owned ids whose agent is already gone: ACLs left by an interrupted earlier attempt. */
        const aclResourceIds = [...soleOwnedObjectIds, ...legacyAgents.map((a) => String(a._id))];
        if (aclResourceIds.length === 0) {
          return;
        }

        /** Reference cleanup precedes the irreversible delete, so a failure keeps the agent discoverable for retry. */
        for (const [tenant, tenantAgentIds] of agentIdsByTenant(allAgents)) {
          await removeAgentIdsFromEdges(edgeSteps, tenantAgentIds, tenant);
          const favoritesFilter = {
            tenantId: tenant,
            'favorites.agentId': { $in: tenantAgentIds },
          };
          const holders = await findFavoriteHolders(favoritesFilter);
          await users().updateMany(favoritesFilter, {
            $pull: { favorites: { agentId: { $in: tenantAgentIds } } },
          });
          await evictAuthUserDocsForUsers(deps.getCache, holders);
        }

        await agents().deleteMany({ _id: { $in: allAgents.map((agent) => String(agent._id)) } });
        /** ACL entries are the retry discovery key for sole-owned agents, so they go last. */
        await aclEntries.deleteMany({
          resourceType: { $in: agentResourceTypes },
          resourceId: { $in: aclResourceIds },
        });
      } catch (error) {
        logger.error('[deleteUserAgents] General error:', error);
        throw error;
      }
    },
  };
  return store;
}

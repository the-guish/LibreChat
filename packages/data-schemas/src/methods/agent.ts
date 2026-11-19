import { PermissionBits, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { FilterQuery, Model, PipelineStage, ProjectionType, Types } from 'mongoose';
import type {
  IAgent,
  IAclEntry,
  IUser,
  ActionQuery,
  CacheStore,
  AgentModelSummary,
  AgentGraphNode,
  AgentGraphAccess,
  AgentListSortOption,
  AgentGraphAccessContext,
} from '~/types';
import type { AgentEdgeCleanupSteps, AgentGraphEdges } from './agentRules';
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
  generateActionMetadataHash,
  buildAgentSortCursorCondition,
  AGENT_OWNER_CONTACT_RESOLVED_FIELD,
} from './agentRules';
import { evictAuthUserDocsForUsers, isAuthUserDocCacheEnabled } from '~/utils/eviction';
import { withCodeEnvironmentReferences } from './codeEnvironment';
import { OWNER_ACL_PERMISSION_BIT_SUPERSETS } from './aclEntry';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { filterExistingSkillIds } from './skill';
import logger from '~/config/winston';

export {
  pruneEdges,
  EDGE_CLEANUP_BATCH,
  AgentSortCursorError,
  EDGE_CLEANUP_MAX_SWEEPS,
  AGENT_OWNER_CONTACT_RESOLVED_FIELD,
} from './agentRules';
export type { AgentSortCursorFailure } from './agentRules';

/**
 * The aggregation-expression shapes the predicate helpers below build: a field path
 * (`'$$e.grantedAt'`), a literal, or a nested operator. Narrow on purpose — the
 * fragments these helpers hand to `$filter`/`$switch`/`$cond` are only correct in
 * these forms, and a wider `Record<string, unknown>` would let a misspelled operator
 * or a wrong-arity operand list through to the production pipeline.
 */
type AggregationOperand = string | number | null | AggregationExpression;

type AggregationExpression =
  | { $and: AggregationExpression[] }
  | { $or: AggregationExpression[] }
  | { $eq: [AggregationOperand, AggregationOperand] }
  | { $ne: [AggregationOperand, AggregationOperand] }
  | { $lt: [AggregationOperand, AggregationOperand] }
  | { $cond: [AggregationExpression, AggregationOperand, AggregationOperand] }
  | { $indexOfCP: [AggregationOperand, AggregationOperand] }
  | { $in: [AggregationOperand, number[]] }
  | { $type: AggregationOperand }
  | { $trim: { input: AggregationOperand } }
  | { $ifNull: [AggregationOperand, AggregationOperand] }
  | { $arrayElemAt: [AggregationOperand, AggregationOperand] };

/**
 * Picks the earlier of two ACL entry sub-documents by (`grantedAt`, `createdAt`, `_id`) —
 * the same tie-break `getFirstOwnerIdsByResource` applies via its `$sort`+`$group` pipeline
 * (`api/server/services/Agents/ownerContact.js`). Written as a manual `$lt`/`$eq` cascade,
 * not `$sortArray`+`$first`, because DocumentDB (this project's CI gate,
 * `documentdb.spec.ts`) rejects `$sortArray` outright.
 *
 * Every timestamp is read through `$ifNull` because an imported or legacy entry can omit
 * `grantedAt` or `createdAt` entirely. `$sort` reads a missing field as null, while a
 * missing field path in a comparison expression is `undefined`, which BSON orders below
 * null — so without this the cascade would rank an entry that omits the field ahead of one
 * that stores null, and an author page would name a different owner than every other list
 * order for the same stored ACL data.
 */
const aclOrderKey = (path: string): AggregationExpression => ({ $ifNull: [path, null] });

function earlierAclEntry(a: string, b: string): AggregationExpression {
  return {
    $or: [
      { $lt: [aclOrderKey(`${a}.grantedAt`), aclOrderKey(`${b}.grantedAt`)] },
      {
        $and: [
          { $eq: [aclOrderKey(`${a}.grantedAt`), aclOrderKey(`${b}.grantedAt`)] },
          {
            $or: [
              { $lt: [aclOrderKey(`${a}.createdAt`), aclOrderKey(`${b}.createdAt`)] },
              {
                $and: [
                  { $eq: [aclOrderKey(`${a}.createdAt`), aclOrderKey(`${b}.createdAt`)] },
                  { $lt: [`${a}._id`, `${b}._id`] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * `true` when `varRef` (already `$trim`-ed by the caller, so it is either `null` or a
 * non-empty-checked string) is usable as a display name: non-empty, and not email-shaped.
 * Mirrors `normalizeDisplayName` (`packages/api/src/agents/contact.ts`), which the card's
 * owner-fallback also runs through — an owner's account email is never shown as their
 * display name, only an opted-in `support_contact.email` is.
 *
 * The `$cond` guard keeps `$indexOfCP` from ever running on a `null` input (DocumentDB/Mongo
 * both throw on that): when `varRef` is `null` the guard short-circuits to `-1` ("no `@`
 * found"), which is moot anyway since the `$ne: [varRef, null]` branch already fails the
 * `$and` in that case.
 */
function isValidDisplayName(varRef: string): AggregationExpression {
  return {
    $and: [
      { $ne: [varRef, null] },
      { $ne: [varRef, ''] },
      {
        $eq: [{ $cond: [{ $eq: [varRef, null] }, -1, { $indexOfCP: [varRef, '@'] }] }, -1],
      },
    ],
  };
}

/** Converts any stored value to a string-safe trimmed aggregation operand. Mixed legacy
 * fields can contain BSON values that `$trim` rejects, so check the type first. */
function trimStringOrEmpty(value: AggregationOperand): AggregationExpression {
  return {
    $trim: {
      input: {
        $cond: [{ $eq: [{ $type: value }, 'string'] }, value, ''],
      },
    },
  };
}

/** The edge cleanup's storage steps on the agent model: `_id`-ordered pages, a bulk compare-and-set. */
function agentEdgeCleanupSteps(Agent: Model<IAgent>): AgentEdgeCleanupSteps<Types.ObjectId> {
  return {
    async findGraphs(filter, limit) {
      return await Agent.find(filter as FilterQuery<IAgent>)
        .sort({ _id: 1 })
        .limit(limit)
        .select('_id edges')
        .lean<AgentGraphEdges<Types.ObjectId>[]>();
    },
    async compareAndSetEdges(writes) {
      const result = await tenantSafeBulkWrite(
        Agent,
        writes.map((graph) => ({
          updateOne: {
            filter: { _id: graph._id, edges: graph.edges },
            update: { $set: { edges: graph.next } },
          },
        })),
        { ordered: false },
      );
      return result.matchedCount;
    },
  };
}

export interface AgentDeps {
  /** Removes all ACL permissions for a resource. Injected from PermissionService. */
  removeAllPermissions: (params: { resourceType: string; resourceId: unknown }) => Promise<void>;
  /** Gets actions. Created by createActionMethods. */
  getActions: (query: ActionQuery, includeSensitive?: boolean) => Promise<unknown[]>;
  /** Returns resource IDs solely owned by the given user. From createAclEntryMethods. */
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
  /** Resolves ACL principals. Kept inside data-schemas so callers pass plain identity. */
  getUserPrincipals: (params: {
    userId: string | Types.ObjectId;
    role?: string | null;
    idOnTheSource?: string | null;
  }) => Promise<Array<{ principalType: string; principalId?: string | Types.ObjectId }>>;
  /** Resolves ACL-visible resources. Kept inside data-schemas so callers use logical IDs. */
  findAccessibleResources: (
    principals: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: Types.ObjectId[],
  ) => Promise<Types.ObjectId[]>;
  /** Recognizes skill IDs supplied by an external, non-database registry. */
  isExternalSkillId?: (id: string) => boolean;
  /** Returns a cache store for the given key, so favorite cleanup can evict cached auth users. */
  getCache?: (key: string) => CacheStore | undefined;
}

export type {
  AgentModelSummary,
  AgentGraphNode,
  AgentGraphAccess,
  AgentListSortOption,
  AgentGraphAccessContext,
} from '~/types/agent';

export interface GetAgent {
  (searchParameter: FilterQuery<IAgent>): Promise<Omit<IAgent, 'versions'> | null>;
  (
    searchParameter: FilterQuery<IAgent>,
    projection: ProjectionType<IAgent>,
  ): Promise<IAgent | null>;
}

export function createAgentMethods(
  mongoose: typeof import('mongoose'),
  deps: AgentDeps,
): {
  getAgent: GetAgent;
  getAgentName: (id: string, tenantId?: string) => Promise<string | undefined>;
  getAgentVersions: (searchParameter: FilterQuery<IAgent>) => Promise<IAgent['versions'] | null>;
  getAgentWithVersionCount: (
    searchParameter: FilterQuery<IAgent>,
  ) => Promise<(IAgent & { version: number }) | null>;
  getAgents: (
    searchParameter: FilterQuery<IAgent>,
    select?: string | Record<string, number>,
  ) => Promise<IAgent[]>;
  resolveAgentGraphAccess: (access: AgentGraphAccess) => Promise<AgentGraphAccessContext>;
  getAgentGraphNodes: (
    ids: string[],
    access?: AgentGraphAccessContext,
  ) => Promise<AgentGraphNode[]>;
  createAgent: (agentData: Record<string, unknown>) => Promise<IAgent>;
  getAgentIdsByMCPServerName: (serverName: string) => Promise<Types.ObjectId[]>;
  getAgentsWithMCPServerNames: () => Promise<Array<Pick<IAgent, '_id' | 'mcpServerNames'>>>;
  getAgentModelSummaries: (
    agentIds: Array<Types.ObjectId | string>,
  ) => Promise<AgentModelSummary[]>;
  updateAgent: (
    searchParameter: FilterQuery<IAgent>,
    updateData: Record<string, unknown>,
    options?: {
      updatingUserId?: string | null;
      forceVersion?: boolean;
      skipVersioning?: boolean;
    },
  ) => Promise<IAgent | null>;
  updateAgentAvatar: (params: {
    id: string;
    avatar: { filepath: string; source: string };
    /** The avatar the caller read. When given, the write only lands while the stored avatar
     *  still matches it. */
    previousAvatar?: { filepath: string; source: string } | null;
  }) => Promise<boolean>;
  deleteAgent: (searchParameter: FilterQuery<IAgent>) => Promise<IAgent | null>;
  deleteUserAgents: (userId: string) => Promise<void>;
  revertAgentVersion: (
    searchParameter: FilterQuery<IAgent>,
    versionIndex: number,
  ) => Promise<IAgent>;
  countPromotedAgents: () => Promise<number>;
  addAgentResourceFile: ({
    agent_id,
    tool_resource,
    file_id,
    updatingUserId,
  }: {
    agent_id: string;
    tool_resource: string;
    file_id: string;
    updatingUserId?: string;
  }) => Promise<IAgent>;
  getListAgentsByAccess: ({
    accessibleIds,
    otherParams,
    tenantId,
    limit,
    after,
    includeSkillConfig,
    includeExecutionConfig,
    sort,
  }: {
    /** ObjectIds, or their hex strings (cast by `.find()`, not by the `author` aggregation). */
    accessibleIds?: IdLike[] | null;
    otherParams?: Record<string, unknown>;
    /** Authenticated tenant for unrestricted listings; null/omitted restricts to legacy agents. */
    tenantId?: string | null;
    limit?: number | null;
    after?: string | null;
    includeSkillConfig?: boolean;
    includeExecutionConfig?: boolean;
    sort?: AgentListSortOption;
  }) => Promise<{
    object: string;
    data: Array<Record<string, unknown>>;
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
    after: string | null;
  }>;
  getAgentManagementListByAccess: ({
    accessibleIds,
    tenantId,
    limit,
    after,
  }: {
    /** `null` means the caller already passed the unrestricted management-capability check. */
    accessibleIds: Types.ObjectId[] | null;
    tenantId: string;
    limit: number;
    after?: string | null;
  }) => Promise<{
    data: Array<IAgent & { version: number; createdAt: Date; updatedAt: Date }>;
    has_more: boolean;
    after: string | null;
  }>;
  removeAgentResourceFiles: ({
    agent_id,
    files,
  }: {
    agent_id: string;
    files: Array<{ tool_resource: string; file_id: string }>;
  }) => Promise<IAgent>;
  generateActionMetadataHash: typeof generateActionMetadataHash;
  removeAgentFromUserFavorites: (resourceId: string, userIds: string[]) => Promise<void>;
  removeAgentResourceFilesFromAllAgents: ({
    file_ids,
  }: {
    file_ids: string[];
  }) => Promise<{ matchedCount: number; modifiedCount: number }>;
  getSharedResourceFileIds: ({
    file_ids,
    excludeAgentObjectId,
    excludeToolResource,
  }: {
    file_ids: string[];
    excludeAgentObjectId?: string;
    excludeToolResource?: string;
  }) => Promise<string[]>;
} {
  const { removeAllPermissions, getActions, getSoleOwnedResourceIds, isExternalSkillId } = deps;

  /** Drops the allowlist ids whose skill no longer exists here or in the external registry. */
  const pruneSkills = (skillIds: string[]) =>
    filterExistingSkillIds(mongoose, skillIds, isExternalSkillId);

  async function restoreAgentAfterReferenceLoss(
    Agent: Model<IAgent>,
    agentAfterWrite: IAgent | null,
    originalAgent: IAgent,
    lostEnvironmentId: string,
  ): Promise<void> {
    if (agentAfterWrite == null) return;
    const { updatedAt } = agentAfterWrite as IAgent & { updatedAt: Date };
    const restored = await Agent.replaceOne(
      {
        _id: agentAfterWrite._id,
        $or: [
          { code_environment_id: lostEnvironmentId },
          { code_environment_ids: lostEnvironmentId },
        ],
        updatedAt,
      },
      originalAgent,
      { timestamps: false },
    );
    if (restored.matchedCount === 0) {
      /** A concurrent writer may have changed the document after the guarded
       * write. Never erase that writer, but still remove the lost reference if
       * it remains active. */
      await Agent.updateOne(
        { _id: agentAfterWrite._id, code_environment_id: lostEnvironmentId },
        { $unset: { code_environment_id: 1 } },
      );
      await Agent.updateOne(
        { _id: agentAfterWrite._id, code_environment_ids: lostEnvironmentId },
        { $pull: { code_environment_ids: lostEnvironmentId } },
      );
    }
  }

  /**
   * Create an agent with the provided data.
   */
  async function createAgent(agentData: Record<string, unknown>): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const initialAgentData = await prepareAgentCreate(agentData, pruneSkills);

    return await withCodeEnvironmentReferences(
      mongoose,
      codeEnvironmentReferences(agentData),
      async () => (await Agent.create(initialAgentData)).toObject() as IAgent,
      async (createdAgent) => {
        await Agent.deleteOne({ _id: createdAgent._id });
      },
    );
  }

  /**
   * Get an agent document based on the provided search parameter.
   * Without an explicit projection, the unbounded `versions` history is excluded;
   * pass `{}` (or a projection including `versions`) to read the full history.
   */
  const getAgent: GetAgent = async (
    searchParameter: FilterQuery<IAgent>,
    projection: ProjectionType<IAgent> = { versions: 0 },
  ): Promise<IAgent | null> => {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.findOne(searchParameter, projection).lean<IAgent>();
  };

  /** Storage-neutral display-name lookup for a known execution subject. */
  async function getAgentName(id: string, tenantId?: string): Promise<string | undefined> {
    const agent = await getAgent(
      { id, tenantId: tenantId ?? null },
      { name: 1, tenantId: 1, _id: 0 },
    );
    if ((agent?.tenantId ?? undefined) !== tenantId) return undefined;
    return agent?.name || undefined;
  }

  /**
   * Get an agent's version history only, without the rest of the document.
   * Returns an empty array when the agent exists but has no versions, or `null`
   * when no agent matches the search parameter.
   */
  async function getAgentVersions(
    searchParameter: FilterQuery<IAgent>,
  ): Promise<IAgent['versions'] | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const result = await Agent.findOne(searchParameter, { versions: 1, _id: 0 }).lean<
      Pick<IAgent, 'versions'>
    >();
    if (!result) {
      return null;
    }
    return result.versions ?? [];
  }

  /**
   * Get an agent document with a `version` count, excluding the heavy `versions` array.
   * Used when loading the editor so large version histories aren't transferred eagerly.
   */
  async function getAgentWithVersionCount(
    searchParameter: FilterQuery<IAgent>,
  ): Promise<(IAgent & { version: number }) | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const [agent] = await Agent.aggregate<IAgent & { version: number }>([
      { $match: searchParameter },
      { $addFields: { version: { $size: { $ifNull: ['$versions', []] } } } },
      { $project: { versions: 0 } },
    ]);
    return agent ?? null;
  }

  /**
   * Get multiple agent documents based on the provided search parameters.
   */
  async function getAgents(
    searchParameter: FilterQuery<IAgent>,
    select?: string | Record<string, number>,
  ): Promise<IAgent[]> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.find(searchParameter, select).lean<IAgent[]>();
  }

  /**
   * Loads a bounded graph frontier by logical agent ID and optionally applies VIEW ACLs.
   * Storage IDs are used only inside this method and never cross the package boundary.
   */
  async function resolveAgentGraphAccess(
    access: AgentGraphAccess,
  ): Promise<AgentGraphAccessContext> {
    return (await deps.getUserPrincipals(access)) as unknown as AgentGraphAccessContext;
  }

  async function getAgentGraphNodes(
    ids: string[],
    access?: AgentGraphAccessContext,
  ): Promise<AgentGraphNode[]> {
    if (ids.length === 0) {
      return [];
    }
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agents = await Agent.find(
      { id: { $in: ids } },
      {
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
    ).lean<
      Array<
        Pick<
          IAgent,
          | '_id'
          | 'id'
          | 'provider'
          | 'model'
          | 'tools'
          | 'mcpServerNames'
          | 'agent_ids'
          | 'edges'
          | 'subagents'
        >
      >
    >();
    let visible = agents;
    if (access != null) {
      const principals = access as unknown as Array<{
        principalType: string;
        principalId?: string | Types.ObjectId;
      }>;
      const resourceIds = await deps.findAccessibleResources(
        principals,
        ResourceType.AGENT,
        PermissionBits.VIEW,
        agents.map((agent) => agent._id),
      );
      const allowed = new Set(resourceIds.map(String));
      visible = agents.filter((agent) => allowed.has(String(agent._id)));
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
  }

  /** Returns the ids of every agent referencing `serverName`, the candidate set
   *  for agent-mediated MCP access checks. Index-covered by `mcpServerNames`. */
  async function getAgentIdsByMCPServerName(serverName: string): Promise<Types.ObjectId[]> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agents = await Agent.find({ mcpServerNames: serverName }, { _id: 1 }).lean<
      Array<Pick<IAgent, '_id'>>
    >();
    return agents.map((agent) => agent._id);
  }

  /** Loads only the fields a models list shows, never the unbounded `versions` history. */
  async function getAgentModelSummaries(
    agentIds: Array<Types.ObjectId | string>,
  ): Promise<AgentModelSummary[]> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.find(
      { _id: { $in: agentIds } },
      { id: 1, name: 1, description: 1, provider: 1, author: 1, createdAt: 1 },
    ).lean<AgentModelSummary[]>();
  }

  /** Returns every agent with a non-empty `mcpServerNames`, so access
   *  calculations can start from the (typically small) set of agents that
   *  actually reference MCP servers instead of every accessible agent. */
  async function getAgentsWithMCPServerNames(): Promise<
    Array<Pick<IAgent, '_id' | 'mcpServerNames'>>
  > {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.find({ mcpServerNames: { $type: 'string' } }, { mcpServerNames: 1 }).lean<
      Array<Pick<IAgent, '_id' | 'mcpServerNames'>>
    >();
  }

  /**
   * Update an agent with new data without overwriting existing properties,
   * or create a new agent if it doesn't exist.
   * When an agent is updated, a copy of the current state will be saved to the versions array.
   */
  async function updateAgent(
    searchParameter: FilterQuery<IAgent>,
    updateData: Record<string, unknown>,
    options: {
      updatingUserId?: string | null;
      forceVersion?: boolean;
      skipVersioning?: boolean;
    } = {},
  ): Promise<IAgent | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const mongoOptions = { new: true, upsert: false };
    /** Set when the update would snapshot a version identical to the newest one. The write
     *  still lands; only the `versions` entry is dropped. */
    let suppressedVersionEntry = false;

    const currentAgent = await Agent.findOne(searchParameter);
    const currentRevision = (currentAgent as (IAgent & { updatedAt: Date }) | null)?.updatedAt;
    if (currentAgent) {
      const currentObject = currentAgent.toObject() as unknown as Record<string, unknown>;
      ({ suppressedVersionEntry } = await prepareAgentUpdate(currentObject, updateData, options, {
        pruneSkills,
        getActions: (actionIds) => getActions({ actionId: actionIds }, true),
        toUserId: (userId) => new mongoose.Types.ObjectId(userId),
        onActionsError: (error) => {
          logger.error('Error fetching actions for hash generation:', error);
        },
      }));
    }

    const nextEnvironmentIds = agentUpdateEnvironmentIds(updateData);
    const updatedAgent = await withCodeEnvironmentReferences(
      mongoose,
      nextEnvironmentIds,
      async () =>
        (await Agent.findOneAndUpdate(
          currentAgent == null || nextEnvironmentIds.length === 0
            ? searchParameter
            : { ...searchParameter, _id: currentAgent._id, updatedAt: currentRevision },
          updateData,
          mongoOptions,
        ).lean()) as IAgent | null,
      async (agentAfterUpdate, lostEnvironmentId) => {
        if (agentAfterUpdate == null) return;
        if (currentAgent == null) return;
        await restoreAgentAfterReferenceLoss(
          Agent,
          agentAfterUpdate,
          currentAgent.toObject() as IAgent,
          lostEnvironmentId,
        );
      },
    );

    /** `version` is a response-only field holding the count of `versions`. It is reported
     *  here so a suppressed entry keeps the shape callers saw before the write was fixed.
     *  It answers "was a version recorded", never "did the update apply". The two stopped
     *  being the same question once a suppressed update started landing. */
    if (updatedAgent && suppressedVersionEntry) {
      (updatedAgent as IAgent & { version?: number }).version = updatedAgent.versions?.length ?? 0;
    }

    return updatedAgent;
  }

  /** Updates only the stored avatar metadata; maintenance must not advance list cursors. */
  async function updateAgentAvatar({
    id,
    avatar,
    previousAvatar,
  }: {
    id: string;
    avatar: { filepath: string; source: string };
    previousAvatar?: { filepath: string; source: string } | null;
  }): Promise<boolean> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const searchParameter = agentAvatarFilter(id, previousAvatar) as FilterQuery<IAgent>;
    const result = await Agent.updateOne(
      searchParameter,
      { $set: { avatar } },
      { timestamps: false },
    );
    return result.matchedCount > 0;
  }

  /**
   * Modifies an agent with the resource file id.
   */
  async function addAgentResourceFile({
    agent_id,
    tool_resource,
    file_id,
    updatingUserId,
  }: {
    agent_id: string;
    tool_resource: string;
    file_id: string;
    updatingUserId?: string;
  }): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const searchParameter = { id: agent_id };
    const agent = await getAgent(searchParameter);
    if (!agent) {
      throw new Error('Agent not found for adding resource file');
    }
    const fileIdsPath = `tool_resources.${tool_resource}.file_ids`;
    await Agent.updateOne(
      {
        id: agent_id,
        [`${fileIdsPath}`]: { $exists: false },
      },
      {
        $set: {
          [`${fileIdsPath}`]: [],
        },
      },
    );

    const updateDataObj: Record<string, unknown> = {
      $addToSet: {
        tools: tool_resource,
        [fileIdsPath]: file_id,
      },
    };

    const updatedAgent = await updateAgent(searchParameter, updateDataObj, {
      updatingUserId,
    });
    if (updatedAgent) {
      return updatedAgent;
    } else {
      throw new Error('Agent not found for adding resource file');
    }
  }

  /**
   * Removes multiple resource files from an agent using atomic operations.
   */
  async function removeAgentResourceFiles({
    agent_id,
    files,
  }: {
    agent_id: string;
    files: Array<{ tool_resource: string; file_id: string }>;
  }): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const searchParameter = { id: agent_id };

    const updatePullData = agentResourceFilesPull(files);
    const agentAfterPull = (await Agent.findOneAndUpdate(searchParameter, updatePullData, {
      new: true,
    }).lean()) as IAgent | null;

    if (!agentAfterPull) {
      const agentExists = await getAgent(searchParameter);
      if (!agentExists) {
        throw new Error('Agent not found for removing resource files');
      }
      throw new Error('Failed to update agent during file removal (pull step)');
    }

    return agentAfterPull;
  }

  /**
   * Removes the given file_ids from every agent's `tool_resources.*.file_ids`
   * so file deletion cannot leave orphaned stubs behind (see issue #12776).
   */
  async function removeAgentResourceFilesFromAllAgents({
    file_ids,
  }: {
    file_ids: string[];
  }): Promise<{ matchedCount: number; modifiedCount: number }> {
    if (!file_ids || file_ids.length === 0) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const Agent = mongoose.models.Agent as Model<IAgent>;

    const result = await Agent.updateMany(
      toolResourceFilesFilter(file_ids) as FilterQuery<IAgent>,
      toolResourceFilesPullAll(file_ids),
    );
    return {
      matchedCount: result.matchedCount ?? 0,
      modifiedCount: result.modifiedCount ?? 0,
    };
  }

  /**
   * Reports which of the given file_ids keep a reference once the caller's own is removed, so a
   * caller can tell a last reference from a shared one.
   *
   * The unit of a reference is the `(agent, tool_resource)` pair rather than the agent:
   * `addAgentResourceFile` stores `file_ids` per resource, so one agent can hold the same file under
   * both `file_search` and `context`, and removing it from one leaves the other needing the bytes.
   * `excludeToolResource` narrows the exclusion to the pair being removed; omitting it excludes the
   * whole agent.
   *
   * The agent is excluded by `_id`, because `id` is unique only together with `tenantId`: matching on
   * `id` alone would skip another tenant's agent of the same name and call its file unreferenced.
   *
   * Duplicating an agent copies `file_ids` rather than the files behind them, so one file record
   * can back two agents; destroying its bytes on behalf of one agent would empty the other. This
   * is deliberately not scoped by tenant: a reference is a reference, whoever holds it.
   */
  async function getSharedResourceFileIds({
    file_ids,
    excludeAgentObjectId,
    excludeToolResource,
  }: {
    file_ids: string[];
    excludeAgentObjectId?: string;
    excludeToolResource?: string;
  }): Promise<string[]> {
    if (!file_ids || file_ids.length === 0) {
      return [];
    }

    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agents = await Agent.find(toolResourceFilesFilter(file_ids) as FilterQuery<IAgent>, {
      _id: 1,
      tool_resources: 1,
    }).lean();
    return sharedResourceFileIds(agents, file_ids, excludeAgentObjectId, excludeToolResource);
  }

  /** Users whose favorites match, read only when their cached auth documents need evicting. */
  async function findFavoriteHolders(filter: FilterQuery<unknown>): Promise<string[]> {
    if (!isAuthUserDocCacheEnabled()) {
      return [];
    }
    const ids = await (mongoose.models.User as Model<unknown>).distinct('_id', filter);
    return ids.map(String);
  }

  /**
   * Deletes an agent based on the provided search parameter.
   */
  async function deleteAgent(searchParameter: FilterQuery<IAgent>): Promise<IAgent | null> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const User = mongoose.models.User as Model<unknown>;
    const agent = await Agent.findOneAndDelete(searchParameter);
    if (agent) {
      const deletedAgent = agent as unknown as { id: string; tenantId?: string };
      await Promise.all([
        removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: agent._id,
        }),
        removeAllPermissions({
          resourceType: ResourceType.REMOTE_AGENT,
          resourceId: agent._id,
        }),
      ]);
      try {
        await removeAgentIdsFromEdges(
          agentEdgeCleanupSteps(Agent),
          [deletedAgent.id],
          deletedAgent.tenantId,
        );
      } catch (error) {
        logger.error('[deleteAgent] Error removing agent from handoff edges', error);
      }
      try {
        const favoritesFilter = {
          ...(deletedAgent.tenantId !== undefined ? { tenantId: deletedAgent.tenantId } : {}),
          'favorites.agentId': deletedAgent.id,
        };
        const holders = await findFavoriteHolders(favoritesFilter);
        await User.updateMany(favoritesFilter, {
          $pull: { favorites: { agentId: deletedAgent.id } },
        });
        await evictAuthUserDocsForUsers(deps.getCache, holders);
      } catch (error) {
        logger.error('[deleteAgent] Error removing agent from user favorites', error);
      }
    }
    return agent ? (agent.toObject() as IAgent) : null;
  }

  /**
   * Deletes agents solely owned by the user and cleans up their ACLs.
   * Agents with other owners are left intact; the caller is responsible for
   * removing the user's own ACL principal entries separately.
   *
   * Also handles legacy (pre-ACL) agents that only have the author field set,
   * ensuring they are not orphaned if no permission migration has been run.
   */
  async function deleteUserAgents(userId: string): Promise<void> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const User = mongoose.models.User as Model<unknown>;

    try {
      const userObjectId = new mongoose.Types.ObjectId(userId);
      const soleOwnedObjectIds = await getSoleOwnedResourceIds(userObjectId, [
        ResourceType.AGENT,
        ResourceType.REMOTE_AGENT,
      ]);

      const authoredAgents = await Agent.find({ author: userObjectId })
        .select('id _id tenantId')
        .lean();

      const migratedEntries =
        authoredAgents.length > 0
          ? await AclEntry.find({
              resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
              resourceId: { $in: authoredAgents.map((a) => a._id) },
            })
              .select('resourceId')
              .lean()
          : [];
      const migratedIds = new Set(migratedEntries.map((e) => e.resourceId.toString()));
      const legacyAgents = authoredAgents.filter((a) => !migratedIds.has(a._id.toString()));

      const soleOwnedAgents =
        soleOwnedObjectIds.length > 0
          ? await Agent.find({ _id: { $in: soleOwnedObjectIds } })
              .select('id _id tenantId')
              .lean()
          : [];

      const allAgents = [...soleOwnedAgents, ...legacyAgents];
      /** Sole-owned ids whose agent is already gone: ACLs left by an interrupted earlier attempt. */
      const aclResourceIds = [...soleOwnedObjectIds, ...legacyAgents.map((a) => a._id)];

      if (aclResourceIds.length === 0) {
        return;
      }

      const agentObjectIds = allAgents.map((agent) => agent._id);
      /** Agent ids are unique per tenant only, so reference cleanup runs once per agent tenant. */
      const idsByTenant = agentIdsByTenant(allAgents);
      /** Reference cleanup precedes the irreversible delete, so a failure keeps the agent discoverable for retry. */
      for (const [tenant, tenantAgentIds] of idsByTenant) {
        await removeAgentIdsFromEdges(agentEdgeCleanupSteps(Agent), tenantAgentIds, tenant);
        const favoritesFilter = { tenantId: tenant, 'favorites.agentId': { $in: tenantAgentIds } };
        const holders = await findFavoriteHolders(favoritesFilter);
        await User.updateMany(favoritesFilter, {
          $pull: { favorites: { agentId: { $in: tenantAgentIds } } },
        });
        await evictAuthUserDocsForUsers(deps.getCache, holders);
      }

      await Agent.deleteMany({ _id: { $in: agentObjectIds } });
      /** ACL entries are the retry discovery key for sole-owned agents, so they go last. */
      await AclEntry.deleteMany({
        resourceType: { $in: [ResourceType.AGENT, ResourceType.REMOTE_AGENT] },
        resourceId: { $in: aclResourceIds },
      });
    } catch (error) {
      logger.error('[deleteUserAgents] General error:', error);
      throw error;
    }
  }

  /**
   * Get agents by accessible IDs with cursor pagination. Pass `accessibleIds: null`
   * only after a management-capability check, with the authenticated tenantId
   * (or null for legacy agents); `[]` and omitted IDs match nothing.
   * Defaults to the most-recently-edited order and a 100-page limit (max 1000);
   * pass `limit: null` to opt out entirely. Other sort modes preserve the projection.
   */
  async function getListAgentsByAccess(params: {
    accessibleIds?: IdLike[] | null;
    otherParams?: Record<string, unknown>;
    tenantId?: string | null;
    limit?: number | null;
    after?: string | null;
    includeSkillConfig?: boolean;
    includeExecutionConfig?: boolean;
    sort?: AgentListSortOption;
  }): Promise<{
    object: string;
    data: Array<Record<string, unknown>>;
    first_id: string | null;
    last_id: string | null;
    has_more: boolean;
    after: string | null;
  }> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const { after = null, includeExecutionConfig = false } = params;
    const { isPaginated, normalizedLimit, sort, baseQuery, projection } = normalizeAgentList(
      params,
      (author) => new mongoose.Types.ObjectId(author),
    );

    const finalizeAgent = (agent: Record<string, unknown>): Record<string, unknown> =>
      finalizeListedAgent(agent, includeExecutionConfig);

    /** Removes internal sort fields after the mode-specific cursor is built. */
    const buildEnvelope = agentListEnvelope;

    /** A cursor that cannot be honored is an error, never a page-one restart. */
    const readCursor = () => readAgentSortCursor(after, sort);

    if (sort === 'popular') {
      const User = mongoose.models.User as Model<IUser>;
      return await listAgentsByPopularity<Types.ObjectId>(
        { baseQuery, projection, normalizedLimit, readCursor, finalize: finalizeAgent },
        {
          async countFavorites() {
            const countRows = (await User.aggregate([
              { $match: { 'favorites.agentId': { $exists: true } } },
              {
                $project: {
                  tenantId: 1,
                  favoriteAgentIds: {
                    $setUnion: [{ $ifNull: ['$favorites.agentId', []] }, []],
                  },
                },
              },
              { $unwind: '$favoriteAgentIds' },
              {
                $group: {
                  _id: {
                    tenantId: '$tenantId',
                    agentId: '$favoriteAgentIds',
                  },
                  favoriteCount: { $sum: 1 },
                },
              },
            ])) as Array<{
              _id: { tenantId?: string | null; agentId: string };
              favoriteCount: number;
            }>;
            return countRows.map((row) => ({
              tenantId: row?._id?.tenantId,
              agentId: row?._id?.agentId,
              favoriteCount: row?.favoriteCount,
            }));
          },
          async findFavoritedRows(filter) {
            return (await Agent.find(filter as FilterQuery<IAgent>, {
              _id: 1,
              id: 1,
              tenantId: 1,
            }).lean()) as Array<{ _id: Types.ObjectId; id: string; tenantId?: string | null }>;
          },
          async findAgents(filter, select) {
            return (await Agent.find(filter as FilterQuery<IAgent>, select).lean()) as Array<
              Record<string, unknown>
            >;
          },
          async findTail(filter, select, limit) {
            let tailQuery = Agent.find(filter as FilterQuery<IAgent>, select).sort({ _id: 1 });
            if (limit != null) {
              tailQuery = tailQuery.limit(limit);
            }
            return (await tailQuery.lean()) as Array<Record<string, unknown>>;
          },
          toId: (hex) => new mongoose.Types.ObjectId(hex),
        },
      );
    }

    if (sort === 'author') {
      const pipeline: PipelineStage[] = [{ $match: baseQuery }];
      /* Resolve the same owner contact used by the agent card before sorting. The join
         matches on `resourceId` alone because a compound `localField` is not a thing, so
         the resource type is asserted in the filter below: `AGENT` and `REMOTE_AGENT`
         entries share an agent's `_id`, and `attachOwnerContacts` counts only the
         `AGENT` ones as ownership. */
      pipeline.push({
        $lookup: {
          from: 'aclentries',
          localField: '_id',
          foreignField: 'resourceId',
          /* Aggregation lookups bypass the ACL model's tenant middleware. The joined
           * array is narrowed in the following stage because DocumentDB 5.0 does not
           * support the `$lookup` `let`/`pipeline` form. */
          as: '_ownerAclEntries',
        },
      });
      pipeline.push({
        $addFields: {
          _ownerAclEntries: {
            $filter: {
              input: '$_ownerAclEntries',
              as: 'e',
              cond: {
                $eq: [{ $ifNull: ['$$e.tenantId', null] }, { $ifNull: ['$tenantId', null] }],
              },
            },
          },
        },
      });
      pipeline.push({
        $addFields: {
          _ownerId: {
            $let: {
              vars: {
                ownerEntry: {
                  $reduce: {
                    input: {
                      $filter: {
                        input: '$_ownerAclEntries',
                        as: 'e',
                        cond: {
                          $and: [
                            { $eq: ['$$e.resourceType', ResourceType.AGENT] },
                            { $eq: ['$$e.principalType', PrincipalType.USER] },
                            {
                              $in: ['$$e.permBits', [...OWNER_ACL_PERMISSION_BIT_SUPERSETS]],
                            },
                          ],
                        },
                      },
                    },
                    initialValue: null,
                    in: {
                      $cond: [
                        { $eq: ['$$value', null] },
                        '$$this',
                        {
                          $cond: [earlierAclEntry('$$this', '$$value'), '$$this', '$$value'],
                        },
                      ],
                    },
                  },
                },
              },
              in: { $ifNull: ['$$ownerEntry.principalId', '$author'] },
            },
          },
        },
      });
      pipeline.push({
        $lookup: {
          from: 'users',
          localField: '_ownerId',
          foreignField: '_id',
          /* User lookups bypass the User model's tenant middleware too. Filter the
           * joined array afterwards to keep imported principals in their own tenant. */
          as: '_ownerUser',
        },
      });
      pipeline.push({
        $addFields: {
          _ownerUser: {
            $filter: {
              input: '$_ownerUser',
              as: 'u',
              cond: {
                $eq: [{ $ifNull: ['$$u.tenantId', null] }, { $ifNull: ['$tenantId', null] }],
              },
            },
          },
        },
      });
      pipeline.push({
        $addFields: {
          /* Trimmed once so the sort key and the owner contact below read exactly the
           * same values. Every operand is checked for BSON string type first because
           * imported legacy values can make `$trim` fail the whole aggregation. */
          _supportName: trimStringOrEmpty('$support_contact.name'),
          _supportEmail: trimStringOrEmpty('$support_contact.email'),
          _ownerName: trimStringOrEmpty({ $arrayElemAt: ['$_ownerUser.name', 0] }),
          _ownerUsername: trimStringOrEmpty({ $arrayElemAt: ['$_ownerUser.username', 0] }),
          // Dead on Agent documents in practice (only Prompts/Skills write it) —
          // kept as the final real-value tier for exact parity with
          // `resolveAgentOwnerContact`, which checks it too.
          _authorName: trimStringOrEmpty('$authorName'),
          _hasOwnerUser: { $gt: [{ $size: { $ifNull: ['$_ownerUser', []] } }, 0] },
        },
      });
      pipeline.push({
        $addFields: {
          authorDisplayName: {
            $switch: {
              branches: [
                { case: { $ne: ['$_supportName', ''] }, then: '$_supportName' },
                { case: { $ne: ['$_supportEmail', ''] }, then: '$_supportEmail' },
                { case: isValidDisplayName('$_ownerName'), then: '$_ownerName' },
                { case: isValidDisplayName('$_ownerUsername'), then: '$_ownerUsername' },
                { case: isValidDisplayName('$_authorName'), then: '$_authorName' },
              ],
              default: AUTHOR_SORT_SENTINEL,
            },
          },
          /* This pipeline joined the owner in order to sort by it, and that is the same
             owner `attachOwnerContacts` would resolve again — an ACL aggregation plus a
             user query per page. Resolved here instead, on exactly the tiers
             `resolveAgentOwnerContact` applies: a support contact means no owner
             contact at all, and without a joined owner user there is none either, even
             when the agent carries a denormalized `authorName`. `$$REMOVE` is rejected
             by DocumentDB, so "no contact" is an explicit null the caller drops. */
          owner_contact: {
            $cond: [
              { $or: [{ $ne: ['$_supportName', ''] }, { $ne: ['$_supportEmail', ''] }] },
              null,
              {
                $let: {
                  vars: {
                    ownerDisplayName: {
                      $switch: {
                        branches: [
                          { case: isValidDisplayName('$_ownerName'), then: '$_ownerName' },
                          {
                            case: isValidDisplayName('$_ownerUsername'),
                            then: '$_ownerUsername',
                          },
                          { case: isValidDisplayName('$_authorName'), then: '$_authorName' },
                        ],
                        default: null,
                      },
                    },
                  },
                  in: {
                    $cond: [
                      { $and: ['$_hasOwnerUser', { $ne: ['$$ownerDisplayName', null] }] },
                      { name: '$$ownerDisplayName' },
                      null,
                    ],
                  },
                },
              },
            ],
          },
        },
      });
      pipeline.push({
        $addFields: {
          authorSortKey: { $toLower: '$authorDisplayName' },
        },
      });

      // Applied after the `$addFields` above, since it compares against the computed
      // sort key rather than a stored field.
      const decodedCursor = readCursor();
      if (decodedCursor) {
        pipeline.push({
          $match: buildAgentSortCursorCondition(
            sort,
            decodedCursor,
            new mongoose.Types.ObjectId(decodedCursor.secondary),
          ),
        } as PipelineStage);
      }

      pipeline.push({
        $project: {
          ...projection,
          authorDisplayName: 1,
          authorSortKey: 1,
          owner_contact: 1,
        },
      });

      pipeline.push({
        $sort: {
          authorSortKey: AGENT_SORT_CONFIG[sort].direction,
          _id: AGENT_SORT_CONFIG[sort].tieBreakDirection,
        },
      });

      if (isPaginated && normalizedLimit) {
        pipeline.push({ $limit: normalizedLimit + 1 });
      }

      const agents = (await Agent.aggregate(pipeline)) as Array<Record<string, unknown>>;

      const hasMore = isPaginated && normalizedLimit ? agents.length > normalizedLimit : false;
      const trimmed = isPaginated && normalizedLimit ? agents.slice(0, normalizedLimit) : agents;
      const data = trimmed.map((agent) => {
        if (agent.owner_contact == null) {
          delete agent.owner_contact;
        }
        agent[AGENT_OWNER_CONTACT_RESOLVED_FIELD] = true;
        return finalizeAgent(agent);
      });

      let nextCursor: string | null = null;
      if (isPaginated && hasMore && data.length > 0 && normalizedLimit) {
        nextCursor = encodeAgentSortCursor(sort, agents[normalizedLimit - 1]);
      }

      return buildEnvelope(data, hasMore, nextCursor);
    }

    /* The remaining modes sort by a stored date: `createdAt` for the marketplace's newest
       and oldest, whose descending compound index supports both directions by reversing
       the scan, and `updatedAt` for the order this endpoint serves when nothing asks. */
    const { field: dateField, direction: dir, tieBreakDirection } = AGENT_SORT_CONFIG[sort];

    let finalQuery: Record<string, unknown> = baseQuery;
    const decodedCursor = readCursor();
    if (decodedCursor) {
      const cursorCondition = buildAgentSortCursorCondition(
        sort,
        decodedCursor,
        new mongoose.Types.ObjectId(decodedCursor.secondary),
      );
      finalQuery =
        Object.keys(baseQuery).length > 0
          ? { $and: [{ ...baseQuery }, cursorCondition] }
          : { ...cursorCondition };
    }

    let query = Agent.find(finalQuery, projection).sort({
      [dateField]: dir,
      _id: tieBreakDirection,
    });

    if (isPaginated && normalizedLimit) {
      query = query.limit(normalizedLimit + 1);
    }

    const agents = (await query.lean()) as Array<Record<string, unknown>>;

    const hasMore = isPaginated && normalizedLimit ? agents.length > normalizedLimit : false;
    const data = (isPaginated && normalizedLimit ? agents.slice(0, normalizedLimit) : agents).map(
      finalizeAgent,
    );

    let nextCursor: string | null = null;
    if (isPaginated && hasMore && data.length > 0 && normalizedLimit) {
      nextCursor = encodeAgentSortCursor(sort, agents[normalizedLimit - 1]);
    }

    return buildEnvelope(data, hasMore, nextCursor);
  }

  /**
   * Returns the full Agent configuration required by the management response projector.
   * Unlike the browser list path, this query performs no avatar refresh or persistence write.
   */
  async function getAgentManagementListByAccess({
    accessibleIds,
    tenantId,
    limit,
    after = null,
  }: {
    /** `null` means the caller already passed the unrestricted management-capability check. */
    accessibleIds: Types.ObjectId[] | null;
    tenantId: string;
    limit: number;
    after?: string | null;
  }): Promise<{
    data: Array<IAgent & { version: number; createdAt: Date; updatedAt: Date }>;
    has_more: boolean;
    after: string | null;
  }> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const match = agentManagementMatch(
      { accessibleIds, tenantId, after },
      (hex) => new mongoose.Types.ObjectId(hex),
    ) as FilterQuery<IAgent>;

    const agents = await Agent.aggregate<
      IAgent & { version: number; createdAt: Date; updatedAt: Date }
    >([
      { $match: match },
      { $sort: { updatedAt: -1, _id: 1 } },
      { $limit: limit + 1 },
      { $addFields: { version: { $size: { $ifNull: ['$versions', []] } } } },
      { $project: { versions: 0 } },
    ]);

    return agentManagementPage(agents, limit);
  }

  /**
   * Reverts an agent to a specific version in its version history.
   */
  async function revertAgentVersion(
    searchParameter: FilterQuery<IAgent>,
    versionIndex: number,
  ): Promise<IAgent> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const agent = await Agent.findOne(searchParameter);
    if (!agent) {
      throw new Error('Agent not found');
    }

    if (!agent.versions || !agent.versions[versionIndex]) {
      throw new Error(`Version ${versionIndex} not found`);
    }

    const originalRevision = (agent as unknown as IAgent & { updatedAt: Date }).updatedAt;
    const { revertToVersion, revertUpdate } = await prepareAgentRevert(
      agent.versions[versionIndex] as Record<string, unknown>,
      pruneSkills,
    );
    const revertedAgent = await withCodeEnvironmentReferences(
      mongoose,
      codeEnvironmentReferences(revertToVersion),
      async () =>
        await Agent.findOneAndUpdate(
          { ...searchParameter, _id: agent._id, updatedAt: originalRevision },
          revertUpdate,
          { new: true },
        ).lean<IAgent>(),
      async (agentAfterRevert, lostEnvironmentId) => {
        if (agentAfterRevert == null) {
          return;
        }
        await restoreAgentAfterReferenceLoss(
          Agent,
          agentAfterRevert,
          agent.toObject() as IAgent,
          lostEnvironmentId,
        );
      },
    );
    if (!revertedAgent) {
      throw new Error('Agent not found');
    }
    return revertedAgent;
  }

  /**
   * Counts the number of promoted agents.
   */
  async function countPromotedAgents(): Promise<number> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    return await Agent.countDocuments({ is_promoted: true });
  }

  /** Removes an agent from the favorites of specified users. */
  async function removeAgentFromUserFavorites(
    resourceId: string,
    userIds: string[],
  ): Promise<void> {
    const Agent = mongoose.models.Agent as Model<IAgent>;
    const User = mongoose.models.User as Model<unknown>;

    const agent = await Agent.findOne({ _id: resourceId }, { id: 1, tenantId: 1 }).lean();
    if (!agent) {
      return;
    }

    await User.updateMany(
      {
        _id: { $in: userIds },
        ...(agent.tenantId !== undefined ? { tenantId: agent.tenantId } : {}),
        'favorites.agentId': agent.id,
      },
      { $pull: { favorites: { agentId: agent.id } } },
    );
    await evictAuthUserDocsForUsers(deps.getCache, userIds);
  }

  return {
    getAgent,
    getAgentName,
    getAgentVersions,
    getAgentWithVersionCount,
    getAgents,
    resolveAgentGraphAccess,
    getAgentGraphNodes,
    createAgent,
    getAgentIdsByMCPServerName,
    getAgentsWithMCPServerNames,
    getAgentModelSummaries,
    updateAgent,
    updateAgentAvatar,
    deleteAgent,
    deleteUserAgents,
    revertAgentVersion,
    countPromotedAgents,
    addAgentResourceFile,
    getListAgentsByAccess,
    getAgentManagementListByAccess,
    removeAgentResourceFiles,
    generateActionMetadataHash,
    removeAgentFromUserFavorites,
    removeAgentResourceFilesFromAllAgents,
    getSharedResourceFileIds,
  };
}

export type AgentMethods = ReturnType<typeof createAgentMethods>;

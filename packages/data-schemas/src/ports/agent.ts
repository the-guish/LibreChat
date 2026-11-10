/**
 * Agent store port: agent definitions (configuration, tools, the files attached to their tool
 * resources, avatars, version history) and the reads the runtime and the management views make
 * of them. Nothing here may import `mongoose`. Signatures are those of `AgentMethods`
 * (`~/methods/agent`), copied verbatim but for ids typed `Types.ObjectId`, which the port states
 * as `IdLike`, and for the criteria, projections and updates of `getAgent`, `getAgents`,
 * `getAgentVersions`, `getAgentWithVersionCount`, `updateAgent`, `deleteAgent`,
 * `revertAgentVersion` and `getListAgentsByAccess`, which the port states in the store query
 * language (`./query`); `agent.spec.ts` fails the typecheck if the MongoDB methods stop
 * satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`).
 * - An agent's `id` is its logical id (unique per tenant); `_id` is the id the store generated.
 * - Authorization is enforced by callers, except where a method takes resolved ACL input
 *   (`getAgentGraphNodes` with an access context, the `*ByAccess` listings).
 * - The methods that take a filter act on the first agent it matches (`getAgents`: on every
 *   one); callers select one agent by its `id` (with `tenantId`), or by `_id`.
 * - An agent's `versions` is its history: one snapshot of the agent per recorded change, oldest
 *   first. The single-agent reads leave it out unless a projection asks for it.
 *
 * `generateActionMetadataHash` is not in the port: it is a pure hashing helper and reads and
 * writes nothing.
 *
 * Known leaks kept for now so callers stay unchanged: `IAgent` extends mongoose's `Document`
 * (its `_id` and `author` are ObjectIds), so do the records built from it
 * (`AgentModelSummary`, the `getAgentsWithMCPServerNames` rows, the listings);
 * `createAgent` takes the agent's fields as an untyped record. Three reads match in a MongoDB
 * aggregation, which does not cast values through the schema: `getAgentWithVersionCount` (its
 * filter), `getListAgentsByAccess` in the `author` order (its `accessibleIds` and `otherParams`
 * but `author`), and `getAgentManagementListByAccess` (its `accessibleIds`). Give the ids there
 * as the id values the store handed out (as `findAccessibleResources` returns them), not their
 * string form; the other conditions callers pass there compare string, boolean and date fields,
 * which need no cast.
 */
import type {
  IAgent,
  AgentGraphNode,
  AgentGraphAccess,
  AgentModelSummary,
  AgentListSortOption,
  AgentGraphAccessContext,
} from '~/types';
import type { StoreFilter, StoreProjection, StoreUpdate } from './query';
import type { IdLike } from './common';
import { listPortMethods } from './common';

export interface AgentStore {
  /* ------------------------------------------------------------ reads */

  /** The first agent matching `filter`, without its `versions`, or `null`. */
  getAgent(filter: StoreFilter): Promise<Omit<IAgent, 'versions'> | null>;
  /**
   * The first agent matching `filter`, with the fields `projection` selects (`{}` selects every
   * field, `versions` included), or `null`.
   */
  getAgent(filter: StoreFilter, projection: StoreProjection): Promise<IAgent | null>;
  /** Every agent matching `filter`, with the fields `select` selects (every field without one). */
  getAgents(filter: StoreFilter, select?: StoreProjection): Promise<IAgent[]>;
  /**
   * The `versions` of the first agent matching `filter` (empty when it has none), or `null` when
   * no agent matches.
   */
  getAgentVersions(filter: StoreFilter): Promise<IAgent['versions'] | null>;
  /**
   * The first agent matching `filter`, without its `versions` but with `version`, how many it
   * has, or `null`. The filter is matched in an aggregation (see the leaks above); callers pass
   * `{ id }` or `{ id, tenantId }`.
   */
  getAgentWithVersionCount(filter: StoreFilter): Promise<(IAgent & { version: number }) | null>;

  /**
   * The display name of the agent `id` of `tenantId` (no `tenantId` matches an agent stored
   * without one), or `undefined` when there is no such agent or it has no name.
   */
  getAgentName(id: string, tenantId?: string): Promise<string | undefined>;
  /**
   * Resolves the user's ACL principals once, as an opaque context that `getAgentGraphNodes`
   * filters by. Only the store reads its contents.
   */
  resolveAgentGraphAccess(access: AgentGraphAccess): Promise<AgentGraphAccessContext>;
  /**
   * The graph-relevant fields of the agents `ids` (logical ids). With `access`, only the agents
   * the resolved principals may view; without it, every match. Empty for no ids.
   */
  getAgentGraphNodes(ids: string[], access?: AgentGraphAccessContext): Promise<AgentGraphNode[]>;
  /** The store ids of every agent whose tools reference the MCP server `serverName`. */
  getAgentIdsByMCPServerName(serverName: string): Promise<IdLike[]>;
  /** Every agent that references at least one MCP server, with only its server names. */
  getAgentsWithMCPServerNames(): Promise<Array<Pick<IAgent, '_id' | 'mcpServerNames'>>>;
  /** The fields a models list shows of the agents `agentIds` (store ids), never their history. */
  getAgentModelSummaries(agentIds: IdLike[]): Promise<AgentModelSummary[]>;
  /** How many agents are promoted. */
  countPromotedAgents(): Promise<number>;
  /**
   * One page of the agents that match `otherParams` and are among `accessibleIds` (store ids),
   * with the fields a listing shows (plus the skill and execution configuration on request; of
   * the tools, only whether code execution is on), `author` as a string. Omitting
   * `accessibleIds` lists none; `null` lists the agents of `tenantId` instead (those stored
   * without a tenant when `tenantId` is `null` or omitted). A string `author` in `otherParams`
   * is compared as an id.
   *
   * Ordered by `sort` (`'recent'`, most recently updated first, by default; an unknown order
   * falls back to it), ties by id. `limit` (100 when omitted) is clamped to 1..1000 (20 when
   * unreadable); `null` lists every match. `after` is the opaque cursor a previous page of the
   * same order returned; a cursor from another order, or an unreadable one, throws an
   * `AgentSortCursorError`.
   */
  getListAgentsByAccess(params: {
    accessibleIds?: IdLike[] | null;
    otherParams?: StoreFilter;
    /** Authenticated tenant for unrestricted listings; null/omitted restricts to legacy agents. */
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
  }>;
  /**
   * One page of the tenant's agents, most recently updated first, each with its `version`
   * count instead of its history. `accessibleIds` (store ids) limits the page to those agents;
   * `null` means the caller already passed the unrestricted management-capability check.
   * `after` is the opaque cursor a previous page returned.
   */
  getAgentManagementListByAccess(params: {
    accessibleIds: IdLike[] | null;
    tenantId: string;
    limit: number;
    after?: string | null;
  }): Promise<{
    data: Array<IAgent & { version: number; createdAt: Date; updatedAt: Date }>;
    has_more: boolean;
    after: string | null;
  }>;
  /**
   * Which of `file_ids` some agent's tool resource still references once the given reference
   * is left out: the agent `excludeAgentObjectId` (store id) under `excludeToolResource`, or
   * under every tool resource when that is omitted. The method adds no tenant condition of its
   * own: a reference is a reference, whoever holds it.
   */
  getSharedResourceFileIds(params: {
    file_ids: string[];
    excludeAgentObjectId?: string;
    excludeToolResource?: string;
  }): Promise<string[]>;

  /* ----------------------------------------------------------- writes */

  /**
   * Creates the agent with its first version snapshot. Skill ids that no longer exist are
   * dropped from its allowlist (and skills are turned off when that empties a scoped
   * allowlist); MCP server names are derived from its tools unless given.
   */
  createAgent(agentData: Record<string, unknown>): Promise<IAgent>;
  /**
   * Updates the first agent matching `filter` and resolves it updated, or `null` when none
   * matches (it never creates one). `update` is a record of fields to set, optionally with
   * `$unset`, `$push`, `$pull` and `$addToSet`; the other operators of the language are not
   * supported here (callers use none).
   *
   * Unless `skipVersioning`, an update that writes anything (or any update, with
   * `forceVersion`) also records a version: the agent's fields with the update's fields applied
   * (and its `$unset` paths removed), with the time, `updatingUserId` as `updatedBy` and a hash
   * of the agent's action definitions. A version equal to the newest one is not recorded, unless
   * `forceVersion` or an operator changes the agent; the update still applies, and the agent
   * resolved then carries `version`, its count of versions. Skill ids that no longer exist are
   * dropped from a written allowlist (and skills are turned off when that empties a scoped
   * allowlist), and writing `tools` re-derives the MCP server names unless the update gives
   * them.
   */
  updateAgent(
    filter: StoreFilter,
    update: StoreUpdate,
    options?: {
      updatingUserId?: string | null;
      forceVersion?: boolean;
      skipVersioning?: boolean;
    },
  ): Promise<IAgent | null>;
  /**
   * Sets the avatar of the agent `id` without touching its update time or history. With
   * `previousAvatar`, only while the stored avatar still equals it (`null`: has none). Resolves
   * whether an agent matched.
   */
  updateAgentAvatar(params: {
    id: string;
    avatar: { filepath: string; source: string };
    previousAvatar?: { filepath: string; source: string } | null;
  }): Promise<boolean>;
  /**
   * Adds `file_id` to the agent's `tool_resource` (and the tool to its tools) as a new version;
   * throws `Agent not found for adding resource file` when there is no such agent.
   */
  addAgentResourceFile(params: {
    agent_id: string;
    tool_resource: string;
    file_id: string;
    updatingUserId?: string;
  }): Promise<IAgent>;
  /** Removes the files from the agent's tool resources; throws when there is no such agent. */
  removeAgentResourceFiles(params: {
    agent_id: string;
    files: Array<{ tool_resource: string; file_id: string }>;
  }): Promise<IAgent>;
  /** Removes `file_ids` from every agent's tool resources; resolves the agents matched/changed. */
  removeAgentResourceFilesFromAllAgents(params: {
    file_ids: string[];
  }): Promise<{ matchedCount: number; modifiedCount: number }>;
  /**
   * Restores the version `versionIndex` (0 is the oldest) of the first agent matching `filter`
   * as its current state, without recording a new version: fields the version lacks among the
   * code environment, workspace and repository settings, the git identity, the linked
   * instructions and the skill scope and authoring settings are removed,
   * and skill ids that no longer exist are dropped as in `updateAgent`. Resolves the agent
   * restored. Throws `Agent not found` when none matches (or it changed meanwhile) and
   * `Version <versionIndex> not found` when it has no such version.
   */
  revertAgentVersion(filter: StoreFilter, versionIndex: number): Promise<IAgent>;
  /**
   * Deletes the first agent matching `filter` and its ACL entries (as an agent and as a remote
   * agent), then removes it from the other agents' graphs and from users' favorites in its
   * tenant. Resolves the deleted agent, or `null` when none matches.
   */
  deleteAgent(filter: StoreFilter): Promise<IAgent | null>;
  /** Removes the agent `resourceId` (store id) from the favorites of the users `userIds`. */
  removeAgentFromUserFavorites(resourceId: string, userIds: string[]): Promise<void>;
  /**
   * Deletes the agents the user solely owns, and their legacy (pre-ACL) authored agents, after
   * removing them from other agents' graphs and from users' favorites; then removes the ACL
   * entries on them. Agents with other owners are left intact.
   */
  deleteUserAgents(userId: string): Promise<void>;
}

/** Every method of {@link AgentStore}, for adapters and conformance checks. */
export const AGENT_STORE_METHODS: ReadonlyArray<keyof AgentStore> = listPortMethods<AgentStore>({
  getAgent: true,
  getAgents: true,
  getAgentVersions: true,
  getAgentWithVersionCount: true,
  getAgentName: true,
  resolveAgentGraphAccess: true,
  getAgentGraphNodes: true,
  getAgentIdsByMCPServerName: true,
  getAgentsWithMCPServerNames: true,
  getAgentModelSummaries: true,
  countPromotedAgents: true,
  getListAgentsByAccess: true,
  getAgentManagementListByAccess: true,
  getSharedResourceFileIds: true,
  createAgent: true,
  updateAgent: true,
  updateAgentAvatar: true,
  addAgentResourceFile: true,
  removeAgentResourceFiles: true,
  removeAgentResourceFilesFromAllAgents: true,
  revertAgentVersion: true,
  deleteAgent: true,
  removeAgentFromUserFavorites: true,
  deleteUserAgents: true,
});

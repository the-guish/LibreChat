/**
 * Agent store port: agent definitions (configuration, tools, the files attached to their tool
 * resources, avatars) and the reads the runtime and the management views make of them. Nothing
 * here may import `mongoose`. Signatures are those of `AgentMethods` (`~/methods/agent`), copied
 * verbatim but for ids typed `Types.ObjectId`, which the port states as `IdLike`;
 * `agent.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Contract common to every method unless its own doc says otherwise:
 * - Reads and writes are scoped to the tenant in the current async context, the way the
 *   tenant-isolation plugin scopes them today (`~/models/plugins/tenantIsolation`).
 * - An agent's `id` is its logical id (unique per tenant); `_id` is the id the store generated.
 * - Authorization is enforced by callers, except where a method takes resolved ACL input
 *   (`getAgentGraphNodes` with an access context, the `*ByAccess` listing).
 *
 * Not in this port, each because its signature takes raw MongoDB input:
 * - `getAgent`: a `FilterQuery<IAgent>` and a projection;
 * - `getAgentVersions`, `getAgentWithVersionCount` (matched in an aggregation), `deleteAgent`:
 *   a `FilterQuery<IAgent>`;
 * - `getAgents`: a `FilterQuery<IAgent>` and a projection string or record;
 * - `updateAgent`: a `FilterQuery<IAgent>`, and an update that may carry raw `$push`, `$pull`,
 *   `$addToSet` and `$unset` operators;
 * - `revertAgentVersion`: a `FilterQuery<IAgent>`;
 * - `getListAgentsByAccess`: its `otherParams` is a raw MongoDB filter, merged into the query
 *   (and into an aggregation's `$match` for the non-default sorts).
 * `generateActionMetadataHash` is not in it either: it is a pure hashing helper and reads and
 * writes nothing.
 *
 * Known leaks kept for now so callers stay unchanged: `IAgent` extends mongoose's `Document`
 * (its `_id` and `author` are ObjectIds), so do the records built from it
 * (`AgentModelSummary`, the `getAgentsWithMCPServerNames` rows, the management listing);
 * `createAgent` takes the agent's fields as an untyped record; and
 * `getAgentManagementListByAccess` matches `accessibleIds` in an aggregation without casting
 * them, so pass them as the ids the store handed out (as `findAccessibleResources` returns
 * them), not their string form.
 */
import type {
  IAgent,
  AgentGraphNode,
  AgentGraphAccess,
  AgentModelSummary,
  AgentGraphAccessContext,
} from '~/types';
import type { IdLike } from './common';
import { listPortMethods } from './common';

export interface AgentStore {
  /* ------------------------------------------------------------ reads */

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
  getAgentName: true,
  resolveAgentGraphAccess: true,
  getAgentGraphNodes: true,
  getAgentIdsByMCPServerName: true,
  getAgentsWithMCPServerNames: true,
  getAgentModelSummaries: true,
  countPromotedAgents: true,
  getAgentManagementListByAccess: true,
  getSharedResourceFileIds: true,
  createAgent: true,
  updateAgentAvatar: true,
  addAgentResourceFile: true,
  removeAgentResourceFiles: true,
  removeAgentResourceFilesFromAllAgents: true,
  removeAgentFromUserFavorites: true,
  deleteUserAgents: true,
});

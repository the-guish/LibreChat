import { Document, Types } from 'mongoose';
import type {
  GraphEdge,
  MemoryScope,
  SkillsScope,
  AgentToolOptions,
  AgentToolResources,
  AgentSubagentsConfig,
  AgentGitIdentity,
  AgentSortOption,
  AgentInstructionsPrompt,
} from 'librechat-data-provider';

export interface ISupportContact {
  name?: string;
  email?: string;
}

export interface IAgent extends Omit<Document, 'model'> {
  id: string;
  name?: string;
  description?: string;
  instructions?: string;
  avatar?: {
    filepath: string;
    source: string;
  };
  provider: string;
  model: string;
  model_parameters?: Record<string, unknown>;
  artifacts?: string;
  access_level?: number;
  recursion_limit?: number;
  tools?: string[];
  skills?: string[];
  skills_enabled?: boolean;
  skill_authoring_enabled?: boolean;
  skills_scope?: SkillsScope;
  tool_kwargs?: Array<unknown>;
  actions?: string[];
  author: Types.ObjectId;
  authorName?: string;
  hide_sequential_outputs?: boolean;
  end_after_tools?: boolean;
  stateful_code_sessions?: boolean;
  stateful_code_environment?: 'user' | 'agent-user' | 'conversation';
  code_environment_id?: string;
  code_environment_ids?: string[];
  code_workspace_id?: string;
  repositoryInstructions?: 'prefer' | 'defer' | 'off';
  git_identity?: AgentGitIdentity | null;
  /** Replaces inline instructions with a linked prompt group revision. */
  instructionsPrompt?: AgentInstructionsPrompt | null;
  /** @deprecated Use edges instead */
  agent_ids?: string[];
  edges?: GraphEdge[];
  conversation_starters?: string[];
  tool_resources?: AgentToolResources;
  versions?: Omit<IAgent, 'versions'>[];
  category: string;
  support_contact?: ISupportContact;
  is_promoted?: boolean;
  /** MCP server names extracted from tools for efficient querying */
  mcpServerNames?: string[];
  /** Per-tool configuration (defer_loading, allowed_callers, run_in_background, describe_intent) */
  tool_options?: AgentToolOptions;
  /** Subagent spawning configuration — isolated-context child agents. */
  subagents?: AgentSubagentsConfig;
  /** Memory partition: 'agent' isolates memories per (user, agent); default shared pool */
  memory_scope?: MemoryScope;
  tenantId?: string;
}

/** The orders of the agent listing: the marketplace's sort options, and `'recent'` (most recently
 *  updated first), which is what the listing serves when nothing asks for an order. */
export type AgentListSortOption = AgentSortOption | 'recent';

/** The agent fields a models list reads. */
export type AgentModelSummary = Pick<
  IAgent,
  '_id' | 'id' | 'name' | 'description' | 'provider' | 'author'
> & { createdAt?: Date };

/** Plain projection used to discover runnable agent graphs without exposing Mongoose. */
export interface AgentGraphNode {
  id: string;
  provider: string;
  model: string;
  tools?: string[];
  mcpServerNames?: string[];
  agent_ids?: string[];
  edges?: IAgent['edges'];
  subagents?: IAgent['subagents'];
}

export interface AgentGraphAccess {
  userId: string;
  role?: string | null;
  idOnTheSource?: string | null;
}

declare const agentGraphAccessContext: unique symbol;
/** Opaque resolved ACL context. Only data-schemas creates or consumes its contents. */
export type AgentGraphAccessContext = { readonly [agentGraphAccessContext]: true };

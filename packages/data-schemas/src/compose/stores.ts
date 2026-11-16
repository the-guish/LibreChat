/**
 * Builds the stores of {@link DataStore} from a backend's module instances, on any database.
 * Nothing here may import `mongoose` or the MongoDB driver, at runtime or as a type.
 */
import type { DataStore } from '~/ports';
import { DATA_STORE_METHODS } from '~/ports';

/**
 * Builds a store from an existing methods instance: the store hands out the instance's own
 * functions, by name, rather than a second instance's. The methods of one instance share
 * per-instance state (cached index builds, late-bound dependencies), and the methods a port
 * leaves out must keep working through the same instance the port serves.
 *
 * Every name must be a method of `methods`, and the result must be assignable to the store type
 * the caller declares, so a port method the instance lacks, or one whose signature it does not
 * satisfy, is a compile error at the call.
 */
export function pickStore<Methods extends object, Name extends keyof Methods>(
  methods: Methods,
  names: ReadonlyArray<Name>,
): Pick<Methods, Name> {
  const store: Partial<Pick<Methods, Name>> = {};
  for (const name of names) {
    store[name] = methods[name];
  }
  return store as Pick<Methods, Name>;
}

/**
 * The stores of {@link DataStore}: each hands out the functions of the module instance the
 * backend already built (see {@link pickStore}), never a second one, and only its port's methods.
 * `instances` holds one instance per store, each at least its store (it may carry more).
 */
export function createDataStore(instances: DataStore): DataStore {
  return {
    conversations: pickStore(instances.conversations, DATA_STORE_METHODS.conversations),
    banners: pickStore(instances.banners, DATA_STORE_METHODS.banners),
    categories: pickStore(instances.categories, DATA_STORE_METHODS.categories),
    tokenLists: pickStore(instances.tokenLists, DATA_STORE_METHODS.tokenLists),
    toolFavorites: pickStore(instances.toolFavorites, DATA_STORE_METHODS.toolFavorites),
    principals: pickStore(instances.principals, DATA_STORE_METHODS.principals),
    userKeys: pickStore(instances.userKeys, DATA_STORE_METHODS.userKeys),
    agentCategories: pickStore(instances.agentCategories, DATA_STORE_METHODS.agentCategories),
    resourceLocks: pickStore(instances.resourceLocks, DATA_STORE_METHODS.resourceLocks),
    toolApprovalGrants: pickStore(
      instances.toolApprovalGrants,
      DATA_STORE_METHODS.toolApprovalGrants,
    ),
    scheduleConsents: pickStore(instances.scheduleConsents, DATA_STORE_METHODS.scheduleConsents),
    openidRefreshFlights: pickStore(
      instances.openidRefreshFlights,
      DATA_STORE_METHODS.openidRefreshFlights,
    ),
    sessions: pickStore(instances.sessions, DATA_STORE_METHODS.sessions),
    tokens: pickStore(instances.tokens, DATA_STORE_METHODS.tokens),
    refreshTokenBridges: pickStore(
      instances.refreshTokenBridges,
      DATA_STORE_METHODS.refreshTokenBridges,
    ),
    passkeys: pickStore(instances.passkeys, DATA_STORE_METHODS.passkeys),
    presets: pickStore(instances.presets, DATA_STORE_METHODS.presets),
    actions: pickStore(instances.actions, DATA_STORE_METHODS.actions),
    toolCalls: pickStore(instances.toolCalls, DATA_STORE_METHODS.toolCalls),
    assistants: pickStore(instances.assistants, DATA_STORE_METHODS.assistants),
    pluginAuths: pickStore(instances.pluginAuths, DATA_STORE_METHODS.pluginAuths),
    memories: pickStore(instances.memories, DATA_STORE_METHODS.memories),
    fileStorage: pickStore(instances.fileStorage, DATA_STORE_METHODS.fileStorage),
    tokenSpending: pickStore(instances.tokenSpending, DATA_STORE_METHODS.tokenSpending),
    users: pickStore(instances.users, DATA_STORE_METHODS.users),
    roles: pickStore(instances.roles, DATA_STORE_METHODS.roles),
    accessRoles: pickStore(instances.accessRoles, DATA_STORE_METHODS.accessRoles),
    agentApiKeys: pickStore(instances.agentApiKeys, DATA_STORE_METHODS.agentApiKeys),
    mcpServers: pickStore(instances.mcpServers, DATA_STORE_METHODS.mcpServers),
    configOverrides: pickStore(instances.configOverrides, DATA_STORE_METHODS.configOverrides),
    auditLogs: pickStore(instances.auditLogs, DATA_STORE_METHODS.auditLogs),
    aclEntries: pickStore(instances.aclEntries, DATA_STORE_METHODS.aclEntries),
    systemGrants: pickStore(instances.systemGrants, DATA_STORE_METHODS.systemGrants),
    userGroups: pickStore(instances.userGroups, DATA_STORE_METHODS.userGroups),
    codeEnvironments: pickStore(instances.codeEnvironments, DATA_STORE_METHODS.codeEnvironments),
    tokenTransactions: pickStore(instances.tokenTransactions, DATA_STORE_METHODS.tokenTransactions),
    prompts: pickStore(instances.prompts, DATA_STORE_METHODS.prompts),
    chatProjects: pickStore(instances.chatProjects, DATA_STORE_METHODS.chatProjects),
    conversationTags: pickStore(instances.conversationTags, DATA_STORE_METHODS.conversationTags),
    insights: pickStore(instances.insights, DATA_STORE_METHODS.insights),
    skillSync: pickStore(instances.skillSync, DATA_STORE_METHODS.skillSync),
    skillLifecycle: pickStore(instances.skillLifecycle, DATA_STORE_METHODS.skillLifecycle),
    subagentContent: pickStore(instances.subagentContent, DATA_STORE_METHODS.subagentContent),
    conversationImports: pickStore(
      instances.conversationImports,
      DATA_STORE_METHODS.conversationImports,
    ),
    messages: pickStore(instances.messages, DATA_STORE_METHODS.messages),
    sharedLinks: pickStore(instances.sharedLinks, DATA_STORE_METHODS.sharedLinks),
    files: pickStore(instances.files, DATA_STORE_METHODS.files),
    agents: pickStore(instances.agents, DATA_STORE_METHODS.agents),
    skills: pickStore(instances.skills, DATA_STORE_METHODS.skills),
    schedules: pickStore(instances.schedules, DATA_STORE_METHODS.schedules),
    agentQueuedTurns: pickStore(instances.agentQueuedTurns, DATA_STORE_METHODS.agentQueuedTurns),
    agentTriggerDeliveries: pickStore(
      instances.agentTriggerDeliveries,
      DATA_STORE_METHODS.agentTriggerDeliveries,
    ),
    mcpAuthorities: pickStore(instances.mcpAuthorities, DATA_STORE_METHODS.mcpAuthorities),
    mcpAuthorizationFenceRetries: pickStore(
      instances.mcpAuthorizationFenceRetries,
      DATA_STORE_METHODS.mcpAuthorizationFenceRetries,
    ),
    browserSetup: pickStore(instances.browserSetup, DATA_STORE_METHODS.browserSetup),
    transactions: pickStore(instances.transactions, DATA_STORE_METHODS.transactions),
  };
}

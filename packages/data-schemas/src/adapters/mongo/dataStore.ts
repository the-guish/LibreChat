import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { OpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import type { RefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import type { ScheduleMCPConsentStorage } from '~/methods/scheduleConsent';
import type { CodeEnvironmentMethods } from '~/methods/codeEnvironment';
import type { ConversationTagMethods } from '~/methods/conversationTag';
import type { SubagentContentMethods } from '~/methods/subagentContent';
import type { SkillLifecycleMethods } from '~/methods/skillLifecycle';
import type { AgentCategoryMethods } from '~/methods/agentCategory';
import type { ConversationMethods } from '~/methods/conversation';
import type { ResourceLockMethods } from '~/methods/resourceLock';
import type { ConversationImportMethods } from '~/methods/import';
import type { FileStorageMethods } from '~/methods/fileStorage';
import type { SpendTokensMethods } from '~/methods/spendTokens';
import type { AgentApiKeyMethods } from '~/methods/agentApiKey';
import type { SystemGrantMethods } from '~/methods/systemGrant';
import type { TransactionMethods } from '~/methods/transaction';
import type { ChatProjectMethods } from '~/methods/chatProject';
import type { CategoriesMethods } from '~/methods/categories';
import type { ToolFavoriteMethods } from '~/methods/favorite';
import type { PluginAuthMethods } from '~/methods/pluginAuth';
import type { AccessRoleMethods } from '~/methods/accessRole';
import type { PrincipalMethods } from '~/methods/principal';
import type { TokenListMethods } from '~/methods/tokenList';
import type { AssistantMethods } from '~/methods/assistant';
import type { MCPServerMethods } from '~/methods/mcpServer';
import type { UserGroupMethods } from '~/methods/userGroup';
import type { SkillSyncMethods } from '~/methods/skillSync';
import type { ToolCallMethods } from '~/methods/toolCall';
import type { AclEntryMethods } from '~/methods/aclEntry';
import type { AuditLogMethods } from '~/methods/auditLog';
import type { InsightsMethods } from '~/methods/insights';
import type { SessionMethods } from '~/methods/session';
import type { PasskeyMethods } from '~/methods/passkey';
import type { MessageMethods } from '~/methods/message';
import type { BannerMethods } from '~/methods/banner';
import type { PresetMethods } from '~/methods/preset';
import type { ActionMethods } from '~/methods/action';
import type { MemoryMethods } from '~/methods/memory';
import type { ConfigMethods } from '~/methods/config';
import type { PromptMethods } from '~/methods/prompt';
import type { AgentMethods } from '~/methods/agent';
import type { SkillMethods } from '~/methods/skill';
import type { ShareMethods } from '~/methods/share';
import type { TokenMethods } from '~/methods/token';
import type { FileMethods } from '~/methods/file';
import type { UserMethods } from '~/methods/user';
import type { RoleMethods } from '~/methods/role';
import type { KeyMethods } from '~/methods/key';
import type { DataStore } from '~/ports';
import { createMongoConversationStore } from './conversationStore';
import { DATA_STORE_METHODS } from '~/ports';
import { pickStore } from './pickStore';

/** The MongoDB methods instances behind each store of {@link DataStore}. */
export interface MongoDataStoreMethods {
  conversations: ConversationMethods;
  banners: BannerMethods;
  categories: CategoriesMethods;
  tokenLists: TokenListMethods;
  toolFavorites: ToolFavoriteMethods;
  principals: PrincipalMethods;
  userKeys: KeyMethods;
  agentCategories: AgentCategoryMethods;
  resourceLocks: ResourceLockMethods;
  toolApprovalGrants: ToolApprovalGrantStorage;
  scheduleConsents: ScheduleMCPConsentStorage;
  openidRefreshFlights: OpenIDRefreshFlightMethods;
  sessions: SessionMethods;
  tokens: TokenMethods;
  refreshTokenBridges: RefreshTokenBridgeMethods;
  passkeys: PasskeyMethods;
  presets: PresetMethods;
  actions: ActionMethods;
  toolCalls: ToolCallMethods;
  assistants: AssistantMethods;
  pluginAuths: PluginAuthMethods;
  memories: MemoryMethods;
  fileStorage: FileStorageMethods;
  tokenSpending: SpendTokensMethods;
  users: UserMethods;
  roles: RoleMethods;
  accessRoles: AccessRoleMethods;
  agentApiKeys: AgentApiKeyMethods;
  mcpServers: MCPServerMethods;
  configOverrides: ConfigMethods;
  auditLogs: AuditLogMethods;
  aclEntries: AclEntryMethods;
  systemGrants: SystemGrantMethods;
  userGroups: UserGroupMethods;
  codeEnvironments: CodeEnvironmentMethods;
  tokenTransactions: TransactionMethods;
  prompts: PromptMethods;
  chatProjects: ChatProjectMethods;
  conversationTags: ConversationTagMethods;
  insights: InsightsMethods;
  skillSync: SkillSyncMethods;
  skillLifecycle: SkillLifecycleMethods;
  subagentContent: SubagentContentMethods;
  conversationImports: ConversationImportMethods;
  messages: MessageMethods;
  sharedLinks: ShareMethods;
  files: FileMethods;
  agents: AgentMethods;
  skills: SkillMethods;
}

/**
 * MongoDB adapter for {@link DataStore}: each store hands out the functions of the methods
 * instance `createMethods` already built for its module (see `pickStore`), never a second one.
 */
export function createMongoDataStore(methods: MongoDataStoreMethods): DataStore {
  return {
    conversations: createMongoConversationStore(methods.conversations),
    banners: pickStore(methods.banners, DATA_STORE_METHODS.banners),
    categories: pickStore(methods.categories, DATA_STORE_METHODS.categories),
    tokenLists: pickStore(methods.tokenLists, DATA_STORE_METHODS.tokenLists),
    toolFavorites: pickStore(methods.toolFavorites, DATA_STORE_METHODS.toolFavorites),
    principals: pickStore(methods.principals, DATA_STORE_METHODS.principals),
    userKeys: pickStore(methods.userKeys, DATA_STORE_METHODS.userKeys),
    agentCategories: pickStore(methods.agentCategories, DATA_STORE_METHODS.agentCategories),
    resourceLocks: pickStore(methods.resourceLocks, DATA_STORE_METHODS.resourceLocks),
    toolApprovalGrants: pickStore(
      methods.toolApprovalGrants,
      DATA_STORE_METHODS.toolApprovalGrants,
    ),
    scheduleConsents: pickStore(methods.scheduleConsents, DATA_STORE_METHODS.scheduleConsents),
    openidRefreshFlights: pickStore(
      methods.openidRefreshFlights,
      DATA_STORE_METHODS.openidRefreshFlights,
    ),
    sessions: pickStore(methods.sessions, DATA_STORE_METHODS.sessions),
    tokens: pickStore(methods.tokens, DATA_STORE_METHODS.tokens),
    refreshTokenBridges: pickStore(
      methods.refreshTokenBridges,
      DATA_STORE_METHODS.refreshTokenBridges,
    ),
    passkeys: pickStore(methods.passkeys, DATA_STORE_METHODS.passkeys),
    presets: pickStore(methods.presets, DATA_STORE_METHODS.presets),
    actions: pickStore(methods.actions, DATA_STORE_METHODS.actions),
    toolCalls: pickStore(methods.toolCalls, DATA_STORE_METHODS.toolCalls),
    assistants: pickStore(methods.assistants, DATA_STORE_METHODS.assistants),
    pluginAuths: pickStore(methods.pluginAuths, DATA_STORE_METHODS.pluginAuths),
    memories: pickStore(methods.memories, DATA_STORE_METHODS.memories),
    fileStorage: pickStore(methods.fileStorage, DATA_STORE_METHODS.fileStorage),
    tokenSpending: pickStore(methods.tokenSpending, DATA_STORE_METHODS.tokenSpending),
    users: pickStore(methods.users, DATA_STORE_METHODS.users),
    roles: pickStore(methods.roles, DATA_STORE_METHODS.roles),
    accessRoles: pickStore(methods.accessRoles, DATA_STORE_METHODS.accessRoles),
    agentApiKeys: pickStore(methods.agentApiKeys, DATA_STORE_METHODS.agentApiKeys),
    mcpServers: pickStore(methods.mcpServers, DATA_STORE_METHODS.mcpServers),
    configOverrides: pickStore(methods.configOverrides, DATA_STORE_METHODS.configOverrides),
    auditLogs: pickStore(methods.auditLogs, DATA_STORE_METHODS.auditLogs),
    aclEntries: pickStore(methods.aclEntries, DATA_STORE_METHODS.aclEntries),
    systemGrants: pickStore(methods.systemGrants, DATA_STORE_METHODS.systemGrants),
    userGroups: pickStore(methods.userGroups, DATA_STORE_METHODS.userGroups),
    codeEnvironments: pickStore(methods.codeEnvironments, DATA_STORE_METHODS.codeEnvironments),
    tokenTransactions: pickStore(methods.tokenTransactions, DATA_STORE_METHODS.tokenTransactions),
    prompts: pickStore(methods.prompts, DATA_STORE_METHODS.prompts),
    chatProjects: pickStore(methods.chatProjects, DATA_STORE_METHODS.chatProjects),
    conversationTags: pickStore(methods.conversationTags, DATA_STORE_METHODS.conversationTags),
    insights: pickStore(methods.insights, DATA_STORE_METHODS.insights),
    skillSync: pickStore(methods.skillSync, DATA_STORE_METHODS.skillSync),
    skillLifecycle: pickStore(methods.skillLifecycle, DATA_STORE_METHODS.skillLifecycle),
    subagentContent: pickStore(methods.subagentContent, DATA_STORE_METHODS.subagentContent),
    conversationImports: pickStore(
      methods.conversationImports,
      DATA_STORE_METHODS.conversationImports,
    ),
    messages: pickStore(methods.messages, DATA_STORE_METHODS.messages),
    sharedLinks: pickStore(methods.sharedLinks, DATA_STORE_METHODS.sharedLinks),
    files: pickStore(methods.files, DATA_STORE_METHODS.files),
    agents: pickStore(methods.agents, DATA_STORE_METHODS.agents),
    skills: pickStore(methods.skills, DATA_STORE_METHODS.skills),
  };
}

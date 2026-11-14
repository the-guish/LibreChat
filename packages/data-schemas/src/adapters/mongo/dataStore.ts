import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { MCPAuthorizationFenceRetryStorage } from '~/methods/mcpAuthorizationFenceRetry';
import type { OpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import type { RefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import type { AgentTriggerDeliveryMethods } from '~/methods/triggerDelivery';
import type { ScheduleMCPConsentStorage } from '~/methods/scheduleConsent';
import type { CodeEnvironmentMethods } from '~/methods/codeEnvironment';
import type { ConversationTagMethods } from '~/methods/conversationTag';
import type { SubagentContentMethods } from '~/methods/subagentContent';
import type { MongoStoreTransactionMethods } from './storeTransactions';
import type { SkillLifecycleMethods } from '~/methods/skillLifecycle';
import type { AgentCategoryMethods } from '~/methods/agentCategory';
import type { AgentQueuedTurnMethods } from '~/methods/queuedTurn';
import type { MCPAuthorityMethods } from '~/methods/mcpAuthority';
import type { ConversationMethods } from '~/methods/conversation';
import type { ResourceLockMethods } from '~/methods/resourceLock';
import type { ConversationImportMethods } from '~/methods/import';
import type { BrowserSetupBackend } from '~/types/browserSetup';
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
import type { ScheduleMethods } from '~/methods/schedule';
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
import { createDataStore } from '~/compose/stores';

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
  schedules: ScheduleMethods;
  agentQueuedTurns: AgentQueuedTurnMethods;
  agentTriggerDeliveries: AgentTriggerDeliveryMethods;
  mcpAuthorities: MCPAuthorityMethods;
  mcpAuthorizationFenceRetries: MCPAuthorizationFenceRetryStorage;
  browserSetup: BrowserSetupBackend;
  transactions: MongoStoreTransactionMethods;
}

/**
 * MongoDB adapter for {@link DataStore}: each store hands out the functions of the methods
 * instance `createMethods` already built for its module (see `pickStore`), never a second one.
 * The same stores `createDataStore` (`~/compose`) builds for every backend.
 */
export function createMongoDataStore(methods: MongoDataStoreMethods): DataStore {
  return createDataStore(methods);
}

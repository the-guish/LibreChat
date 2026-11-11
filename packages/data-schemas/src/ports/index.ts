/**
 * Ports: database-neutral interfaces for the data layer. Each is satisfied today by the
 * MongoDB methods in `~/methods` and is meant to be satisfied by other adapters as well.
 *
 * {@link DataStore} holds one store per ported module. An adapter supplies all of them at once:
 * the database is switched as a whole, never per module, so an adapter may read any collection
 * it needs while callers and database-neutral code only see the ports.
 */
import type { MCPAuthorizationFenceRetryStore } from './mcpAuthorizationFenceRetry';
import type { OpenIDRefreshFlightStore } from './openidRefreshFlight';
import type { RefreshTokenBridgeStore } from './refreshTokenBridge';
import type { ConversationImportStore } from './conversationImport';
import type { ToolApprovalGrantStore } from './toolApprovalGrant';
import type { TokenTransactionStore } from './tokenTransaction';
import type { BrowserSetupBackendStore } from './browserSetup';
import type { ScheduleConsentStore } from './scheduleConsent';
import type { CodeEnvironmentStore } from './codeEnvironment';
import type { ConversationTagStore } from './conversationTag';
import type { SubagentContentStore } from './subagentContent';
import type { TriggerDeliveryStore } from './triggerDelivery';
import type { StoreTransactions } from './storeTransactions';
import type { SkillLifecycleStore } from './skillLifecycle';
import type { AgentCategoryStore } from './agentCategory';
import type { PromptLibraryStore } from './promptLibrary';
import type { AgentQueuedTurnStore } from './queuedTurn';
import type { MCPAuthorityStore } from './mcpAuthority';
import type { ConversationStore } from './conversation';
import type { ResourceLockStore } from './resourceLock';
import type { FileStorageStore } from './fileStorage';
import type { SpendTokensStore } from './spendTokens';
import type { AgentApiKeyStore } from './agentApiKey';
import type { SystemGrantStore } from './systemGrant';
import type { ChatProjectStore } from './chatProject';
import type { CategoriesStore } from './categories';
import type { ToolFavoriteStore } from './favorite';
import type { PluginAuthStore } from './pluginAuth';
import type { AccessRoleStore } from './accessRole';
import type { ConfigOverrideStore } from './config';
import type { PrincipalStore } from './principal';
import type { TokenListStore } from './tokenList';
import type { AssistantStore } from './assistant';
import type { MCPServerStore } from './mcpServer';
import type { UserGroupStore } from './userGroup';
import type { SkillSyncStore } from './skillSync';
import type { ScheduleStore } from './schedule';
import type { ToolCallStore } from './toolCall';
import type { AclEntryStore } from './aclEntry';
import type { AuditLogStore } from './auditLog';
import type { InsightsStore } from './insights';
import type { SharedLinkStore } from './share';
import type { MessageStore } from './message';
import type { SessionStore } from './session';
import type { PasskeyStore } from './passkey';
import type { BannerStore } from './banner';
import type { PresetStore } from './preset';
import type { ActionStore } from './action';
import type { MemoryStore } from './memory';
import type { AgentStore } from './agent';
import type { SkillStore } from './skill';
import type { UserKeyStore } from './key';
import type { TokenStore } from './token';
import type { FileStore } from './file';
import type { UserStore } from './user';
import type { RoleStore } from './role';
import { MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS } from './mcpAuthorizationFenceRetry';
import { OPENID_REFRESH_FLIGHT_STORE_METHODS } from './openidRefreshFlight';
import { REFRESH_TOKEN_BRIDGE_STORE_METHODS } from './refreshTokenBridge';
import { CONVERSATION_IMPORT_STORE_METHODS } from './conversationImport';
import { TOOL_APPROVAL_GRANT_STORE_METHODS } from './toolApprovalGrant';
import { TOKEN_TRANSACTION_STORE_METHODS } from './tokenTransaction';
import { BROWSER_SETUP_BACKEND_STORE_METHODS } from './browserSetup';
import { SCHEDULE_CONSENT_STORE_METHODS } from './scheduleConsent';
import { CODE_ENVIRONMENT_STORE_METHODS } from './codeEnvironment';
import { CONVERSATION_TAG_STORE_METHODS } from './conversationTag';
import { SUBAGENT_CONTENT_STORE_METHODS } from './subagentContent';
import { TRIGGER_DELIVERY_STORE_METHODS } from './triggerDelivery';
import { SKILL_LIFECYCLE_STORE_METHODS } from './skillLifecycle';
import { STORE_TRANSACTIONS_METHODS } from './storeTransactions';
import { AGENT_QUEUED_TURN_STORE_METHODS } from './queuedTurn';
import { AGENT_CATEGORY_STORE_METHODS } from './agentCategory';
import { PROMPT_LIBRARY_STORE_METHODS } from './promptLibrary';
import { MCP_AUTHORITY_STORE_METHODS } from './mcpAuthority';
import { RESOURCE_LOCK_STORE_METHODS } from './resourceLock';
import { CONVERSATION_STORE_METHODS } from './conversation';
import { AGENT_API_KEY_STORE_METHODS } from './agentApiKey';
import { FILE_STORAGE_STORE_METHODS } from './fileStorage';
import { SPEND_TOKENS_STORE_METHODS } from './spendTokens';
import { SYSTEM_GRANT_STORE_METHODS } from './systemGrant';
import { CHAT_PROJECT_STORE_METHODS } from './chatProject';
import { TOOL_FAVORITE_STORE_METHODS } from './favorite';
import { PLUGIN_AUTH_STORE_METHODS } from './pluginAuth';
import { ACCESS_ROLE_STORE_METHODS } from './accessRole';
import { CONFIG_OVERRIDE_STORE_METHODS } from './config';
import { CATEGORIES_STORE_METHODS } from './categories';
import { TOKEN_LIST_STORE_METHODS } from './tokenList';
import { MCP_SERVER_STORE_METHODS } from './mcpServer';
import { USER_GROUP_STORE_METHODS } from './userGroup';
import { SKILL_SYNC_STORE_METHODS } from './skillSync';
import { PRINCIPAL_STORE_METHODS } from './principal';
import { ASSISTANT_STORE_METHODS } from './assistant';
import { TOOL_CALL_STORE_METHODS } from './toolCall';
import { ACL_ENTRY_STORE_METHODS } from './aclEntry';
import { AUDIT_LOG_STORE_METHODS } from './auditLog';
import { SCHEDULE_STORE_METHODS } from './schedule';
import { INSIGHTS_STORE_METHODS } from './insights';
import { SHARED_LINK_STORE_METHODS } from './share';
import { MESSAGE_STORE_METHODS } from './message';
import { SESSION_STORE_METHODS } from './session';
import { PASSKEY_STORE_METHODS } from './passkey';
import { BANNER_STORE_METHODS } from './banner';
import { PRESET_STORE_METHODS } from './preset';
import { ACTION_STORE_METHODS } from './action';
import { MEMORY_STORE_METHODS } from './memory';
import { USER_KEY_STORE_METHODS } from './key';
import { AGENT_STORE_METHODS } from './agent';
import { SKILL_STORE_METHODS } from './skill';
import { TOKEN_STORE_METHODS } from './token';
import { FILE_STORE_METHODS } from './file';
import { USER_STORE_METHODS } from './user';
import { ROLE_STORE_METHODS } from './role';

export type {
  IdLike,
  DeleteCount,
  UpdateCount,
  BulkWriteCount,
  StoreTransaction,
  PortMethodSet,
  WithIdLike,
} from './common';
export type {
  DataStoreHealth,
  DataStoreBackend,
  DataStoreConnection,
  DataStoreQueryObserver,
  DataStoreConnectionState,
  DataStoreQueryObservation,
  DataStoreConnectionOptions,
} from './connection';
export type { TokenStoreQuery, TokenStoreCreateData } from './token';
export type { SpendTokensTxData } from './spendTokens';
export type { AgentApiKeyStoreCreateData } from './agentApiKey';
export type { AuditLogStoreEntryInput } from './auditLog';
export type {
  AclStorePrincipal,
  AclRoleBitsStoreWrite,
  AclEntryStoreBulkWrite,
  AclEntryStoreBulkUpdate,
} from './aclEntry';
export type { SystemGrantStorePrincipal } from './systemGrant';
export type { UserGroupSource, UserGroupStorePrincipal } from './userGroup';
export type { TokenTransactionTxData, TokenTransactionRecord } from './tokenTransaction';
export type {
  PromptLibraryListParams,
  PromptLibraryGroupFilter,
  PromptLibraryGroupPageFilter,
} from './promptLibrary';
export type {
  ParentSubagentTaskStoreRecord,
  MessageStoreReadOptions,
  MessagePageSortField,
  MessagePageOptions,
  MessagePage,
  MessageSearchInput,
  MessageSearchHit,
  MessageSearchResult,
} from './message';
export type { ScheduleStoreData, ScheduleRunStoreData } from './schedule';
export type {
  AgentQueuedTurnStoreOwnerScope,
  AgentQueuedTurnStoreConversationScope,
  AgentQueuedTurnStoreClaimFence,
  EnqueueAgentQueuedTurnStoreInput,
} from './queuedTurn';
export type { AgentEventActorReceiptStoreInput } from './triggerDelivery';
export type { MCPAuthorityStoreResolveInput, MCPAuthorityStoreAssertInput } from './mcpAuthority';
export type { MCPAuthorizationFenceRetryStoreRecord } from './mcpAuthorizationFenceRetry';
export type {
  SkillStoreCreateInput,
  SkillStoreAuthorNameParams,
  SkillStoreFileInput,
  SkillStoreListParams,
  SkillStoreAlwaysApplyParams,
} from './skill';
export { listPortMethods } from './common';
export { DATA_STORE_CONNECTION_METHODS, DATA_STORE_BACKEND_MEMBERS } from './connection';
export type {
  StoreScalar,
  StoreEqualityValue,
  StoreRangeValue,
  StoreRegexOptions,
  StoreFieldOperators,
  StoreFieldCondition,
  StoreFilter,
  StoreProjection,
  StoreProjectionString,
  StoreProjectionRecord,
  StoreSort,
  StoreQueryOptions,
  StoreFieldValues,
  StorePushValue,
  StoreAddToSetValue,
  StoreUpdateOperators,
  StoreUpdate,
} from './query';
export {
  StoreQueryError,
  assertStoreFilter,
  assertStoreProjection,
  assertStoreSort,
  assertStoreUpdate,
  matchesStoreFilter,
  applyStoreProjection,
  compareStoreValues,
  compareByStoreSort,
  applyStoreQueryOptions,
  applyStoreUpdate,
  storeFilterInsertSeed,
} from './query';
export {
  ACCESS_ROLE_STORE_METHODS,
  ACL_ENTRY_STORE_METHODS,
  ACTION_STORE_METHODS,
  AGENT_API_KEY_STORE_METHODS,
  AGENT_CATEGORY_STORE_METHODS,
  AGENT_QUEUED_TURN_STORE_METHODS,
  AGENT_STORE_METHODS,
  ASSISTANT_STORE_METHODS,
  AUDIT_LOG_STORE_METHODS,
  BANNER_STORE_METHODS,
  BROWSER_SETUP_BACKEND_STORE_METHODS,
  CATEGORIES_STORE_METHODS,
  CHAT_PROJECT_STORE_METHODS,
  CODE_ENVIRONMENT_STORE_METHODS,
  CONFIG_OVERRIDE_STORE_METHODS,
  CONVERSATION_IMPORT_STORE_METHODS,
  CONVERSATION_STORE_METHODS,
  CONVERSATION_TAG_STORE_METHODS,
  FILE_STORAGE_STORE_METHODS,
  FILE_STORE_METHODS,
  INSIGHTS_STORE_METHODS,
  MCP_AUTHORITY_STORE_METHODS,
  MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS,
  MCP_SERVER_STORE_METHODS,
  MEMORY_STORE_METHODS,
  MESSAGE_STORE_METHODS,
  OPENID_REFRESH_FLIGHT_STORE_METHODS,
  PASSKEY_STORE_METHODS,
  PLUGIN_AUTH_STORE_METHODS,
  PRESET_STORE_METHODS,
  PRINCIPAL_STORE_METHODS,
  PROMPT_LIBRARY_STORE_METHODS,
  REFRESH_TOKEN_BRIDGE_STORE_METHODS,
  RESOURCE_LOCK_STORE_METHODS,
  ROLE_STORE_METHODS,
  SCHEDULE_CONSENT_STORE_METHODS,
  SCHEDULE_STORE_METHODS,
  SESSION_STORE_METHODS,
  SHARED_LINK_STORE_METHODS,
  SKILL_LIFECYCLE_STORE_METHODS,
  SKILL_STORE_METHODS,
  SKILL_SYNC_STORE_METHODS,
  SPEND_TOKENS_STORE_METHODS,
  SUBAGENT_CONTENT_STORE_METHODS,
  SYSTEM_GRANT_STORE_METHODS,
  TOKEN_LIST_STORE_METHODS,
  TOKEN_STORE_METHODS,
  TOKEN_TRANSACTION_STORE_METHODS,
  TOOL_APPROVAL_GRANT_STORE_METHODS,
  TOOL_CALL_STORE_METHODS,
  TOOL_FAVORITE_STORE_METHODS,
  TRIGGER_DELIVERY_STORE_METHODS,
  USER_GROUP_STORE_METHODS,
  USER_KEY_STORE_METHODS,
  USER_STORE_METHODS,
  STORE_TRANSACTIONS_METHODS,
};
export type {
  AccessRoleStore,
  AclEntryStore,
  ActionStore,
  AgentApiKeyStore,
  AgentCategoryStore,
  AgentQueuedTurnStore,
  AgentStore,
  AssistantStore,
  AuditLogStore,
  BannerStore,
  BrowserSetupBackendStore,
  CategoriesStore,
  ChatProjectStore,
  CodeEnvironmentStore,
  ConfigOverrideStore,
  ConversationImportStore,
  ConversationStore,
  ConversationTagStore,
  FileStorageStore,
  FileStore,
  InsightsStore,
  MCPAuthorityStore,
  MCPAuthorizationFenceRetryStore,
  MCPServerStore,
  MemoryStore,
  MessageStore,
  OpenIDRefreshFlightStore,
  PasskeyStore,
  PluginAuthStore,
  PresetStore,
  PrincipalStore,
  PromptLibraryStore,
  RefreshTokenBridgeStore,
  ResourceLockStore,
  RoleStore,
  ScheduleConsentStore,
  ScheduleStore,
  SessionStore,
  SharedLinkStore,
  SkillLifecycleStore,
  SkillStore,
  SkillSyncStore,
  SpendTokensStore,
  SubagentContentStore,
  SystemGrantStore,
  TokenListStore,
  TokenStore,
  TokenTransactionStore,
  ToolApprovalGrantStore,
  ToolCallStore,
  ToolFavoriteStore,
  TriggerDeliveryStore,
  UserGroupStore,
  UserKeyStore,
  UserStore,
  StoreTransactions,
};

/** Every ported module's store. No two stores share a method name. */
export interface DataStore {
  conversations: ConversationStore;
  banners: BannerStore;
  categories: CategoriesStore;
  tokenLists: TokenListStore;
  toolFavorites: ToolFavoriteStore;
  principals: PrincipalStore;
  userKeys: UserKeyStore;
  agentCategories: AgentCategoryStore;
  resourceLocks: ResourceLockStore;
  toolApprovalGrants: ToolApprovalGrantStore;
  scheduleConsents: ScheduleConsentStore;
  openidRefreshFlights: OpenIDRefreshFlightStore;
  sessions: SessionStore;
  tokens: TokenStore;
  refreshTokenBridges: RefreshTokenBridgeStore;
  passkeys: PasskeyStore;
  presets: PresetStore;
  actions: ActionStore;
  toolCalls: ToolCallStore;
  assistants: AssistantStore;
  pluginAuths: PluginAuthStore;
  memories: MemoryStore;
  fileStorage: FileStorageStore;
  tokenSpending: SpendTokensStore;
  users: UserStore;
  roles: RoleStore;
  accessRoles: AccessRoleStore;
  agentApiKeys: AgentApiKeyStore;
  mcpServers: MCPServerStore;
  configOverrides: ConfigOverrideStore;
  auditLogs: AuditLogStore;
  aclEntries: AclEntryStore;
  systemGrants: SystemGrantStore;
  userGroups: UserGroupStore;
  codeEnvironments: CodeEnvironmentStore;
  tokenTransactions: TokenTransactionStore;
  prompts: PromptLibraryStore;
  chatProjects: ChatProjectStore;
  conversationTags: ConversationTagStore;
  insights: InsightsStore;
  skillSync: SkillSyncStore;
  skillLifecycle: SkillLifecycleStore;
  subagentContent: SubagentContentStore;
  conversationImports: ConversationImportStore;
  messages: MessageStore;
  sharedLinks: SharedLinkStore;
  files: FileStore;
  agents: AgentStore;
  skills: SkillStore;
  schedules: ScheduleStore;
  agentQueuedTurns: AgentQueuedTurnStore;
  agentTriggerDeliveries: TriggerDeliveryStore;
  mcpAuthorities: MCPAuthorityStore;
  mcpAuthorizationFenceRetries: MCPAuthorizationFenceRetryStore;
  browserSetup: BrowserSetupBackendStore;
  /** Runs store operations as one transaction; see {@link StoreTransactions}. */
  transactions: StoreTransactions;
}

/** The method names of each store of {@link DataStore}, for adapters and conformance checks. */
export const DATA_STORE_METHODS: {
  readonly [K in keyof DataStore]: ReadonlyArray<keyof DataStore[K]>;
} = {
  conversations: CONVERSATION_STORE_METHODS,
  banners: BANNER_STORE_METHODS,
  categories: CATEGORIES_STORE_METHODS,
  tokenLists: TOKEN_LIST_STORE_METHODS,
  toolFavorites: TOOL_FAVORITE_STORE_METHODS,
  principals: PRINCIPAL_STORE_METHODS,
  userKeys: USER_KEY_STORE_METHODS,
  agentCategories: AGENT_CATEGORY_STORE_METHODS,
  resourceLocks: RESOURCE_LOCK_STORE_METHODS,
  toolApprovalGrants: TOOL_APPROVAL_GRANT_STORE_METHODS,
  scheduleConsents: SCHEDULE_CONSENT_STORE_METHODS,
  openidRefreshFlights: OPENID_REFRESH_FLIGHT_STORE_METHODS,
  sessions: SESSION_STORE_METHODS,
  tokens: TOKEN_STORE_METHODS,
  refreshTokenBridges: REFRESH_TOKEN_BRIDGE_STORE_METHODS,
  passkeys: PASSKEY_STORE_METHODS,
  presets: PRESET_STORE_METHODS,
  actions: ACTION_STORE_METHODS,
  toolCalls: TOOL_CALL_STORE_METHODS,
  assistants: ASSISTANT_STORE_METHODS,
  pluginAuths: PLUGIN_AUTH_STORE_METHODS,
  memories: MEMORY_STORE_METHODS,
  fileStorage: FILE_STORAGE_STORE_METHODS,
  tokenSpending: SPEND_TOKENS_STORE_METHODS,
  users: USER_STORE_METHODS,
  roles: ROLE_STORE_METHODS,
  accessRoles: ACCESS_ROLE_STORE_METHODS,
  agentApiKeys: AGENT_API_KEY_STORE_METHODS,
  mcpServers: MCP_SERVER_STORE_METHODS,
  configOverrides: CONFIG_OVERRIDE_STORE_METHODS,
  auditLogs: AUDIT_LOG_STORE_METHODS,
  aclEntries: ACL_ENTRY_STORE_METHODS,
  systemGrants: SYSTEM_GRANT_STORE_METHODS,
  userGroups: USER_GROUP_STORE_METHODS,
  codeEnvironments: CODE_ENVIRONMENT_STORE_METHODS,
  tokenTransactions: TOKEN_TRANSACTION_STORE_METHODS,
  prompts: PROMPT_LIBRARY_STORE_METHODS,
  chatProjects: CHAT_PROJECT_STORE_METHODS,
  conversationTags: CONVERSATION_TAG_STORE_METHODS,
  insights: INSIGHTS_STORE_METHODS,
  skillSync: SKILL_SYNC_STORE_METHODS,
  skillLifecycle: SKILL_LIFECYCLE_STORE_METHODS,
  subagentContent: SUBAGENT_CONTENT_STORE_METHODS,
  conversationImports: CONVERSATION_IMPORT_STORE_METHODS,
  messages: MESSAGE_STORE_METHODS,
  sharedLinks: SHARED_LINK_STORE_METHODS,
  files: FILE_STORE_METHODS,
  agents: AGENT_STORE_METHODS,
  skills: SKILL_STORE_METHODS,
  schedules: SCHEDULE_STORE_METHODS,
  agentQueuedTurns: AGENT_QUEUED_TURN_STORE_METHODS,
  agentTriggerDeliveries: TRIGGER_DELIVERY_STORE_METHODS,
  mcpAuthorities: MCP_AUTHORITY_STORE_METHODS,
  mcpAuthorizationFenceRetries: MCP_AUTHORIZATION_FENCE_RETRY_STORE_METHODS,
  browserSetup: BROWSER_SETUP_BACKEND_STORE_METHODS,
  transactions: STORE_TRANSACTIONS_METHODS,
};

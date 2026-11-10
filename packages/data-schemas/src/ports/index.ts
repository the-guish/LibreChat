/**
 * Ports: database-neutral interfaces for the data layer. Each is satisfied today by the
 * MongoDB methods in `~/methods` and is meant to be satisfied by other adapters as well.
 *
 * {@link DataStore} holds one store per ported module. An adapter supplies all of them at once:
 * the database is switched as a whole, never per module, so an adapter may read any collection
 * it needs while callers and database-neutral code only see the ports.
 */
import type { OpenIDRefreshFlightStore } from './openidRefreshFlight';
import type { RefreshTokenBridgeStore } from './refreshTokenBridge';
import type { ToolApprovalGrantStore } from './toolApprovalGrant';
import type { ScheduleConsentStore } from './scheduleConsent';
import type { AgentCategoryStore } from './agentCategory';
import type { ConversationStore } from './conversation';
import type { ResourceLockStore } from './resourceLock';
import type { FileStorageStore } from './fileStorage';
import type { SpendTokensStore } from './spendTokens';
import type { CategoriesStore } from './categories';
import type { ToolFavoriteStore } from './favorite';
import type { PluginAuthStore } from './pluginAuth';
import type { PrincipalStore } from './principal';
import type { TokenListStore } from './tokenList';
import type { AssistantStore } from './assistant';
import type { ToolCallStore } from './toolCall';
import type { SessionStore } from './session';
import type { PasskeyStore } from './passkey';
import type { BannerStore } from './banner';
import type { PresetStore } from './preset';
import type { ActionStore } from './action';
import type { MemoryStore } from './memory';
import type { UserKeyStore } from './key';
import type { TokenStore } from './token';
import { OPENID_REFRESH_FLIGHT_STORE_METHODS } from './openidRefreshFlight';
import { REFRESH_TOKEN_BRIDGE_STORE_METHODS } from './refreshTokenBridge';
import { TOOL_APPROVAL_GRANT_STORE_METHODS } from './toolApprovalGrant';
import { SCHEDULE_CONSENT_STORE_METHODS } from './scheduleConsent';
import { AGENT_CATEGORY_STORE_METHODS } from './agentCategory';
import { RESOURCE_LOCK_STORE_METHODS } from './resourceLock';
import { CONVERSATION_STORE_METHODS } from './conversation';
import { FILE_STORAGE_STORE_METHODS } from './fileStorage';
import { SPEND_TOKENS_STORE_METHODS } from './spendTokens';
import { TOOL_FAVORITE_STORE_METHODS } from './favorite';
import { PLUGIN_AUTH_STORE_METHODS } from './pluginAuth';
import { CATEGORIES_STORE_METHODS } from './categories';
import { TOKEN_LIST_STORE_METHODS } from './tokenList';
import { PRINCIPAL_STORE_METHODS } from './principal';
import { ASSISTANT_STORE_METHODS } from './assistant';
import { TOOL_CALL_STORE_METHODS } from './toolCall';
import { SESSION_STORE_METHODS } from './session';
import { PASSKEY_STORE_METHODS } from './passkey';
import { BANNER_STORE_METHODS } from './banner';
import { PRESET_STORE_METHODS } from './preset';
import { ACTION_STORE_METHODS } from './action';
import { MEMORY_STORE_METHODS } from './memory';
import { USER_KEY_STORE_METHODS } from './key';
import { TOKEN_STORE_METHODS } from './token';

export type { IdLike, DeleteCount, PortMethodSet, WithIdLike } from './common';
export type { TokenStoreQuery, TokenStoreCreateData } from './token';
export type { SpendTokensTxData } from './spendTokens';
export { listPortMethods } from './common';
export {
  ACTION_STORE_METHODS,
  AGENT_CATEGORY_STORE_METHODS,
  ASSISTANT_STORE_METHODS,
  BANNER_STORE_METHODS,
  CATEGORIES_STORE_METHODS,
  CONVERSATION_STORE_METHODS,
  FILE_STORAGE_STORE_METHODS,
  MEMORY_STORE_METHODS,
  OPENID_REFRESH_FLIGHT_STORE_METHODS,
  PASSKEY_STORE_METHODS,
  PLUGIN_AUTH_STORE_METHODS,
  PRESET_STORE_METHODS,
  PRINCIPAL_STORE_METHODS,
  REFRESH_TOKEN_BRIDGE_STORE_METHODS,
  RESOURCE_LOCK_STORE_METHODS,
  SCHEDULE_CONSENT_STORE_METHODS,
  SESSION_STORE_METHODS,
  SPEND_TOKENS_STORE_METHODS,
  TOKEN_LIST_STORE_METHODS,
  TOKEN_STORE_METHODS,
  TOOL_APPROVAL_GRANT_STORE_METHODS,
  TOOL_CALL_STORE_METHODS,
  TOOL_FAVORITE_STORE_METHODS,
  USER_KEY_STORE_METHODS,
};
export type {
  ActionStore,
  AgentCategoryStore,
  AssistantStore,
  BannerStore,
  CategoriesStore,
  ConversationStore,
  FileStorageStore,
  MemoryStore,
  OpenIDRefreshFlightStore,
  PasskeyStore,
  PluginAuthStore,
  PresetStore,
  PrincipalStore,
  RefreshTokenBridgeStore,
  ResourceLockStore,
  ScheduleConsentStore,
  SessionStore,
  SpendTokensStore,
  TokenListStore,
  TokenStore,
  ToolApprovalGrantStore,
  ToolCallStore,
  ToolFavoriteStore,
  UserKeyStore,
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
};

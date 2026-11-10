import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { OpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import type { RefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import type { ScheduleMCPConsentStorage } from '~/methods/scheduleConsent';
import type { AgentCategoryMethods } from '~/methods/agentCategory';
import type { ConversationMethods } from '~/methods/conversation';
import type { ResourceLockMethods } from '~/methods/resourceLock';
import type { FileStorageMethods } from '~/methods/fileStorage';
import type { SpendTokensMethods } from '~/methods/spendTokens';
import type { CategoriesMethods } from '~/methods/categories';
import type { ToolFavoriteMethods } from '~/methods/favorite';
import type { PluginAuthMethods } from '~/methods/pluginAuth';
import type { PrincipalMethods } from '~/methods/principal';
import type { TokenListMethods } from '~/methods/tokenList';
import type { AssistantMethods } from '~/methods/assistant';
import type { ToolCallMethods } from '~/methods/toolCall';
import type { SessionMethods } from '~/methods/session';
import type { PasskeyMethods } from '~/methods/passkey';
import type { BannerMethods } from '~/methods/banner';
import type { PresetMethods } from '~/methods/preset';
import type { ActionMethods } from '~/methods/action';
import type { MemoryMethods } from '~/methods/memory';
import type { TokenMethods } from '~/methods/token';
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
  };
}

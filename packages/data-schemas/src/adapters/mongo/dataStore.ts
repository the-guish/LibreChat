import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { OpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import type { ScheduleMCPConsentStorage } from '~/methods/scheduleConsent';
import type { AgentCategoryMethods } from '~/methods/agentCategory';
import type { ConversationMethods } from '~/methods/conversation';
import type { ResourceLockMethods } from '~/methods/resourceLock';
import type { CategoriesMethods } from '~/methods/categories';
import type { ToolFavoriteMethods } from '~/methods/favorite';
import type { PrincipalMethods } from '~/methods/principal';
import type { TokenListMethods } from '~/methods/tokenList';
import type { BannerMethods } from '~/methods/banner';
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
  };
}

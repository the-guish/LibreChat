/**
 * Ports: database-neutral interfaces for the data layer. Each is satisfied today by the
 * MongoDB methods in `~/methods` and is meant to be satisfied by other adapters as well.
 *
 * {@link DataStore} holds one store per ported module. An adapter supplies all of them at once:
 * the database is switched as a whole, never per module, so an adapter may read any collection
 * it needs while callers and database-neutral code only see the ports.
 */
import type { OpenIDRefreshFlightStore } from './openidRefreshFlight';
import type { ToolApprovalGrantStore } from './toolApprovalGrant';
import type { ScheduleConsentStore } from './scheduleConsent';
import type { AgentCategoryStore } from './agentCategory';
import type { ConversationStore } from './conversation';
import type { ResourceLockStore } from './resourceLock';
import type { CategoriesStore } from './categories';
import type { ToolFavoriteStore } from './favorite';
import type { PrincipalStore } from './principal';
import type { TokenListStore } from './tokenList';
import type { BannerStore } from './banner';
import type { UserKeyStore } from './key';
import { OPENID_REFRESH_FLIGHT_STORE_METHODS } from './openidRefreshFlight';
import { TOOL_APPROVAL_GRANT_STORE_METHODS } from './toolApprovalGrant';
import { SCHEDULE_CONSENT_STORE_METHODS } from './scheduleConsent';
import { AGENT_CATEGORY_STORE_METHODS } from './agentCategory';
import { RESOURCE_LOCK_STORE_METHODS } from './resourceLock';
import { CONVERSATION_STORE_METHODS } from './conversation';
import { TOOL_FAVORITE_STORE_METHODS } from './favorite';
import { CATEGORIES_STORE_METHODS } from './categories';
import { TOKEN_LIST_STORE_METHODS } from './tokenList';
import { PRINCIPAL_STORE_METHODS } from './principal';
import { BANNER_STORE_METHODS } from './banner';
import { USER_KEY_STORE_METHODS } from './key';

export type { IdLike, DeleteCount, PortMethodSet } from './common';
export { listPortMethods } from './common';
export {
  AGENT_CATEGORY_STORE_METHODS,
  BANNER_STORE_METHODS,
  CATEGORIES_STORE_METHODS,
  CONVERSATION_STORE_METHODS,
  OPENID_REFRESH_FLIGHT_STORE_METHODS,
  PRINCIPAL_STORE_METHODS,
  RESOURCE_LOCK_STORE_METHODS,
  SCHEDULE_CONSENT_STORE_METHODS,
  TOKEN_LIST_STORE_METHODS,
  TOOL_APPROVAL_GRANT_STORE_METHODS,
  TOOL_FAVORITE_STORE_METHODS,
  USER_KEY_STORE_METHODS,
};
export type {
  AgentCategoryStore,
  BannerStore,
  CategoriesStore,
  ConversationStore,
  OpenIDRefreshFlightStore,
  PrincipalStore,
  ResourceLockStore,
  ScheduleConsentStore,
  TokenListStore,
  ToolApprovalGrantStore,
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
};

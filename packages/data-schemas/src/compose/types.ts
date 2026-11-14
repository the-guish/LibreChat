/**
 * Types of the database-neutral composition root (`composeDataMethods`, `./methods`): what a
 * backend hands it (one factory per module, each told exactly which other modules' functions it
 * receives), what the api layer injects, and what comes out. Nothing here may import `mongoose`
 * or the MongoDB driver, at runtime or as a type (the `data-layer/no-database-driver` rule
 * applies to this directory, see eslint.config.mjs).
 *
 * `M` is a backend's module instances, one per module, keyed like {@link DataStore} plus `tx`.
 * Each instance is at least its store (`DataModules`) and may carry more (with MongoDB: the
 * methods the ports leave out, such as `aggregateAclEntries`, which stay on the flat methods).
 * A dependency is typed as the providing module's own method (`M['aclEntries'][...]`), so a
 * backend's factories receive its own functions with their own signatures; with
 * `M = DataModules` these are exactly the port signatures.
 *
 * Compile-time leaks, like the record types listed in each port header: the domain functions
 * and pure helpers are typed as the MongoDB methods modules declare them (`ConversationMethods`,
 * `TxMethods`, `AgentMethods`, `UserGroupMethods`, `SessionMethods`). The pure helpers are
 * shared as they are; the domain functions' database-neutral builders (`createSaveConvo`,
 * `createDeleteConvos`, `createBulkSaveConvos`, `createSearchConversation`) return types
 * assignable to those declarations.
 */
import type { SearchParams } from 'meilisearch';
import type { ConversationMethods } from '~/methods/conversation';
import type { UserGroupMethods } from '~/methods/userGroup';
import type { DataStoreBackend } from '~/ports/connection';
import type { SessionMethods } from '~/methods/session';
import type { TxDeps, TxMethods } from '~/methods/tx';
import type { AgentMethods } from '~/methods/agent';
import type { StoreIds } from '~/ports/storeIds';
import type { IdLike } from '~/ports/common';
import type { CacheStore } from '~/types';
import type { DataStore } from '~/ports';

/** Dependencies injected from the api layer into `createMethods` / `composeDataMethods`. */
export interface CreateMethodsDeps {
  /** Matches a model name to a canonical key. From @librechat/api. */
  matchModelName?: (model: string, endpoint?: string) => string | undefined;
  /** Finds the first key in values whose key is a substring of model. From @librechat/api. */
  findMatchingPattern?: (
    model: string,
    values: Record<string, number | Record<string, number>>,
  ) => string | undefined;
  /** Removes all ACL permissions for a resource. From PermissionService. */
  removeAllPermissions?: RemoveAllPermissions;
  /** Returns a cache store for the given key. From getLogStores. */
  getCache?: CacheGetter;
  /** Resolves only the base deployment's aggregate MCP App persistence limit. */
  getMCPAppMessageBudget?: () => Promise<number | undefined>;
  /** Recognizes agent skill IDs supplied by an external, non-database registry. */
  isExternalSkillId?: (id: string) => boolean;
}

/** Returns a cache store for the given key (`getLogStores`), or nothing. */
export type CacheGetter = (key: string) => CacheStore | undefined;

/** Removes every ACL entry of a resource. */
export type RemoveAllPermissions = (params: {
  resourceType: string;
  resourceId: unknown;
}) => Promise<void>;

/** The four domain functions written once on the conversation store's steps. */
export type ConversationDomainFunctions = Pick<
  ConversationMethods,
  'saveConvo' | 'deleteConvos' | 'bulkSaveConvos' | 'searchConversation'
>;

/** The pure helpers on the flat methods, shared as they are by every backend. */
export type DataPureHelpers = TxMethods &
  Pick<AgentMethods, 'generateActionMetadataHash'> &
  Pick<UserGroupMethods, 'calculateRelevanceScore' | 'sortPrincipalsByRelevance'> &
  Pick<SessionMethods, 'SessionError'>;

/**
 * The search-engine message search (MeiliSearch) the conversation title search also matches,
 * when the backend's message module offers it. Not in the message port: callers use
 * `searchUserMessages`.
 */
export interface MessageIndexSearch {
  searchMessages?(
    query: string,
    searchOptions: SearchParams,
    hydrate?: boolean,
  ): Promise<{ hits: unknown[] }>;
}

/**
 * The least each module instance must be: its store, plus the domain functions (conversations),
 * the pure helpers (`tx`, agents, user groups, sessions) and the optional message search.
 */
export interface DataModules
  extends Omit<DataStore, 'conversations' | 'messages' | 'agents' | 'userGroups' | 'sessions'> {
  /** Token pricing helpers (`createTxMethods`), pure. */
  tx: TxMethods;
  conversations: DataStore['conversations'] & ConversationDomainFunctions;
  messages: DataStore['messages'] & MessageIndexSearch;
  agents: DataStore['agents'] & Pick<AgentMethods, 'generateActionMetadataHash'>;
  userGroups: DataStore['userGroups'] &
    Pick<UserGroupMethods, 'calculateRelevanceScore' | 'sortPrincipalsByRelevance'>;
  sessions: DataStore['sessions'] & Pick<SessionMethods, 'SessionError'>;
}

/** What `tokenTransactions` is built with: the pricing helpers of `tx`. */
export interface TokenTransactionFactoryDeps<M extends DataModules = DataModules> {
  getMultiplier: M['tx']['getMultiplier'];
  getCacheMultiplier: M['tx']['getCacheMultiplier'];
}

/** What `tokenSpending` is built with: the transaction writes of `tokenTransactions`. */
export interface TokenSpendingFactoryDeps<M extends DataModules = DataModules> {
  createTransaction: M['tokenTransactions']['createTransaction'];
  createStructuredTransaction: M['tokenTransactions']['createStructuredTransaction'];
}

/** What `messages` is built with. */
export interface MessageFactoryDeps {
  /** Read from deployment config, never from a message/request or a principal override. */
  getMCPAppMessageBudget?: () => Promise<number | undefined>;
}

/** What `agentTriggerDeliveries` is built with. */
export interface TriggerDeliveryFactoryDeps<M extends DataModules = DataModules> {
  /** Releases a batch's background tool result claims on its messages. */
  releaseBatchProjections: M['messages']['releaseBackgroundToolResultClaims'];
  /** Deletes every queued turn of the owner (the owner's purge). */
  purgeQueuedTurnsForUser: (user: IdLike) => Promise<unknown>;
}

/** What `conversations` is built with: message reads and the cross-store deletion work. */
export interface ConversationFactoryDeps<M extends DataModules = DataModules> {
  getMessages: M['messages']['getMessages'];
  deleteMessages: M['messages']['deleteMessages'];
  /** The message search engine's search, when the message module offers one. */
  searchMessages: M['messages']['searchMessages'];
  eraseAgentTriggerDeliveryConversationResults: M['agentTriggerDeliveries']['eraseAgentTriggerDeliveryConversationResults'];
  prepareAgentTriggerConversationResultErasure: M['agentTriggerDeliveries']['prepareAgentTriggerConversationResultErasure'];
  /** Retires the owner's queued turns (and their deliveries) in the listed conversations. */
  deleteAgentQueuedTurns: (
    user: string,
    conversations: Array<{ conversationId: string; tenantId?: string; allTenants?: true }>,
  ) => Promise<void>;
}

/** What `roles` and `users` are built with. */
export interface CacheFactoryDeps {
  getCache?: CacheGetter;
}

/** What `userGroups` is built with. */
export interface UserGroupFactoryDeps extends CacheFactoryDeps {
  /**
   * Notified after membership caches are invalidated so access caches derived from
   * memberships (prompt group access ids) drop their stale entries too.
   */
  onMemberGroupsInvalidated?: () => void | Promise<void>;
}

/** What the modules that own ACL-protected resources are built with. */
export interface OwnedResourceFactoryDeps<M extends DataModules = DataModules> {
  removeAllPermissions: RemoveAllPermissions;
  getSoleOwnedResourceIds: M['aclEntries']['getSoleOwnedResourceIds'];
}

/** What `prompts` is built with. */
export interface PromptFactoryDeps<M extends DataModules = DataModules>
  extends OwnedResourceFactoryDeps<M>,
    CacheFactoryDeps {
  getUserPrincipals: M['userGroups']['getUserPrincipals'];
  findAccessibleResources: M['aclEntries']['findAccessibleResources'];
  findPublicResourceIds: M['aclEntries']['findPublicResourceIds'];
}

/** What `agents` is built with. */
export interface AgentFactoryDeps<M extends DataModules = DataModules>
  extends OwnedResourceFactoryDeps<M>,
    CacheFactoryDeps {
  getActions: M['actions']['getActions'];
  getUserPrincipals: M['userGroups']['getUserPrincipals'];
  findAccessibleResources: M['aclEntries']['findAccessibleResources'];
  isExternalSkillId?: (id: string) => boolean;
}

/** What `mcpServers` is built with. */
export interface MCPServerFactoryDeps<M extends DataModules = DataModules> {
  getSoleOwnedResourceIds: M['aclEntries']['getSoleOwnedResourceIds'];
}

/** What `browserSetup` is built with: the code environment module it registers through. */
export interface BrowserSetupFactoryDeps<M extends DataModules = DataModules> {
  codeEnvironments: M['codeEnvironments'];
}

/**
 * What a backend hands `composeDataMethods`: its id format and one factory per module. Each
 * factory builds a new instance on every call and is called once per composition, in the
 * order `composeDataMethods` documents.
 */
export interface DataModuleFactories<M extends DataModules = DataModules> {
  /** The backend's id format; the wiring validates and casts ids only through it. */
  ids: StoreIds;
  tx(deps: TxDeps): M['tx'];
  tokenTransactions(deps: TokenTransactionFactoryDeps<M>): M['tokenTransactions'];
  tokenSpending(deps: TokenSpendingFactoryDeps<M>): M['tokenSpending'];
  messages(deps: MessageFactoryDeps): M['messages'];
  agentQueuedTurns(): M['agentQueuedTurns'];
  agentTriggerDeliveries(deps: TriggerDeliveryFactoryDeps<M>): M['agentTriggerDeliveries'];
  conversations(deps: ConversationFactoryDeps<M>): M['conversations'];
  aclEntries(): M['aclEntries'];
  systemGrants(): M['systemGrants'];
  roles(deps: CacheFactoryDeps): M['roles'];
  userGroups(deps: UserGroupFactoryDeps): M['userGroups'];
  prompts(deps: PromptFactoryDeps<M>): M['prompts'];
  skills(deps: OwnedResourceFactoryDeps<M>): M['skills'];
  actions(): M['actions'];
  agents(deps: AgentFactoryDeps<M>): M['agents'];
  toolApprovalGrants(): M['toolApprovalGrants'];
  tokenLists(): M['tokenLists'];
  openidRefreshFlights(): M['openidRefreshFlights'];
  resourceLocks(): M['resourceLocks'];
  userKeys(): M['userKeys'];
  toolFavorites(): M['toolFavorites'];
  agentCategories(): M['agentCategories'];
  banners(): M['banners'];
  categories(): M['categories'];
  scheduleConsents(): M['scheduleConsents'];
  principals(): M['principals'];
  sessions(): M['sessions'];
  tokens(): M['tokens'];
  refreshTokenBridges(): M['refreshTokenBridges'];
  passkeys(): M['passkeys'];
  presets(): M['presets'];
  toolCalls(): M['toolCalls'];
  assistants(): M['assistants'];
  pluginAuths(): M['pluginAuths'];
  memories(): M['memories'];
  fileStorage(): M['fileStorage'];
  users(deps: CacheFactoryDeps): M['users'];
  accessRoles(): M['accessRoles'];
  agentApiKeys(): M['agentApiKeys'];
  mcpServers(deps: MCPServerFactoryDeps<M>): M['mcpServers'];
  configOverrides(): M['configOverrides'];
  auditLogs(): M['auditLogs'];
  codeEnvironments(): M['codeEnvironments'];
  chatProjects(): M['chatProjects'];
  conversationTags(): M['conversationTags'];
  insights(): M['insights'];
  skillSync(): M['skillSync'];
  skillLifecycle(): M['skillLifecycle'];
  subagentContent(): M['subagentContent'];
  conversationImports(): M['conversationImports'];
  sharedLinks(): M['sharedLinks'];
  files(): M['files'];
  schedules(): M['schedules'];
  mcpAuthorities(): M['mcpAuthorities'];
  mcpAuthorizationFenceRetries(): M['mcpAuthorizationFenceRetries'];
  browserSetup(deps: BrowserSetupFactoryDeps<M>): M['browserSetup'];
  transactions(): M['transactions'];
}

/** The ports' own members on the composed methods: the stores and the top-level conversation store. */
export interface DataStoreMembers {
  /**
   * Every ported module's operations as database-neutral stores, backed by the flat methods
   * (the same functions). Callers should reach a ported operation through its store.
   */
  stores: DataStore;
  /** `stores.conversations`, kept at the top level for existing callers. */
  conversations: DataStore['conversations'];
}

/**
 * What `composeDataMethods` returns for a backend's modules `M`: every instance's methods, flat
 * (spread in this order, so a later module's method of a name wins), and the stores.
 */
export type ComposedDataMethods<M extends DataModules> = M['users'] &
  M['toolApprovalGrants'] &
  M['sessions'] &
  M['tokens'] &
  M['tokenLists'] &
  M['refreshTokenBridges'] &
  M['openidRefreshFlights'] &
  M['resourceLocks'] &
  M['subagentContent'] &
  M['passkeys'] &
  M['roles'] &
  M['userKeys'] &
  M['files'] &
  M['fileStorage'] &
  M['memories'] &
  M['toolFavorites'] &
  M['agentCategories'] &
  M['agentApiKeys'] &
  M['mcpServers'] &
  M['codeEnvironments'] &
  M['accessRoles'] &
  M['userGroups'] &
  M['aclEntries'] &
  M['systemGrants'] &
  M['auditLogs'] &
  M['sharedLinks'] &
  M['pluginAuths'] &
  M['actions'] &
  M['assistants'] &
  M['banners'] &
  M['toolCalls'] &
  M['categories'] &
  M['presets'] &
  M['conversationTags'] &
  M['conversationImports'] &
  M['messages'] &
  M['conversations'] &
  M['chatProjects'] &
  M['tx'] &
  M['tokenTransactions'] &
  M['tokenSpending'] &
  M['prompts'] &
  M['skills'] &
  M['skillSync'] &
  M['skillLifecycle'] &
  M['agentTriggerDeliveries'] &
  M['agentQueuedTurns'] &
  M['schedules'] &
  M['scheduleConsents'] &
  M['agents'] &
  M['configOverrides'] &
  M['principals'] &
  M['mcpAuthorities'] &
  M['insights'] &
  M['mcpAuthorizationFenceRetries'] &
  M['browserSetup'] &
  M['transactions'] &
  DataStoreMembers;

type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends (
  member: infer I,
) => void
  ? I
  : never;

/** Every store's methods, flat (no two stores share a method name). */
export type DataStoreMethods = UnionToIntersection<DataStore[keyof DataStore]>;

/**
 * The data methods every backend's `createMethods` returns: every store's methods flat, the
 * domain functions, the pure helpers, the stores and the top-level conversation store. A
 * backend may return more (with MongoDB: `aggregateAclEntries`, `getMessagesByCursor` and
 * `searchMessages`, which have no production caller; see `AllMethods`).
 */
export type DataMethods = DataStoreMethods &
  ConversationDomainFunctions &
  DataPureHelpers &
  DataStoreMembers;

/** A backend as database-neutral code sees it: `createMethods` builds {@link DataMethods}. */
export type DataMethodsBackend = DataStoreBackend<DataMethods, CreateMethodsDeps>;

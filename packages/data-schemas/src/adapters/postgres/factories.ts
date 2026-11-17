/**
 * The PostgreSQL backend's module factories for `composeDataMethods` (`~/compose`;
 * docs/postgres-port/PHASE4.md §8). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Implemented so far: `transactions` (`./storeTransactions`), the pure `tx` helpers (shared as
 * they are) and the store adapters of `./stores` (S3: the small and config stores; S1: the
 * identity and auth stores; S4: the balance stores, `tokenTransactions` valuing transactions with
 * `tx`'s pricing helpers and `tokenSpending` on its transaction writes), each built
 * with the backend's `PostgresStoreContext`. Every other store is a stand-in whose methods throw
 * `StoreNotImplementedError` (`./notImplemented`); the S units replace them one by one, and their
 * names leave {@link POSTGRES_IMPLEMENTED_STORES}'s complement. So are the members the module instances
 * carry beyond their stores: the four conversation domain functions (rebuilt on the PostgreSQL
 * conversation store, S6a) and the pure helper that still lives inside a MongoDB method module
 * (`generateActionMetadataHash`; shared once extracted, S7). `SessionError` is the class itself.
 * The user group ranking helpers (`calculateRelevanceScore`, `sortPrincipalsByRelevance`) are
 * served by the PostgreSQL `userGroups` module from `~/methods/userGroupRules` (S2).
 */
import type { DataModuleFactories, DataModules } from '~/compose/types';
import type { StoreTransactions } from '~/ports/storeTransactions';
import type { PostgresStoreContext } from './stores/context';
import type { DataStore } from '~/ports';
import {
  createPostgresBannerStore,
  createPostgresActionStore,
  createPostgresMemoryStore,
  createPostgresPresetStore,
  createPostgresAuditLogStore,
  createPostgresToolCallStore,
  createPostgresAssistantStore,
  createPostgresTokenListStore,
  createPostgresCategoriesStore,
  createPostgresFileStorageStore,
  createPostgresToolFavoriteStore,
  createPostgresAgentCategoryStore,
  createPostgresConfigOverrideStore,
  createPostgresToolApprovalGrantStore,
  createPostgresUserStore,
  createPostgresTokenStore,
  createPostgresPasskeyStore,
  createPostgresSessionStore,
  createPostgresUserKeyStore,
  createPostgresPluginAuthStore,
  createPostgresAgentApiKeyStore,
  createPostgresRefreshTokenBridgeStore,
  createPostgresOpenIDRefreshFlightStore,
  createPostgresSpendTokensStore,
  createPostgresTokenTransactionStore,
} from './stores';
import {
  createPostgresRoleStore,
  createPostgresAclEntryStore,
  createPostgresUserGroupStore,
  createPostgresPrincipalStore,
  createPostgresAccessRoleStore,
  createPostgresSystemGrantStore,
  createPostgresResourceLockStore,
} from './stores';
import { createPostgresMessageStore, createPostgresSubagentContentStore } from './stores';
import { createNotImplementedStore, notImplemented } from './notImplemented';
import { SessionError } from '~/methods/sessionRules';
import { createTxMethods } from '~/methods/tx';
import { postgresStoreIds } from './storeIds';
import { DATA_STORE_METHODS } from '~/ports';

/** The stores the PostgreSQL backend implements; every other store is a stand-in. */
export const POSTGRES_IMPLEMENTED_STORES: ReadonlySet<keyof DataStore> = new Set<keyof DataStore>([
  'transactions',
  /** S3: the small and config stores (`./stores`). */
  'configOverrides',
  'banners',
  'categories',
  'agentCategories',
  'toolFavorites',
  'tokenLists',
  'presets',
  'actions',
  'assistants',
  'toolCalls',
  'auditLogs',
  'memories',
  'fileStorage',
  'toolApprovalGrants',
  /** S1: the identity and auth stores (`./stores`). */
  'users',
  'sessions',
  'tokens',
  'refreshTokenBridges',
  'openidRefreshFlights',
  'passkeys',
  'userKeys',
  'pluginAuths',
  'agentApiKeys',
  /** S2: the authorization stores (`./stores`). */
  'roles',
  'accessRoles',
  'aclEntries',
  'systemGrants',
  'userGroups',
  'principals',
  'resourceLocks',
  /** S4: the balance stores (`./stores`). */
  'tokenTransactions',
  'tokenSpending',
  /** S5: the message stores (`./stores`). */
  'messages',
  'subagentContent',
]);

/** The stores of `DataStore` the PostgreSQL backend does not implement yet, in port order. */
export const POSTGRES_UNIMPLEMENTED_STORES: ReadonlyArray<keyof DataStore> = (
  Object.keys(DATA_STORE_METHODS) as Array<keyof DataStore>
).filter((store) => !POSTGRES_IMPLEMENTED_STORES.has(store));

/** What the PostgreSQL module factories are built with. */
export interface PostgresDataModuleFactoryOptions {
  /** The `transactions` store, on the backend's connection. */
  createTransactions(): StoreTransactions;
  /**
   * What the store adapters are built with (`./stores/context`), given the `transactions` store
   * the same composition uses.
   */
  createStoreContext(transactions: StoreTransactions): PostgresStoreContext;
}

/** `createTxMethods` takes the mongoose instance only by convention; it never reads it. */
type TxMongooseParameter = Parameters<typeof createTxMethods>[0];

/** The PostgreSQL module factories (stand-ins except `tx`, `transactions` and the stores). */
export function createPostgresDataModuleFactories(
  options: PostgresDataModuleFactoryOptions,
): DataModuleFactories<DataModules> {
  const stub = createNotImplementedStore;
  /** One `transactions` store per composition, shared with the stores that open transactions. */
  let transactions: StoreTransactions | undefined;
  const getTransactions = () => (transactions ??= options.createTransactions());
  let context: PostgresStoreContext | undefined;
  const ctx = () => (context ??= options.createStoreContext(getTransactions()));
  return {
    ids: postgresStoreIds,
    tx: (deps) => createTxMethods(undefined as unknown as TxMongooseParameter, deps),
    tokenTransactions: (deps) => createPostgresTokenTransactionStore(ctx(), deps),
    tokenSpending: (deps) => createPostgresSpendTokensStore(deps),
    messages: (deps) => createPostgresMessageStore(ctx(), deps),
    agentQueuedTurns: () => stub('agentQueuedTurns'),
    agentTriggerDeliveries: () => stub('agentTriggerDeliveries'),
    conversations: () => ({
      ...stub('conversations'),
      saveConvo: notImplemented('conversations', 'saveConvo'),
      deleteConvos: notImplemented('conversations', 'deleteConvos'),
      bulkSaveConvos: notImplemented('conversations', 'bulkSaveConvos'),
      searchConversation: notImplemented('conversations', 'searchConversation'),
    }),
    aclEntries: () => createPostgresAclEntryStore(ctx()),
    systemGrants: () => createPostgresSystemGrantStore(ctx()),
    roles: (deps) => createPostgresRoleStore(ctx(), deps),
    userGroups: (deps) => createPostgresUserGroupStore(ctx(), deps),
    prompts: () => stub('prompts'),
    skills: () => stub('skills'),
    actions: () => createPostgresActionStore(ctx()),
    agents: () => ({
      ...stub('agents'),
      generateActionMetadataHash: notImplemented('agents', 'generateActionMetadataHash'),
    }),
    toolApprovalGrants: () => createPostgresToolApprovalGrantStore(ctx()),
    tokenLists: () => createPostgresTokenListStore(ctx()),
    openidRefreshFlights: () => createPostgresOpenIDRefreshFlightStore(ctx()),
    resourceLocks: () => createPostgresResourceLockStore(ctx()),
    userKeys: () => createPostgresUserKeyStore(ctx()),
    toolFavorites: () => createPostgresToolFavoriteStore(ctx()),
    agentCategories: () => createPostgresAgentCategoryStore(ctx()),
    banners: () => createPostgresBannerStore(ctx()),
    categories: () => createPostgresCategoriesStore(),
    scheduleConsents: () => stub('scheduleConsents'),
    principals: () => createPostgresPrincipalStore(ctx()),
    sessions: () => ({ ...createPostgresSessionStore(ctx()), SessionError }),
    tokens: () => createPostgresTokenStore(ctx()),
    refreshTokenBridges: () => createPostgresRefreshTokenBridgeStore(ctx()),
    passkeys: () => createPostgresPasskeyStore(ctx()),
    presets: () => createPostgresPresetStore(ctx()),
    toolCalls: () => createPostgresToolCallStore(ctx()),
    assistants: () => createPostgresAssistantStore(ctx()),
    pluginAuths: () => createPostgresPluginAuthStore(ctx()),
    memories: () => createPostgresMemoryStore(ctx()),
    fileStorage: () => createPostgresFileStorageStore(ctx()),
    users: (deps) => createPostgresUserStore(ctx(), deps),
    accessRoles: () => createPostgresAccessRoleStore(ctx()),
    agentApiKeys: () => createPostgresAgentApiKeyStore(ctx()),
    mcpServers: () => stub('mcpServers'),
    configOverrides: () => createPostgresConfigOverrideStore(ctx()),
    auditLogs: () => createPostgresAuditLogStore(ctx()),
    codeEnvironments: () => stub('codeEnvironments'),
    chatProjects: () => stub('chatProjects'),
    conversationTags: () => stub('conversationTags'),
    insights: () => stub('insights'),
    skillSync: () => stub('skillSync'),
    skillLifecycle: () => stub('skillLifecycle'),
    subagentContent: () => createPostgresSubagentContentStore(ctx()),
    conversationImports: () => stub('conversationImports'),
    sharedLinks: () => stub('sharedLinks'),
    files: () => stub('files'),
    schedules: () => stub('schedules'),
    mcpAuthorities: () => stub('mcpAuthorities'),
    mcpAuthorizationFenceRetries: () => stub('mcpAuthorizationFenceRetries'),
    browserSetup: () => stub('browserSetup'),
    transactions: () => getTransactions(),
  };
}

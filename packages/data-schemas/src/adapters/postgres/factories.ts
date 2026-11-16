/**
 * The PostgreSQL backend's module factories for `composeDataMethods` (`~/compose`;
 * docs/postgres-port/PHASE4.md §8). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Implemented so far: `transactions` (`./storeTransactions`), the pure `tx` helpers (shared as
 * they are) and the store adapters of `./stores` (S3: the small and config stores), each built
 * with the backend's `PostgresStoreContext`. Every other store is a stand-in whose methods throw
 * `StoreNotImplementedError` (`./notImplemented`); the S units replace them one by one, and their
 * names leave {@link POSTGRES_IMPLEMENTED_STORES}'s complement. So are the members the module instances
 * carry beyond their stores: the four conversation domain functions (rebuilt on the PostgreSQL
 * conversation store, S6a) and the pure helpers that still live inside MongoDB method modules
 * (`generateActionMetadataHash`, `calculateRelevanceScore`, `sortPrincipalsByRelevance`; shared
 * once extracted, S7 and S2). `SessionError` is the class itself.
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
} from './stores';
import { createNotImplementedStore, notImplemented } from './notImplemented';
import { SessionError } from '~/methods/session';
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
    tokenTransactions: () => stub('tokenTransactions'),
    tokenSpending: () => stub('tokenSpending'),
    messages: () => stub('messages'),
    agentQueuedTurns: () => stub('agentQueuedTurns'),
    agentTriggerDeliveries: () => stub('agentTriggerDeliveries'),
    conversations: () => ({
      ...stub('conversations'),
      saveConvo: notImplemented('conversations', 'saveConvo'),
      deleteConvos: notImplemented('conversations', 'deleteConvos'),
      bulkSaveConvos: notImplemented('conversations', 'bulkSaveConvos'),
      searchConversation: notImplemented('conversations', 'searchConversation'),
    }),
    aclEntries: () => stub('aclEntries'),
    systemGrants: () => stub('systemGrants'),
    roles: () => stub('roles'),
    userGroups: () => ({
      ...stub('userGroups'),
      calculateRelevanceScore: notImplemented('userGroups', 'calculateRelevanceScore'),
      sortPrincipalsByRelevance: notImplemented('userGroups', 'sortPrincipalsByRelevance'),
    }),
    prompts: () => stub('prompts'),
    skills: () => stub('skills'),
    actions: () => createPostgresActionStore(ctx()),
    agents: () => ({
      ...stub('agents'),
      generateActionMetadataHash: notImplemented('agents', 'generateActionMetadataHash'),
    }),
    toolApprovalGrants: () => createPostgresToolApprovalGrantStore(ctx()),
    tokenLists: () => createPostgresTokenListStore(ctx()),
    openidRefreshFlights: () => stub('openidRefreshFlights'),
    resourceLocks: () => stub('resourceLocks'),
    userKeys: () => stub('userKeys'),
    toolFavorites: () => createPostgresToolFavoriteStore(ctx()),
    agentCategories: () => createPostgresAgentCategoryStore(ctx()),
    banners: () => createPostgresBannerStore(ctx()),
    categories: () => createPostgresCategoriesStore(),
    scheduleConsents: () => stub('scheduleConsents'),
    principals: () => stub('principals'),
    sessions: () => ({ ...stub('sessions'), SessionError }),
    tokens: () => stub('tokens'),
    refreshTokenBridges: () => stub('refreshTokenBridges'),
    passkeys: () => stub('passkeys'),
    presets: () => createPostgresPresetStore(ctx()),
    toolCalls: () => createPostgresToolCallStore(ctx()),
    assistants: () => createPostgresAssistantStore(ctx()),
    pluginAuths: () => stub('pluginAuths'),
    memories: () => createPostgresMemoryStore(ctx()),
    fileStorage: () => createPostgresFileStorageStore(ctx()),
    users: () => stub('users'),
    accessRoles: () => stub('accessRoles'),
    agentApiKeys: () => stub('agentApiKeys'),
    mcpServers: () => stub('mcpServers'),
    configOverrides: () => createPostgresConfigOverrideStore(ctx()),
    auditLogs: () => createPostgresAuditLogStore(ctx()),
    codeEnvironments: () => stub('codeEnvironments'),
    chatProjects: () => stub('chatProjects'),
    conversationTags: () => stub('conversationTags'),
    insights: () => stub('insights'),
    skillSync: () => stub('skillSync'),
    skillLifecycle: () => stub('skillLifecycle'),
    subagentContent: () => stub('subagentContent'),
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

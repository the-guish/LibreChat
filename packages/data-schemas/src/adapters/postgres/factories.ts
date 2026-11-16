/**
 * The PostgreSQL backend's module factories for `composeDataMethods` (`~/compose`;
 * docs/postgres-port/PHASE4.md §8). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Implemented so far: `transactions` (`./storeTransactions`) and the pure `tx` helpers (shared
 * as they are). Every other store is a stand-in whose methods throw `StoreNotImplementedError`
 * (`./notImplemented`); the S units replace them one by one, and their names leave
 * {@link POSTGRES_IMPLEMENTED_STORES}'s complement. So are the members the module instances
 * carry beyond their stores: the four conversation domain functions (rebuilt on the PostgreSQL
 * conversation store, S6a) and the pure helpers that still live inside MongoDB method modules
 * (`generateActionMetadataHash`, `calculateRelevanceScore`, `sortPrincipalsByRelevance`; shared
 * once extracted, S7 and S2). `SessionError` is the class itself.
 */
import type { DataModuleFactories, DataModules } from '~/compose/types';
import type { StoreTransactions } from '~/ports/storeTransactions';
import type { DataStore } from '~/ports';
import { createNotImplementedStore, notImplemented } from './notImplemented';
import { SessionError } from '~/methods/session';
import { createTxMethods } from '~/methods/tx';
import { postgresStoreIds } from './storeIds';
import { DATA_STORE_METHODS } from '~/ports';

/** The stores the PostgreSQL backend implements; every other store is a stand-in. */
export const POSTGRES_IMPLEMENTED_STORES: ReadonlySet<keyof DataStore> = new Set<keyof DataStore>([
  'transactions',
]);

/** The stores of `DataStore` the PostgreSQL backend does not implement yet, in port order. */
export const POSTGRES_UNIMPLEMENTED_STORES: ReadonlyArray<keyof DataStore> = (
  Object.keys(DATA_STORE_METHODS) as Array<keyof DataStore>
).filter((store) => !POSTGRES_IMPLEMENTED_STORES.has(store));

/** What the PostgreSQL module factories are built with. */
export interface PostgresDataModuleFactoryOptions {
  /** The `transactions` store, on the backend's connection. */
  createTransactions(): StoreTransactions;
}

/** `createTxMethods` takes the mongoose instance only by convention; it never reads it. */
type TxMongooseParameter = Parameters<typeof createTxMethods>[0];

/** The PostgreSQL module factories (stand-ins except `tx` and `transactions`). */
export function createPostgresDataModuleFactories(
  options: PostgresDataModuleFactoryOptions,
): DataModuleFactories<DataModules> {
  const stub = createNotImplementedStore;
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
    actions: () => stub('actions'),
    agents: () => ({
      ...stub('agents'),
      generateActionMetadataHash: notImplemented('agents', 'generateActionMetadataHash'),
    }),
    toolApprovalGrants: () => stub('toolApprovalGrants'),
    tokenLists: () => stub('tokenLists'),
    openidRefreshFlights: () => stub('openidRefreshFlights'),
    resourceLocks: () => stub('resourceLocks'),
    userKeys: () => stub('userKeys'),
    toolFavorites: () => stub('toolFavorites'),
    agentCategories: () => stub('agentCategories'),
    banners: () => stub('banners'),
    categories: () => stub('categories'),
    scheduleConsents: () => stub('scheduleConsents'),
    principals: () => stub('principals'),
    sessions: () => ({ ...stub('sessions'), SessionError }),
    tokens: () => stub('tokens'),
    refreshTokenBridges: () => stub('refreshTokenBridges'),
    passkeys: () => stub('passkeys'),
    presets: () => stub('presets'),
    toolCalls: () => stub('toolCalls'),
    assistants: () => stub('assistants'),
    pluginAuths: () => stub('pluginAuths'),
    memories: () => stub('memories'),
    fileStorage: () => stub('fileStorage'),
    users: () => stub('users'),
    accessRoles: () => stub('accessRoles'),
    agentApiKeys: () => stub('agentApiKeys'),
    mcpServers: () => stub('mcpServers'),
    configOverrides: () => stub('configOverrides'),
    auditLogs: () => stub('auditLogs'),
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
    transactions: () => options.createTransactions(),
  };
}

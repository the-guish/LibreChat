/**
 * The PostgreSQL backend's module factories for `composeDataMethods` (`~/compose`;
 * docs/postgres-port/PHASE4.md §8). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Every module is implemented (since S11; B1 removed the stand-ins): `transactions`
 * (`./storeTransactions`), the pure `tx` helpers (shared as they are) and the store adapters of
 * `./stores` (S1 to S11), each built with the backend's `PostgresStoreContext`. The factories type
 * (`DataModuleFactories`) names every module, so a store `DataStore` gains is a type error here
 * until its PostgreSQL adapter exists. The agents module serves the pure
 * `generateActionMetadataHash` from `~/methods/agentRules` (S7). The four conversation domain
 * functions are written on the PostgreSQL conversation store (S6a), as on MongoDB. `SessionError`
 * is the class itself. The user group ranking helpers (`calculateRelevanceScore`,
 * `sortPrincipalsByRelevance`) are served by the PostgreSQL `userGroups` module from
 * `~/methods/userGroupRules` (S2).
 */
import type { DataModuleFactories, DataModules } from '~/compose/types';
import type { StoreTransactions } from '~/ports/storeTransactions';
import type { PostgresStoreContext } from './stores/context';
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
import {
  createPostgresMCPServerStore,
  createPostgresBrowserSetupStore,
  createPostgresMCPAuthorityStore,
  createPostgresCodeEnvironmentStore,
  createPostgresMCPAuthorizationFenceRetryStore,
} from './stores';
import {
  createPostgresInsightsStore,
  createPostgresSharedLinkStore,
  createPostgresChatProjectStore,
  createPostgresConversationTagStore,
  createPostgresConversationImportStore,
} from './stores';
import {
  createPostgresSkillStore,
  createPostgresPromptStore,
  createPostgresSkillSyncStore,
  createPostgresSkillLifecycleStore,
} from './stores';
import { createPostgresScheduleStore, createPostgresScheduleConsentStore } from './stores';
import { createPostgresMessageStore, createPostgresSubagentContentStore } from './stores';
import { createPostgresFileStore, createPostgresAgentStore } from './stores';
import { generateActionMetadataHash } from '~/methods/agentRules';
import { createPostgresAgentQueuedTurnStore } from './stores';
import { createPostgresTriggerDeliveryStore } from './stores';
import { createPostgresConversationStore } from './stores';
import { SessionError } from '~/methods/sessionRules';
import { createTxMethods } from '~/methods/tx';
import { postgresStoreIds } from './storeIds';

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

/** The PostgreSQL module factories: `tx`, `transactions` and every store. */
export function createPostgresDataModuleFactories(
  options: PostgresDataModuleFactoryOptions,
): DataModuleFactories<DataModules> {
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
    agentQueuedTurns: () => createPostgresAgentQueuedTurnStore(ctx()),
    agentTriggerDeliveries: (deps) => createPostgresTriggerDeliveryStore(ctx(), deps),
    conversations: (deps) => createPostgresConversationStore(ctx(), deps),
    aclEntries: () => createPostgresAclEntryStore(ctx()),
    systemGrants: () => createPostgresSystemGrantStore(ctx()),
    roles: (deps) => createPostgresRoleStore(ctx(), deps),
    userGroups: (deps) => createPostgresUserGroupStore(ctx(), deps),
    prompts: (deps) => createPostgresPromptStore(ctx(), deps),
    skills: (deps) => createPostgresSkillStore(ctx(), deps),
    actions: () => createPostgresActionStore(ctx()),
    agents: (deps) => ({
      ...createPostgresAgentStore(ctx(), deps),
      generateActionMetadataHash,
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
    scheduleConsents: () => createPostgresScheduleConsentStore(ctx()),
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
    mcpServers: (deps) => createPostgresMCPServerStore(ctx(), deps),
    configOverrides: () => createPostgresConfigOverrideStore(ctx()),
    auditLogs: () => createPostgresAuditLogStore(ctx()),
    codeEnvironments: () => createPostgresCodeEnvironmentStore(ctx()),
    chatProjects: () => createPostgresChatProjectStore(ctx()),
    conversationTags: () => createPostgresConversationTagStore(ctx()),
    insights: () => createPostgresInsightsStore(ctx()),
    skillSync: () => createPostgresSkillSyncStore(ctx()),
    skillLifecycle: () => createPostgresSkillLifecycleStore(ctx()),
    subagentContent: () => createPostgresSubagentContentStore(ctx()),
    conversationImports: () => createPostgresConversationImportStore(ctx()),
    sharedLinks: () => createPostgresSharedLinkStore(ctx()),
    files: () => createPostgresFileStore(ctx()),
    schedules: () => createPostgresScheduleStore(ctx()),
    mcpAuthorities: () => createPostgresMCPAuthorityStore(ctx()),
    mcpAuthorizationFenceRetries: () => createPostgresMCPAuthorizationFenceRetryStore(ctx()),
    browserSetup: (deps) => createPostgresBrowserSetupStore(ctx(), deps),
    transactions: () => getTransactions(),
  };
}

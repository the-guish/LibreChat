/**
 * The database-neutral composition root: builds every module of a backend once, from that
 * backend's factories, wires the modules to each other, and returns the flat methods with their
 * stores. Every backend composes through here, so the cross-store wiring (which module a module
 * is built with, the late bindings, the queued-turn and delivery deletion orchestration, the
 * default ACL cleanup) is written once. Nothing here may import `mongoose` or the MongoDB driver,
 * at runtime or as a type; ids are validated and cast only through the backend's `ids`.
 */
import type {
  DataModules,
  CreateMethodsDeps,
  DataModuleFactories,
  ComposedDataMethods,
  RemoveAllPermissions,
  ConversationFactoryDeps,
} from './types';
import type { StoreEqualityValue } from '~/ports/query';
import { createDataStore } from './stores';

/** How a store id is written as a string: 24 hex characters, in either case. */
const HEX_STORE_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Builds the data methods on a backend's module factories (see {@link DataModuleFactories}):
 * each module once, in this order (a module is built after the modules it is built with):
 * `tx`, `tokenTransactions`, `tokenSpending`, `messages`, `agentQueuedTurns`,
 * `agentTriggerDeliveries`, `conversations`, `aclEntries`, `systemGrants`, `roles`,
 * `userGroups`, `prompts`, `skills`, `actions`, `agents`, then the modules built with nothing
 * but the api layer's dependencies, `browserSetup` (on the `codeEnvironments` instance) and
 * `transactions`. The stores hand out the instances' own functions (one instance serves both).
 */
export function composeDataMethods<M extends DataModules>(
  factories: DataModuleFactories<M>,
  deps: CreateMethodsDeps = {},
): ComposedDataMethods<M> {
  const { ids } = factories;

  // tx methods need matchModelName and findMatchingPattern
  const txMethods = factories.tx({
    matchModelName: deps.matchModelName ?? (() => undefined),
    findMatchingPattern: deps.findMatchingPattern ?? (() => undefined),
  });

  // transaction methods need tx's getMultiplier/getCacheMultiplier
  const transactionMethods = factories.tokenTransactions({
    getMultiplier: txMethods.getMultiplier,
    getCacheMultiplier: txMethods.getCacheMultiplier,
  });

  // spendTokens methods need transaction methods
  const spendTokensMethods = factories.tokenSpending({
    createTransaction: transactionMethods.createTransaction,
    createStructuredTransaction: transactionMethods.createStructuredTransaction,
  });

  const messageMethods = factories.messages({
    getMCPAppMessageBudget: deps.getMCPAppMessageBudget,
  });

  const agentQueuedTurnMethods = factories.agentQueuedTurns();
  const agentTriggerDeliveryMethods = factories.agentTriggerDeliveries({
    releaseBatchProjections: messageMethods.releaseBackgroundToolResultClaims,
    purgeQueuedTurnsForUser: (user) =>
      agentQueuedTurnMethods.deleteAllAgentQueuedTurnsForUser({
        user: typeof user === 'string' ? ids.toStoreId(user) : user,
      }),
  });

  const deleteAgentQueuedTurns: ConversationFactoryDeps<M>['deleteAgentQueuedTurns'] = async (
    user,
    conversations,
  ) => {
    /** Queued-turn ownership is store-id-backed. Conversation methods also support
     * synthetic/non-id owners in embedded integrations and tests; those owners cannot have
     * queued-turn rows to retire. */
    if (!(typeof user === 'string' ? HEX_STORE_ID.test(user) : ids.isValid(user))) {
      return;
    }
    const owner = ids.toStoreId(user);
    const settledAt = new Date();
    const deliveryKeys = await agentQueuedTurnMethods.prepareAgentQueuedTurnConversationDeletion({
      user: owner,
      targets: conversations,
      settledAt,
    });
    await Promise.all(
      deliveryKeys.map(async (deliveryKey) => {
        const retirement = {
          deliveryKey,
          sourceId: 'agent-queued-turn',
          reason: 'queued_turn_conversation_deleted',
          settledAt,
          /** The source lane is fenced and admission has settled. Queued-turn
           * deliveries need not receive a later terminal handling receipt. */
          allowSucceeded: true,
        };
        let retired = await agentTriggerDeliveryMethods.retireAgentTriggerDelivery(retirement);
        if (!retired) {
          /** A delivery can exhaust immediately before owner deletion wins.
           * Convert that operator-requeueable dead row into the same terminal
           * retirement receipt before removing its source record. */
          retired = await agentTriggerDeliveryMethods.retireAgentTriggerDelivery({
            ...retirement,
            onlyIfDead: true,
          });
        }
        if (!retired) {
          /** Successful and dead delivery receipts have bounded retention.
           * A source in `published` proves the delivery existed, so a missing
           * receipt after both retirement attempts is terminal absence. */
          const fenced = await agentQueuedTurnMethods.beginAgentQueuedTurnMissingDeliveryRetirement(
            { deliveryKey },
          );
          if (fenced) {
            const delivery = await agentTriggerDeliveryMethods.getAgentTriggerDelivery(deliveryKey);
            if (delivery == null) {
              retired = await agentQueuedTurnMethods.markAgentQueuedTurnMissingDeliveryRetired({
                deliveryKey,
              });
            }
          }
        }
        if (retired) {
          await agentQueuedTurnMethods.markAgentQueuedTurnDeliveryRetired({ deliveryKey });
        }
      }),
    );
    await agentQueuedTurnMethods.deletePreparedAgentQueuedTurnConversations({
      user: owner,
      targets: conversations,
    });
  };

  const conversationMethods = factories.conversations({
    getMessages: messageMethods.getMessages,
    deleteMessages: messageMethods.deleteMessages,
    searchMessages: messageMethods.searchMessages,
    eraseAgentTriggerDeliveryConversationResults:
      agentTriggerDeliveryMethods.eraseAgentTriggerDeliveryConversationResults,
    prepareAgentTriggerConversationResultErasure:
      agentTriggerDeliveryMethods.prepareAgentTriggerConversationResultErasure,
    deleteAgentQueuedTurns,
  });

  // ACL entry methods (used internally for removeAllPermissions)
  const aclEntryMethods = factories.aclEntries();

  const systemGrantMethods = factories.systemGrants();

  // Internal removeAllPermissions: use deleteAclEntries from aclEntryMethods
  // instead of requiring it as an external dep from PermissionService
  const removeAllPermissions: RemoveAllPermissions =
    deps.removeAllPermissions ??
    (async ({ resourceType, resourceId }) => {
      /** The resource id is matched as the caller gives it (`RemoveAllPermissions` leaves it
       * untyped, as the PermissionService it stands in for does). */
      await aclEntryMethods.deleteAclEntries({
        resourceType,
        resourceId: resourceId as StoreEqualityValue,
      });
    });

  // Role and user-group methods with optional cache injection; user-group methods
  // are created before prompt methods so prompt methods can resolve ACL principals.
  // The membership hook is late-bound: prompt methods do not exist yet here.
  const promptAccessInvalidator: { current?: () => Promise<void> } = {};
  const roleMethods = factories.roles({ getCache: deps.getCache });
  const userGroupMethods = factories.userGroups({
    getCache: deps.getCache,
    onMemberGroupsInvalidated: () => promptAccessInvalidator.current?.(),
  });

  const promptMethods = factories.prompts({
    removeAllPermissions,
    getSoleOwnedResourceIds: aclEntryMethods.getSoleOwnedResourceIds,
    getCache: deps.getCache,
    getUserPrincipals: userGroupMethods.getUserPrincipals,
    findAccessibleResources: aclEntryMethods.findAccessibleResources,
    findPublicResourceIds: aclEntryMethods.findPublicResourceIds,
  });
  promptAccessInvalidator.current = promptMethods.invalidatePromptGroupAccessContext;

  const skillMethods = factories.skills({
    removeAllPermissions,
    getSoleOwnedResourceIds: aclEntryMethods.getSoleOwnedResourceIds,
  });

  // action methods (created as variable for agent dependency)
  const actionMethods = factories.actions();

  // agent methods need removeAllPermissions + getActions
  const agentMethods = factories.agents({
    removeAllPermissions,
    getActions: actionMethods.getActions,
    getSoleOwnedResourceIds: aclEntryMethods.getSoleOwnedResourceIds,
    getUserPrincipals: userGroupMethods.getUserPrincipals,
    findAccessibleResources: aclEntryMethods.findAccessibleResources,
    isExternalSkillId: deps.isExternalSkillId,
    getCache: deps.getCache,
  });

  // Modules served through a port: one instance each, shared by the flat methods and the store.
  const toolApprovalGrantMethods = factories.toolApprovalGrants();
  const tokenListMethods = factories.tokenLists();
  const openidRefreshFlightMethods = factories.openidRefreshFlights();
  const resourceLockMethods = factories.resourceLocks();
  const keyMethods = factories.userKeys();
  const toolFavoriteMethods = factories.toolFavorites();
  const agentCategoryMethods = factories.agentCategories();
  const bannerMethods = factories.banners();
  const categoriesMethods = factories.categories();
  const scheduleConsentMethods = factories.scheduleConsents();
  const principalMethods = factories.principals();
  const sessionMethods = factories.sessions();
  const tokenMethods = factories.tokens();
  const refreshTokenBridgeMethods = factories.refreshTokenBridges();
  const passkeyMethods = factories.passkeys();
  const presetMethods = factories.presets();
  const toolCallMethods = factories.toolCalls();
  const assistantMethods = factories.assistants();
  const pluginAuthMethods = factories.pluginAuths();
  const memoryMethods = factories.memories();
  const fileStorageMethods = factories.fileStorage();
  const userMethods = factories.users({ getCache: deps.getCache });
  const accessRoleMethods = factories.accessRoles();
  const agentApiKeyMethods = factories.agentApiKeys();
  const mcpServerMethods = factories.mcpServers({
    getSoleOwnedResourceIds: aclEntryMethods.getSoleOwnedResourceIds,
  });
  const configMethods = factories.configOverrides();
  const auditLogMethods = factories.auditLogs();
  const codeEnvironmentMethods = factories.codeEnvironments();
  const chatProjectMethods = factories.chatProjects();
  const conversationTagMethods = factories.conversationTags();
  const insightsMethods = factories.insights();
  const skillSyncMethods = factories.skillSync();
  const skillLifecycleMethods = factories.skillLifecycle();
  const subagentContentMethods = factories.subagentContent();
  const conversationImportMethods = factories.conversationImports();
  const shareMethods = factories.sharedLinks();
  const fileMethods = factories.files();
  const scheduleMethods = factories.schedules();
  const mcpAuthorityMethods = factories.mcpAuthorities();
  const mcpAuthorizationFenceRetryMethods = factories.mcpAuthorizationFenceRetries();
  /** Registers through the code environment instance above, so per-instance work (with
   * MongoDB: the setup index build, see `ensureSetupEnvironmentIndexes`) is not repeated in a
   * second instance. */
  const browserSetupBackend = factories.browserSetup({ codeEnvironments: codeEnvironmentMethods });
  const storeTransactionMethods = factories.transactions();
  const stores = createDataStore({
    conversations: conversationMethods,
    banners: bannerMethods,
    categories: categoriesMethods,
    tokenLists: tokenListMethods,
    toolFavorites: toolFavoriteMethods,
    principals: principalMethods,
    userKeys: keyMethods,
    agentCategories: agentCategoryMethods,
    resourceLocks: resourceLockMethods,
    toolApprovalGrants: toolApprovalGrantMethods,
    scheduleConsents: scheduleConsentMethods,
    openidRefreshFlights: openidRefreshFlightMethods,
    sessions: sessionMethods,
    tokens: tokenMethods,
    refreshTokenBridges: refreshTokenBridgeMethods,
    passkeys: passkeyMethods,
    presets: presetMethods,
    actions: actionMethods,
    toolCalls: toolCallMethods,
    assistants: assistantMethods,
    pluginAuths: pluginAuthMethods,
    memories: memoryMethods,
    fileStorage: fileStorageMethods,
    tokenSpending: spendTokensMethods,
    users: userMethods,
    roles: roleMethods,
    accessRoles: accessRoleMethods,
    agentApiKeys: agentApiKeyMethods,
    mcpServers: mcpServerMethods,
    configOverrides: configMethods,
    auditLogs: auditLogMethods,
    aclEntries: aclEntryMethods,
    systemGrants: systemGrantMethods,
    userGroups: userGroupMethods,
    codeEnvironments: codeEnvironmentMethods,
    tokenTransactions: transactionMethods,
    prompts: promptMethods,
    chatProjects: chatProjectMethods,
    conversationTags: conversationTagMethods,
    insights: insightsMethods,
    skillSync: skillSyncMethods,
    skillLifecycle: skillLifecycleMethods,
    subagentContent: subagentContentMethods,
    conversationImports: conversationImportMethods,
    messages: messageMethods,
    sharedLinks: shareMethods,
    files: fileMethods,
    agents: agentMethods,
    skills: skillMethods,
    schedules: scheduleMethods,
    agentQueuedTurns: agentQueuedTurnMethods,
    agentTriggerDeliveries: agentTriggerDeliveryMethods,
    mcpAuthorities: mcpAuthorityMethods,
    mcpAuthorizationFenceRetries: mcpAuthorizationFenceRetryMethods,
    browserSetup: browserSetupBackend,
    transactions: storeTransactionMethods,
  });

  return {
    ...userMethods,
    ...toolApprovalGrantMethods,
    ...sessionMethods,
    ...tokenMethods,
    ...tokenListMethods,
    ...refreshTokenBridgeMethods,
    ...openidRefreshFlightMethods,
    ...resourceLockMethods,
    ...subagentContentMethods,
    ...passkeyMethods,
    ...roleMethods,
    ...keyMethods,
    ...fileMethods,
    ...fileStorageMethods,
    ...memoryMethods,
    ...toolFavoriteMethods,
    ...agentCategoryMethods,
    ...agentApiKeyMethods,
    ...mcpServerMethods,
    ...codeEnvironmentMethods,
    ...accessRoleMethods,
    ...userGroupMethods,
    ...aclEntryMethods,
    ...systemGrantMethods,
    ...auditLogMethods,
    ...shareMethods,
    ...pluginAuthMethods,
    /* Tier 1 */
    ...actionMethods,
    ...assistantMethods,
    ...bannerMethods,
    ...toolCallMethods,
    ...categoriesMethods,
    ...presetMethods,
    /* Tier 2 */
    ...conversationTagMethods,
    ...conversationImportMethods,
    ...messageMethods,
    ...conversationMethods,
    ...chatProjectMethods,
    /* Tier 3 */
    ...txMethods,
    ...transactionMethods,
    ...spendTokensMethods,
    ...promptMethods,
    ...skillMethods,
    ...skillSyncMethods,
    ...skillLifecycleMethods,
    ...agentTriggerDeliveryMethods,
    ...agentQueuedTurnMethods,
    ...scheduleMethods,
    ...scheduleConsentMethods,
    /* Tier 5 */
    ...agentMethods,
    /* Config */
    ...configMethods,
    ...principalMethods,
    /* MCP authority proofs */
    ...mcpAuthorityMethods,
    /* Insights */
    ...insightsMethods,
    /* MCP authorization fence retries */
    ...mcpAuthorizationFenceRetryMethods,
    /* Browser setup */
    ...browserSetupBackend,
    /* Transactions */
    ...storeTransactionMethods,
    /* Ports */
    stores,
    conversations: stores.conversations,
  };
}

import type { DataModuleFactories } from '~/compose/types';
import type { MongoDataStoreMethods } from './dataStore';
import type { TxMethods } from '~/methods/tx';
import { createMCPAuthorizationFenceRetryStorage } from '~/methods/mcpAuthorizationFenceRetry';
import { createOpenIDRefreshFlightMethods } from '~/methods/openidRefreshFlight';
import { createRefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import { createAgentTriggerDeliveryMethods } from '~/methods/triggerDelivery';
import { createToolApprovalGrantMethods } from '~/methods/toolApprovalGrant';
import { createScheduleMCPConsentStorage } from '~/methods/scheduleConsent';
import { createCodeEnvironmentMethods } from '~/methods/codeEnvironment';
import { createConversationTagMethods } from '~/methods/conversationTag';
import { createSubagentContentMethods } from '~/methods/subagentContent';
import { createMongoStoreTransactionMethods } from './storeTransactions';
import { createSkillLifecycleMethods } from '~/methods/skillLifecycle';
import { createAgentCategoryMethods } from '~/methods/agentCategory';
import { createAgentQueuedTurnMethods } from '~/methods/queuedTurn';
import { createMCPAuthorityMethods } from '~/methods/mcpAuthority';
import { createConversationMethods } from '~/methods/conversation';
import { createConversationImportMethods } from '~/methods/import';
import { createResourceLockMethods } from '~/methods/resourceLock';
import { createBrowserSetupBackend } from '~/methods/browserSetup';
import { createFileStorageMethods } from '~/methods/fileStorage';
import { createAgentApiKeyMethods } from '~/methods/agentApiKey';
import { createSpendTokensMethods } from '~/methods/spendTokens';
import { createSystemGrantMethods } from '~/methods/systemGrant';
import { createTransactionMethods } from '~/methods/transaction';
import { createChatProjectMethods } from '~/methods/chatProject';
import { createCategoriesMethods } from '~/methods/categories';
import { createPluginAuthMethods } from '~/methods/pluginAuth';
import { createAccessRoleMethods } from '~/methods/accessRole';
import { createToolFavoriteMethods } from '~/methods/favorite';
import { createAssistantMethods } from '~/methods/assistant';
import { createPrincipalMethods } from '~/methods/principal';
import { createTokenListMethods } from '~/methods/tokenList';
import { createUserGroupMethods } from '~/methods/userGroup';
import { createMCPServerMethods } from '~/methods/mcpServer';
import { createSkillSyncMethods } from '~/methods/skillSync';
import { createAclEntryMethods } from '~/methods/aclEntry';
import { createAuditLogMethods } from '~/methods/auditLog';
import { createInsightsMethods } from '~/methods/insights';
import { createScheduleMethods } from '~/methods/schedule';
import { createToolCallMethods } from '~/methods/toolCall';
import { createMessageMethods } from '~/methods/message';
import { createSessionMethods } from '~/methods/session';
import { createPasskeyMethods } from '~/methods/passkey';
import { createActionMethods } from '~/methods/action';
import { createBannerMethods } from '~/methods/banner';
import { createConfigMethods } from '~/methods/config';
import { createMemoryMethods } from '~/methods/memory';
import { createPresetMethods } from '~/methods/preset';
import { createPromptMethods } from '~/methods/prompt';
import { createAgentMethods } from '~/methods/agent';
import { createShareMethods } from '~/methods/share';
import { createSkillMethods } from '~/methods/skill';
import { createTokenMethods } from '~/methods/token';
import { createFileMethods } from '~/methods/file';
import { createRoleMethods } from '~/methods/role';
import { createUserMethods } from '~/methods/user';
import { createKeyMethods } from '~/methods/key';
import { createTxMethods } from '~/methods/tx';
import { mongoStoreIds } from './storeIds';

/** The MongoDB module instances: the methods behind each store, plus the pure `tx` helpers. */
export interface MongoDataModules extends MongoDataStoreMethods {
  tx: TxMethods;
}

/**
 * The MongoDB backend's module factories for `composeDataMethods` (`~/compose`): each builds
 * today's methods instance on `mongoose` with the dependencies the composition root hands it.
 */
export function createMongoDataModuleFactories(
  mongoose: typeof import('mongoose'),
): DataModuleFactories<MongoDataModules> {
  return {
    ids: mongoStoreIds,
    tx: (deps) => createTxMethods(mongoose, deps),
    tokenTransactions: (deps) => createTransactionMethods(mongoose, deps),
    tokenSpending: (deps) => createSpendTokensMethods(mongoose, deps),
    messages: (deps) => createMessageMethods(mongoose, deps),
    agentQueuedTurns: () => createAgentQueuedTurnMethods(mongoose),
    agentTriggerDeliveries: (deps) => createAgentTriggerDeliveryMethods(mongoose, deps),
    conversations: (deps) => createConversationMethods(mongoose, deps),
    aclEntries: () => createAclEntryMethods(mongoose),
    systemGrants: () => createSystemGrantMethods(mongoose),
    roles: (deps) => createRoleMethods(mongoose, deps),
    userGroups: (deps) => createUserGroupMethods(mongoose, deps),
    prompts: (deps) => createPromptMethods(mongoose, deps),
    skills: (deps) => createSkillMethods(mongoose, deps),
    actions: () => createActionMethods(mongoose),
    agents: (deps) => createAgentMethods(mongoose, deps),
    toolApprovalGrants: () => createToolApprovalGrantMethods(mongoose),
    tokenLists: () => createTokenListMethods(mongoose),
    openidRefreshFlights: () => createOpenIDRefreshFlightMethods(mongoose),
    resourceLocks: () => createResourceLockMethods(mongoose),
    userKeys: () => createKeyMethods(mongoose),
    toolFavorites: () => createToolFavoriteMethods(mongoose),
    agentCategories: () => createAgentCategoryMethods(mongoose),
    banners: () => createBannerMethods(mongoose),
    categories: () => createCategoriesMethods(mongoose),
    scheduleConsents: () => createScheduleMCPConsentStorage(mongoose),
    principals: () => createPrincipalMethods(mongoose),
    sessions: () => createSessionMethods(mongoose),
    tokens: () => createTokenMethods(mongoose),
    refreshTokenBridges: () => createRefreshTokenBridgeMethods(mongoose),
    passkeys: () => createPasskeyMethods(mongoose),
    presets: () => createPresetMethods(mongoose),
    toolCalls: () => createToolCallMethods(mongoose),
    assistants: () => createAssistantMethods(mongoose),
    pluginAuths: () => createPluginAuthMethods(mongoose),
    memories: () => createMemoryMethods(mongoose),
    fileStorage: () => createFileStorageMethods(mongoose),
    users: (deps) => createUserMethods(mongoose, deps),
    accessRoles: () => createAccessRoleMethods(mongoose),
    agentApiKeys: () => createAgentApiKeyMethods(mongoose),
    mcpServers: (deps) => createMCPServerMethods(mongoose, deps),
    configOverrides: () => createConfigMethods(mongoose),
    auditLogs: () => createAuditLogMethods(mongoose),
    codeEnvironments: () => createCodeEnvironmentMethods(mongoose),
    chatProjects: () => createChatProjectMethods(mongoose),
    conversationTags: () => createConversationTagMethods(mongoose),
    insights: () => createInsightsMethods(mongoose),
    skillSync: () => createSkillSyncMethods(mongoose),
    skillLifecycle: () => createSkillLifecycleMethods(mongoose),
    subagentContent: () => createSubagentContentMethods(mongoose),
    conversationImports: () => createConversationImportMethods(mongoose),
    sharedLinks: () => createShareMethods(mongoose),
    files: () => createFileMethods(mongoose),
    schedules: () => createScheduleMethods(mongoose),
    mcpAuthorities: () => createMCPAuthorityMethods(mongoose),
    mcpAuthorizationFenceRetries: () => createMCPAuthorizationFenceRetryStorage(mongoose),
    browserSetup: ({ codeEnvironments }) => createBrowserSetupBackend(mongoose, codeEnvironments),
    transactions: () => createMongoStoreTransactionMethods(mongoose),
  };
}

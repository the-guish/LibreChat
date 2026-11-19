import type { SubagentContentMethods } from './subagentContent';
export type {
  SubagentContentScope,
  SubagentContentHead,
  SubagentContentBatch,
  SubagentContentMethods,
  SubagentContentAppendResult,
} from './subagentContent';
import type { ToolApprovalGrantStorage } from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage } from './scheduleConsent';
import type { ClearFileCodeEnvRefsParams } from '~/types/file';
import type { FileStorageMethods } from './fileStorage';
export { createScheduleMCPConsentStorage } from './scheduleConsent';
export type { ScheduleMCPConsentStorage, ScheduleConsentSnapshot } from './scheduleConsent';
import type {
  FileMethods,
  FileOwnerScope,
  ClearFileEmbeddingsParams,
  AvailableProjectFileRecord,
  AvailableProjectFilesOptions,
  AvailableProjectFilesResult,
  ProjectFileRecord,
  ProjectFilesOptions,
} from './file';
import type { RoleMethods } from './role';
import type { OpenIDRefreshFlightMethods } from './openidRefreshFlight';
import type { ResourceLockMethods } from './resourceLock';
import {
  createMCPAuthorizationFenceRetryStorage,
  type MCPAuthorizationFenceRetryStorage,
} from './mcpAuthorizationFenceRetry';
export { createMCPAuthorizationFenceRetryStorage, type MCPAuthorizationFenceRetryStorage };
import type { BrowserSetupBackend } from '~/types/browserSetup';
import type { RefreshTokenBridgeMethods } from './refreshTokenBridge';
import { DEFAULT_REFRESH_TOKEN_EXPIRY, type SessionMethods } from './session';
import type { PasskeyMethods } from './passkey';
import { DEFAULT_SESSION_EXPIRY, type UserMethods } from './user';
import type { TokenMethods } from './token';
import type { TokenListMethods } from './tokenList';
import { RoleConflictError } from './role';
import type { KeyMethods } from './key';
export { createFileStorageMethods } from './fileStorage';
/* Memories */
import type { MemoryMethods } from './memory';
/* Tool Favorites */
import { MAX_TOOL_FAVORITES, type ToolFavoriteMethods } from './favorite';
/* Agent Categories */
import type { AgentCategoryMethods } from './agentCategory';
/* Agent API Keys */
import type { AgentApiKeyMethods } from './agentApiKey';
/* MCP Servers */
import type { MCPServerMethods } from './mcpServer';
import type { CodeEnvironmentMethods } from './codeEnvironment';
/* Plugin Auth */
import type { PluginAuthMethods } from './pluginAuth';
/* Permissions */
import type { AccessRoleMethods } from './accessRole';
import { runAfterTransaction, type UserGroupMethods } from './userGroup';
import { permissionBitSupersets, PERM_BITS_WRITE_ATTEMPTS, type AclEntryMethods } from './aclEntry';
import type { SystemGrantMethods } from './systemGrant';
import {
  AUDIT_SCHEMA_VERSION,
  MAX_AUDIT_EXPORT_ROWS,
  MAX_AUDIT_LOG_LIMIT,
  MAX_AUDIT_VERIFY_ROWS,
  type AuditLogMethods,
} from './auditLog';
import type { ShareMethods } from './share';
/* Tier 1 — Simple CRUD */
import type { ActionMethods } from './action';
import type { AssistantMethods } from './assistant';
import type { BannerMethods } from './banner';
import type { ToolCallMethods } from './toolCall';
import type { CategoriesMethods } from './categories';
import type { PresetMethods } from './preset';
/* Tier 2 — Moderate (service deps injected) */
import type { ConversationTagMethods } from './conversationTag';
import { createMongoDataModuleFactories } from '~/adapters/mongo/factories';
import type { MongoStoreTransactionMethods } from '~/adapters/mongo/storeTransactions';
import type { ConversationStore, DataStore } from '~/ports';
import type { CreateMethodsDeps } from '~/compose/types';
import { composeDataMethods } from '~/compose/methods';
import type { ConversationImportMethods } from './import';
import {
  CLIENT_MESSAGE_SELECT,
  SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT,
  type MessageMethods,
  type ParentSubagentTaskRecord,
  type SubagentThreadViewMessageRecord,
  type SubagentTaskResultClaim,
  type BackgroundToolResultClaim,
  type BackgroundToolResultRecord,
  type ConversationTraceRefs,
  type SampledTraceMessage,
} from './message';
import type {
  AgentEventActorReconciliationStorageMetrics,
  ConversationMethods,
  ParentSubagentThreadRecord,
} from './conversation';
import type { ChatProjectMethods } from './chatProject';
export type {
  AssignConversationToProjectResult,
  ChatProjectSortBy,
  ChatProjectSortDirection,
  CreateChatProjectInput,
  DeleteChatProjectResult,
  ListChatProjectsOptions,
  ListChatProjectsResult,
  UpdateChatProjectInput,
} from './chatProject';
/* Tier 3 — Complex (heavier injection) */
import {
  createTxMethods,
  type TxMethods,
  tokenValues,
  cacheTokenValues,
  premiumTokenValues,
  defaultRate,
} from './tx';
import type { TransactionMethods } from './transaction';
import type { SpendTokensMethods } from './spendTokens';
import type { PromptMethods, PromptGroupListParams } from './prompt';
import {
  partitionIssues,
  validateSkillName,
  validateSkillBody,
  validateRelativePath,
  validateSkillFrontmatter,
  getCanonicalSkillFrontmatterKey,
  normalizeSkillFrontmatterKeys,
  validateSkillDescription,
  deriveStructuredFrontmatterFields,
  inferSkillFileCategory,
  filterExistingSkillIds,
  type SkillMethods,
  type SkillDeps,
  type CreateSkillInput,
  type CreateSkillResult,
  type UpdateSkillInput,
  type UpsertSkillFileInput,
  type ListSkillsByAccessParams,
  type ListSkillsByAccessResult,
  type UpdateSkillResult,
  type ValidationIssue,
  type DeleteSkillCleanupStep,
  type DeleteSkillResult,
} from './skill';
import type { ScheduleMethods } from './schedule';
import {
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnLaneRetiredError,
  type AgentQueuedTurnMethods,
} from './queuedTurn';
import {
  AgentTriggerDeliveryConflictError,
  recordAgentEventActorReceiptMetric,
  setAgentEventActorReceiptMetricObserver,
  type AgentTriggerDeliveryMethods,
  type AgentTriggerProducerLeaseStatus,
  type AgentEventActorReceiptMetric,
  type AgentEventActorReceiptStorageMetrics,
} from './triggerDelivery';
import type { SkillSyncMethods } from './skillSync';
import type { SkillLifecycleMethods } from './skillLifecycle';
import type {
  SkillSyncStatusInput,
  SkillSyncCredentialSummary,
  UpsertSkillSyncCredentialInput,
} from './skillSync';
/* Tier 5 — Agent */
import type {
  AgentMethods,
  AgentGraphNode,
  AgentGraphAccess,
  AgentGraphAccessContext,
} from './agent';
/* Config */
import type { ConfigMethods } from './config';
import type { PrincipalMethods } from './principal';
import {
  MCPAuthorityProofError,
  MAX_MCP_AUTHORITY_TARGETS,
  createMCPAuthorityBootRevision,
  createMCPAuthorityConfigSourceRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityDatabaseSourceRevision,
  digestMCPAuthorityValue,
  type MCPAuthorityMethods,
  type MCPAuthorityMethodHooks,
  type MCPAuthorityConfigSourceDocument,
  type MCPAuthorityCredentialSourceDocument,
} from './mcpAuthority';
/* Insights */
import type { InsightsMethods } from './insights';

export {
  runAfterTransaction,
  RoleConflictError,
  MCPAuthorityProofError,
  MAX_MCP_AUTHORITY_TARGETS,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
  DEFAULT_SESSION_EXPIRY,
  createMCPAuthorityBootRevision,
  createMCPAuthorityConfigSourceRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityDatabaseSourceRevision,
  digestMCPAuthorityValue,
};
export { tokenValues, cacheTokenValues, premiumTokenValues, defaultRate, createTxMethods };
export { permissionBitSupersets, PERM_BITS_WRITE_ATTEMPTS };
export { CLIENT_MESSAGE_SELECT, SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT };
export {
  partitionIssues,
  validateSkillName,
  validateSkillBody,
  validateRelativePath,
  validateSkillFrontmatter,
  getCanonicalSkillFrontmatterKey,
  normalizeSkillFrontmatterKeys,
  validateSkillDescription,
  deriveStructuredFrontmatterFields,
  inferSkillFileCategory,
  filterExistingSkillIds,
};
export { AUDIT_SCHEMA_VERSION, MAX_AUDIT_EXPORT_ROWS, MAX_AUDIT_LOG_LIMIT, MAX_AUDIT_VERIFY_ROWS };
export { MAX_TOOL_FAVORITES };
export { AgentTriggerDeliveryConflictError };
export type { PromptGroupListParams };
export { AGENT_OWNER_CONTACT_RESOLVED_FIELD, AgentSortCursorError } from './agent';
export { createSkillDeletionPersistenceAdapter } from './skillDeletionAdapter';
export type {
  SkillDeletionRecord,
  SkillUploadIntentRecord,
  SkillDeletionFileRecord,
} from './skillDeletionAdapter';
export {
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnLaneRetiredError,
};

export type AllMethods = SubagentContentMethods &
  ToolApprovalGrantStorage &
  UserMethods &
  SessionMethods &
  TokenMethods &
  TokenListMethods &
  RefreshTokenBridgeMethods &
  OpenIDRefreshFlightMethods &
  ResourceLockMethods &
  PasskeyMethods &
  RoleMethods &
  KeyMethods &
  FileMethods &
  FileStorageMethods &
  MemoryMethods &
  ToolFavoriteMethods &
  AgentCategoryMethods &
  AgentApiKeyMethods &
  MCPServerMethods &
  CodeEnvironmentMethods &
  UserGroupMethods &
  AclEntryMethods &
  SystemGrantMethods &
  AuditLogMethods &
  ShareMethods &
  AccessRoleMethods &
  PluginAuthMethods &
  ActionMethods &
  AssistantMethods &
  BannerMethods &
  ToolCallMethods &
  CategoriesMethods &
  PresetMethods &
  ConversationTagMethods &
  ConversationImportMethods &
  MessageMethods &
  ConversationMethods &
  ChatProjectMethods &
  TxMethods &
  TransactionMethods &
  SpendTokensMethods &
  PromptMethods &
  SkillMethods &
  SkillSyncMethods &
  SkillLifecycleMethods &
  AgentTriggerDeliveryMethods &
  AgentQueuedTurnMethods &
  ScheduleMCPConsentStorage &
  ScheduleMethods &
  AgentMethods &
  ConfigMethods &
  PrincipalMethods &
  MCPAuthorityMethods &
  InsightsMethods &
  MCPAuthorizationFenceRetryStorage &
  BrowserSetupBackend &
  MongoStoreTransactionMethods & {
    /**
     * Every ported module's operations as database-neutral stores, backed by the methods above
     * (the same functions). Callers should reach a ported operation through its store.
     */
    stores: DataStore;
    /** `stores.conversations`, kept at the top level for existing callers. */
    conversations: ConversationStore;
  };

export type { CreateMethodsDeps } from '~/compose/types';

/**
 * Creates all database methods for all collections: the MongoDB module factories on `mongoose`,
 * composed by the database-neutral composition root (`composeDataMethods`, `~/compose`).
 * @param mongoose - Mongoose instance
 * @param deps - Optional dependencies injected from the api layer
 */
export function createMethods(
  mongoose: typeof import('mongoose'),
  deps: CreateMethodsDeps = {},
): AllMethods {
  return composeDataMethods(createMongoDataModuleFactories(mongoose), deps);
}

export {
  InvalidAvailableProjectFilesCursorError,
  parseAvailableProjectFilesCursor,
  MAX_AVAILABLE_PROJECT_FILES_LIMIT,
  DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT,
} from './file';

export type {
  UserMethods,
  PasskeyMethods,
  SessionMethods,
  TokenMethods,
  RefreshTokenBridgeMethods,
  OpenIDRefreshFlightMethods,
  ResourceLockMethods,
  RoleMethods,
  KeyMethods,
  MemoryMethods,
  FileMethods,
  FileStorageMethods,
  FileOwnerScope,
  AvailableProjectFileRecord,
  ClearFileCodeEnvRefsParams,
  ClearFileEmbeddingsParams,
  AvailableProjectFilesOptions,
  AvailableProjectFilesResult,
  ProjectFileRecord,
  ProjectFilesOptions,
  ToolFavoriteMethods,
  AgentCategoryMethods,
  AgentApiKeyMethods,
  MCPServerMethods,
  CodeEnvironmentMethods,
  UserGroupMethods,
  AclEntryMethods,
  SystemGrantMethods,
  AuditLogMethods,
  ShareMethods,
  AccessRoleMethods,
  PluginAuthMethods,
  ActionMethods,
  AssistantMethods,
  BannerMethods,
  ToolCallMethods,
  CategoriesMethods,
  PresetMethods,
  ConversationTagMethods,
  ConversationImportMethods,
  MessageMethods,
  ParentSubagentTaskRecord,
  ParentSubagentThreadRecord,
  SubagentThreadViewMessageRecord,
  SubagentTaskResultClaim,
  BackgroundToolResultClaim,
  BackgroundToolResultRecord,
  ConversationTraceRefs,
  SampledTraceMessage,
  ConversationMethods,
  AgentEventActorReconciliationStorageMetrics,
  ChatProjectMethods,
  TxMethods,
  TransactionMethods,
  SpendTokensMethods,
  PromptMethods,
  SkillMethods,
  SkillDeps,
  CreateSkillInput,
  CreateSkillResult,
  UpdateSkillInput,
  UpsertSkillFileInput,
  ListSkillsByAccessParams,
  ListSkillsByAccessResult,
  UpdateSkillResult,
  ValidationIssue,
  DeleteSkillCleanupStep,
  DeleteSkillResult,
  SkillSyncStatusInput,
  SkillSyncCredentialSummary,
  UpsertSkillSyncCredentialInput,
  SkillSyncMethods,
  SkillLifecycleMethods,
  AgentTriggerDeliveryMethods,
  AgentQueuedTurnMethods,
  AgentTriggerProducerLeaseStatus,
  AgentEventActorReceiptMetric,
  AgentEventActorReceiptStorageMetrics,
  ScheduleMethods,
  AgentMethods,
  AgentGraphNode,
  AgentGraphAccess,
  AgentGraphAccessContext,
  ConfigMethods,
  PrincipalMethods,
  MCPAuthorityMethods,
  MCPAuthorityMethodHooks,
  MCPAuthorityConfigSourceDocument,
  MCPAuthorityCredentialSourceDocument,
  InsightsMethods,
};

export { recordAgentEventActorReceiptMetric, setAgentEventActorReceiptMetricObserver };

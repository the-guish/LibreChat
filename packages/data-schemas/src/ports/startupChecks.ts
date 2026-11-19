/**
 * Startup checks port: the dry-run probes the server runs once at boot to warn about data
 * migrations that are still due (missing people-search tokens, agents and prompt groups not yet
 * in the permission system). Nothing here may import `mongoose` or the MongoDB driver, at runtime
 * or as a type.
 *
 * Each backend reads its own data to answer them (with MongoDB: raw collections, the ACL entry
 * model and the agent and prompt group models), so `api/server/services/start/migration.js`
 * asks the backend for them (`DataStoreBackend.createStartupChecks`) and hands them to
 * `checkStartupMigrations` in `@librechat/api`, which runs them together and logs the warnings.
 * The results have the same shape on every backend.
 */
import type { AccessRoleStore } from './accessRole';
import { listPortMethods } from './common';

/** The data methods the checks use, from the composition root's stores. */
export interface StartupCheckMethods {
  findRoleByIdentifier: AccessRoleStore['findRoleByIdentifier'];
}

/** Agents not yet in the permission system, by the access they will get. */
export interface AgentPermissionsMigrationCheckResult {
  totalToMigrate: number;
  globalEditAccess: number;
  globalViewAccess: number;
  privateAgents: number;
  details?: {
    globalEditAccess: Array<{ name: string; id: string }>;
    globalViewAccess: Array<{ name: string; id: string }>;
    privateAgents: Array<{ name: string; id: string }>;
  };
}

/** Prompt groups not yet in the permission system, by the access they will get. */
export interface PromptPermissionsMigrationCheckResult {
  totalToMigrate: number;
  globalViewAccess: number;
  privateGroups: number;
  details?: {
    globalViewAccess: Array<{ name: string; _id: string; category: string }>;
    privateGroups: Array<{ name: string; _id: string; category: string }>;
  };
}

/**
 * The startup checks. They change no data (the MongoDB permission checks first create the
 * permission system's collections when missing, as the migration scripts do). A failed check
 * logs its error and resolves (search tokens) or resolves to all-zero counts (permissions).
 */
export interface DataStoreStartupChecks {
  /** Warns when users or groups lack people-search tokens or their indexes. */
  probeSearchTokens(): Promise<void>;
  /** Agents that `npm run migrate:agent-permissions` would migrate (a dry run). */
  checkAgentPermissions(): Promise<AgentPermissionsMigrationCheckResult>;
  /** Prompt groups that `npm run migrate:prompt-permissions` would migrate (a dry run). */
  checkPromptPermissions(): Promise<PromptPermissionsMigrationCheckResult>;
}

/** Every method of {@link DataStoreStartupChecks}, for adapters and conformance checks. */
export const DATA_STORE_STARTUP_CHECK_METHODS: ReadonlyArray<keyof DataStoreStartupChecks> =
  listPortMethods<DataStoreStartupChecks>({
    probeSearchTokens: true,
    checkAgentPermissions: true,
    checkPromptPermissions: true,
  });

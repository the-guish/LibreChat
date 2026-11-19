import { logger } from '@librechat/data-schemas';
import type { AgentPermissionsMigrationCheckResult } from '@librechat/data-schemas';

/**
 * The dry-run check itself is MongoDB-specific and lives in the MongoDB adapter in
 * `@librechat/data-schemas` (the server runs it through
 * `getDataStoreBackend().createStartupChecks`); it is re-exported here, with its types under
 * their former names, for existing MongoDB-only callers.
 */
export { checkAgentPermissionsMigration } from '@librechat/data-schemas';
export type {
  StartupCheckMethods as MigrationCheckDbMethods,
  AgentPermissionsMigrationCheckParams as MigrationCheckParams,
  AgentPermissionsMigrationCheckResult as MigrationCheckResult,
} from '@librechat/data-schemas';

/**
 * Log migration warning to console if agents need migration
 */
export function logAgentMigrationWarning(result: AgentPermissionsMigrationCheckResult): void {
  if (result.totalToMigrate === 0) {
    return;
  }

  const border = '='.repeat(80);
  const warning = [
    '',
    border,
    '                    IMPORTANT: AGENT PERMISSIONS MIGRATION REQUIRED',
    border,
    '',
    `  Total agents to migrate: ${result.totalToMigrate}`,
    `  - Global Edit Access: ${result.globalEditAccess} agents`,
    `  - Global View Access: ${result.globalViewAccess} agents`,
    `  - Private Agents: ${result.privateAgents} agents`,
    '',
    '  The new agent sharing system requires migrating existing agents.',
    '  Please run the following command to migrate your agents:',
    '',
    '    npm run migrate:agent-permissions',
    '',
    '  For a dry run (preview) of what will be migrated:',
    '',
    '    npm run migrate:agent-permissions:dry-run',
    '',
    '  This migration will:',
    '  1. Grant owner permissions to agent authors',
    '  2. Set appropriate public permissions based on global project status',
    '  3. Preserve existing collaborative settings',
    '',
    border,
    '',
  ];

  console.log('\n' + warning.join('\n') + '\n');

  logger.warn('Agent permissions migration required', {
    totalToMigrate: result.totalToMigrate,
    globalEditAccess: result.globalEditAccess,
    globalViewAccess: result.globalViewAccess,
    privateAgents: result.privateAgents,
  });
}

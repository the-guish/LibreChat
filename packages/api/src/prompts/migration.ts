import { logger } from '@librechat/data-schemas';
import type { PromptPermissionsMigrationCheckResult } from '@librechat/data-schemas';

/**
 * The dry-run check itself is MongoDB-specific and lives in the MongoDB adapter in
 * `@librechat/data-schemas` (the server runs it through
 * `getDataStoreBackend().createStartupChecks`); it is re-exported here, with its types under
 * their former names, for existing MongoDB-only callers.
 */
export { checkPromptPermissionsMigration } from '@librechat/data-schemas';
export type {
  StartupCheckMethods as PromptMigrationCheckDbMethods,
  PromptPermissionsMigrationCheckParams as PromptMigrationCheckParams,
  PromptPermissionsMigrationCheckResult as PromptMigrationCheckResult,
} from '@librechat/data-schemas';

/**
 * Log migration warning to console if prompt groups need migration
 */
export function logPromptMigrationWarning(result: PromptPermissionsMigrationCheckResult): void {
  if (result.totalToMigrate === 0) {
    return;
  }

  const border = '='.repeat(80);
  const warning = [
    '',
    border,
    '                   IMPORTANT: PROMPT PERMISSIONS MIGRATION REQUIRED',
    border,
    '',
    `  Total prompt groups to migrate: ${result.totalToMigrate}`,
    `  - Global View Access: ${result.globalViewAccess} prompt groups`,
    `  - Private Prompt Groups: ${result.privateGroups} prompt groups`,
    '',
    '  The new prompt sharing system requires migrating existing prompt groups.',
    '  Please run the following command to migrate your prompts:',
    '',
    '    npm run migrate:prompt-permissions',
    '',
    '  For a dry run (preview) of what will be migrated:',
    '',
    '    npm run migrate:prompt-permissions:dry-run',
    '',
    '  This migration will:',
    '  1. Grant owner permissions to prompt authors',
    '  2. Set public view permissions for prompts in the global project',
    '  3. Keep private prompts accessible only to their authors',
    '',
    border,
    '',
  ];

  console.log('\n' + warning.join('\n') + '\n');

  logger.warn('Prompt permissions migration required', {
    totalToMigrate: result.totalToMigrate,
    globalViewAccess: result.globalViewAccess,
    privateGroups: result.privateGroups,
  });
}

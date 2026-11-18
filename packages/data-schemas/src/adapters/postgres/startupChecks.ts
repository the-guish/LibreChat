/**
 * The PostgreSQL startup checks (`~/ports/startupChecks`; docs/postgres-port/PHASE4.md §8 B1):
 * the MongoDB checks that have a PostgreSQL meaning, on the collection primitive's raw mode (all
 * tenants, as the server runs them as the system). Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * - `probeSearchTokens`: warns when users or groups lack people-search tokens (the token arrays'
 *   count columns are `NULL`, MongoDB's missing fields), as rows copied from a MongoDB database
 *   whose search tokens were never backfilled do. Such rows stay findable through the search's
 *   legacy fallback (an unindexed regex on the source field). MongoDB's other warning, missing
 *   token indexes (`MONGO_AUTO_INDEX` off), has no PostgreSQL meaning: the indexes come with the
 *   migrations, and the connection refuses a database whose migrations are behind.
 * - `checkAgentPermissions` and `checkPromptPermissions`: the dry runs of the MongoDB checks
 *   (`~/methods/startupCheckRules`), on the `aclentries`, `agents` and `promptgroups` tables:
 *   agents and prompt groups with an author but no user ACL entry, as rows copied from a MongoDB
 *   database that never ran `migrate:agent-permissions` / `migrate:prompt-permissions` are. The
 *   retired `projects` collection has no table (MongoDB only, never copied), so nothing counts as
 *   formerly global: every such record counts as private. MongoDB's first step, creating the
 *   permission system's collections, has no PostgreSQL meaning (the tables come with the
 *   migrations).
 *
 * The migrations these checks point to run on MongoDB only (docs/postgres-port/PLAN.md, "MongoDB-only
 * legacy scripts"): a deployment moving to PostgreSQL runs them on its MongoDB database before
 * copying it (docs/postgresql.md). So when a check finds something, it also logs that remedy.
 *
 * Each check reads the database when called; while the backend is not connected, the probe logs
 * the failure and resolves and the dry runs resolve to all-zero counts, as on MongoDB.
 */
import { ResourceType, PrincipalType } from 'librechat-data-provider';
import type {
  StartupCheckMethods,
  DataStoreStartupChecks,
  AgentPermissionsMigrationCheckResult,
  PromptPermissionsMigrationCheckResult,
} from '~/ports/startupChecks';
import type { AgentMigrationData, PromptGroupMigrationData } from '~/methods/startupCheckRules';
import type { SearchTokenField } from '~/utils/search';
import type { PgCollections } from './collection';
import {
  checkAgentPermissionsOnSteps,
  checkPromptPermissionsOnSteps,
} from '~/methods/startupCheckRules';
import { USER_SEARCH_TOKEN_FIELDS, GROUP_SEARCH_TOKEN_FIELDS } from '~/utils/search';
import logger from '~/config/winston';

/** The collections whose records carry people-search tokens, and their token fields. */
const SEARCH_TOKEN_COLLECTIONS: ReadonlyArray<{
  name: string;
  fields: readonly SearchTokenField[];
}> = [
  { name: 'users', fields: USER_SEARCH_TOKEN_FIELDS },
  { name: 'groups', fields: GROUP_SEARCH_TOKEN_FIELDS },
];

/** How the remedy of a startup check finding reads on PostgreSQL. */
export const POSTGRES_LEGACY_MIGRATION_REMEDY =
  'that migration runs on MongoDB only: run it on the MongoDB database before copying it to PostgreSQL (docs/postgresql.md, "Coming from MongoDB")';

/** What the PostgreSQL startup checks read through. */
export interface PostgresStartupCheckDeps {
  /** The backend's collections (raw mode); throws while the backend is not connected. */
  collections(): PgCollections;
  methods: StartupCheckMethods;
}

/** Warns when users or groups lack search tokens; logs a failure and resolves. */
async function probeSearchTokens(collections: () => PgCollections): Promise<void> {
  try {
    const pending = await Promise.all(
      SEARCH_TOKEN_COLLECTIONS.map(async ({ name, fields }) => {
        const missing = await collections()
          .raw(name)
          .exists({ $or: fields.map((field) => ({ [field.tokens]: { $exists: false } })) });
        return missing != null ? name : null;
      }),
    );
    const names = pending.filter((name): name is string => name != null);
    if (names.length > 0) {
      logger.warn(
        `[SearchTokenMigration] Some ${names.join(' and ')} lack search tokens; people search scans the table for them until npm run migrate:search-tokens backfills them, and ${POSTGRES_LEGACY_MIGRATION_REMEDY}`,
      );
    }
  } catch (error) {
    logger.error('[SearchTokenMigration] Failed to check search token migration:', error);
  }
}

/** The resource ids some user already has an ACL entry for, for `resourceType`. */
function readMigratedIds(
  collections: () => PgCollections,
  resourceType: ResourceType,
): Promise<unknown[]> {
  return collections()
    .raw('aclentries')
    .distinct('resourceId', { resourceType, principalType: PrincipalType.USER });
}

/** Logs where the migration a dry run points to runs, when it found anything. */
function noteRemedy<T extends { totalToMigrate: number }>(script: string, result: T): T {
  if (result.totalToMigrate > 0) {
    logger.warn(
      `[checkMigrations] PostgreSQL: npm run ${script}: ${POSTGRES_LEGACY_MIGRATION_REMEDY}`,
    );
  }
  return result;
}

/** The PostgreSQL startup checks on the backend's collections. */
export function createPostgresStartupChecks(
  deps: PostgresStartupCheckDeps,
): DataStoreStartupChecks {
  const { collections, methods } = deps;
  return {
    probeSearchTokens: () => probeSearchTokens(collections),
    checkAgentPermissions: async (): Promise<AgentPermissionsMigrationCheckResult> =>
      noteRemedy(
        'migrate:agent-permissions',
        await checkAgentPermissionsOnSteps({
          methods,
          readGlobalAgentIds: async () => new Set<string>(),
          readMigratedAgentIds: () => readMigratedIds(collections, ResourceType.AGENT),
          findAgentsToMigrate: async (migratedAgentIds) =>
            (await collections()
              .raw('agents')
              .find(
                { _id: { $nin: migratedAgentIds }, author: { $exists: true, $ne: null } },
                { projection: { _id: 1, id: 1, name: 1, author: 1, isCollaborative: 1 } },
              )) as unknown as AgentMigrationData[],
        }),
      ),
    checkPromptPermissions: async (): Promise<PromptPermissionsMigrationCheckResult> =>
      noteRemedy(
        'migrate:prompt-permissions',
        await checkPromptPermissionsOnSteps({
          methods,
          readGlobalPromptGroupIds: async () => new Set<string>(),
          readMigratedPromptGroupIds: () => readMigratedIds(collections, ResourceType.PROMPTGROUP),
          findPromptGroupsToMigrate: async (migratedGroupIds) =>
            (await collections()
              .raw('promptgroups')
              .find(
                {
                  _id: { $nin: migratedGroupIds },
                  author: { $exists: true, $ne: null },
                  source: { $in: [null, 'native'] },
                },
                { projection: { _id: 1, name: 1, author: 1, authorName: 1, category: 1 } },
              )) as unknown as PromptGroupMigrationData[],
        }),
      ),
  };
}

/**
 * The agent and prompt group permission migration dry runs (`~/ports/startupChecks`), written once
 * on storage steps so every backend runs the same rules: the required roles, the categories by the
 * legacy global project, the result and its details, the log lines, and a failure resolving to
 * all-zero counts. Moved verbatim from the MongoDB startup checks (`adapters/mongo/startupChecks.ts`),
 * which supply the MongoDB steps; the PostgreSQL startup checks (`adapters/postgres/startupChecks.ts`)
 * supply theirs. Database-neutral: nothing here may import `mongoose` or the MongoDB driver.
 */
import { AccessRoleIds } from 'librechat-data-provider';
import type {
  StartupCheckMethods,
  AgentPermissionsMigrationCheckResult,
  PromptPermissionsMigrationCheckResult,
} from '~/ports/startupChecks';
import logger from '~/config/winston';

/** An agent not yet in the permission system, as the dry run reads it. */
export interface AgentMigrationData {
  _id: unknown;
  id: string;
  name: string;
  author: string;
  isCollaborative: boolean;
}

/** A prompt group not yet in the permission system, as the dry run reads it. */
export interface PromptGroupMigrationData {
  _id: { toString(): string };
  name: string;
  author: string;
  authorName?: string;
  category?: string;
}

/** What the agent dry run reads, in the order it reads it. */
export interface AgentPermissionsMigrationSteps {
  methods: StartupCheckMethods;
  /** Prepares the storage the checks read, if the backend needs it (first). */
  prepare?(): Promise<void>;
  /** The `id`s of the agents of the legacy global project (`projects`, `instance`). */
  readGlobalAgentIds(): Promise<Set<string>>;
  /** The resource ids of the agents some user already has an ACL entry for. */
  readMigratedAgentIds(): Promise<unknown[]>;
  /** The agents with an author whose `_id` is not among `migratedIds`. */
  findAgentsToMigrate(migratedIds: unknown[]): Promise<AgentMigrationData[]>;
}

/** What the prompt group dry run reads. */
export interface PromptPermissionsMigrationSteps {
  methods: StartupCheckMethods;
  /** Prepares the storage the checks read, if the backend needs it (first). */
  prepare?(): Promise<void>;
  /** The `_id`s (as strings) of the prompt groups of the legacy global project. */
  readGlobalPromptGroupIds(): Promise<Set<string>>;
  /** The resource ids of the prompt groups some user already has an ACL entry for. */
  readMigratedPromptGroupIds(): Promise<unknown[]>;
  /** The native prompt groups with an author whose `_id` is not among `migratedIds`. */
  findPromptGroupsToMigrate(migratedIds: unknown[]): Promise<PromptGroupMigrationData[]>;
}

/**
 * Check if agents need to be migrated to the new permission system
 * This performs a dry-run check similar to the migration script
 */
export async function checkAgentPermissionsOnSteps(
  steps: AgentPermissionsMigrationSteps,
): Promise<AgentPermissionsMigrationCheckResult> {
  const { methods } = steps;
  logger.debug('Checking if agent permissions migration is needed');

  try {
    await steps.prepare?.();

    const ownerRole = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER);
    const viewerRole = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
    const editorRole = await methods.findRoleByIdentifier(AccessRoleIds.AGENT_EDITOR);

    if (!ownerRole || !viewerRole || !editorRole) {
      logger.warn(
        'Required agent roles not found. Permission system may not be fully initialized.',
      );
      return {
        totalToMigrate: 0,
        globalEditAccess: 0,
        globalViewAccess: 0,
        privateAgents: 0,
      };
    }

    const globalAgentIds = await steps.readGlobalAgentIds();
    const migratedAgentIds = await steps.readMigratedAgentIds();
    const agentsToMigrate = await steps.findAgentsToMigrate(migratedAgentIds);

    const categories: {
      globalEditAccess: AgentMigrationData[];
      globalViewAccess: AgentMigrationData[];
      privateAgents: AgentMigrationData[];
    } = {
      globalEditAccess: [],
      globalViewAccess: [],
      privateAgents: [],
    };

    agentsToMigrate.forEach((agent) => {
      const isGlobal = globalAgentIds.has(agent.id);
      const isCollab = agent.isCollaborative;

      if (isGlobal && isCollab) {
        categories.globalEditAccess.push(agent);
      } else if (isGlobal && !isCollab) {
        categories.globalViewAccess.push(agent);
      } else {
        categories.privateAgents.push(agent);
      }
    });

    const result: AgentPermissionsMigrationCheckResult = {
      totalToMigrate: agentsToMigrate.length,
      globalEditAccess: categories.globalEditAccess.length,
      globalViewAccess: categories.globalViewAccess.length,
      privateAgents: categories.privateAgents.length,
    };

    if (agentsToMigrate.length > 0) {
      result.details = {
        globalEditAccess: categories.globalEditAccess.map((a) => ({
          name: a.name,
          id: a.id,
        })),
        globalViewAccess: categories.globalViewAccess.map((a) => ({
          name: a.name,
          id: a.id,
        })),
        privateAgents: categories.privateAgents.map((a) => ({
          name: a.name,
          id: a.id,
        })),
      };
    }

    logger.debug('Agent migration check completed', {
      totalToMigrate: result.totalToMigrate,
      globalEditAccess: result.globalEditAccess,
      globalViewAccess: result.globalViewAccess,
      privateAgents: result.privateAgents,
    });

    return result;
  } catch (error) {
    logger.error('Failed to check agent permissions migration', error);
    return {
      totalToMigrate: 0,
      globalEditAccess: 0,
      globalViewAccess: 0,
      privateAgents: 0,
    };
  }
}

/**
 * Check if prompt groups need to be migrated to the new permission system
 * This performs a dry-run check similar to the migration script
 */
export async function checkPromptPermissionsOnSteps(
  steps: PromptPermissionsMigrationSteps,
): Promise<PromptPermissionsMigrationCheckResult> {
  const { methods } = steps;
  logger.debug('Checking if prompt permissions migration is needed');

  try {
    await steps.prepare?.();

    const [ownerRole, viewerRole, editorRole] = await Promise.all([
      methods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_OWNER),
      methods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_VIEWER),
      methods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_EDITOR),
    ]);

    if (!ownerRole || !viewerRole || !editorRole) {
      logger.warn(
        'Required promptGroup roles not found. Permission system may not be fully initialized.',
      );
      return {
        totalToMigrate: 0,
        globalViewAccess: 0,
        privateGroups: 0,
      };
    }

    const [globalPromptGroupIds, migratedGroupIds] = await Promise.all([
      steps.readGlobalPromptGroupIds(),
      steps.readMigratedPromptGroupIds(),
    ]);

    const promptGroupsToMigrate = await steps.findPromptGroupsToMigrate(migratedGroupIds);

    const categories: {
      globalViewAccess: PromptGroupMigrationData[];
      privateGroups: PromptGroupMigrationData[];
    } = {
      globalViewAccess: [],
      privateGroups: [],
    };

    promptGroupsToMigrate.forEach((group) => {
      const isGlobalGroup = globalPromptGroupIds.has(group._id.toString());

      if (isGlobalGroup) {
        categories.globalViewAccess.push(group);
      } else {
        categories.privateGroups.push(group);
      }
    });

    const result: PromptPermissionsMigrationCheckResult = {
      totalToMigrate: promptGroupsToMigrate.length,
      globalViewAccess: categories.globalViewAccess.length,
      privateGroups: categories.privateGroups.length,
    };

    if (promptGroupsToMigrate.length > 0) {
      result.details = {
        globalViewAccess: categories.globalViewAccess.map((g) => ({
          name: g.name,
          _id: g._id.toString(),
          category: g.category || 'uncategorized',
        })),
        privateGroups: categories.privateGroups.map((g) => ({
          name: g.name,
          _id: g._id.toString(),
          category: g.category || 'uncategorized',
        })),
      };
    }

    logger.debug('Prompt migration check completed', {
      totalToMigrate: result.totalToMigrate,
      globalViewAccess: result.globalViewAccess,
      privateGroups: result.privateGroups,
    });

    return result;
  } catch (error) {
    logger.error('Failed to check prompt permissions migration', error);
    return {
      totalToMigrate: 0,
      globalViewAccess: 0,
      privateGroups: 0,
    };
  }
}

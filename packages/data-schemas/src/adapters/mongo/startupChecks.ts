/**
 * The MongoDB startup checks (`~/ports/startupChecks`): the search token probe on the default
 * connection and the agent and prompt group permission migration dry runs, which read the
 * `projects` collection, the ACL entries and the agent and prompt group models directly.
 *
 * The two check functions moved here from `@librechat/api`, which still re-exports them (and
 * their parameter and result types under the former names) for the MongoDB-only callers; the
 * server reaches them through `DataStoreBackend.createStartupChecks`.
 */
import { AccessRoleIds, ResourceType, PrincipalType } from 'librechat-data-provider';
import type { Model, Mongoose } from 'mongoose';
import type {
  StartupCheckMethods,
  DataStoreStartupChecks,
  AgentPermissionsMigrationCheckResult,
  PromptPermissionsMigrationCheckResult,
} from '~/ports/startupChecks';
import type { IPromptGroupDocument } from '~/types/prompts';
import type { IAgent } from '~/types/agent';
import { warnOnMissingSearchTokens } from '~/migrations/searchTokens';
import { ensureRequiredCollectionsExist } from './collections';
import logger from '~/config/winston';

const GLOBAL_PROJECT_NAME = 'instance';

export interface AgentPermissionsMigrationCheckParams {
  mongoose: Mongoose;
  methods: StartupCheckMethods;
  AgentModel: Model<IAgent>;
}

export interface PromptPermissionsMigrationCheckParams {
  mongoose: Mongoose;
  methods: StartupCheckMethods;
  PromptGroupModel: Model<IPromptGroupDocument>;
}

interface AgentMigrationData {
  _id: unknown;
  id: string;
  name: string;
  author: string;
  isCollaborative: boolean;
}

interface PromptGroupMigrationData {
  _id: { toString(): string };
  name: string;
  author: string;
  authorName?: string;
  category?: string;
}

/**
 * Check if agents need to be migrated to the new permission system
 * This performs a dry-run check similar to the migration script
 */
export async function checkAgentPermissionsMigration({
  methods,
  mongoose,
  AgentModel,
}: AgentPermissionsMigrationCheckParams): Promise<AgentPermissionsMigrationCheckResult> {
  logger.debug('Checking if agent permissions migration is needed');

  try {
    const db = mongoose.connection.db;
    if (db) {
      await ensureRequiredCollectionsExist(db);
    }

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

    let globalAgentIds = new Set<string>();
    if (db) {
      const project = await db
        .collection('projects')
        .findOne({ name: GLOBAL_PROJECT_NAME }, { projection: { agentIds: 1 } });
      globalAgentIds = new Set(project?.agentIds || []);
    }

    const AclEntry = mongoose.model('AclEntry');
    const migratedAgentIds = await AclEntry.distinct('resourceId', {
      resourceType: ResourceType.AGENT,
      principalType: PrincipalType.USER,
    });

    const agentsToMigrate = (await AgentModel.find({
      _id: { $nin: migratedAgentIds },
      author: { $exists: true, $ne: null },
    })
      .select('_id id name author isCollaborative')
      .lean()) as unknown as AgentMigrationData[];

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
export async function checkPromptPermissionsMigration({
  methods,
  mongoose,
  PromptGroupModel,
}: PromptPermissionsMigrationCheckParams): Promise<PromptPermissionsMigrationCheckResult> {
  logger.debug('Checking if prompt permissions migration is needed');

  try {
    const db = mongoose.connection.db;
    if (db) {
      await ensureRequiredCollectionsExist(db);
    }

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

    const AclEntry = mongoose.model('AclEntry');
    const [project, migratedGroupIds] = await Promise.all([
      db
        ? db
            .collection('projects')
            .findOne({ name: GLOBAL_PROJECT_NAME }, { projection: { promptGroupIds: 1 } })
        : Promise.resolve(null),
      AclEntry.distinct('resourceId', {
        resourceType: ResourceType.PROMPTGROUP,
        principalType: PrincipalType.USER,
      }),
    ]);
    const globalPromptGroupIds = new Set<string>(
      (project?.promptGroupIds || []).map((id: { toString(): string }) => id.toString()),
    );

    const promptGroupsToMigrate = (await PromptGroupModel.find({
      _id: { $nin: migratedGroupIds },
      author: { $exists: true, $ne: null },
      source: { $in: [null, 'native'] },
    })
      .select('_id name author authorName category')
      .lean()) as unknown as PromptGroupMigrationData[];

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

/**
 * The MongoDB startup checks on `mongoose`: each check reads `mongoose.connection` and the
 * registered `Agent` / `PromptGroup` models when it is called, as the server did before it asked
 * the backend for them.
 */
export function createMongoStartupChecks(
  mongoose: Mongoose,
  methods: StartupCheckMethods,
): DataStoreStartupChecks {
  return {
    probeSearchTokens: () => warnOnMissingSearchTokens(mongoose.connection),
    checkAgentPermissions: () =>
      checkAgentPermissionsMigration({
        mongoose,
        methods,
        AgentModel: mongoose.models.Agent as Model<IAgent>,
      }),
    checkPromptPermissions: () =>
      checkPromptPermissionsMigration({
        mongoose,
        methods,
        PromptGroupModel: mongoose.models.PromptGroup as Model<IPromptGroupDocument>,
      }),
  };
}

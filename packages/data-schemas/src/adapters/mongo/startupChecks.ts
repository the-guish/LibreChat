/**
 * The MongoDB startup checks (`~/ports/startupChecks`): the search token probe on the default
 * connection and the agent and prompt group permission migration dry runs, which read the
 * `projects` collection, the ACL entries and the agent and prompt group models directly.
 *
 * The two check functions moved here from `@librechat/api`, which still re-exports them (and
 * their parameter and result types under the former names) for the MongoDB-only callers; the
 * server reaches them through `DataStoreBackend.createStartupChecks`. Their rules are shared with
 * the PostgreSQL startup checks (`~/methods/startupCheckRules`); this module supplies the MongoDB
 * reads.
 */
import { ResourceType, PrincipalType } from 'librechat-data-provider';
import type { Model, Mongoose } from 'mongoose';
import type {
  StartupCheckMethods,
  DataStoreStartupChecks,
  AgentPermissionsMigrationCheckResult,
  PromptPermissionsMigrationCheckResult,
} from '~/ports/startupChecks';
import type { AgentMigrationData, PromptGroupMigrationData } from '~/methods/startupCheckRules';
import type { IPromptGroupDocument } from '~/types/prompts';
import type { IAgent } from '~/types/agent';
import {
  checkAgentPermissionsOnSteps,
  checkPromptPermissionsOnSteps,
} from '~/methods/startupCheckRules';
import { warnOnMissingSearchTokens } from '~/migrations/searchTokens';
import { ensureRequiredCollectionsExist } from './collections';

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

/**
 * Check if agents need to be migrated to the new permission system
 * This performs a dry-run check similar to the migration script
 * (`~/methods/startupCheckRules`, on the `projects` collection, the ACL entries and `AgentModel`).
 */
export async function checkAgentPermissionsMigration({
  methods,
  mongoose,
  AgentModel,
}: AgentPermissionsMigrationCheckParams): Promise<AgentPermissionsMigrationCheckResult> {
  const db = mongoose.connection.db;
  return checkAgentPermissionsOnSteps({
    methods,
    prepare: async () => {
      if (db) {
        await ensureRequiredCollectionsExist(db);
      }
    },
    readGlobalAgentIds: async () => {
      if (!db) {
        return new Set<string>();
      }
      const project = await db
        .collection('projects')
        .findOne({ name: GLOBAL_PROJECT_NAME }, { projection: { agentIds: 1 } });
      return new Set(project?.agentIds || []);
    },
    readMigratedAgentIds: () => {
      const AclEntry = mongoose.model('AclEntry');
      return AclEntry.distinct('resourceId', {
        resourceType: ResourceType.AGENT,
        principalType: PrincipalType.USER,
      });
    },
    findAgentsToMigrate: async (migratedAgentIds) =>
      (await AgentModel.find({
        _id: { $nin: migratedAgentIds },
        author: { $exists: true, $ne: null },
      })
        .select('_id id name author isCollaborative')
        .lean()) as unknown as AgentMigrationData[],
  });
}

/**
 * Check if prompt groups need to be migrated to the new permission system
 * This performs a dry-run check similar to the migration script
 * (`~/methods/startupCheckRules`, on the `projects` collection, the ACL entries and
 * `PromptGroupModel`).
 */
export async function checkPromptPermissionsMigration({
  methods,
  mongoose,
  PromptGroupModel,
}: PromptPermissionsMigrationCheckParams): Promise<PromptPermissionsMigrationCheckResult> {
  const db = mongoose.connection.db;
  return checkPromptPermissionsOnSteps({
    methods,
    prepare: async () => {
      if (db) {
        await ensureRequiredCollectionsExist(db);
      }
    },
    readGlobalPromptGroupIds: async () => {
      const project = db
        ? await db
            .collection('projects')
            .findOne({ name: GLOBAL_PROJECT_NAME }, { projection: { promptGroupIds: 1 } })
        : null;
      return new Set<string>(
        (project?.promptGroupIds || []).map((id: { toString(): string }) => id.toString()),
      );
    },
    readMigratedPromptGroupIds: () =>
      mongoose.model('AclEntry').distinct('resourceId', {
        resourceType: ResourceType.PROMPTGROUP,
        principalType: PrincipalType.USER,
      }),
    findPromptGroupsToMigrate: async (migratedGroupIds) =>
      (await PromptGroupModel.find({
        _id: { $nin: migratedGroupIds },
        author: { $exists: true, $ne: null },
        source: { $in: [null, 'native'] },
      })
        .select('_id name author authorName category')
        .lean()) as unknown as PromptGroupMigrationData[],
  });
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

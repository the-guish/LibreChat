import { Types } from 'mongoose';
import { PrincipalType, ResourceType } from 'librechat-data-provider';
import type { Model, ClientSession, RootFilterQuery } from 'mongoose';
import type {
  AclProjection,
  AggregateBatch,
  AgentProjection,
  RoleProjection,
  TokenProjection,
  UserProjection,
  GroupProjection,
  ConfigProjection,
  ServerProjection,
  PluginAuthProjection,
  MCPAuthoritySnapshotReads,
  MCPAuthorityConfigSourceDocument as RulesConfigSourceDocument,
  MCPAuthorityCredentialSourceDocument as RulesCredentialSourceDocument,
} from './mcpAuthorityRules';
import type {
  IRole,
  IUser,
  IGroup,
  IConfig,
  IAgent,
  IAclEntry,
  IPluginAuth,
  IToken,
  MCPServerDocument,
  MCPAuthorityDatabaseMethods,
} from '~/types';
import {
  MCPAuthorityProofError,
  createMCPAuthorityRevisions,
  createMCPAuthorityOnSnapshot,
} from './mcpAuthorityRules';
import logger from '~/config/winston';

export {
  MCPAuthorityProofError,
  MAX_MCP_AUTHORITY_TARGETS,
  digestMCPAuthorityValue,
  createMCPAuthorityBootRevision,
} from './mcpAuthorityRules';

interface PinnableQuery {
  session(session: ClientSession): this;
}

export type MCPAuthorityMethods = MCPAuthorityDatabaseMethods;

export interface MCPAuthorityMethodHooks {
  afterPrincipalSnapshot?: () => void | Promise<void>;
  /** Overrides the cooldown that throttles snapshot-namespace preflight
   * retries after a failure. Tests use it to exercise both sides of the
   * boundary without waiting. */
  snapshotNamespaceRetryCooldownMs?: number;
}

export interface MCPAuthorityConfigSourceDocument extends RulesConfigSourceDocument {
  _id: Types.ObjectId | string;
  principalId: Types.ObjectId | string;
  overrides?: IConfig['overrides'];
}

export interface MCPAuthorityCredentialSourceDocument extends RulesCredentialSourceDocument {
  _id: Types.ObjectId | string;
}

const isValidObjectId = (id: unknown): boolean =>
  Types.ObjectId.isValid(id as Parameters<typeof Types.ObjectId.isValid>[0]);

/** The revision helpers over MongoDB ids (`Types.ObjectId.isValid`). */
const revisions = createMCPAuthorityRevisions(isValidObjectId);

export function createMCPAuthorityConfigSourceRevision(
  bootDigest: string,
  documents: readonly MCPAuthorityConfigSourceDocument[],
): string {
  return revisions.createMCPAuthorityConfigSourceRevision(bootDigest, documents);
}

export function createMCPAuthorityDatabaseSourceRevision(server: {
  databaseId: string;
  serverName: string;
  author: string;
  config: MCPServerDocument['config'];
  createdAt?: Date | null;
  updatedAt?: Date | null;
}): string {
  return revisions.createMCPAuthorityDatabaseSourceRevision(server);
}

export function createMCPAuthorityCredentialRevision(
  credentialFields: readonly string[],
  credentials: readonly MCPAuthorityCredentialSourceDocument[],
): string {
  return revisions.createMCPAuthorityCredentialRevision(credentialFields, credentials);
}

function pinAuthoritativeRead<QueryType extends PinnableQuery>(
  query: QueryType,
  session: ClientSession,
): QueryType {
  query.session(session);
  return query;
}

/** `NamespaceExists`: the collection is already there, including when a
 * concurrent creator won the race. */
const NAMESPACE_EXISTS_CODE = 48;

/** After a failed namespace preflight, hold the failure this long before
 * attempting the DDL again. Without it a persistent failure (an authorization
 * error, say) turns every authority request into another serial collection
 * preflight — a DDL retry storm precisely while the database is unhealthy. */
const SNAPSHOT_NAMESPACE_RETRY_COOLDOWN_MS = 30_000;

function isNamespaceExistsError(error: unknown): boolean {
  const candidate = error as { code?: number; codeName?: string; message?: string };
  return (
    candidate?.code === NAMESPACE_EXISTS_CODE ||
    candidate?.codeName === 'NamespaceExists' ||
    /already exists/i.test(String(candidate?.message ?? ''))
  );
}

/** Every collection the authoritative snapshot reads inside its transaction. */
const AUTHORITY_SNAPSHOT_MODELS = [
  'User',
  'Role',
  'Group',
  'Config',
  'MCPServer',
  'Agent',
  'AclEntry',
  'PluginAuth',
  'Token',
] as const;
export function createMCPAuthorityMethods(
  mongoose: typeof import('mongoose'),
  hooks: MCPAuthorityMethodHooks = {},
): MCPAuthorityDatabaseMethods {
  let snapshotNamespacesReady: Promise<void> | undefined;
  let snapshotNamespacesFailure: { error: unknown; at: number } | undefined;
  const namespaceRetryCooldownMs =
    hooks.snapshotNamespaceRetryCooldownMs ?? SNAPSHOT_NAMESPACE_RETRY_COOLDOWN_MS;

  /** Amazon DocumentDB rejects any statement inside a transaction that touches
   * a collection which does not exist, and `asMCPError` converts that server
   * rejection into `proof_unavailable` — so on a deployment where, say, no
   * `PluginAuth` or `Token` row has ever been written, every authority proof
   * fails with an error that names nothing about the real cause. Materializing
   * the snapshot's namespaces before the transaction opens costs one `create`
   * per collection per process and nothing on MongoDB, which tolerates the
   * in-transaction read either way. */
  async function ensureSnapshotNamespaces(): Promise<void> {
    /** Inside the cooldown, replay the recorded failure without touching the
     * database: retries stay possible, but bounded. */
    if (snapshotNamespacesFailure != null) {
      if (Date.now() - snapshotNamespacesFailure.at < namespaceRetryCooldownMs) {
        throw snapshotNamespacesFailure.error;
      }
      snapshotNamespacesFailure = undefined;
    }
    snapshotNamespacesReady ??= (async () => {
      for (const modelName of AUTHORITY_SNAPSHOT_MODELS) {
        const model = mongoose.models[modelName];
        if (model == null) {
          continue;
        }
        try {
          await model.createCollection();
        } catch (error) {
          /** The namespace already exists, or a concurrent creator won the
           * race — either way it is there now. EVERY other failure must
           * propagate: swallowing one would cache this promise as settled and
           * skip creation for the rest of the process, so a transient error
           * would strand authority proofs permanently even after it cleared. */
          if (!isNamespaceExistsError(error)) {
            throw error;
          }
          logger.debug(`[MCPAuthority] ${modelName} collection already exists`);
        }
      }
    })();
    try {
      await snapshotNamespacesReady;
      snapshotNamespacesFailure = undefined;
    } catch (error) {
      /** Clear the memo so a later request retries rather than inheriting a
       * failure that may have already cleared, and record it so requests
       * arriving during the cooldown fail fast instead of re-running the DDL. */
      snapshotNamespacesReady = undefined;
      snapshotNamespacesFailure = { error, at: Date.now() };
      throw error;
    }
  }

  /** The snapshot's reads, each pinned to `session` (the order the rules call them in). */
  function snapshotReads(session: ClientSession): MCPAuthoritySnapshotReads {
    const tenantScope = (tenantId: string | undefined) =>
      tenantId === undefined ? { tenantId: { $exists: false as const } } : { tenantId };
    const groupFilter = (memberId: string, tenantId: string | undefined) => ({
      memberIds: memberId,
      ...tenantScope(tenantId),
    });
    const serverFilter = (
      serverNames: readonly string[],
      normalizedNames: readonly string[],
      tenantId: string | undefined,
    ) => ({
      ...tenantScope(tenantId),
      $or: [
        { serverName: { $in: serverNames } },
        { normalizedServerName: { $in: normalizedNames } },
      ],
    });
    const credentialFilter = (
      userId: string,
      selectors: Parameters<MCPAuthoritySnapshotReads['credentials']>[1],
      tenantId: string | undefined,
    ) => {
      const credentialSelectors = selectors.map((selector) => ({
        pluginKey: selector.pluginKey,
        authField: { $in: selector.authFields },
      }));
      return {
        userId,
        ...tenantScope(tenantId),
        $or: credentialSelectors.length > 0 ? credentialSelectors : [{ _id: null }],
      };
    };
    const tokenFilter = (
      userId: string,
      selectors: Parameters<MCPAuthoritySnapshotReads['tokens']>[1],
      tenantId: string | undefined,
    ) => ({
      userId: new Types.ObjectId(userId),
      ...tenantScope(tenantId),
      $or: selectors.length > 0 ? [...selectors] : [{ _id: null }],
    });
    const aclFilter = (
      selection: Parameters<MCPAuthoritySnapshotReads['aclEntries']>[0],
      tenantId: string | undefined,
    ) => {
      const principals: RootFilterQuery<IAclEntry>[] = [
        { principalType: PrincipalType.USER, principalId: new Types.ObjectId(selection.userId) },
        { principalType: PrincipalType.ROLE, principalId: selection.roleName },
        { principalType: PrincipalType.PUBLIC },
        ...selection.groupIds.map((groupId) => ({
          principalType: PrincipalType.GROUP,
          principalId: groupId,
        })),
      ];
      const resources: RootFilterQuery<IAclEntry>[] = [];
      if (selection.serverIds.length > 0) {
        resources.push({
          resourceType: ResourceType.MCPSERVER,
          resourceId: { $in: [...selection.serverIds] },
        });
      }
      if (selection.agentIds.length > 0) {
        resources.push({
          resourceType: ResourceType.AGENT,
          resourceId: { $in: selection.agentIds },
        });
      }
      return { $and: [tenantScope(tenantId), { $or: principals }, { $or: resources }] };
    };

    return {
      async user(userId, tenantId) {
        const User = mongoose.models.User as Model<IUser>;
        const userQuery = User.findOne({
          _id: new Types.ObjectId(userId),
          ...tenantScope(tenantId),
        }).select(
          '_id tenantId role provider idOnTheSource openidIssuer googleId facebookId openidId samlId ldapId githubId discordId appleId createdAt updatedAt',
        );
        return await pinAuthoritativeRead(userQuery, session).lean<UserProjection>();
      },
      async groupCount(memberId, tenantId, limit) {
        const Group = mongoose.models.Group as Model<IGroup>;
        const groupCountQuery = Group.countDocuments(groupFilter(memberId, tenantId)).limit(limit);
        return await pinAuthoritativeRead(groupCountQuery, session);
      },
      async groups(memberId, tenantId, limit) {
        const Group = mongoose.models.Group as Model<IGroup>;
        const groupQuery = Group.find(groupFilter(memberId, tenantId))
          .select('_id source idOnTheSource createdAt updatedAt')
          .limit(limit)
          .setOptions({ singleBatch: true });
        return await pinAuthoritativeRead(groupQuery, session).lean<GroupProjection[]>();
      },
      async role(name, tenantId) {
        const Role = mongoose.models.Role as Model<IRole>;
        const roleQuery = Role.findOne({ name, ...tenantScope(tenantId) }).select(
          '_id name permissions.MCP_SERVERS.USE',
        );
        return await pinAuthoritativeRead(roleQuery, session).lean<RoleProjection>();
      },
      afterPrincipalSnapshot: hooks.afterPrincipalSnapshot,
      async configs(slots, tenantId, limit, tombstoneLimit) {
        const Config = mongoose.models.Config as Model<IConfig>;
        const tombstoneConditions = [
          { $eq: ['$$path', 'mcpSettings'] },
          { $eq: [{ $indexOfCP: ['$$path', 'mcpSettings.'] }, 0] },
        ];
        const configQuery = Config.aggregate<AggregateBatch<ConfigProjection>>([
          { $match: { $and: [tenantScope(tenantId), { $or: [...slots] }] } },
          {
            $project: {
              _id: 1,
              principalType: 1,
              principalId: 1,
              priority: 1,
              isActive: 1,
              configVersion: 1,
              updatedAt: 1,
              mcpSettingsOverride: '$overrides.mcpSettings',
              tombstones: {
                $slice: [
                  {
                    $filter: {
                      input: { $ifNull: ['$tombstones', []] },
                      as: 'path',
                      cond: { $or: tombstoneConditions },
                    },
                  },
                  tombstoneLimit,
                ],
              },
            },
          },
          { $limit: limit },
          { $group: { _id: null, rows: { $push: '$$ROOT' }, count: { $sum: 1 } } },
        ]);
        return await pinAuthoritativeRead(configQuery, session);
      },
      async serverCount(serverNames, normalizedNames, tenantId, limit) {
        const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
        const serverCountQuery = MCPServer.countDocuments(
          serverFilter(serverNames, normalizedNames, tenantId),
        ).limit(limit);
        return await pinAuthoritativeRead(serverCountQuery, session);
      },
      async servers(serverNames, normalizedNames, tenantId, limit) {
        const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
        const serverQuery = MCPServer.find(serverFilter(serverNames, normalizedNames, tenantId))
          .select('_id serverName normalizedServerName config author createdAt updatedAt')
          .limit(limit)
          .setOptions({ singleBatch: true });
        return await pinAuthoritativeRead(serverQuery, session).lean<ServerProjection[]>();
      },
      async agents(serverNames, tenantId, limit) {
        const Agent = mongoose.models.Agent as Model<IAgent>;
        const agentQuery = Agent.aggregate<AggregateBatch<AgentProjection>>([
          {
            $match: {
              mcpServerNames: { $in: serverNames },
              ...tenantScope(tenantId),
            },
          },
          {
            $project: {
              _id: 1,
              id: 1,
              createdAt: 1,
              updatedAt: 1,
              mcpServerNames: {
                $filter: {
                  input: { $ifNull: ['$mcpServerNames', []] },
                  as: 'serverName',
                  cond: { $in: ['$$serverName', serverNames] },
                },
              },
            },
          },
          { $limit: limit },
          { $group: { _id: null, rows: { $push: '$$ROOT' }, count: { $sum: 1 } } },
        ]);
        return await pinAuthoritativeRead(agentQuery, session);
      },
      async credentialCount(userId, selectors, tenantId, limit) {
        const PluginAuth = mongoose.models.PluginAuth as Model<IPluginAuth>;
        const credentialCountQuery = PluginAuth.countDocuments(
          credentialFilter(userId, selectors, tenantId),
        ).limit(limit);
        return await pinAuthoritativeRead(credentialCountQuery, session);
      },
      async credentials(userId, selectors, tenantId, limit) {
        const PluginAuth = mongoose.models.PluginAuth as Model<IPluginAuth>;
        const credentialQuery = PluginAuth.find(credentialFilter(userId, selectors, tenantId))
          .select('_id pluginKey authField value createdAt updatedAt')
          .limit(limit)
          .setOptions({ singleBatch: true });
        return await pinAuthoritativeRead(credentialQuery, session).lean<PluginAuthProjection[]>();
      },
      async tokenCount(userId, selectors, tenantId, limit) {
        const Token = mongoose.models.Token as Model<IToken>;
        const tokenCountQuery = Token.countDocuments(
          tokenFilter(userId, selectors, tenantId),
        ).limit(limit);
        return await pinAuthoritativeRead(tokenCountQuery, session);
      },
      async tokens(userId, selectors, tenantId, limit) {
        const Token = mongoose.models.Token as Model<IToken>;
        const tokenQuery = Token.find(tokenFilter(userId, selectors, tenantId))
          .select('_id type identifier token metadata createdAt expiresAt')
          .limit(limit)
          .setOptions({ singleBatch: true });
        return await pinAuthoritativeRead(tokenQuery, session).lean<TokenProjection[]>();
      },
      async aclCount(selection, tenantId, limit) {
        const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
        const aclCountQuery = AclEntry.countDocuments(aclFilter(selection, tenantId)).limit(limit);
        return await pinAuthoritativeRead(aclCountQuery, session);
      },
      async aclEntries(selection, tenantId, limit) {
        const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
        const aclQuery = AclEntry.find(aclFilter(selection, tenantId))
          .select(
            '_id principalType principalId resourceType resourceId permBits expiredAt updatedAt',
          )
          .limit(limit)
          .setOptions({ singleBatch: true });
        return await pinAuthoritativeRead(aclQuery, session).lean<AclProjection[]>();
      },
    };
  }

  return createMCPAuthorityOnSnapshot<ClientSession>({
    isValidId: isValidObjectId,
    async runSnapshot(read, suppliedSession) {
      if (suppliedSession?.inTransaction()) {
        throw new MCPAuthorityProofError(
          'proof_unavailable',
          'MCP authority reads cannot use a caller transaction snapshot',
        );
      }
      await ensureSnapshotNamespaces();
      const session = suppliedSession ?? (await mongoose.startSession());
      const ownsSession = suppliedSession == null;
      try {
        session.startTransaction({
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
        const proof = await read(snapshotReads(session));
        await session.commitTransaction();
        return proof;
      } catch (error) {
        if (session.inTransaction()) {
          try {
            await session.abortTransaction();
          } catch {
            /** The authoritative read already failed closed. */
          }
        }
        throw error;
      } finally {
        if (ownsSession) {
          await session.endSession();
        }
      }
    },
  });
}

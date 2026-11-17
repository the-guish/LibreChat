import { ResourceType, PermissionBits } from 'librechat-data-provider';
import type { Model, RootFilterQuery, Types } from 'mongoose';
import type { MCPOptions } from 'librechat-data-provider';
import type {
  MCPServerDocument,
  ErasableMCPServer,
  MCPServerViewerEntry,
  MCPServerViewerPrincipal,
} from '~/types/mcp';
import type { IAclEntry } from '~/types/aclEntry';
import type { IdLike } from '~/ports/common';
import {
  mcpServerPageLimit,
  encodeMCPServerCursor,
  decodeMCPServerCursor,
  createMCPServerOnSteps,
  mcpServerOAuthIdentifiers,
  assembleErasableMCPServers,
  splitMCPServerViewerPrincipals,
  MCP_OBJECT_ID_PATTERN,
} from './mcpServerRules';
import { permissionBitSupersets } from './aclEntry';
import logger from '~/config/winston';

/**
 * Helper to check if an error is a MongoDB duplicate key error.
 * Both MCPServer unique indexes represent raw or normalized server-name collisions,
 * so retrying name allocation is safe for either E11000 source.
 */
function isDuplicateKeyError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const mongoError = error as { code: number };
    return mongoError.code === 11000;
  }
  return false;
}

export interface MCPServerDeps {
  /** Returns resource IDs solely owned by the given user. From createAclEntryMethods. */
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
}

export type {
  ErasableMCPServer,
  MCPServerViewerEntry,
  MCPServerViewerPrincipal,
} from '~/types/mcp';

export function createMCPServerMethods(
  mongoose: typeof import('mongoose'),
  deps: MCPServerDeps,
): {
  createMCPServer: (data: {
    config: MCPOptions;
    author: string | Types.ObjectId;
    reservedServerNames?: Iterable<string>;
  }) => Promise<MCPServerDocument>;
  findMCPServerByServerName: (serverName: string) => Promise<MCPServerDocument | null>;
  findMCPServerByObjectId: (_id: string | Types.ObjectId) => Promise<MCPServerDocument | null>;
  getListMCPServersByIds: ({
    ids,
    otherParams,
    limit,
    after,
  }: {
    /** ObjectIds, or their hex strings: the query casts them. */
    ids?: IdLike[];
    otherParams?: RootFilterQuery<MCPServerDocument>;
    limit?: number | null;
    after?: string | null;
  }) => Promise<{
    data: MCPServerDocument[];
    has_more: boolean;
    after: string | null;
  }>;
  getListMCPServersByNames: ({ names }: { names: string[] }) => Promise<{
    data: MCPServerDocument[];
  }>;
  updateMCPServer: (
    serverName: string,
    updateData: { config?: MCPOptions },
  ) => Promise<MCPServerDocument | null>;
  deleteMCPServer: (serverName: string) => Promise<MCPServerDocument | null>;
  findUserErasableMCPServers: (userId: string) => Promise<ErasableMCPServer[]>;
  deleteMCPServersWithAcl: (ids: string[]) => Promise<number>;
  findMCPServerOAuthTokenUserIds: (serverName: string, tenantId?: string) => Promise<string[]>;
  findMCPServerTokenHolderIds: (serverName: string) => Promise<Types.ObjectId[]>;
  findMCPServerViewerEntries: (serverId: string) => Promise<MCPServerViewerEntry[]>;
  findMCPServerViewAclEntries: (serverId: string | Types.ObjectId) => Promise<IAclEntry[]>;
  findMCPServerViewerUserIds: (entries: MCPServerViewerPrincipal[]) => Promise<string[]>;
} {
  /**
   * Create a new MCP server, retrying with a fresh name when a concurrent create takes it
   * (`createMCPServerOnSteps`).
   * @param data - Object containing config (with title, description, url, etc.) and author
   * @returns The created MCP server document
   */
  async function createMCPServer(data: {
    config: MCPOptions;
    author: string | Types.ObjectId;
    reservedServerNames?: Iterable<string>;
  }): Promise<MCPServerDocument> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return createMCPServerOnSteps(
      {
        async findServerNames(pattern) {
          // Find all servers with matching base name pattern (baseName or baseName-N)
          const existing = await MCPServer.find({
            serverName: { $regex: pattern },
          })
            .select('serverName')
            .lean<Array<{ serverName: string }>>();
          return existing.map((server) => server.serverName);
        },
        async insert(document) {
          const newServer = await MCPServer.create(document);
          return newServer.toObject() as MCPServerDocument;
        },
        isDuplicateKey: isDuplicateKeyError,
      },
      data,
    );
  }

  /**
   * Find an MCP server by serverName
   * @param serverName - The unique server name identifier
   * @returns The MCP server document or null
   */
  async function findMCPServerByServerName(serverName: string): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findOne({ serverName }).lean<MCPServerDocument>();
  }

  /**
   * Find an MCP server by MongoDB ObjectId
   * @param _id - The MongoDB ObjectId
   * @returns The MCP server document or null
   */
  async function findMCPServerByObjectId(
    _id: string | Types.ObjectId,
  ): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findById(_id).lean<MCPServerDocument>();
  }

  /**
   * Get a paginated list of MCP servers by IDs with filtering and search
   * @param ids - Array of ObjectIds to include
   * @param otherParams - Additional filter parameters (e.g., search)
   * @param limit - Page size limit (null for no pagination)
   * @param after - Cursor for pagination
   * @returns Paginated list of MCP servers
   */
  async function getListMCPServersByIds({
    ids = [],
    otherParams = {},
    limit = null,
    after = null,
  }: {
    /** ObjectIds, or their hex strings: the query casts them. */
    ids?: IdLike[];
    otherParams?: RootFilterQuery<MCPServerDocument>;
    limit?: number | null;
    after?: string | null;
  }): Promise<{
    data: MCPServerDocument[];
    has_more: boolean;
    after: string | null;
  }> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    const normalizedLimit = mcpServerPageLimit(limit);

    // Build base query combining accessible servers with other filters
    const baseQuery: RootFilterQuery<MCPServerDocument> = { ...otherParams, _id: { $in: ids } };

    // Add cursor condition
    if (after) {
      try {
        const { updatedAt, _id } = decodeMCPServerCursor(after);

        const cursorCondition = {
          $or: [
            { updatedAt: { $lt: new Date(updatedAt as string) } },
            {
              updatedAt: new Date(updatedAt as string),
              _id: { $gt: new mongoose.Types.ObjectId(_id as string) },
            },
          ],
        };

        // Merge cursor condition with base query
        if (Object.keys(baseQuery).length > 0) {
          baseQuery.$and = [{ ...baseQuery }, cursorCondition];
          // Remove the original conditions from baseQuery to avoid duplication
          Object.keys(baseQuery).forEach((key) => {
            if (key !== '$and') {
              delete baseQuery[key];
            }
          });
        }
      } catch (error) {
        // Invalid cursor, ignore
        logger.warn('[getListMCPServersByIds] Invalid cursor provided', error);
      }
    }

    if (normalizedLimit === null) {
      // No pagination - return all matching servers
      const servers = await MCPServer.find(baseQuery)
        .sort({ updatedAt: -1, _id: 1 })
        .lean<MCPServerDocument[]>();

      return {
        data: servers,
        has_more: false,
        after: null,
      };
    }

    // Paginated query - assign to const to help TypeScript
    const servers = await MCPServer.find(baseQuery)
      .sort({ updatedAt: -1, _id: 1 })
      .limit(normalizedLimit + 1)
      .lean<MCPServerDocument[]>();

    const hasMore = servers.length > normalizedLimit;
    const data = hasMore ? servers.slice(0, normalizedLimit) : servers;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = encodeMCPServerCursor(lastItem.updatedAt, lastItem._id);
    }

    return {
      data,
      has_more: hasMore,
      after: nextCursor,
    };
  }

  /**
   * Update an MCP server
   * @param serverName - The MCP server ID
   * @param updateData - Object containing config to update
   * @returns The updated MCP server document or null
   */
  async function updateMCPServer(
    serverName: string,
    updateData: { config?: MCPOptions },
  ): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findOneAndUpdate(
      { serverName },
      { $set: updateData },
      { new: true, runValidators: true },
    ).lean<MCPServerDocument>();
  }

  /**
   * Delete an MCP server
   * @param serverName - The MCP server ID
   * @returns The deleted MCP server document or null
   */
  async function deleteMCPServer(serverName: string): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findOneAndDelete({ serverName }).lean<MCPServerDocument>();
  }

  /**
   * Get MCP servers by their serverName strings
   * @param names - Array of serverName strings to fetch
   * @returns Object containing array of MCP server documents
   */
  async function getListMCPServersByNames({ names = [] }: { names: string[] }): Promise<{
    data: MCPServerDocument[];
  }> {
    if (names.length === 0) {
      return { data: [] };
    }
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    const servers = await MCPServer.find({ serverName: { $in: names } }).lean<
      MCPServerDocument[]
    >();
    return { data: servers };
  }

  /**
   * Account erasure: servers solely owned by the user, plus legacy (pre-ACL) servers that only
   * carry the author field. Servers shared with another owner are not returned.
   */
  async function findUserErasableMCPServers(userId: string): Promise<ErasableMCPServer[]> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument> | undefined;
    const AclEntry = mongoose.models.AclEntry;
    if (!MCPServer || !AclEntry) {
      return [];
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);
    const soleOwnedIds = await deps.getSoleOwnedResourceIds(userObjectId, ResourceType.MCPSERVER);
    const authoredServers = await MCPServer.find({ author: userObjectId })
      .select('_id serverName')
      .lean<Array<{ _id: Types.ObjectId; serverName: string }>>();
    const migratedEntries =
      authoredServers.length > 0
        ? await AclEntry.find({
            resourceType: ResourceType.MCPSERVER,
            resourceId: { $in: authoredServers.map((s) => s._id) },
          })
            .select('resourceId')
            .lean<Array<{ resourceId: Types.ObjectId }>>()
        : [];
    const migratedIds = new Set(migratedEntries.map((e) => e.resourceId.toString()));
    const aclOwnedServers =
      soleOwnedIds.length > 0
        ? await MCPServer.find({ _id: { $in: soleOwnedIds } })
            .select('_id serverName')
            .lean<Array<{ _id: Types.ObjectId; serverName: string }>>()
        : [];
    /** Sole-owned ids whose server is already gone keep an empty name so the ACLs still get cleaned. */
    return assembleErasableMCPServers({
      soleOwnedIds,
      aclOwnedServers,
      authoredServers,
      migratedIds,
    });
  }

  /** Users holding an OAuth credential record for the server, used to fence them on removal. */
  async function findMCPServerOAuthTokenUserIds(
    serverName: string,
    tenantId?: string,
  ): Promise<string[]> {
    const Token = mongoose.models.Token;
    if (!Token) {
      return [];
    }
    /** Server names are unique per tenant, so a tenantless owner only matches tenantless tokens. */
    const userIds = await Token.distinct('userId', {
      tenantId: tenantId ?? null,
      identifier: { $in: mcpServerOAuthIdentifiers(serverName) },
    });
    return userIds.map(String);
  }

  /**
   * Users holding an OAuth credential record for the server (`mcp:<serverName>` and its `:client`
   * and `:refresh` records) as stored, in the tenant scope the model applies, without the explicit
   * tenant criterion of {@link findMCPServerOAuthTokenUserIds}. None without the token model.
   */
  async function findMCPServerTokenHolderIds(serverName: string): Promise<Types.ObjectId[]> {
    const Token = mongoose.models.Token;
    if (!Token) {
      return [];
    }
    return Token.distinct('userId', {
      identifier: { $in: mcpServerOAuthIdentifiers(serverName) },
    });
  }

  /**
   * The ACL entries on the server with any view bit set, whole. None without the ACL entry model.
   * `serverId` is cast as the model casts it (an id it cannot cast rejects).
   */
  async function findMCPServerViewAclEntries(
    serverId: string | Types.ObjectId,
  ): Promise<IAclEntry[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry> | undefined;
    if (!AclEntry) {
      return [];
    }
    return AclEntry.find({
      resourceType: ResourceType.MCPSERVER,
      resourceId: serverId,
      permBits: { $bitsAnySet: PermissionBits.VIEW },
    }).lean<IAclEntry[]>();
  }

  /** Principals holding view access on the server, used to find users it was shared with. */
  async function findMCPServerViewerEntries(serverId: string): Promise<MCPServerViewerEntry[]> {
    const entries = await mongoose.models.AclEntry.find({
      resourceType: ResourceType.MCPSERVER,
      resourceId: new mongoose.Types.ObjectId(serverId),
      permBits: { $in: permissionBitSupersets(PermissionBits.VIEW) },
    })
      .select('principalType principalId')
      .lean<Array<{ principalType: string; principalId?: Types.ObjectId | string }>>();
    return entries.map((entry) => ({
      principalType: entry.principalType,
      principalId: entry.principalId?.toString(),
    }));
  }

  /**
   * Users a server's view ACL names directly or through a group, so its removal can fence viewers
   * who hold no OAuth credential. Role and public principals are not enumerated.
   */
  async function findMCPServerViewerUserIds(
    entries: MCPServerViewerPrincipal[],
  ): Promise<string[]> {
    const { userIds, groupIds } = splitMCPServerViewerPrincipals(entries);
    if (groupIds.size === 0) {
      return [...userIds];
    }
    const groups = await mongoose.models.Group.find({
      _id: { $in: [...groupIds].map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select('memberIds')
      .lean<Array<{ memberIds?: string[] }>>();
    /** `memberIds` holds `idOnTheSource` for external users and the user id otherwise. */
    const memberIds = [...new Set(groups.flatMap((group) => group.memberIds ?? []))];
    if (memberIds.length === 0) {
      return [...userIds];
    }
    const objectIds = memberIds
      .filter((id) => MCP_OBJECT_ID_PATTERN.test(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    const members = await mongoose.models.User.find({
      $or: [
        { idOnTheSource: { $in: memberIds } },
        ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
      ],
    })
      .select('_id')
      .lean<Array<{ _id: Types.ObjectId }>>();
    for (const member of members) {
      userIds.add(member._id.toString());
    }
    return [...userIds];
  }

  /** Deletes MCP servers by id together with every ACL entry on them. */
  async function deleteMCPServersWithAcl(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    const result = await MCPServer.deleteMany({ _id: { $in: objectIds } });
    /** ACL entries are the retry discovery key for sole-owned servers, so they go last. */
    await mongoose.models.AclEntry.deleteMany({
      resourceType: ResourceType.MCPSERVER,
      resourceId: { $in: objectIds },
    });
    return result.deletedCount ?? 0;
  }

  return {
    findUserErasableMCPServers,
    deleteMCPServersWithAcl,
    findMCPServerOAuthTokenUserIds,
    findMCPServerTokenHolderIds,
    findMCPServerViewerEntries,
    findMCPServerViewAclEntries,
    findMCPServerViewerUserIds,
    createMCPServer,
    findMCPServerByServerName,
    findMCPServerByObjectId,
    getListMCPServersByIds,
    getListMCPServersByNames,
    updateMCPServer,
    deleteMCPServer,
  };
}

export type MCPServerMethods = ReturnType<typeof createMCPServerMethods>;

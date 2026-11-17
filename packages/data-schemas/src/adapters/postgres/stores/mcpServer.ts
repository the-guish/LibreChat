/**
 * The PostgreSQL `MCPServerStore` (`~/ports/mcpServer`): the MCP servers users add, on the
 * `mcpservers` table, with the removal and erasure reads over `aclentries`, `tokens`, `groups` and
 * `users`, all through the collection primitive in document mode (so every read and write is
 * scoped to the active tenant, as the mongoose models are). Must not import `mongoose`, `mongodb`
 * or `bson`.
 *
 * - The server name allocation and the create's retry loop are the shared rules
 *   (`createMCPServerOnSteps`): the stored names matching `^base(-\d+)?$` are read, the next name
 *   is inserted, and the unique `{ serverName, tenantId }` / `{ normalizedServerName, tenantId }`
 *   indexes decide between racing creates (the loser retries with a fresh name). The stored
 *   `normalizedServerName` is the primitive's collection hook.
 * - The id listing pages on `(updatedAt desc, _id asc)` with `limit + 1` rows and the shared
 *   cursor; a cursor whose id is not a store id or whose time is not a date is ignored.
 * - The view ACL reads match the view bit by its supersets (`permissionBitSupersets`) or by
 *   `$bitsAnySet` (C2's bit test on the `permBits` column).
 */
import { ResourceType, PermissionBits } from 'librechat-data-provider';
import type { MCPServerFactoryDeps } from '~/compose/types';
import type { IAclEntry, MCPServerDocument } from '~/types';
import type { MCPServerStore } from '~/ports/mcpServer';
import type { PostgresStoreContext } from './context';
import {
  mcpServerPageLimit,
  encodeMCPServerCursor,
  decodeMCPServerCursor,
  createMCPServerOnSteps,
  mcpServerOAuthIdentifiers,
  assembleErasableMCPServers,
  splitMCPServerViewerPrincipals,
  MCP_OBJECT_ID_PATTERN,
} from '~/methods/mcpServerRules';
import { permissionBitSupersets } from '~/methods/aclEntryRules';
import { postgresStoreErrors } from '../storeErrors';
import { postgresStoreIds } from '../storeIds';
import logger from '~/config/winston';

type ServerRecord = Record<string, unknown> & { _id: string; serverName: string };

/** A record as the port hands it out (the port types it as a mongoose document, a known leak). */
const asServer = (record: Record<string, unknown>): MCPServerDocument =>
  record as unknown as MCPServerDocument;

export function createPostgresMCPServerStore(
  context: PostgresStoreContext,
  deps: Pick<MCPServerFactoryDeps, 'getSoleOwnedResourceIds'>,
): MCPServerStore {
  const servers = () => context.collections().collection<ServerRecord>('mcpservers');
  const aclEntries = () => context.collections().collection('aclentries');
  const tokens = () => context.collections().collection('tokens');

  const store: MCPServerStore = {
    createMCPServer: (data) =>
      createMCPServerOnSteps(
        {
          async findServerNames(pattern) {
            const existing = await servers().find(
              { serverName: { $regex: pattern } },
              { projection: 'serverName' },
            );
            return existing.map((server) => server.serverName);
          },
          async insert(document) {
            return asServer(await servers().insertOne(document));
          },
          isDuplicateKey: (error) => postgresStoreErrors.isDuplicateKey(error),
        },
        data,
      ),

    async findMCPServerByServerName(serverName) {
      const found = await servers().findOne({ serverName });
      return found == null ? null : asServer(found);
    },

    async findMCPServerByObjectId(_id) {
      const found = await servers().findOne({ _id });
      return found == null ? null : asServer(found);
    },

    async getListMCPServersByIds({ ids = [], otherParams = {}, limit = null, after = null }) {
      const normalizedLimit = mcpServerPageLimit(limit);
      let filter: Record<string, unknown> = { ...otherParams, _id: { $in: ids } };
      if (after) {
        try {
          const { updatedAt, _id } = decodeMCPServerCursor(after);
          const time = new Date(updatedAt as string);
          if (Number.isNaN(time.getTime()) || !postgresStoreIds.isValid(_id)) {
            throw new Error('Unreadable cursor');
          }
          filter = {
            $and: [
              filter,
              { $or: [{ updatedAt: { $lt: time } }, { updatedAt: time, _id: { $gt: _id } }] },
            ],
          };
        } catch (error) {
          logger.warn('[getListMCPServersByIds] Invalid cursor provided', error);
        }
      }
      const sort = { updatedAt: -1, _id: 1 } as const;
      if (normalizedLimit === null) {
        const all = await servers().find(filter, { sort });
        return { data: all.map(asServer), has_more: false, after: null };
      }
      const page = await servers().find(filter, { sort, limit: normalizedLimit + 1 });
      const hasMore = page.length > normalizedLimit;
      const data = hasMore ? page.slice(0, normalizedLimit) : page;
      const last = data[data.length - 1];
      return {
        data: data.map(asServer),
        has_more: hasMore,
        after: hasMore && last != null ? encodeMCPServerCursor(last.updatedAt, last._id) : null,
      };
    },

    async getListMCPServersByNames({ names = [] }) {
      if (names.length === 0) {
        return { data: [] };
      }
      const found = await servers().find({ serverName: { $in: names } });
      return { data: found.map(asServer) };
    },

    async updateMCPServer(serverName, updateData) {
      const updated = await servers().findOneAndUpdate(
        { serverName },
        { $set: updateData },
        { returnDocument: 'after', runValidators: true },
      );
      return updated == null ? null : asServer(updated);
    },

    async deleteMCPServer(serverName) {
      const deleted = await servers().findOneAndDelete({ serverName });
      return deleted == null ? null : asServer(deleted);
    },

    async findUserErasableMCPServers(userId) {
      const soleOwnedIds = await deps.getSoleOwnedResourceIds(userId, ResourceType.MCPSERVER);
      const authoredServers = await servers().find(
        { author: userId },
        { projection: '_id serverName' },
      );
      const migratedEntries =
        authoredServers.length > 0
          ? await aclEntries().find(
              {
                resourceType: ResourceType.MCPSERVER,
                resourceId: { $in: authoredServers.map((s) => s._id) },
              },
              { projection: 'resourceId' },
            )
          : [];
      const migratedIds = new Set(migratedEntries.map((e) => String(e.resourceId)));
      const aclOwnedServers =
        soleOwnedIds.length > 0
          ? await servers().find({ _id: { $in: soleOwnedIds } }, { projection: '_id serverName' })
          : [];
      return assembleErasableMCPServers({
        soleOwnedIds,
        aclOwnedServers,
        authoredServers,
        migratedIds,
      });
    },

    async deleteMCPServersWithAcl(ids) {
      if (ids.length === 0) {
        return 0;
      }
      const result = await servers().deleteMany({ _id: { $in: ids } });
      /** ACL entries are the retry discovery key for sole-owned servers, so they go last. */
      await aclEntries().deleteMany({
        resourceType: ResourceType.MCPSERVER,
        resourceId: { $in: ids },
      });
      return result.deletedCount;
    },

    async findMCPServerOAuthTokenUserIds(serverName, tenantId) {
      /** Server names are unique per tenant, so a tenantless owner only matches tenantless tokens. */
      const userIds = await tokens().distinct('userId', {
        tenantId: tenantId ?? null,
        identifier: { $in: mcpServerOAuthIdentifiers(serverName) },
      });
      return userIds.map(String);
    },

    async findMCPServerTokenHolderIds(serverName) {
      const userIds = await tokens().distinct('userId', {
        identifier: { $in: mcpServerOAuthIdentifiers(serverName) },
      });
      return userIds.map(String);
    },

    async findMCPServerViewAclEntries(serverId) {
      const entries = await aclEntries().find({
        resourceType: ResourceType.MCPSERVER,
        resourceId: serverId,
        permBits: { $bitsAnySet: PermissionBits.VIEW },
      });
      return entries as unknown as IAclEntry[];
    },

    async findMCPServerViewerEntries(serverId) {
      const entries = await aclEntries().find(
        {
          resourceType: ResourceType.MCPSERVER,
          resourceId: serverId,
          permBits: { $in: permissionBitSupersets(PermissionBits.VIEW) },
        },
        { projection: 'principalType principalId' },
      );
      return entries.map((entry) => ({
        principalType: entry.principalType as string,
        principalId: entry.principalId == null ? undefined : String(entry.principalId),
      }));
    },

    async findMCPServerViewerUserIds(entries) {
      const { userIds, groupIds } = splitMCPServerViewerPrincipals(entries);
      if (groupIds.size === 0) {
        return [...userIds];
      }
      const groups = await context
        .collections()
        .collection('groups')
        .find(
          { _id: { $in: [...groupIds].map((id) => id.toLowerCase()) } },
          { projection: 'memberIds' },
        );
      /** `memberIds` holds `idOnTheSource` for external users and the user id otherwise. */
      const memberIds = [
        ...new Set(groups.flatMap((group) => (group.memberIds as string[] | undefined) ?? [])),
      ];
      if (memberIds.length === 0) {
        return [...userIds];
      }
      const objectIds = memberIds
        .filter((id) => MCP_OBJECT_ID_PATTERN.test(id))
        .map((id) => id.toLowerCase());
      const members = await context
        .collections()
        .collection('users')
        .find(
          {
            $or: [
              { idOnTheSource: { $in: memberIds } },
              ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
            ],
          },
          { projection: '_id' },
        );
      for (const member of members) {
        userIds.add(String(member._id));
      }
      return [...userIds];
    },
  };
  return store;
}

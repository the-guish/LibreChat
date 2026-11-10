/**
 * MCP server store port: the MCP servers users add through the UI (as opposed to those in the
 * YAML config), with the lookups their removal needs. Nothing here may import `mongoose`.
 * Signatures are those of `MCPServerMethods` (`~/methods/mcpServer`) with ids stated as `IdLike`
 * and the extra criteria of `getListMCPServersByIds` in the store query language (`./query`);
 * `mcpServer.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * A server is addressed by its `serverName`, unique per tenant together with its normalized
 * form; `createMCPServer` derives it from the title (`my-server`, `my-server-2`, ...), skipping
 * names that are taken or reserved.
 *
 * Known leak kept for now so callers stay unchanged: `MCPServerDocument` extends mongoose's
 * `Document` (its `_id` and `author` are ObjectIds).
 */
import type { MCPOptions } from 'librechat-data-provider';
import type {
  MCPServerDocument,
  ErasableMCPServer,
  MCPServerViewerEntry,
  MCPServerViewerPrincipal,
} from '~/types';
import type { StoreFilter } from './query';
import type { IdLike } from './common';
import { listPortMethods } from './common';

export interface MCPServerStore {
  /**
   * The servers removed with the user's account: those the user solely owns, and legacy ones
   * only the user authored. A sole-owned id whose server is gone comes with an empty name.
   */
  findUserErasableMCPServers(userId: string): Promise<ErasableMCPServer[]>;
  /** Deletes the servers with these ids and every ACL entry on them; resolves how many. */
  deleteMCPServersWithAcl(ids: string[]): Promise<number>;
  /**
   * The users holding an OAuth credential for the server in the tenant (outside a tenant, only
   * tenantless credentials).
   */
  findMCPServerOAuthTokenUserIds(serverName: string, tenantId?: string): Promise<string[]>;
  /** The principals holding view access on the server. */
  findMCPServerViewerEntries(serverId: string): Promise<MCPServerViewerEntry[]>;
  /**
   * The users these view-ACL principals name directly or through a group; role and public
   * principals are not enumerated.
   */
  findMCPServerViewerUserIds(entries: MCPServerViewerPrincipal[]): Promise<string[]>;
  /**
   * Creates a server with a name derived from its title (or a random one without), retrying
   * when a concurrent create takes the name.
   */
  createMCPServer(data: {
    config: MCPOptions;
    author: IdLike;
    reservedServerNames?: Iterable<string>;
  }): Promise<MCPServerDocument>;
  /** The server named `serverName`, or `null`. */
  findMCPServerByServerName(serverName: string): Promise<MCPServerDocument | null>;
  /** The server with this id, or `null`. */
  findMCPServerByObjectId(_id: IdLike): Promise<MCPServerDocument | null>;
  /**
   * A page of the servers with these ids (none without ids) that also match `otherParams`, most
   * recently updated first (ties by id): `limit` servers (clamped to 1..100) after the cursor
   * `after` with `has_more` and the next cursor, or every match with `limit` `null` or absent.
   * An unreadable cursor is ignored.
   */
  getListMCPServersByIds(params: {
    ids?: IdLike[];
    otherParams?: StoreFilter;
    limit?: number | null;
    after?: string | null;
  }): Promise<{ data: MCPServerDocument[]; has_more: boolean; after: string | null }>;
  /** The servers with these names that exist. */
  getListMCPServersByNames(params: { names: string[] }): Promise<{ data: MCPServerDocument[] }>;
  /** Sets the server's config; resolves to it updated, or `null`. */
  updateMCPServer(
    serverName: string,
    updateData: { config?: MCPOptions },
  ): Promise<MCPServerDocument | null>;
  /** Deletes the server and resolves to it, or `null`; its ACL entries are left to the caller. */
  deleteMCPServer(serverName: string): Promise<MCPServerDocument | null>;
}

/** Every method of {@link MCPServerStore}, for adapters and conformance checks. */
export const MCP_SERVER_STORE_METHODS: ReadonlyArray<keyof MCPServerStore> =
  listPortMethods<MCPServerStore>({
    findUserErasableMCPServers: true,
    deleteMCPServersWithAcl: true,
    findMCPServerOAuthTokenUserIds: true,
    findMCPServerViewerEntries: true,
    findMCPServerViewerUserIds: true,
    createMCPServer: true,
    findMCPServerByServerName: true,
    findMCPServerByObjectId: true,
    getListMCPServersByIds: true,
    getListMCPServersByNames: true,
    updateMCPServer: true,
    deleteMCPServer: true,
  });

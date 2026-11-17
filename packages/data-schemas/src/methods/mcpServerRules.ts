/**
 * The MCP server store's database-neutral rules (`MCPServerStore`, `~/ports/mcpServer`), shared by
 * every backend: the MongoDB methods (`./mcpServer`) and the PostgreSQL store
 * (`adapters/postgres/stores/mcpServer.ts`). The server name allocation and the create's retry
 * loop are written once here on the storage steps of {@link MCPServerCreateSteps}; the rest are
 * the listing's limit and cursor, the OAuth credential identifiers of a server, the viewer
 * principals' split into users and groups, and the account-erasure assembly. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import { nanoid } from 'nanoid';
import { PrincipalType, normalizeServerName } from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { ErasableMCPServer, MCPServerDocument, MCPServerViewerPrincipal } from '~/types/mcp';
import logger from '~/config/winston';

/** The page size of a listing whose limit is not a number. */
export const MCP_SERVER_PAGE_DEFAULT = 20;
const MAX_CREATE_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 25;

/** A 24-hex id, as group principals and group members are matched. */
export const MCP_OBJECT_ID_PATTERN: RegExp = /^[a-f\d]{24}$/i;

/**
 * Escapes special regex characters in a string so they are treated literally.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a URL-friendly server name from a title.
 * Converts to lowercase, replaces spaces with hyphens, removes special characters.
 */
export function generateServerNameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Remove consecutive hyphens
    .replace(/^-|-$/g, ''); // Trim leading/trailing hyphens

  return slug || 'mcp-server'; // Fallback if empty
}

/** The names `baseName` and `baseName-N` (case-sensitive), which the allocation numbers past. */
export function serverNamePattern(baseName: string): RegExp {
  return new RegExp(`^${escapeRegex(baseName)}(-\\d+)?$`);
}

/**
 * The next available name for `baseName`: itself when neither a stored name (`storedNames`, the
 * names matching {@link serverNamePattern}) nor a reserved one takes it, otherwise `baseName-N`
 * past the highest number taken.
 */
export function nextAvailableServerName(
  baseName: string,
  storedNames: readonly string[],
  reservedServerNames: Set<string> = new Set(),
): string {
  const matchingNamePattern = serverNamePattern(baseName);
  const existingNames = new Set([
    ...storedNames,
    ...Array.from(reservedServerNames).filter((serverName) => matchingNamePattern.test(serverName)),
  ]);

  if (existingNames.size === 0) {
    return baseName;
  }

  // Extract numbers from existing names
  const numbers = Array.from(existingNames).map((serverName) => {
    const match = serverName.match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : 1;
  });

  const maxNumber = Math.max(...numbers);
  return `${baseName}-${maxNumber + 1}`;
}

/** The storage steps of {@link createMCPServerOnSteps}. */
export interface MCPServerCreateSteps {
  /** The stored server names matching `pattern` (in the active tenant). */
  findServerNames(pattern: RegExp): Promise<string[]>;
  /** Inserts the server; rejects with a duplicate-key error when its name is taken. */
  insert(document: {
    serverName: string;
    normalizedServerName: string;
    config: MCPOptions;
    author: unknown;
  }): Promise<MCPServerDocument>;
  /** Whether `error` is the backend's duplicate-key error. */
  isDuplicateKey(error: unknown): boolean;
}

/**
 * Create a new MCP server with retry logic for handling race conditions.
 * When multiple requests try to create servers with the same title simultaneously,
 * they may get the same serverName from the name allocation before any
 * creates the record (TOCTOU race condition). This is handled by retrying with
 * exponential backoff when a duplicate key error occurs.
 */
export async function createMCPServerOnSteps(
  steps: MCPServerCreateSteps,
  data: { config: MCPOptions; author: unknown; reservedServerNames?: Iterable<string> },
): Promise<MCPServerDocument> {
  let lastError: unknown;
  const reservedServerNames = new Set(data.reservedServerNames ?? []);

  for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
    try {
      // Generate serverName from title, with fallback to nanoid if no title
      // Important: regenerate on each attempt to get fresh available name
      let serverName: string;
      if (data.config.title) {
        const baseSlug = generateServerNameFromTitle(data.config.title);
        const storedNames = await steps.findServerNames(serverNamePattern(baseSlug));
        serverName = nextAvailableServerName(baseSlug, storedNames, reservedServerNames);
      } else {
        serverName = `mcp-${nanoid(16)}`;
      }

      return await steps.insert({
        serverName,
        normalizedServerName: normalizeServerName(serverName),
        config: data.config,
        author: data.author,
      });
    } catch (error) {
      lastError = error;

      // Only retry on duplicate key errors (serverName collision)
      if (steps.isDuplicateKey(error) && attempt < MAX_CREATE_RETRIES - 1) {
        // Exponential backoff: 10ms, 20ms, 40ms
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.debug(
          `[createMCPServer] Duplicate serverName detected, retrying (attempt ${attempt + 2}/${MAX_CREATE_RETRIES}) after ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Not a duplicate key error or out of retries - throw immediately
      throw error;
    }
  }

  // Should not reach here, but TypeScript requires a return
  throw lastError;
}

/**
 * The page size of a listing: `null` (no paging) for a `null` or absent limit, otherwise the limit
 * clamped to 1..100, a limit that is not a number (`0` included) giving the default page.
 */
export function mcpServerPageLimit(limit: number | null | undefined): number | null {
  const isPaginated = limit !== null && limit !== undefined;
  return isPaginated
    ? Math.min(Math.max(1, parseInt(String(limit)) || MCP_SERVER_PAGE_DEFAULT), 100)
    : null;
}

/** The listing's cursor after the record (its update time and id). */
export function encodeMCPServerCursor(updatedAt: unknown, _id: unknown): string {
  return Buffer.from(JSON.stringify({ updatedAt, _id })).toString('base64');
}

/** The update time and id a cursor holds, as written; throws for an unreadable cursor. */
export function decodeMCPServerCursor(after: string): { updatedAt: unknown; _id: unknown } {
  const { updatedAt, _id } = JSON.parse(Buffer.from(after, 'base64').toString('utf8'));
  return { updatedAt, _id };
}

/** The identifiers of a server's OAuth credential records (the token, client and refresh). */
export function mcpServerOAuthIdentifiers(serverName: string): string[] {
  const identifier = `mcp:${serverName}`;
  return [identifier, `${identifier}:client`, `${identifier}:refresh`];
}

/**
 * The users a server's view principals name directly, and the groups (by 24-hex id) they name;
 * role and public principals are not enumerated.
 */
export function splitMCPServerViewerPrincipals(entries: readonly MCPServerViewerPrincipal[]): {
  userIds: Set<string>;
  groupIds: Set<string>;
} {
  const userIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const entry of entries) {
    const principalId = entry.principalId?.toString();
    if (!principalId) {
      continue;
    }
    if (entry.principalType === PrincipalType.USER) {
      userIds.add(principalId);
    } else if (
      entry.principalType === PrincipalType.GROUP &&
      MCP_OBJECT_ID_PATTERN.test(principalId)
    ) {
      groupIds.add(principalId);
    }
  }
  return { userIds, groupIds };
}

/** A server as the account-erasure read lists it. */
interface ServerName {
  _id: { toString(): string };
  serverName: string;
}

/**
 * The account-erasure result: the sole-owned servers found, then the legacy servers the user
 * authored that no ACL entry names yet (`migratedIds`, as strings), then the sole-owned ids whose
 * server is gone, with an empty name so their ACL entries still get cleaned.
 */
export function assembleErasableMCPServers(input: {
  soleOwnedIds: ReadonlyArray<{ toString(): string }>;
  aclOwnedServers: readonly ServerName[];
  authoredServers: readonly ServerName[];
  migratedIds: ReadonlySet<string>;
}): ErasableMCPServer[] {
  const legacyServers = input.authoredServers.filter(
    (s) => !input.migratedIds.has(s._id.toString()),
  );
  const found = new Set(input.aclOwnedServers.map((s) => s._id.toString()));
  const residual = input.soleOwnedIds
    .filter((id) => !found.has(id.toString()))
    .map((id) => ({ id: id.toString(), serverName: '' }));
  return [
    ...[...input.aclOwnedServers, ...legacyServers].map((s) => ({
      id: s._id.toString(),
      serverName: s.serverName,
    })),
    ...residual,
  ];
}

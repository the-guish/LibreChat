/**
 * The PostgreSQL `MCPAuthorityStore` (`~/ports/mcpAuthority`): MCP authority proofs, resolved and
 * asserted by the shared rules (`createMCPAuthorityOnSnapshot`, `~/methods/mcpAuthorityRules`) on
 * the reads of one snapshot. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The snapshot is one `REPEATABLE READ, READ ONLY` transaction (`context.transactions`, its first
 * statement `SET TRANSACTION`), so every read of the proof (the user, groups, role, config
 * documents, servers, agents, ACL entries, plugin credentials and OAuth tokens) sees one
 * consistent state of the database, as MongoDB's snapshot transaction does. Each read is a
 * primitive `find`/`count` on that transaction in document mode (scoped to the active tenant, plus
 * the proof's own tenant condition), with the projections and bounds of the MongoDB reads; the two
 * MongoDB aggregations (the config documents with their `mcpSettings` override and tombstones, and
 * the agents' links narrowed to the selected servers) are a `find` shaped in JavaScript into the
 * same one-batch result. Any failure that is not an `MCPAuthorityProofError` becomes
 * `proof_unavailable`.
 */
import { sql } from 'kysely';
import { PrincipalType, ResourceType } from 'librechat-data-provider';
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
  AuthorityAclSelection,
  MCPAuthoritySnapshotReads,
  AuthorityTokenSelector,
  AuthorityCredentialSelector,
} from '~/methods/mcpAuthorityRules';
import type { MCPAuthorityStore } from '~/ports/mcpAuthority';
import type { PgFilter, PgRecord } from '../collection';
import type { StoreTransaction } from '~/ports/common';
import type { PostgresStoreContext } from './context';
import { createMCPAuthorityOnSnapshot } from '~/methods/mcpAuthorityRules';
import { postgresStoreIds } from '../storeIds';
import { runStoreSql } from './context';

/** The proof's own tenant condition: the tenant, or records without one. */
const tenantScope = (tenantId: string | undefined): PgFilter =>
  tenantId === undefined ? { tenantId: { $exists: false } } : { tenantId };

/** One batch of rows, as a MongoDB `$group` returns it (none for no rows). */
const batchOf = <T>(rows: T[]): AggregateBatch<T>[] =>
  rows.length === 0 ? [] : [{ rows, count: rows.length }];

const credentialFilter = (
  userId: string,
  selectors: readonly AuthorityCredentialSelector[],
  tenantId: string | undefined,
): PgFilter => ({
  userId,
  ...tenantScope(tenantId),
  $or:
    selectors.length > 0
      ? selectors.map((selector) => ({
          pluginKey: selector.pluginKey,
          authField: { $in: [...selector.authFields] },
        }))
      : [{ _id: null }],
});

const tokenFilter = (
  userId: string,
  selectors: readonly AuthorityTokenSelector[],
  tenantId: string | undefined,
): PgFilter => ({
  userId,
  ...tenantScope(tenantId),
  $or: selectors.length > 0 ? selectors.map((selector) => ({ ...selector })) : [{ _id: null }],
});

const aclFilter = (selection: AuthorityAclSelection, tenantId: string | undefined): PgFilter => {
  const principals: PgFilter[] = [
    { principalType: PrincipalType.USER, principalId: selection.userId },
    { principalType: PrincipalType.ROLE, principalId: selection.roleName },
    { principalType: PrincipalType.PUBLIC },
    ...selection.groupIds.map((groupId) => ({
      principalType: PrincipalType.GROUP,
      principalId: String(groupId),
    })),
  ];
  const resources: PgFilter[] = [];
  if (selection.serverIds.length > 0) {
    resources.push({
      resourceType: ResourceType.MCPSERVER,
      resourceId: { $in: selection.serverIds.map(String) },
    });
  }
  if (selection.agentIds.length > 0) {
    resources.push({
      resourceType: ResourceType.AGENT,
      resourceId: { $in: selection.agentIds.map(String) },
    });
  }
  return { $and: [tenantScope(tenantId), { $or: principals }, { $or: resources }] };
};

const serverFilter = (
  serverNames: readonly string[],
  normalizedNames: readonly string[],
  tenantId: string | undefined,
): PgFilter => ({
  ...tenantScope(tenantId),
  $or: [
    { serverName: { $in: [...serverNames] } },
    { normalizedServerName: { $in: [...normalizedNames] } },
  ],
});

/** A config document's `mcpSettings` override, as the aggregation projects `$overrides.mcpSettings`. */
function mcpSettingsOverride(overrides: unknown): object | undefined {
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(overrides, 'mcpSettings')
    ? ((overrides as Record<string, unknown>).mcpSettings as object)
    : undefined;
}

/** The reads of one snapshot, on the transaction `tx`. */
function snapshotReads(
  context: PostgresStoreContext,
  tx: StoreTransaction,
): MCPAuthoritySnapshotReads {
  const collection = <T>(name: string) => context.collections().collection<T & PgRecord>(name);
  const groupFilter = (memberId: string, tenantId: string | undefined): PgFilter => ({
    memberIds: memberId,
    ...tenantScope(tenantId),
  });

  return {
    user: (userId, tenantId) =>
      collection<UserProjection>('users').findOne(
        { _id: userId, ...tenantScope(tenantId) },
        {
          projection:
            '_id tenantId role provider idOnTheSource openidIssuer googleId facebookId openidId samlId ldapId githubId discordId appleId createdAt updatedAt',
          tx,
        },
      ),
    groupCount: (memberId, tenantId, limit) =>
      collection('groups').count(groupFilter(memberId, tenantId), { limit, tx }),
    groups: (memberId, tenantId, limit) =>
      collection<GroupProjection>('groups').find(groupFilter(memberId, tenantId), {
        projection: '_id source idOnTheSource createdAt updatedAt',
        limit,
        tx,
      }),
    role: (name, tenantId) =>
      collection<RoleProjection>('roles').findOne(
        { name, ...tenantScope(tenantId) },
        { projection: '_id name permissions.MCP_SERVERS.USE', tx },
      ),
    async configs(slots, tenantId, limit, tombstoneLimit) {
      const documents = await collection('configs').find(
        { $and: [tenantScope(tenantId), { $or: slots.map((slot) => ({ ...slot })) }] },
        {
          projection:
            '_id principalType principalId priority isActive configVersion updatedAt overrides tombstones',
          limit,
          tx,
        },
      );
      return batchOf(
        documents.map(({ overrides, tombstones, ...document }): ConfigProjection => {
          const override = mcpSettingsOverride(overrides);
          return {
            ...(document as unknown as ConfigProjection),
            ...(override === undefined ? {} : { mcpSettingsOverride: override }),
            tombstones: ((tombstones as string[] | null | undefined) ?? [])
              .filter((path) => path === 'mcpSettings' || path.startsWith('mcpSettings.'))
              .slice(0, tombstoneLimit),
          };
        }),
      );
    },
    serverCount: (serverNames, normalizedNames, tenantId, limit) =>
      collection('mcpservers').count(serverFilter(serverNames, normalizedNames, tenantId), {
        limit,
        tx,
      }),
    servers: (serverNames, normalizedNames, tenantId, limit) =>
      collection<ServerProjection>('mcpservers').find(
        serverFilter(serverNames, normalizedNames, tenantId),
        {
          projection: '_id serverName normalizedServerName config author createdAt updatedAt',
          limit,
          tx,
        },
      ),
    async agents(serverNames, tenantId, limit) {
      const names = new Set(serverNames);
      const agents = await collection<AgentProjection>('agents').find(
        { mcpServerNames: { $in: [...serverNames] }, ...tenantScope(tenantId) },
        { projection: '_id id createdAt updatedAt mcpServerNames', limit, tx },
      );
      return batchOf(
        agents.map((agent) => ({
          ...agent,
          mcpServerNames: (agent.mcpServerNames ?? []).filter((name) => names.has(name)),
        })),
      );
    },
    credentialCount: (userId, selectors, tenantId, limit) =>
      collection('pluginauths').count(credentialFilter(userId, selectors, tenantId), {
        limit,
        tx,
      }),
    credentials: (userId, selectors, tenantId, limit) =>
      collection<PluginAuthProjection>('pluginauths').find(
        credentialFilter(userId, selectors, tenantId),
        { projection: '_id pluginKey authField value createdAt updatedAt', limit, tx },
      ),
    tokenCount: (userId, selectors, tenantId, limit) =>
      collection('tokens').count(tokenFilter(userId, selectors, tenantId), { limit, tx }),
    tokens: (userId, selectors, tenantId, limit) =>
      collection<TokenProjection>('tokens').find(tokenFilter(userId, selectors, tenantId), {
        projection: '_id type identifier token metadata createdAt expiresAt',
        limit,
        tx,
      }),
    aclCount: (selection, tenantId, limit) =>
      collection('aclentries').count(aclFilter(selection, tenantId), { limit, tx }),
    aclEntries: (selection, tenantId, limit) =>
      collection<AclProjection>('aclentries').find(aclFilter(selection, tenantId), {
        projection:
          '_id principalType principalId resourceType resourceId permBits expiredAt updatedAt',
        limit,
        tx,
      }),
  };
}

export function createPostgresMCPAuthorityStore(context: PostgresStoreContext): MCPAuthorityStore {
  return createMCPAuthorityOnSnapshot({
    isValidId: (id) => postgresStoreIds.isValid(id),
    runSnapshot: (read) =>
      context.transactions.transaction(async (tx) => {
        if (tx === undefined) {
          throw new Error('PostgreSQL always runs transactions');
        }
        await runStoreSql(
          context,
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
          tx,
        );
        return read(snapshotReads(context, tx));
      }),
  });
}

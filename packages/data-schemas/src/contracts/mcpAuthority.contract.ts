/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `MCPAuthorityStore` contract (`~/ports/mcpAuthority`), ported from
 * `methods/mcpAuthority.spec.ts`: a proof resolved from one snapshot of the user, role, groups,
 * config overrides, MCP servers, agents, ACL entries, plugin credentials and OAuth tokens (its
 * shape, the per-server direct and agent access, the credential fields and OAuth generation the
 * store derives whatever the caller claims), the fail-closed rules (no exact tenant context, a
 * foreign tenant's role, the bounded proof shape and row counts), the malformed inputs (target
 * sources, the target bound, mutated proofs, normalized name collisions within and across
 * proofs), the sources that changed between the caller's parse and the resolve (server, config,
 * credential, OAuth grant) and, for `assertMCPAuthorityProofsCurrent`, every authority change
 * after the proof, each made through the store that owns it, rejected with its reason.
 *
 * The method runs its own snapshot transaction (no port method takes a `StoreTransaction`), so
 * the MongoDB runner uses a one-member replica set. Not here (they stay in the method spec): the
 * session, read-concern and query-count spies, a caller-supplied session, the namespace
 * preflight and its retry cooldown, the injected-hook race between snapshot phases, and the
 * moves of a record to another tenant (no store writes those). The revision helpers are the
 * package's own (`createMCPAuthority*Revision`, the ones `@librechat/api` computes its targets
 * with), fed from the raw records. Nothing here may import `mongoose` or the MongoDB driver.
 */
import {
  Permissions,
  PrincipalType,
  ResourceType,
  PrincipalModel,
  PermissionBits,
  PermissionTypes,
} from 'librechat-data-provider';
import type { MCPOptions } from 'librechat-data-provider';
import type { MCPAuthorityConfigSourceDocument } from '~/methods/mcpAuthority';
import type { MCPAuthorityProofV1, MCPAuthorityTargetInput } from '~/types';
import type { ContractHarness, RawRecord } from './harness';
import {
  MCPAuthorityProofError,
  createMCPAuthorityBootRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityConfigSourceRevision,
  createMCPAuthorityDatabaseSourceRevision,
} from '~/methods/mcpAuthority';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { tenantStorage } from '~/config/tenantContext';
import { useContractHarness } from './support';

const TENANT_ID = 'tenant-authority';
const USER_ROLE = 'MCP_USER';
const SERVER_NAME = 'selected-server';
const PLUGIN_KEY = `mcp_${SERVER_NAME}`;
const SEEDED_AT = new Date('2026-07-01T00:00:00.000Z');
const immutableConfig = {
  mcpServers: {
    'operator-server': { type: 'sse' as const, url: 'https://operator.example/mcp' },
  },
  mcpSettings: { allowedDomains: ['operator.example'] },
};
const boot = createMCPAuthorityBootRevision('boot-1', immutableConfig);
const EMPTY_CREDENTIAL_REVISION = createMCPAuthorityCredentialRevision([], []);

/** The error a store method rejected with, or a failure when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject');
}

export function describeMCPAuthorityContract(harness: ContractHarness): void {
  describe(`MCPAuthorityStore contract: ${harness.name}`, () => {
    useContractHarness(harness);
    jest.setTimeout(60_000);

    const stores = () => harness.createStores();
    const authority = () => stores().mcpAuthorities;
    const newId = () => harness.ids.generate();
    const storeId = (id: string) => harness.ids.toStoreId(id);

    let userId: string;
    let groupId: string;
    let serverId: string;
    let serverSourceRevision: string;
    let credentialSourceRevision: string;

    const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId: TENANT_ID, userId }, run);
    const tenanted = (record: RawRecord): RawRecord => ({ ...record, tenantId: TENANT_ID });

    const oauthTokens = (generation: string, serverName = SERVER_NAME): RawRecord[] =>
      [
        ['mcp_oauth', `mcp:${serverName}`],
        ['mcp_oauth_refresh', `mcp:${serverName}:refresh`],
        ['mcp_oauth_client', `mcp:${serverName}:client`],
      ].map(([type, identifier]) =>
        tenanted({
          _id: newId(),
          userId,
          type,
          identifier,
          token: `${type}-secret`,
          metadata: { credential_set_id: generation },
          createdAt: SEEDED_AT,
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      );

    /** The database server's source revision, from its stored record. */
    const serverRevisionOf = async (id: string): Promise<string> => {
      const server = (await harness.readRaw('mcpservers')).find((row) => row._id === id);
      if (server == null) {
        throw new Error(`No stored server ${id}`);
      }
      return createMCPAuthorityDatabaseSourceRevision({
        databaseId: id,
        serverName: server.serverName as string,
        author: server.author as string,
        config: server.config as MCPOptions,
        createdAt: server.createdAt as Date,
        updatedAt: server.updatedAt as Date,
      });
    };

    /** The credential revision of the stored `API_KEY` credential. */
    const credentialRevisionOf = async (): Promise<string> => {
      const credentials = (await harness.readRaw('pluginauths')).filter(
        (row) => row.pluginKey === PLUGIN_KEY && row.userId === userId,
      );
      return createMCPAuthorityCredentialRevision(
        ['API_KEY'],
        credentials.map((row) => ({
          _id: row._id as string,
          authField: row.authField as string,
          value: row.value as string,
          createdAt: row.createdAt as Date,
          updatedAt: row.updatedAt as Date,
        })),
      );
    };

    /** The config source revision of the user's stored config documents. */
    const configRevisionOf = async (): Promise<string> => {
      const principals = new Set([
        `${PrincipalType.ROLE}:${BASE_CONFIG_PRINCIPAL_ID}`,
        `${PrincipalType.ROLE}:${USER_ROLE}`,
        `${PrincipalType.GROUP}:${groupId}`,
        `${PrincipalType.USER}:${userId}`,
      ]);
      const configs = (await harness.readRaw('configs')).filter(
        (row) =>
          row.tenantId === TENANT_ID && principals.has(`${row.principalType}:${row.principalId}`),
      );
      return createMCPAuthorityConfigSourceRevision(
        boot.digest,
        configs as unknown as MCPAuthorityConfigSourceDocument[],
      );
    };

    /**
     * The fixture of the method spec, raw: an OpenID user of the tenant with a role allowing MCP
     * use, an external group holding the user, a user config override, one database server the
     * user may view directly, its custom credential and its three OAuth records.
     */
    const seedFixture = async (options: { tombstones?: string[] } = {}): Promise<void> => {
      userId = newId();
      groupId = newId();
      serverId = newId();
      await harness.seedRaw('users', [
        tenanted({
          _id: userId,
          email: 'authority@example.com',
          emailVerified: true,
          provider: 'openid',
          role: USER_ROLE,
          idOnTheSource: 'source-user-1',
          openidId: 'openid-user-1',
          openidIssuer: 'https://issuer.example',
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        }),
      ]);
      await harness.seedRaw('roles', [
        tenanted({
          _id: newId(),
          name: USER_ROLE,
          permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } },
        }),
      ]);
      await harness.seedRaw('groups', [
        tenanted({
          _id: groupId,
          name: 'MCP group',
          source: 'entra',
          idOnTheSource: 'source-group-1',
          memberIds: ['source-user-1'],
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        }),
      ]);
      await harness.seedRaw('mcpservers', [
        tenanted({
          _id: serverId,
          serverName: SERVER_NAME,
          normalizedServerName: SERVER_NAME,
          config: { type: 'sse', url: `https://${SERVER_NAME}.example/mcp` },
          author: userId,
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        }),
      ]);
      await harness.seedRaw('configs', [
        tenanted({
          _id: newId(),
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          priority: 30,
          overrides: { mcpServers: { [SERVER_NAME]: { startup: false } } },
          tombstones: options.tombstones ?? [],
          isActive: true,
          configVersion: 1,
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        }),
      ]);
      await harness.seedRaw('pluginauths', [
        tenanted({
          _id: newId(),
          userId,
          pluginKey: PLUGIN_KEY,
          authField: 'API_KEY',
          value: 'secret-generation-1',
          createdAt: SEEDED_AT,
          updatedAt: SEEDED_AT,
        }),
      ]);
      await harness.seedRaw('tokens', oauthTokens('oauth-generation-1'));
      await inTenant(() =>
        stores().aclEntries.grantPermission(
          PrincipalType.USER,
          storeId(userId),
          ResourceType.MCPSERVER,
          storeId(serverId),
          PermissionBits.VIEW,
          storeId(userId),
        ),
      );
      serverSourceRevision = await serverRevisionOf(serverId);
      credentialSourceRevision = await credentialRevisionOf();
    };

    beforeEach(() => seedFixture());

    const target = (
      overrides: Partial<{
        serverName: string;
        databaseId: string;
        sourceRevision: string;
        expectedOAuthGrantGeneration: string | null;
        expectedCredentialRevision: string;
      }> = {},
    ): MCPAuthorityTargetInput => {
      const serverName = overrides.serverName ?? SERVER_NAME;
      return {
        serverName,
        source: 'database',
        databaseId: overrides.databaseId ?? serverId,
        sourceRevision: overrides.sourceRevision ?? serverSourceRevision,
        expectedCredentialRevision:
          overrides.expectedCredentialRevision ?? credentialSourceRevision,
        expectedOAuthGrantGeneration:
          'expectedOAuthGrantGeneration' in overrides
            ? (overrides.expectedOAuthGrantGeneration ?? null)
            : 'oauth-generation-1',
        resolvedConfig: {
          type: 'sse',
          url: `https://${serverName}.example/mcp`,
          customUserVars: { API_KEY: { title: 'API key', description: 'Credential' } },
        },
        requiresOAuth: true,
      };
    };
    const configTarget = (
      serverName: string,
      sourceRevision: string,
      resolvedConfig: MCPOptions = { type: 'sse', url: `https://${serverName}.example/mcp` },
    ): MCPAuthorityTargetInput => ({
      serverName,
      source: 'config',
      sourceRevision,
      expectedCredentialRevision: EMPTY_CREDENTIAL_REVISION,
      expectedOAuthGrantGeneration: null,
      resolvedConfig,
    });

    const resolve = (targets: readonly MCPAuthorityTargetInput[] = [target()]) =>
      inTenant(() =>
        authority().resolveMCPAuthorityProof({ userId, tenantId: TENANT_ID, boot, targets }),
      );
    const assertCurrent = (proofs: MCPAuthorityProofV1 | readonly MCPAuthorityProofV1[]) =>
      inTenant(() => authority().assertMCPAuthorityProofsCurrent({ proofs, boot }));
    /** Resolves to the rejection reason of `promise`. */
    const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
      const error = await rejectionOf(promise);
      expect(error).toBeInstanceOf(MCPAuthorityProofError);
      return (error as MCPAuthorityProofError).reason;
    };

    /* ------------------------------------------------------------------ resolve */

    describe('resolveMCPAuthorityProof', () => {
      it('resolves one immutable proof of the shared authority and each server', async () => {
        const proof = await resolve();
        expect(proof.version).toBe(1);
        expect(Object.isFrozen(proof)).toBe(true);
        expect(Object.isFrozen(proof.shared)).toBe(true);
        expect(Object.isFrozen(proof.servers)).toBe(true);
        expect(proof.shared.user).toMatchObject({
          userId,
          tenantId: TENANT_ID,
          role: USER_ROLE,
          provider: 'openid',
        });
        expect(proof.shared.role).toMatchObject({ name: USER_ROLE, use: true });
        expect(proof.shared.groups.map((group) => group.id)).toEqual([groupId]);
        expect(proof.shared.configs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              principalType: PrincipalType.USER,
              principalId: userId,
              present: true,
              active: true,
              configVersion: 1,
            }),
          ]),
        );
        expect(proof.shared.boot).toEqual(boot);
        expect(proof.servers).toHaveLength(1);
        expect(proof.servers[0]).toMatchObject({
          serverName: SERVER_NAME,
          source: 'database',
          databaseId: serverId,
          sourceRevision: serverSourceRevision,
          directAccess: true,
          agentAccess: false,
          linkedAgentIds: [],
          credentialFields: ['API_KEY'],
          requiresOAuth: true,
          oauthGrantGeneration: 'oauth-generation-1',
        });
        expect(JSON.stringify(proof)).not.toContain('secret');
        await expect(assertCurrent(proof)).resolves.toBeUndefined();
      });

      it('resolves the same revisions from an unchanged snapshot', async () => {
        const [first, second] = [await resolve(), await resolve()];
        expect(second.revision).toBe(first.revision);
        expect(second.shared.revision).toBe(first.shared.revision);
      });

      it('fails closed without the exact tenant context', async () => {
        const input = { userId, tenantId: TENANT_ID, boot, targets: [target()] };
        expect(await reasonOf(authority().resolveMCPAuthorityProof(input))).toBe(
          'proof_unavailable',
        );
        expect(
          await reasonOf(
            tenantStorage.run({ tenantId: 'different-tenant' }, () =>
              authority().resolveMCPAuthorityProof(input),
            ),
          ),
        ).toBe('proof_unavailable');
      });

      it('does not use a foreign tenant role for a tenantless principal', async () => {
        const tenantlessUserId = newId();
        const roleName = 'TENANTLESS_AUTHORITY_USER';
        await harness.seedRaw('users', [
          {
            _id: tenantlessUserId,
            email: 'tenantless-authority@example.com',
            provider: 'local',
            role: roleName,
          },
        ]);
        await harness.seedRaw('roles', [
          {
            _id: newId(),
            name: roleName,
            tenantId: 'foreign-tenant',
            permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } },
          },
        ]);
        expect(
          await reasonOf(
            authority().resolveMCPAuthorityProof({
              userId: tenantlessUserId,
              boot,
              targets: [configTarget('tenantless-config', 'tenantless-source-revision')],
            }),
          ),
        ).toBe('role_changed');
      });

      it('rejects malformed targets before reading authority', async () => {
        expect(
          await reasonOf(
            resolve([{ ...target(), source: 'DATABASE' } as unknown as MCPAuthorityTargetInput]),
          ),
        ).toBe('malformed_input');
        expect(
          await reasonOf(
            resolve(
              Array.from({ length: 33 }, (_, index) =>
                configTarget(`config-${index}`, 'bounded-source-revision'),
              ),
            ),
          ),
        ).toBe('malformed_input');
      });

      it('fails closed on a stored server whose normalized name collides with a target', async () => {
        await harness.seedRaw('mcpservers', [
          tenanted({
            _id: newId(),
            serverName: 'selected/server',
            normalizedServerName: 'selected_server',
            config: { type: 'sse', url: 'https://collision.example/mcp' },
            author: userId,
            createdAt: SEEDED_AT,
            updatedAt: SEEDED_AT,
          }),
        ]);
        const sourceRevision = await configRevisionOf();
        expect(
          await reasonOf(
            resolve([
              configTarget('selected server', sourceRevision, {
                type: 'sse',
                url: 'https://operator.example/mcp',
              }),
            ]),
          ),
        ).toBe('server_changed');
      });

      it('rejects a database server changed since the caller read it', async () => {
        const stale = target();
        await inTenant(() =>
          stores().mcpServers.updateMCPServer(SERVER_NAME, {
            config: { type: 'sse', url: 'https://changed-before-proof.example/mcp' },
          }),
        );
        expect(await reasonOf(resolve([stale]))).toBe('server_changed');
        const current = await resolve([
          target({ sourceRevision: await serverRevisionOf(serverId) }),
        ]);
        expect(current.servers[0].sourceRevision).not.toBe(serverSourceRevision);
      });

      it('derives the credential fields and OAuth requirement whatever the target claims', async () => {
        const credentialProof = await resolve([{ ...target(), credentialFields: [] }]);
        expect(credentialProof.servers[0].credentialFields).toEqual(['API_KEY']);
        const base = target();
        const oauthProof = await resolve([
          { ...base, requiresOAuth: false, resolvedConfig: { ...base.resolvedConfig, oauth: {} } },
        ]);
        expect(oauthProof.servers[0].requiresOAuth).toBe(true);
      });

      it('rejects a credential, then an OAuth grant, rotated since the caller read them', async () => {
        const stale = target();
        await inTenant(() =>
          stores().pluginAuths.updatePluginAuth({
            userId,
            authField: 'API_KEY',
            pluginKey: PLUGIN_KEY,
            value: 'rotated-before-proof',
          }),
        );
        await inTenant(() => stores().tokens.deleteTokens({ userId: storeId(userId) }));
        await harness.seedRaw('tokens', oauthTokens('rotated-before-proof'));
        expect(await reasonOf(resolve([stale]))).toBe('credential_changed');
        const currentCredential = target({
          expectedCredentialRevision: await credentialRevisionOf(),
        });
        expect(await reasonOf(resolve([currentCredential]))).toBe('oauth_grant_changed');
        const current = await resolve([
          target({
            expectedCredentialRevision: await credentialRevisionOf(),
            expectedOAuthGrantGeneration: 'rotated-before-proof',
          }),
        ]);
        expect(current.servers[0].oauthGrantGeneration).toBe('rotated-before-proof');
      });

      it('rejects a config override changed since the caller read it', async () => {
        const stale = await configRevisionOf();
        await inTenant(() =>
          stores().configOverrides.toggleConfigActive(PrincipalType.USER, userId, false),
        );
        const operator = immutableConfig.mcpServers['operator-server'];
        expect(await reasonOf(resolve([configTarget('operator-server', stale, operator)]))).toBe(
          'config_changed',
        );
        const current = await resolve([
          configTarget('operator-server', await configRevisionOf(), operator),
        ]);
        expect(current.servers[0]).toMatchObject({ source: 'config', databaseId: null });
      });

      it('proves no OAuth generation before the first grant, and needs a new proof after it', async () => {
        await inTenant(() => stores().tokens.deleteTokens({ userId: storeId(userId) }));
        const before = await resolve([target({ expectedOAuthGrantGeneration: null })]);
        expect(before.servers[0].oauthGrantGeneration).toBeNull();
        await harness.seedRaw('tokens', oauthTokens('oauth-first-install'));
        expect(await reasonOf(assertCurrent(before))).toBe('oauth_grant_changed');
        const after = await resolve([
          target({ expectedOAuthGrantGeneration: 'oauth-first-install' }),
        ]);
        expect(after.servers[0].oauthGrantGeneration).toBe('oauth-first-install');
        await expect(assertCurrent(after)).resolves.toBeUndefined();
      });

      it('keys OAuth grants by token type and identifier, not by identifier prefix', async () => {
        const sourceRevision = await configRevisionOf();
        await harness.seedRaw('tokens', [
          tenanted({
            _id: newId(),
            userId,
            type: 'mcp_oauth_refresh',
            identifier: 'mcp:foo:refresh',
            token: 'unselected-refresh-token',
            metadata: { credential_set_id: 'unselected-foo' },
            createdAt: SEEDED_AT,
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
        ]);
        const selected = configTarget('foo:refresh', sourceRevision, {
          type: 'sse',
          url: 'https://foo-refresh.example/mcp',
          oauth: {},
        });
        const proof = await resolve([selected]);
        expect(proof.servers[0].oauthGrantGeneration).toBeNull();
        await harness.seedRaw('tokens', [
          tenanted({
            _id: newId(),
            userId,
            type: 'mcp_oauth',
            identifier: 'mcp:foo:refresh',
            token: 'selected-access-token',
            metadata: { credential_set_id: 'selected-foo-refresh' },
            createdAt: SEEDED_AT,
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
        ]);
        const selectedProof = await resolve([
          { ...selected, expectedOAuthGrantGeneration: 'selected-foo-refresh' },
        ]);
        expect(selectedProof.servers[0].oauthGrantGeneration).toBe('selected-foo-refresh');
      });

      it('grants access through an agent the user may view, and loses it with the link', async () => {
        await inTenant(() =>
          stores().aclEntries.deleteAclEntries({
            resourceType: ResourceType.MCPSERVER,
            resourceId: storeId(serverId),
          }),
        );
        const agentId = newId();
        await harness.seedRaw('agents', [
          tenanted({
            _id: agentId,
            id: 'agent-with-selected-server',
            name: 'MCP agent',
            provider: 'openAI',
            model: 'test-model',
            author: userId,
            mcpServerNames: [SERVER_NAME],
            versions: [],
            createdAt: SEEDED_AT,
            updatedAt: SEEDED_AT,
          }),
        ]);
        await inTenant(() =>
          stores().aclEntries.grantPermission(
            PrincipalType.USER,
            storeId(userId),
            ResourceType.AGENT,
            storeId(agentId),
            PermissionBits.VIEW,
            storeId(userId),
          ),
        );
        const proof = await resolve();
        expect(proof.servers[0]).toMatchObject({
          directAccess: false,
          agentAccess: true,
          linkedAgentIds: [agentId],
        });
        await inTenant(() =>
          stores().agents.updateAgent({ id: 'agent-with-selected-server' }, { mcpServerNames: [] }),
        );
        expect(await reasonOf(assertCurrent(proof))).toBe('access_revoked');
      });

      it('fails closed past the bounded group count and config tombstones', async () => {
        await harness.seedRaw(
          'groups',
          Array.from({ length: 64 }, (_, index) =>
            tenanted({
              _id: newId(),
              name: `extra-group-${index}`,
              source: 'local',
              memberIds: ['source-user-1'],
            }),
          ),
        );
        expect(await reasonOf(resolve())).toBe('proof_unavailable');

        await harness.reset();
        await seedFixture({
          tombstones: Array.from({ length: 65 }, (_, index) => `mcpSettings.path-${index}`),
        });
        expect(await reasonOf(resolve())).toBe('proof_unavailable');
      });
    });

    /* ------------------------------------------------------------------ assert */

    describe('assertMCPAuthorityProofsCurrent', () => {
      const mutations: Array<[string, string, () => Promise<unknown>]> = [
        [
          'user deletion',
          'user_revoked',
          () => inTenant(() => stores().users.deleteUserById(userId)),
        ],
        [
          'source identity change',
          'principal_changed',
          () =>
            inTenant(() => stores().users.updateUser(userId, { idOnTheSource: 'source-user-2' })),
        ],
        [
          'group revocation',
          'groups_changed',
          () =>
            inTenant(() =>
              stores().userGroups.updateGroupById(storeId(groupId), { memberIds: [] }),
            ),
        ],
        [
          'role USE revocation',
          'mcp_use_revoked',
          () =>
            inTenant(() =>
              stores().roles.updateAccessPermissions(USER_ROLE, {
                [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: false },
              }),
            ),
        ],
        [
          'role reassignment',
          'role_changed',
          () => inTenant(() => stores().users.updateUser(userId, { role: 'REASSIGNED_ROLE' })),
        ],
        [
          'config toggle',
          'config_changed',
          () =>
            inTenant(() =>
              stores().configOverrides.toggleConfigActive(PrincipalType.USER, userId, false),
            ),
        ],
        [
          'config deletion',
          'config_changed',
          () => inTenant(() => stores().configOverrides.deleteConfig(PrincipalType.USER, userId)),
        ],
        [
          'server deletion',
          'server_revoked',
          () => inTenant(() => stores().mcpServers.deleteMCPServer(SERVER_NAME)),
        ],
        [
          'server configuration change',
          'server_changed',
          () =>
            inTenant(() =>
              stores().mcpServers.updateMCPServer(SERVER_NAME, {
                config: { type: 'sse', url: 'https://changed.example/mcp' },
              }),
            ),
        ],
        [
          'direct ACL revocation',
          'access_revoked',
          () =>
            inTenant(() =>
              stores().aclEntries.deleteAclEntries({
                resourceType: ResourceType.MCPSERVER,
                resourceId: storeId(serverId),
              }),
            ),
        ],
        [
          'view bit removal',
          'access_revoked',
          () =>
            inTenant(() =>
              stores().aclEntries.modifyPermissionBits(
                PrincipalType.USER,
                storeId(userId),
                ResourceType.MCPSERVER,
                storeId(serverId),
                null,
                PermissionBits.VIEW,
              ),
            ),
        ],
        [
          'new ACL grant',
          'authorization_changed',
          () =>
            inTenant(() =>
              stores().aclEntries.grantPermission(
                PrincipalType.GROUP,
                storeId(groupId),
                ResourceType.MCPSERVER,
                storeId(serverId),
                PermissionBits.VIEW,
                storeId(userId),
              ),
            ),
        ],
        [
          'custom credential rotation',
          'credential_changed',
          () =>
            inTenant(() =>
              stores().pluginAuths.updatePluginAuth({
                userId,
                authField: 'API_KEY',
                pluginKey: PLUGIN_KEY,
                value: 'secret-generation-2',
              }),
            ),
        ],
        [
          'custom credential deletion',
          'credential_changed',
          () =>
            inTenant(() =>
              stores().pluginAuths.deletePluginAuth({
                userId,
                authField: 'API_KEY',
                pluginKey: PLUGIN_KEY,
              }),
            ),
        ],
        [
          'OAuth grant rotation',
          'oauth_grant_changed',
          async () => {
            await inTenant(() => stores().tokens.deleteTokens({ userId: storeId(userId) }));
            await harness.seedRaw('tokens', oauthTokens('oauth-generation-2'));
          },
        ],
        [
          'OAuth grant deletion',
          'oauth_grant_changed',
          () =>
            inTenant(() =>
              stores().tokens.deleteTokens({
                userId: storeId(userId),
                type: 'mcp_oauth_refresh',
                identifier: `mcp:${SERVER_NAME}:refresh`,
              }),
            ),
        ],
      ];

      it.each(mutations)('rejects the proof after: %s (%s)', async (_name, reason, mutate) => {
        const proof = await resolve();
        await mutate();
        expect(await reasonOf(assertCurrent(proof))).toBe(reason);
      });

      it('rejects a proof resolved under another boot revision', async () => {
        const proof = await resolve();
        const nextBoot = createMCPAuthorityBootRevision('boot-2', immutableConfig);
        expect(
          await reasonOf(
            inTenant(() =>
              authority().assertMCPAuthorityProofsCurrent({ proofs: proof, boot: nextBoot }),
            ),
          ),
        ).toBe('boot_revision_changed');
      });

      it('rejects mutated proof identities and sources', async () => {
        const proof = await resolve();
        const [server] = proof.servers;
        expect(
          await reasonOf(
            assertCurrent({
              ...proof,
              servers: [{ ...server, normalizedServerName: 'unrelated_identity' }],
            }),
          ),
        ).toBe('malformed_input');
        expect(
          await reasonOf(assertCurrent({ ...proof, servers: [{ ...server, source: 'config' }] })),
        ).toBe('malformed_input');
      });

      it('rejects proofs whose server names collide once normalized', async () => {
        const sourceRevision = await configRevisionOf();
        const [space, slash] = await Promise.all([
          resolve([configTarget('alias server', sourceRevision)]),
          resolve([configTarget('alias/server', sourceRevision)]),
        ]);
        expect(await reasonOf(assertCurrent([space, slash]))).toBe('malformed_input');
      });

      it('composes separately resolved config proofs that share their revisions', async () => {
        await inTenant(() =>
          stores().configOverrides.patchConfigFields(
            PrincipalType.USER,
            userId,
            PrincipalModel.USER,
            {
              'mcpServers.config-a': { startup: false },
              'mcpServers.config-b': { startup: true },
            },
          ),
        );
        const sourceRevision = await configRevisionOf();
        const [first, second] = await Promise.all([
          resolve([configTarget('config-a', sourceRevision)]),
          resolve([configTarget('config-b', sourceRevision)]),
        ]);
        expect(first.shared.revision).toBe(second.shared.revision);
        expect(first.shared.configs.every((config) => config.mcpOverrideDigest === null)).toBe(
          true,
        );
        await expect(assertCurrent([first, second])).resolves.toBeUndefined();
      });

      it('rejects composed proofs over the target bound', async () => {
        const sourceRevision = await configRevisionOf();
        const targets = Array.from({ length: 34 }, (_, index) =>
          configTarget(`composed-${index}`, sourceRevision),
        );
        const [first, second] = await Promise.all([
          resolve(targets.slice(0, 17)),
          resolve(targets.slice(17)),
        ]);
        expect(await reasonOf(assertCurrent([first, second]))).toBe('malformed_input');
      });

      it('fails closed without the exact tenant context', async () => {
        const proof = await resolve();
        expect(
          await reasonOf(authority().assertMCPAuthorityProofsCurrent({ proofs: proof, boot })),
        ).toBe('proof_unavailable');
      });
    });
  });
}

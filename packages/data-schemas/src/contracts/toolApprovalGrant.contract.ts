/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ToolApprovalGrantStore` contract (`~/ports/toolApprovalGrant`), ported from
 * `methods/toolApprovalGrant.spec.ts`: per-chat and persistent approvals, the tool and
 * agent-wide reset fences, tenant isolation, and the OAuth epoch read from the user's MCP
 * OAuth tokens (another store's collection, seeded raw). The cases that pause a write between
 * its read and its update hook into the MongoDB driver and stay in the method spec. Nothing here
 * may import `mongoose` or the MongoDB driver.
 */
import type { ToolApprovalGrantBinding } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import { tenantStorage } from '~/config/tenantContext';
import { useContractHarness } from './support';

export function describeToolApprovalGrantContract(harness: ContractHarness): void {
  describe(`ToolApprovalGrantStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const scope = { userId: 'user-a', conversationId: 'chat-a' };
    const grant: ToolApprovalGrantBinding = {
      agentId: 'agent-a',
      instanceName: 'query_mcp_db',
      toolName: 'query_mcp_db',
      binding: 'digest-a',
      scope: 'chat',
    };
    const stores = () => harness.createStores().toolApprovalGrants;
    const approved = async (
      current: { userId: string; conversationId: string; tenantId?: string },
      bindings: ToolApprovalGrantBinding[],
    ) => (await stores().getToolApprovalGrants(current, bindings)).map((status) => status.approved);
    const inTenant = <T>(tenantId: string, run: () => Promise<T>) =>
      tenantStorage.run({ tenantId }, run);
    const oauthToken = (userId: string, credentialSetId: string): RawRecord => ({
      _id: harness.ids.generate(),
      userId,
      type: 'mcp_oauth',
      identifier: 'mcp:db',
      token: 'synthetic-token-a',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: { credential_set_id: credentialSetId },
    });
    /** Changes the stored token rows as `edit` returns them, bypassing the stores. */
    const rewriteTokens = async (edit: (token: RawRecord) => RawRecord) => {
      const grants = await harness.readRaw('toolapprovalgrants');
      const tokens = (await harness.readRaw('tokens')).map(edit);
      await harness.reset();
      await harness.seedRaw('toolapprovalgrants', grants);
      await harness.seedRaw('tokens', tokens);
    };

    describe('getToolApprovalGrants', () => {
      it('reports a binding without any grant as not approved, with no revocation', async () => {
        const [status] = await stores().getToolApprovalGrants(scope, [grant]);
        expect(status).toMatchObject({
          binding: 'digest-a',
          approved: false,
          oauthEpoch: null,
          consentBinding: null,
        });
        expect(status.revocation).toBeUndefined();
      });

      it('answers an empty list for no bindings', async () => {
        expect(await stores().getToolApprovalGrants(scope, [])).toEqual([]);
      });

      it('answers in the order of the bindings asked', async () => {
        const other = { ...grant, toolName: 'other', instanceName: 'other', binding: 'digest-b' };
        await stores().rememberToolApprovalGrants(scope, [other]);
        expect(await approved(scope, [grant, other])).toEqual([false, true]);
        expect(await approved(scope, [other, grant])).toEqual([true, false]);
      });
    });

    describe('rememberToolApprovalGrants', () => {
      it('remembers a per-chat approval for that chat and user only', async () => {
        await stores().rememberToolApprovalGrants(scope, [grant]);
        expect(await approved(scope, [grant])).toEqual([true]);
        expect(await approved({ ...scope, conversationId: 'chat-b' }, [grant])).toEqual([false]);
        expect(await approved({ ...scope, userId: 'user-b' }, [grant])).toEqual([false]);
        const [stored] = await harness.readRaw('toolapprovalgrants');
        expect(stored).toMatchObject({
          user: 'user-a',
          agentId: 'agent-a',
          toolName: 'query_mcp_db',
          conversationId: 'chat-a',
          binding: 'digest-a',
        });
      });

      it('remembers a persistent approval across chats, but not for a changed binding', async () => {
        await stores().rememberToolApprovalGrants(scope, [{ ...grant, scope: 'always' }]);
        expect(await approved({ ...scope, conversationId: 'chat-b' }, [grant])).toEqual([true]);
        expect(await approved(scope, [{ ...grant, binding: 'digest-b' }])).toEqual([false]);
      });

      it('keeps one record under parallel saves', async () => {
        await Promise.all(
          Array.from({ length: 6 }, () => stores().rememberToolApprovalGrants(scope, [grant])),
        );
        expect(await harness.readRaw('toolapprovalgrants')).toHaveLength(1);
        expect(await approved(scope, [grant])).toEqual([true]);
      });

      it('refuses a one-time approval, storing nothing', async () => {
        await expect(
          stores().rememberToolApprovalGrants(scope, [{ ...grant, scope: 'once' }]),
        ).rejects.toThrow('One-time');
        expect(await harness.readRaw('toolapprovalgrants')).toEqual([]);
      });

      it('lets a reviewed replacement supersede the previous binding', async () => {
        await stores().rememberToolApprovalGrants(scope, [grant]);
        const [snapshot] = await stores().getToolApprovalGrants(scope, [grant]);
        expect(snapshot.consentBinding).toBe('digest-a');
        const replacement = {
          ...grant,
          binding: 'reviewed-new-authority',
          consentBinding: snapshot.consentBinding,
        };
        await Promise.all(
          Array.from({ length: 4 }, () =>
            stores().rememberToolApprovalGrants(scope, [replacement]),
          ),
        );
        expect(await approved(scope, [replacement])).toEqual([true]);
        expect(await approved(scope, [grant])).toEqual([false]);
        expect(await harness.readRaw('toolapprovalgrants')).toHaveLength(1);
      });

      it('isolates identical user and tool identifiers between tenants', async () => {
        const tenantA = { ...scope, tenantId: 'tenant-a' };
        const tenantB = { ...scope, tenantId: 'tenant-b' };
        await inTenant('tenant-a', () => stores().rememberToolApprovalGrants(tenantA, [grant]));
        expect(await inTenant('tenant-a', () => approved(tenantA, [grant]))).toEqual([true]);
        expect(await inTenant('tenant-b', () => approved(tenantB, [grant]))).toEqual([false]);
      });
    });

    describe('OAuth consent', () => {
      it("binds an approval to the server's OAuth credential set, not to token bytes", async () => {
        const owner = harness.ids.generate();
        const authScope = { userId: owner, conversationId: 'oauth-chat' };
        const bound = { ...grant, serverName: 'db', oauthEpoch: 'grant-a' };
        await harness.seedRaw('tokens', [oauthToken(owner, 'grant-a')]);
        await stores().rememberToolApprovalGrants(authScope, [bound]);
        expect(await approved(authScope, [bound])).toEqual([true]);

        await rewriteTokens((token) => ({ ...token, token: 'synthetic-refreshed-token' }));
        expect(await approved(authScope, [bound])).toEqual([true]);

        await rewriteTokens((token) => ({ ...token, metadata: { credential_set_id: 'grant-b' } }));
        const [changed] = await stores().getToolApprovalGrants(authScope, [bound]);
        expect(changed.oauthEpoch).toBe('grant-b');
        expect(changed.approved).toBe(false);
        expect(JSON.stringify(changed)).not.toContain('synthetic-refreshed-token');
      });

      it.each(['chat', 'always'] as const)(
        'refuses a %s approval for an OAuth epoch already replaced',
        async (mode) => {
          const userId = harness.ids.generate();
          const current = { ...scope, userId };
          const old = { ...grant, scope: mode, serverName: 'db', oauthEpoch: 'account-a' };
          await harness.seedRaw('tokens', [oauthToken(userId, 'account-a')]);
          await stores().rememberToolApprovalGrants(current, [old]);
          await rewriteTokens((token) => ({
            ...token,
            metadata: { credential_set_id: 'account-b' },
          }));
          const renewed = { ...old, oauthEpoch: 'account-b' };
          await stores().rememberToolApprovalGrants(current, [renewed]);
          await stores().rememberToolApprovalGrants(current, [old]);
          expect(await approved(current, [renewed])).toEqual([true]);
        },
      );

      it('resolves distinct epochs for OAuth and API-key tools of one server', async () => {
        const userId = harness.ids.generate();
        const current = { ...scope, userId };
        await harness.seedRaw('tokens', [oauthToken(userId, 'account-a')]);
        const oauth = {
          ...grant,
          serverName: 'db',
          authKind: 'oauth' as const,
          oauthEpoch: 'account-a',
        };
        const apiKey = {
          ...grant,
          serverName: 'db',
          authKind: 'other' as const,
          oauthEpoch: null,
          toolName: 'key_mcp_db',
          instanceName: 'key_mcp_db',
          binding: 'key-authority',
        };
        await stores().rememberToolApprovalGrants(current, [oauth, apiKey]);
        expect(
          (await stores().getToolApprovalGrants(current, [oauth, apiKey])).map((status) => [
            status.oauthEpoch,
            status.approved,
          ]),
        ).toEqual([
          ['account-a', true],
          [null, true],
        ]);
        await rewriteTokens((token) => ({
          ...token,
          metadata: { credential_set_id: 'account-b' },
        }));
        expect(await approved(current, [oauth, apiKey])).toEqual([false, true]);
      });
    });

    describe('resetToolApprovalGrants', () => {
      it('fences every chat, and a late approval with the old revocation cannot resurrect it', async () => {
        await stores().rememberToolApprovalGrants(scope, [grant]);
        await stores().resetToolApprovalGrants(scope.userId, grant.agentId, grant.toolName);
        await stores().rememberToolApprovalGrants(scope, [grant]);
        const [reset] = await stores().getToolApprovalGrants(scope, [grant]);
        expect(reset.approved).toBe(false);
        expect(reset.revocation).toEqual(expect.any(String));
        await stores().rememberToolApprovalGrants(scope, [
          { ...grant, revocation: reset.revocation },
        ]);
        expect(await approved(scope, [grant])).toEqual([true]);
      });

      it('fences a late approval when reset before the first stored grant', async () => {
        const [initial] = await stores().getToolApprovalGrants(scope, [grant]);
        await stores().resetToolApprovalGrants(scope.userId, grant.agentId, grant.toolName);
        await stores().rememberToolApprovalGrants(scope, [
          { ...grant, revocation: initial.revocation },
        ]);
        expect(await approved(scope, [grant])).toEqual([false]);
      });

      it('resets every tool of the agent without touching another agent or user', async () => {
        const persistent: ToolApprovalGrantBinding = {
          ...grant,
          toolName: 'other_mcp_db',
          instanceName: 'other_mcp_db',
          binding: 'digest-b',
          scope: 'always',
        };
        const anotherAgent = { ...grant, agentId: 'agent-b', binding: 'digest-agent-b' };
        await stores().rememberToolApprovalGrants(scope, [grant, persistent, anotherAgent]);
        await stores().rememberToolApprovalGrants({ ...scope, userId: 'user-b' }, [grant]);
        await stores().resetToolApprovalGrants(scope.userId, grant.agentId);
        await stores().rememberToolApprovalGrants(scope, [grant, persistent]);
        expect(await approved(scope, [grant, persistent])).toEqual([false, false]);
        expect(await approved(scope, [anotherAgent])).toEqual([true]);
        expect(await approved({ ...scope, userId: 'user-b' }, [grant])).toEqual([true]);
      });

      it('fences every unseen tool when the agent is reset before any grant', async () => {
        const pending = { ...grant, toolName: 'pending', instanceName: 'pending', binding: 'p' };
        await stores().resetToolApprovalGrants(scope.userId, grant.agentId);
        await stores().rememberToolApprovalGrants(scope, [grant, pending]);
        expect(await approved(scope, [grant, pending])).toEqual([false, false]);
      });

      it.each([
        ['chat', 'tool'],
        ['chat', 'agent'],
        ['always', 'tool'],
        ['always', 'agent'],
      ] as const)(
        'keeps a %s consent renewed after a %s reset over a late stale completion',
        async (mode, resetScope) => {
          const pending = { ...grant, scope: mode };
          await stores().rememberToolApprovalGrants(scope, [pending]);
          await stores().resetToolApprovalGrants(
            scope.userId,
            grant.agentId,
            resetScope === 'tool' ? grant.toolName : undefined,
          );
          const [current] = await stores().getToolApprovalGrants(scope, [pending]);
          const renewed = { ...pending, revocation: current.revocation };
          await stores().rememberToolApprovalGrants(scope, [renewed]);
          await stores().rememberToolApprovalGrants(scope, [pending]);
          expect(await approved(scope, [renewed])).toEqual([true]);
        },
      );

      it('does not cross tenants', async () => {
        const other = { ...grant, toolName: 'other', instanceName: 'other', binding: 'digest-b' };
        const a = { ...scope, tenantId: 'tenant-a' };
        const b = { ...scope, tenantId: 'tenant-b' };
        for (const current of [a, b]) {
          await inTenant(current.tenantId, () =>
            stores().rememberToolApprovalGrants(current, [grant, other]),
          );
        }
        await inTenant('tenant-a', () =>
          stores().resetToolApprovalGrants(scope.userId, grant.agentId),
        );
        expect(await inTenant('tenant-a', () => approved(a, [grant, other]))).toEqual([
          false,
          false,
        ]);
        expect(await inTenant('tenant-b', () => approved(b, [grant, other]))).toEqual([true, true]);
      });
    });
  });
}

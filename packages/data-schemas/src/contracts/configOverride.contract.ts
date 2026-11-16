/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ConfigOverrideStore` contract (`~/ports/config`), ported from `methods/config.spec.ts`:
 * the per-principal override documents (whole replacement, dotted patches, tombstones, resets),
 * merge-order reads, the tenant partition of role documents, activation, priority, moves, the
 * revision preconditions and restores. Revisions are built with `getConfigRevision`
 * (`<id>:<configVersion>`), as callers build them. The MongoDB key encoding at rest is that
 * backend's business and is not part of the port. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { ContractHarness } from './harness';
import type { ConfigRecord } from '~/app/store';
import { getConfigRevision, isConfigMoveRefused, isConfigRevisionConflict } from '~/app/store';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { useContractHarness } from './support';

const ROLE = PrincipalType.ROLE;
const ROLE_MODEL = PrincipalModel.ROLE;
const BASE = '__base__';

export function describeConfigOverrideContract(harness: ContractHarness): void {
  describe(`ConfigOverrideStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().configOverrides;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>) =>
      tenantStorage.run({ tenantId }, run);
    const ids = (configs: ConfigRecord[]) => configs.map((config) => config.principalId);
    /** A role document seeded raw, so it keeps exactly the `tenantId` form given. */
    const seedRole = (
      principalId: string,
      label: string,
      tenant: { tenantId?: string | null } = {},
      priority = principalId === BASE ? 0 : 10,
    ) =>
      harness.seedRaw('configs', [
        {
          _id: harness.ids.generate(),
          principalType: ROLE,
          principalId,
          principalModel: ROLE_MODEL,
          priority,
          overrides: { registration: { allowedDomains: [label] } },
          tombstones: [],
          isActive: true,
          configVersion: 1,
          ...tenant,
        },
      ]);
    const labels = (configs: ConfigRecord[]) =>
      configs.map((config) => config.overrides.registration?.allowedDomains?.[0] ?? '');
    const expectConflict = async (promise: Promise<unknown>, currentRevision?: string | null) => {
      const error = await promise.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(isConfigRevisionConflict(error)).toBe(true);
      if (currentRevision !== undefined) {
        expect(error).toMatchObject({ currentRevision });
      }
    };

    describe('upsertConfig', () => {
      it('creates an active document at version 1 with the given priority', async () => {
        const created = await stores().upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          { interface: { modelSelect: false } },
          10,
        );
        expect(created).toMatchObject({
          principalType: ROLE,
          principalId: 'admin',
          principalModel: ROLE_MODEL,
          priority: 10,
          isActive: true,
          configVersion: 1,
          overrides: { interface: { modelSelect: false } },
          tombstones: [],
        });
        expect(typeof created?._id).toBe('string');
        const stored = await harness.readRaw('configs');
        expect(stored).toHaveLength(1);
        expect(stored[0]._id).toBe(created?._id);
      });

      it('replaces the same document on a second upsert, bumping the version', async () => {
        const configs = stores();
        const first = await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          { interface: { modelSelect: true, parameters: true } },
          10,
        );
        const second = await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          { interface: { modelSelect: false } },
          10,
        );
        expect(second?._id).toBe(first?._id);
        expect(second?.configVersion).toBe(2);
        expect(second?.overrides).toEqual({ interface: { modelSelect: false } });
        expect(await harness.readRaw('configs')).toHaveLength(1);
      });

      it('keeps tombstones and reactivates the document', async () => {
        const configs = stores();
        await configs.tombstoneConfigField(ROLE, 'admin', ROLE_MODEL, 'mcpServers.github', 10);
        await configs.toggleConfigActive(ROLE, 'admin', false);
        const replaced = await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          { interface: { modelSelect: false } },
          10,
        );
        expect(replaced?.tombstones).toContain('mcpServers.github');
        expect(replaced?.isActive).toBe(true);
      });

      it('stores an id principal as its string', async () => {
        const groupId = harness.ids.generate();
        await stores().upsertConfig(PrincipalType.GROUP, groupId, PrincipalModel.GROUP, {}, 20);
        const found = await stores().findConfigByPrincipal(PrincipalType.GROUP, groupId);
        expect(found?.principalId).toBe(groupId);
      });

      it('keeps the stored priority when none is given, and defaults by type on create', async () => {
        const configs = stores();
        const groupId = harness.ids.generate();
        const created = await configs.upsertConfig(
          PrincipalType.GROUP,
          groupId,
          PrincipalModel.GROUP,
          {
            interface: { modelSelect: false },
          },
        );
        expect(created?.priority).toBe(20);
        await configs.setConfigPriority(PrincipalType.GROUP, groupId, 35);
        const replaced = await configs.upsertConfig(
          PrincipalType.GROUP,
          groupId,
          PrincipalModel.GROUP,
          { interface: { modelSelect: true } },
        );
        expect(replaced?.priority).toBe(35);
        expect(
          (await configs.upsertConfig(PrincipalType.USER, 'u1', PrincipalModel.USER, {}))?.priority,
        ).toBe(100);
        expect((await configs.upsertConfig(ROLE, BASE, ROLE_MODEL, {}))?.priority).toBe(0);
      });

      it('with expectEmpty, writes only an absent or empty document', async () => {
        const configs = stores();
        expect(
          (
            await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 5, undefined, {
              expectEmpty: true,
            })
          )?.priority,
        ).toBe(5);
        expect(
          (
            await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 99, undefined, {
              expectEmpty: true,
            })
          )?.priority,
        ).toBe(99);
        await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          { interface: { modelSelect: false } },
          10,
        );
        expect(
          await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 99, undefined, {
            expectEmpty: true,
          }),
        ).toBeNull();
        const stored = await configs.findConfigByPrincipal(ROLE, 'admin');
        expect(stored).toMatchObject({
          priority: 10,
          overrides: { interface: { modelSelect: false } },
        });
      });

      it('with preservePriority, keeps the priority of an empty existing document', async () => {
        const configs = stores();
        expect(
          (
            await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 10, undefined, {
              expectEmpty: true,
              preservePriority: true,
            })
          )?.priority,
        ).toBe(10);
        const kept = await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 99, undefined, {
          expectEmpty: true,
          preservePriority: true,
        });
        expect(kept).toMatchObject({ priority: 10, configVersion: 2 });
      });

      it("creates with 'absent', then conflicts on a second create", async () => {
        const configs = stores();
        const created = await configs.upsertConfig(ROLE, 'once', ROLE_MODEL, {}, 10, undefined, {
          expectedRevision: 'absent',
        });
        expect(created?.configVersion).toBe(1);
        await expectConflict(
          configs.upsertConfig(ROLE, 'once', ROLE_MODEL, { cache: true }, 10, undefined, {
            expectedRevision: 'absent',
          }),
          getConfigRevision(created as ConfigRecord),
        );
      });

      it('keeps one document when unconditioned upserts race to create it', async () => {
        const configs = stores();
        const results = await Promise.all(
          [1, 2, 3].map((index) =>
            configs.upsertConfig(ROLE, 'raced', ROLE_MODEL, { version: String(index) }, 10),
          ),
        );
        expect(new Set(results.map((result) => result?._id)).size).toBe(1);
        expect(await harness.readRaw('configs')).toHaveLength(1);
        expect((await configs.findConfigByPrincipal(ROLE, 'raced'))?.configVersion).toBe(3);
      });
    });

    describe('findConfigByPrincipal', () => {
      it('finds the active document, an inactive one only with includeInactive, else null', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, { cache: true }, 10);
        expect(await configs.findConfigByPrincipal(ROLE, 'admin')).toMatchObject({
          principalType: ROLE,
          overrides: { cache: true },
        });
        expect(await configs.findConfigByPrincipal(ROLE, 'nonexistent')).toBeNull();
        await configs.toggleConfigActive(ROLE, 'admin', false);
        expect(await configs.findConfigByPrincipal(ROLE, 'admin')).toBeNull();
        expect(
          await configs.findConfigByPrincipal(ROLE, 'admin', { includeInactive: true }),
        ).toMatchObject({ isActive: false });
      });

      it('reads a legacy document without a version at version 0', async () => {
        const id = harness.ids.generate();
        await harness.seedRaw('configs', [
          {
            _id: id,
            principalType: ROLE,
            principalId: 'old',
            principalModel: ROLE_MODEL,
            priority: 10,
            isActive: true,
            overrides: { a: { b: 1 } },
          },
        ]);
        const found = await stores().findConfigByPrincipal(ROLE, 'old');
        expect(found).toMatchObject({ _id: id, configVersion: 0 });
        expect(getConfigRevision(found as ConfigRecord)).toBe(`${id}:0`);
      });
    });

    describe('listAllConfigs', () => {
      it('lists every document, or only active or inactive ones', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'a', ROLE_MODEL, {}, 10);
        await configs.upsertConfig(ROLE, 'b', ROLE_MODEL, {}, 20);
        await configs.toggleConfigActive(ROLE, 'b', false);
        expect(ids(await configs.listAllConfigs())).toEqual(['a', 'b']);
        expect(ids(await configs.listAllConfigs({ isActive: true }))).toEqual(['a']);
        expect(ids(await configs.listAllConfigs({ isActive: false }))).toEqual(['b']);
      });

      it('orders by priority, Base first, with a stable order for equal priorities', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'high', ROLE_MODEL, {}, 100);
        await configs.upsertConfig(ROLE, 'low', ROLE_MODEL, {}, 1);
        await configs.upsertConfig(ROLE, BASE, ROLE_MODEL, {}, 90);
        await configs.upsertConfig(ROLE, 'mid', ROLE_MODEL, {}, 50);
        const first = ids(await configs.listAllConfigs());
        expect(first).toEqual([BASE, 'low', 'mid', 'high']);
        expect(ids(await configs.listAllConfigs())).toEqual(first);
      });
    });

    describe('getApplicableConfigs', () => {
      it('returns Base and the given principals, in merge order', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, BASE, ROLE_MODEL, { cache: true }, 0);
        await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, { version: '2' }, 10);
        await configs.upsertConfig(ROLE, 'user', ROLE_MODEL, { version: '3' }, 10);
        expect(ids(await configs.getApplicableConfigs([]))).toEqual([BASE]);
        expect(ids(await configs.getApplicableConfigs())).toEqual([BASE]);
        expect(
          ids(await configs.getApplicableConfigs([{ principalType: ROLE, principalId: 'admin' }])),
        ).toEqual([BASE, 'admin']);
      });

      it('leaves out inactive documents and principals without an id', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, BASE, ROLE_MODEL, {}, 0);
        await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 10);
        await configs.toggleConfigActive(ROLE, 'admin', false);
        expect(
          ids(
            await configs.getApplicableConfigs([
              { principalType: ROLE, principalId: 'admin' },
              { principalType: PrincipalType.GROUP, principalId: undefined },
            ]),
          ),
        ).toEqual([BASE]);
      });

      it('puts Base first and keeps a stable order for equal priorities', async () => {
        const configs = stores();
        const groups = Array.from({ length: 4 }, () => harness.ids.generate());
        for (const groupId of groups) {
          await configs.upsertConfig(PrincipalType.GROUP, groupId, PrincipalModel.GROUP, {}, 20);
        }
        await configs.upsertConfig(PrincipalType.USER, 'u1', PrincipalModel.USER, {}, 20);
        await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 20);
        await configs.upsertConfig(ROLE, BASE, ROLE_MODEL, {}, 90);
        const principals = [
          { principalType: PrincipalType.USER, principalId: 'u1' },
          { principalType: ROLE, principalId: 'admin' },
          ...groups.map((principalId) => ({ principalType: PrincipalType.GROUP, principalId })),
        ];
        const order = async () =>
          (await configs.getApplicableConfigs(principals)).map(
            (config) => `${config.principalType}:${config.principalId}`,
          );
        const first = await order();
        expect(first[0]).toBe(`role:${BASE}`);
        expect(first[1]).toBe('role:admin');
        expect(first[first.length - 1]).toBe('user:u1');
        expect(await order()).toEqual(first);
      });

      describe('tenant partition', () => {
        const USER_ROLE = [{ principalType: ROLE, principalId: 'USER' }];
        const seedPartitions = async () => {
          await seedRole(BASE, 'deployment-base');
          await seedRole(BASE, 'a-base', { tenantId: 'tenant-a' });
          await seedRole(BASE, 'b-base', { tenantId: 'tenant-b' });
          await seedRole('USER', 'deployment-user', {}, 11);
          await seedRole('USER', 'a-user', { tenantId: 'tenant-a' }, 11);
          await seedRole('USER', 'b-user', { tenantId: 'tenant-b' }, 11);
        };

        it('reads only tenantless documents outside a tenant and under the system sentinel', async () => {
          await seedPartitions();
          expect(labels(await stores().getApplicableConfigs(USER_ROLE))).toEqual([
            'deployment-base',
            'deployment-user',
          ]);
          expect(labels(await runAsSystem(() => stores().getApplicableConfigs(USER_ROLE)))).toEqual(
            ['deployment-base', 'deployment-user'],
          );
        });

        it("reads only the active tenant's documents, never the deployment's", async () => {
          await seedPartitions();
          expect(
            labels(await inTenant('tenant-a', () => stores().getApplicableConfigs(USER_ROLE))),
          ).toEqual(['a-base', 'a-user']);
          expect(
            await inTenant('tenant-c', () => stores().getApplicableConfigs(USER_ROLE)),
          ).toEqual([]);
        });

        it('treats a stored null or empty tenantId as tenantless', async () => {
          await seedRole(BASE, 'null-base', { tenantId: null });
          await seedRole('USER', 'empty-user', { tenantId: '' }, 11);
          await seedRole('ADMIN', 'a-admin', { tenantId: 'tenant-a' }, 12);
          expect(
            labels(
              await stores().getApplicableConfigs([
                ...USER_ROLE,
                { principalType: ROLE, principalId: 'ADMIN' },
              ]),
            ),
          ).toEqual(['null-base', 'empty-user']);
        });
      });
    });

    describe('listConfigTombstones', () => {
      it('returns the active documents with a tombstone at or below the path, without overrides', async () => {
        const configs = stores();
        await configs.upsertConfig(
          ROLE,
          'hides',
          ROLE_MODEL,
          {
            interface: { modelSelect: false },
            mcpServers: { docs: { url: 'https://docs.test/mcp' } },
          },
          20,
        );
        await configs.tombstoneConfigField(ROLE, 'hides', ROLE_MODEL, 'mcpServers.github', 20);
        await configs.tombstoneConfigField(ROLE, 'section', ROLE_MODEL, 'mcpServers', 10);
        await configs.tombstoneConfigField(ROLE, 'other', ROLE_MODEL, 'webSearch', 5);
        await configs.tombstoneConfigField(ROLE, 'prefix', ROLE_MODEL, 'mcpServersArchive', 5);
        await configs.tombstoneConfigField(ROLE, 'inactive', ROLE_MODEL, 'mcpServers.github', 5);
        await configs.toggleConfigActive(ROLE, 'inactive', false);
        await harness.seedRaw('configs', [
          {
            _id: harness.ids.generate(),
            principalType: ROLE,
            principalId: 'USER',
            principalModel: ROLE_MODEL,
            priority: 30,
            tenantId: 'acme',
            isActive: true,
            configVersion: 1,
            overrides: { mcpServers: { github: { timeout: 1 } } },
            tombstones: ['mcpServers.github.headers', 'webSearch'],
          },
        ]);
        expect(await configs.listConfigTombstones('mcpServers')).toEqual([
          { principalType: ROLE, principalId: 'section', tombstones: ['mcpServers'] },
          { principalType: ROLE, principalId: 'hides', tombstones: ['mcpServers.github'] },
          {
            principalType: ROLE,
            principalId: 'USER',
            tenantId: 'acme',
            tombstones: ['mcpServers.github.headers', 'webSearch'],
          },
        ]);
      });
    });

    describe('patchConfigFields', () => {
      it('sets dotted paths, keeping sibling fields', async () => {
        const configs = stores();
        await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          { interface: { modelSelect: true, parameters: true } },
          10,
        );
        const patched = await configs.patchConfigFields(ROLE, 'admin', ROLE_MODEL, {
          'interface.modelSelect': false,
        });
        expect(patched.overrides).toEqual({ interface: { modelSelect: false, parameters: true } });
        expect(patched.priority).toBe(10);
        expect(patched.configVersion).toBe(2);
      });

      it('creates the document when there is none', async () => {
        const created = await stores().patchConfigFields(
          ROLE,
          'newrole',
          ROLE_MODEL,
          { 'interface.modelSelect': false },
          10,
        );
        expect(created).toMatchObject({
          principalId: 'newrole',
          priority: 10,
          overrides: { interface: { modelSelect: false } },
        });
      });

      it('clears tombstones on the patched path and its ancestors, not on a whole section above', async () => {
        const configs = stores();
        await configs.tombstoneConfigField(ROLE, 'admin', ROLE_MODEL, 'mcpServers.github', 10);
        const cleared = await configs.patchConfigFields(ROLE, 'admin', ROLE_MODEL, {
          'mcpServers.github.url': 'https://scoped.example.com',
        });
        expect(cleared.tombstones).not.toContain('mcpServers.github');
        await configs.tombstoneConfigField(ROLE, 'other', ROLE_MODEL, 'mcpServers', 10);
        const kept = await configs.patchConfigFields(ROLE, 'other', ROLE_MODEL, {
          'mcpServers.github.url': 'https://scoped.example.com',
        });
        expect(kept.tombstones).toContain('mcpServers');
      });

      it('stores record keys containing dots verbatim', async () => {
        const profiles = { 'us.anthropic.claude-sonnet-4-5': 'arn:aws:x' };
        const configs = stores();
        await configs.patchConfigFields(ROLE, 'editor', ROLE_MODEL, {
          'endpoints.bedrock.inferenceProfiles': profiles,
        });
        expect((await configs.findConfigByPrincipal(ROLE, 'editor'))?.overrides).toEqual({
          endpoints: { bedrock: { inferenceProfiles: profiles } },
        });
      });

      it('writes at the matching revision, bumping the version by one', async () => {
        const configs = stores();
        const first = await configs.patchConfigFields(ROLE, 'rev', ROLE_MODEL, {
          'interface.customWelcome': 'v1',
        });
        const next = await configs.patchConfigFields(
          ROLE,
          'rev',
          ROLE_MODEL,
          { 'interface.customWelcome': 'v2' },
          undefined,
          undefined,
          { expectedRevision: getConfigRevision(first) },
        );
        expect(next.configVersion).toBe(first.configVersion + 1);
        expect(next._id).toBe(first._id);
      });

      it('lets exactly one of two concurrent conditioned patches win', async () => {
        const configs = stores();
        const first = await configs.patchConfigFields(ROLE, 'race', ROLE_MODEL, {
          'interface.customWelcome': 'v1',
        });
        const results = await Promise.allSettled(
          ['a', 'b'].map((value) =>
            stores().patchConfigFields(
              ROLE,
              'race',
              ROLE_MODEL,
              { 'interface.customWelcome': value },
              undefined,
              undefined,
              { expectedRevision: getConfigRevision(first) },
            ),
          ),
        );
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(isConfigRevisionConflict((rejected as PromiseRejectedResult).reason)).toBe(true);
        expect((await configs.findConfigByPrincipal(ROLE, 'race'))?.configVersion).toBe(2);
      });

      it('keeps every concurrent unconditioned patch', async () => {
        const configs = stores();
        await configs.patchConfigFields(ROLE, 'merge', ROLE_MODEL, {
          'interface.customWelcome': 'v1',
        });
        await Promise.all(
          ['a', 'b', 'c'].map((key) =>
            stores().patchConfigFields(ROLE, 'merge', ROLE_MODEL, { [`speech.${key}`]: key }),
          ),
        );
        const stored = await configs.findConfigByPrincipal(ROLE, 'merge');
        expect((stored?.overrides as Record<string, unknown>).speech).toEqual({
          a: 'a',
          b: 'b',
          c: 'c',
        });
        expect(stored?.configVersion).toBe(4);
      });

      it('refuses the revision of a deleted and recreated document', async () => {
        const configs = stores();
        const original = await configs.patchConfigFields(ROLE, 'aba', ROLE_MODEL, { 'a.b': 1 });
        await configs.deleteConfig(ROLE, 'aba');
        await configs.patchConfigFields(ROLE, 'aba', ROLE_MODEL, { 'a.b': 1 });
        await expectConflict(
          configs.patchConfigFields(ROLE, 'aba', ROLE_MODEL, { 'a.b': 2 }, 10, undefined, {
            expectedRevision: getConfigRevision(original),
          }),
        );
        expect((await configs.findConfigByPrincipal(ROLE, 'aba'))?.overrides).toEqual({
          a: { b: 1 },
        });
      });
    });

    describe('tombstoneConfigField', () => {
      it('adds the tombstone and removes the overridden subtree', async () => {
        const configs = stores();
        await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          {
            mcpServers: {
              github: { type: 'streamable-http', url: 'https://github.example.com' },
              slack: { type: 'streamable-http', url: 'https://slack.example.com' },
            },
          } as never,
          10,
        );
        const result = await configs.tombstoneConfigField(
          ROLE,
          'admin',
          ROLE_MODEL,
          'mcpServers.github',
        );
        expect(result.tombstones).toContain('mcpServers.github');
        expect(result.overrides).toEqual({
          mcpServers: { slack: { type: 'streamable-http', url: 'https://slack.example.com' } },
        });
      });

      it('creates the document, and keeps an inactive one inactive', async () => {
        const configs = stores();
        const created = await configs.tombstoneConfigField(
          ROLE,
          'admin',
          ROLE_MODEL,
          'mcpServers.github',
          10,
        );
        expect(created).toMatchObject({ tombstones: ['mcpServers.github'], priority: 10 });
        await configs.toggleConfigActive(ROLE, 'admin', false);
        const inactive = await configs.tombstoneConfigField(ROLE, 'admin', ROLE_MODEL, [
          'memory',
          'webSearch',
        ]);
        expect(inactive.isActive).toBe(false);
        expect(inactive.tombstones).toEqual(
          expect.arrayContaining(['mcpServers.github', 'memory', 'webSearch']),
        );
      });

      it('never creates a document for the revision of one that does not exist', async () => {
        await expectConflict(
          stores().tombstoneConfigField(ROLE, 'ghost', ROLE_MODEL, 'memory', 10, undefined, {
            expectedRevision: `${harness.ids.generate()}:4`,
          }),
          null,
        );
        expect(await harness.readRaw('configs')).toEqual([]);
      });
    });

    describe('unsetConfigField', () => {
      it('removes the field, keeps siblings, and prunes the parents it empties', async () => {
        const configs = stores();
        await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          {
            interface: { modelSelect: false, parameters: false },
            speech: { tts: { url: 'x' } },
          } as never,
          10,
        );
        const result = await configs.unsetConfigField(ROLE, 'admin', [
          'interface.modelSelect',
          'speech.tts.url',
        ]);
        expect(result?.overrides).toEqual({ interface: { parameters: false } });
      });

      it('resolves null for a principal without a document', async () => {
        expect(await stores().unsetConfigField(ROLE, 'ghost', 'a.b')).toBeNull();
        expect(await harness.readRaw('configs')).toEqual([]);
      });

      it('clears tombstones on the reset path', async () => {
        const configs = stores();
        await configs.tombstoneConfigField(ROLE, 'admin', ROLE_MODEL, 'mcpServers.github', 10);
        const result = await configs.unsetConfigField(ROLE, 'admin', 'mcpServers.github');
        expect(result?.tombstones).not.toContain('mcpServers.github');
      });

      it('refuses a stale revision with the current one, changing nothing', async () => {
        const configs = stores();
        const first = await configs.patchConfigFields(ROLE, 'stale', ROLE_MODEL, {
          'interface.customWelcome': 'v1',
        });
        const second = await configs.patchConfigFields(ROLE, 'stale', ROLE_MODEL, {
          'interface.customWelcome': 'v2',
        });
        await expectConflict(
          configs.unsetConfigField(ROLE, 'stale', 'interface.customWelcome', undefined, {
            expectedRevision: getConfigRevision(first),
          }),
          getConfigRevision(second),
        );
        expect((await configs.findConfigByPrincipal(ROLE, 'stale'))?.configVersion).toBe(2);
      });

      it('matches a legacy document without a version at version 0', async () => {
        const id = harness.ids.generate();
        await harness.seedRaw('configs', [
          {
            _id: id,
            principalType: ROLE,
            principalId: 'old',
            principalModel: ROLE_MODEL,
            priority: 10,
            isActive: true,
            overrides: { a: { b: 1 } },
          },
        ]);
        const written = await stores().unsetConfigField(ROLE, 'old', 'a.b', undefined, {
          expectedRevision: `${id}:0`,
        });
        expect(written).toMatchObject({ configVersion: 1, overrides: {} });
      });
    });

    describe('deleteConfig', () => {
      it('deletes the document and resolves to it, or null when there is none', async () => {
        const configs = stores();
        const created = await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, { cache: true }, 10);
        const deleted = await configs.deleteConfig(ROLE, 'admin');
        expect(deleted).toMatchObject({ _id: created?._id, overrides: { cache: true } });
        expect(await configs.findConfigByPrincipal(ROLE, 'admin')).toBeNull();
        expect(await configs.deleteConfig(ROLE, 'ghost')).toBeNull();
      });

      it('with expectEmpty, deletes only a document holding nothing', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'empty', ROLE_MODEL, {}, 10);
        await configs.upsertConfig(
          ROLE,
          'full',
          ROLE_MODEL,
          { interface: { modelSelect: false } },
          10,
        );
        await configs.tombstoneConfigField(ROLE, 'hidden', ROLE_MODEL, 'endpoints.openAI', 10);
        expect(
          await configs.deleteConfig(ROLE, 'empty', undefined, { expectEmpty: true }),
        ).toMatchObject({ principalId: 'empty' });
        expect(
          await configs.deleteConfig(ROLE, 'full', undefined, { expectEmpty: true }),
        ).toBeNull();
        expect(
          await configs.deleteConfig(ROLE, 'hidden', undefined, { expectEmpty: true }),
        ).toBeNull();
        expect(ids(await configs.listAllConfigs()).sort()).toEqual(['full', 'hidden']);
      });

      it('deletes only at the expected revision', async () => {
        const configs = stores();
        const first = await configs.patchConfigFields(ROLE, 'life', ROLE_MODEL, { 'a.b': 1 });
        const toggled = await configs.toggleConfigActiveTracked(ROLE, 'life', false, {
          expectedRevision: getConfigRevision(first),
        });
        await expectConflict(
          configs.deleteConfig(ROLE, 'life', undefined, {
            expectedRevision: getConfigRevision(first),
          }),
        );
        const deleted = await configs.deleteConfig(ROLE, 'life', undefined, {
          expectedRevision: getConfigRevision(toggled?.config as ConfigRecord),
        });
        expect(deleted?._id).toBe(first._id);
      });
    });

    describe('restoreConfig', () => {
      it('restores tombstones, the inactive flag and the version, never over a newer document', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 10);
        await configs.tombstoneConfigField(ROLE, 'admin', ROLE_MODEL, 'a.b', 10);
        await configs.toggleConfigActive(ROLE, 'admin', false);
        const deleted = await configs.deleteConfig(ROLE, 'admin');
        const snapshot = { ...(deleted as ConfigRecord) };
        expect(await configs.restoreConfig(snapshot)).toBe(true);
        const restored = await configs.findConfigByPrincipal(ROLE, 'admin', {
          includeInactive: true,
        });
        expect(restored).toMatchObject({
          _id: snapshot._id,
          isActive: false,
          configVersion: snapshot.configVersion,
        });
        expect(restored?.tombstones).toContain('a.b');
        await configs.upsertConfig(
          ROLE,
          'admin',
          ROLE_MODEL,
          { interface: { modelSelect: false } },
          99,
        );
        expect(await configs.restoreConfig(snapshot)).toBe(false);
        expect((await configs.findConfigByPrincipal(ROLE, 'admin'))?.priority).toBe(99);
      });
    });

    describe('toggleConfigActive', () => {
      it('deactivates and reactivates, or resolves null without a document', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 10);
        expect((await configs.toggleConfigActive(ROLE, 'admin', false))?.isActive).toBe(false);
        expect((await configs.toggleConfigActive(ROLE, 'admin', true))?.isActive).toBe(true);
        expect(await configs.toggleConfigActive(ROLE, 'ghost', true)).toBeNull();
      });

      it('with expectEmpty, toggles only a document holding nothing', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'empty', ROLE_MODEL, {}, 10);
        await configs.upsertConfig(
          ROLE,
          'full',
          ROLE_MODEL,
          { interface: { modelSelect: false } },
          10,
        );
        expect(
          (await configs.toggleConfigActive(ROLE, 'empty', false, undefined, { expectEmpty: true }))
            ?.isActive,
        ).toBe(false);
        expect(
          await configs.toggleConfigActive(ROLE, 'full', false, undefined, { expectEmpty: true }),
        ).toBeNull();
        expect((await configs.findConfigByPrincipal(ROLE, 'full'))?.isActive).toBe(true);
      });
    });

    describe('toggleConfigActiveTracked', () => {
      it('reports a change once, bumping the version, and null without a document', async () => {
        const configs = stores();
        await configs.upsertConfig(ROLE, 'admin', ROLE_MODEL, {}, 10);
        expect(await configs.toggleConfigActiveTracked(ROLE, 'admin', false)).toMatchObject({
          changed: true,
          config: { isActive: false, configVersion: 2 },
        });
        expect(await configs.toggleConfigActiveTracked(ROLE, 'admin', false)).toMatchObject({
          changed: false,
          config: { isActive: false },
        });
        expect(await configs.toggleConfigActiveTracked(ROLE, 'none', false)).toBeNull();
      });
    });

    describe('setConfigPriority', () => {
      it('changes only the priority, or resolves null without a document', async () => {
        const configs = stores();
        await configs.patchConfigFields(ROLE, 'prio', ROLE_MODEL, {
          'interface.customWelcome': 'hi',
        });
        await configs.tombstoneConfigField(ROLE, 'prio', ROLE_MODEL, 'memory');
        await configs.toggleConfigActive(ROLE, 'prio', false);
        expect((await configs.setConfigPriority(ROLE, 'prio', 3))?.changed).toBe(true);
        expect(
          await configs.findConfigByPrincipal(ROLE, 'prio', { includeInactive: true }),
        ).toMatchObject({
          priority: 3,
          overrides: { interface: { customWelcome: 'hi' } },
          tombstones: ['memory'],
          isActive: false,
          configVersion: 4,
        });
        expect(await configs.setConfigPriority(ROLE, 'missing', 3)).toBeNull();
      });

      it("changes only the active tenant's role document", async () => {
        await seedRole('editor', 'platform');
        await seedRole('editor', 'tenant', { tenantId: 'tenant-a' });
        await inTenant('tenant-a', () => stores().setConfigPriority(ROLE, 'editor', 42));
        const stored = await harness.readRaw('configs');
        expect(stored.map((record) => [record.tenantId ?? '-', record.priority])).toEqual([
          ['-', 10],
          ['tenant-a', 42],
        ]);
      });
    });

    describe('renameConfigPrincipal', () => {
      it('moves the document to the new id, dotted record keys included', async () => {
        const profiles = { 'us.anthropic.claude-sonnet-4-5': 'arn:aws:x' };
        const configs = stores();
        await configs.patchConfigFields(ROLE, 'editor', ROLE_MODEL, {
          'endpoints.bedrock.inferenceProfiles': profiles,
        });
        const moved = await configs.renameConfigPrincipal(ROLE, 'editor', 'writer');
        expect(moved).toMatchObject({
          principalId: 'writer',
          overrides: { endpoints: { bedrock: { inferenceProfiles: profiles } } },
        });
        expect(await configs.findConfigByPrincipal(ROLE, 'editor')).toBeNull();
        expect((await configs.findConfigByPrincipal(ROLE, 'writer'))?.overrides).toEqual(
          moved?.overrides,
        );
        expect(await harness.readRaw('configs')).toHaveLength(1);
      });

      it('resolves null when there is nothing to move, or the identity does not match', async () => {
        const configs = stores();
        expect(await configs.renameConfigPrincipal(ROLE, 'ghost', 'writer')).toBeNull();
        await configs.patchConfigFields(ROLE, 'editor', ROLE_MODEL, { x: 1 });
        expect(
          await configs.renameConfigPrincipal(ROLE, 'editor', 'writer', {
            identity: harness.ids.generate(),
          }),
        ).toBeNull();
        expect(await configs.findConfigByPrincipal(ROLE, 'editor')).not.toBeNull();
      });

      it('refuses a move onto a principal that has a document, or of Base, changing nothing', async () => {
        const configs = stores();
        await configs.patchConfigFields(ROLE, 'a', ROLE_MODEL, { x: 1 });
        await configs.patchConfigFields(ROLE, 'b', ROLE_MODEL, { y: 1 });
        await configs.patchConfigFields(ROLE, BASE, ROLE_MODEL, { z: 1 });
        const exists = await configs.renameConfigPrincipal(ROLE, 'a', 'b').catch((e: unknown) => e);
        expect(isConfigMoveRefused(exists, 'CONFIG_PRINCIPAL_EXISTS')).toBe(true);
        const reserved = await configs
          .renameConfigPrincipal(ROLE, BASE, 'c')
          .catch((e: unknown) => e);
        expect(isConfigMoveRefused(reserved, 'CONFIG_PRINCIPAL_RESERVED')).toBe(true);
        expect((await configs.findConfigByPrincipal(ROLE, 'a'))?.overrides).toEqual({ x: 1 });
        expect((await configs.findConfigByPrincipal(ROLE, 'b'))?.overrides).toEqual({ y: 1 });
      });

      it("moves only the caller's partition: the platform document outside a tenant", async () => {
        await seedRole('editor', 'platform');
        await seedRole('editor', 'tenant', { tenantId: 'tenant-a' });
        await stores().renameConfigPrincipal(ROLE, 'editor', 'writer');
        const layout = (await harness.readRaw('configs'))
          .map((record) => `${record.tenantId || '-'}/${record.principalId}`)
          .sort();
        expect(layout).toEqual(['-/writer', 'tenant-a/editor']);
      });
    });

    describe('writeConfigDocument', () => {
      const draft = {
        principalModel: ROLE_MODEL,
        priority: 15,
        overrides: { interface: { modelSelect: false } },
        tombstones: ['memory'],
        isActive: true,
      };

      it("creates with 'absent', then replaces the whole document at its revision", async () => {
        const configs = stores();
        const created = await configs.writeConfigDocument(ROLE, 'doc', draft, 'absent');
        expect(created).toMatchObject({ principalId: 'doc', configVersion: 1, ...draft });
        const replaced = await configs.writeConfigDocument(
          ROLE,
          'doc',
          { ...draft, overrides: { cache: true }, tombstones: [], isActive: false, priority: 5 },
          getConfigRevision(created),
        );
        expect(replaced).toMatchObject({
          _id: created._id,
          configVersion: 2,
          overrides: { cache: true },
          tombstones: [],
          isActive: false,
          priority: 5,
        });
      });

      it('refuses a stale or absent precondition, changing nothing', async () => {
        const configs = stores();
        const created = await configs.writeConfigDocument(ROLE, 'doc', draft, 'absent');
        await configs.writeConfigDocument(ROLE, 'doc', draft, getConfigRevision(created));
        await expectConflict(
          configs.writeConfigDocument(
            ROLE,
            'doc',
            { ...draft, priority: 1 },
            getConfigRevision(created),
          ),
        );
        await expectConflict(configs.writeConfigDocument(ROLE, 'doc', draft, 'absent'));
        await expectConflict(
          configs.writeConfigDocument(ROLE, 'none', draft, `${harness.ids.generate()}:1`),
        );
        const stored = await configs.findConfigByPrincipal(ROLE, 'doc');
        expect(stored).toMatchObject({ configVersion: 2, priority: 15 });
        expect(await configs.findConfigByPrincipal(ROLE, 'none')).toBeNull();
      });
    });
  });
}

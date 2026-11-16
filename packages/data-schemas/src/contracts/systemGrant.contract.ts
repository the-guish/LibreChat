/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `SystemGrantStore` contract (`~/ports/systemGrant`), ported from
 * `methods/systemGrant.spec.ts`: the ADMIN seed, insert-only grants (concurrent grants of one
 * capability create it once), revokes of one scope, capability checks with implications and
 * config sections, listings, the per-principal reads, deletes and moves of one scope, and the
 * undo of a move. User and group principal ids are given both as store ids and as their string
 * form, which must name the same principal (the PostgreSQL adapter stores them as text). Grants
 * of users and groups are created through the store, never seeded raw: MongoDB stores their ids
 * typed, and a raw seed would not say which form. Cases that inject failures (retries, a move
 * failing part-way, a revoke racing the move's snapshot) or check the schema's validators and
 * index layout stay in the method spec. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { SystemCapability } from '~/types/admin';
import type { ContractHarness } from './harness';
import type { ISystemGrant } from '~/types';
import { SystemCapabilities, CapabilityImplications } from '~/admin/capabilities';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

const ROLE = PrincipalType.ROLE;
const USER = PrincipalType.USER;
const GROUP = PrincipalType.GROUP;
const caps = SystemCapabilities;

export function describeSystemGrantContract(harness: ContractHarness): void {
  describe(`SystemGrantStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().systemGrants;
    const grant = (
      principalType: PrincipalType,
      principalId: string,
      capability: SystemCapability,
      tenantId?: string,
    ) => stores().grantCapability({ principalType, principalId, capability, tenantId });
    /** The `<tenant or ->:<capability>` keys of the principal's stored grants, sorted. */
    const held = async (principalType: PrincipalType, principalId: string) =>
      (await harness.readRaw('systemgrants'))
        .filter(
          (stored) => stored.principalType === principalType && stored.principalId === principalId,
        )
        .map((stored) => `${stored.tenantId ?? '-'}:${stored.capability}`)
        .sort();
    const capabilitiesOf = (grants: ISystemGrant[]) =>
      grants.map((stored) => stored.capability).sort();

    describe('seedSystemGrants', () => {
      it('grants the ADMIN role every capability at platform level, idempotently', async () => {
        await stores().seedSystemGrants();
        await stores().seedSystemGrants();
        const stored = await harness.readRaw('systemgrants');
        expect(stored.map((record) => record.capability).sort()).toEqual(
          Object.values(SystemCapabilities).sort(),
        );
        for (const record of stored) {
          expect(record).toMatchObject({ principalType: ROLE, principalId: SystemRoles.ADMIN });
          expect(record.tenantId ?? null).toBeNull();
          expect(record.grantedAt).toBeInstanceOf(Date);
        }
      });

      it('leaves existing grants unchanged', async () => {
        const { grant: existing } = await grant(ROLE, SystemRoles.ADMIN, caps.READ_USERS);
        await stores().seedSystemGrants();
        const kept = await readRawWhere(harness, 'systemgrants', {
          capability: caps.READ_USERS,
        });
        expect(kept).toHaveLength(1);
        expect(kept[0]._id).toBe(idOf(harness, existing?._id));
        expect(timeOf(kept[0].grantedAt)).toBe(timeOf(existing?.grantedAt));
      });

      it('is safe to run concurrently', async () => {
        await Promise.all([
          stores().seedSystemGrants(),
          stores().seedSystemGrants(),
          stores().seedSystemGrants(),
        ]);
        expect(await harness.readRaw('systemgrants')).toHaveLength(
          Object.values(SystemCapabilities).length,
        );
      });
    });

    describe('grantCapability', () => {
      it('creates a grant and resolves it, created', async () => {
        const before = Date.now();
        const result = await grant(ROLE, 'editor', caps.READ_USERS);
        expect(result.created).toBe(true);
        expect(result.grant).toMatchObject({
          principalType: ROLE,
          principalId: 'editor',
          capability: caps.READ_USERS,
        });
        expect(timeOf(result.grant?.grantedAt)).toBeGreaterThanOrEqual(before - 1000);
        const stored = await harness.readRaw('systemgrants');
        expect(stored).toHaveLength(1);
        expect(stored[0]._id).toBe(idOf(harness, result.grant?._id));
        expect(stored[0].tenantId ?? null).toBeNull();
      });

      it('is insert-only: a re-grant changes nothing and is not created', async () => {
        const grantedBy = harness.ids.generate();
        const first = await stores().grantCapability({
          principalType: ROLE,
          principalId: 'editor',
          capability: caps.READ_USERS,
          grantedBy,
        });
        const second = await stores().grantCapability({
          principalType: ROLE,
          principalId: 'editor',
          capability: caps.READ_USERS,
          grantedBy: harness.ids.generate(),
        });
        expect(second.created).toBe(false);
        expect(idOf(harness, second.grant?._id)).toBe(idOf(harness, first.grant?._id));
        expect(timeOf(second.grant?.grantedAt)).toBe(timeOf(first.grant?.grantedAt));
        const stored = await harness.readRaw('systemgrants');
        expect(stored).toHaveLength(1);
        expect(stored[0].grantedBy).toBe(grantedBy);
      });

      it('stores a tenant-scoped grant apart from the platform-level one', async () => {
        const platform = await grant(ROLE, 'editor', caps.READ_USERS);
        const tenantA = await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-a');
        const tenantB = await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-b');
        expect([platform.created, tenantA.created, tenantB.created]).toEqual([true, true, true]);
        expect(tenantA.grant?.tenantId).toBe('tenant-a');
        expect(await held(ROLE, 'editor')).toEqual([
          `-:${caps.READ_USERS}`,
          `tenant-a:${caps.READ_USERS}`,
          `tenant-b:${caps.READ_USERS}`,
        ]);
      });

      it('treats a user or group id and its string form as the same principal', async () => {
        const userId = harness.ids.generate();
        const groupId = harness.ids.generate();
        expect((await grant(USER, userId, caps.READ_USERS)).created).toBe(true);
        expect(
          (
            await stores().grantCapability({
              principalType: USER,
              principalId: harness.ids.toStoreId(userId),
              capability: caps.READ_USERS,
            })
          ).created,
        ).toBe(false);
        await grant(GROUP, groupId, caps.READ_GROUPS);
        expect(await held(USER, userId)).toEqual([`-:${caps.READ_USERS}`]);
        expect(await held(GROUP, groupId)).toEqual([`-:${caps.READ_GROUPS}`]);
      });

      it('keeps a role principal id as given', async () => {
        await grant(ROLE, 'Custom Role', caps.READ_USERS);
        expect(await held(ROLE, 'Custom Role')).toEqual([`-:${caps.READ_USERS}`]);
      });

      it('throws for a user or group id string that is not a valid id', async () => {
        await expect(grant(USER, 'not-an-id', caps.READ_USERS)).rejects.toThrow();
        await expect(grant(GROUP, 'not-an-id', caps.READ_USERS)).rejects.toThrow();
        expect(await harness.readRaw('systemgrants')).toEqual([]);
      });

      it('creates a grant once when concurrent grants race, reporting one creation', async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, () => grant(ROLE, 'editor', caps.MANAGE_USERS)),
        );
        expect(results.filter(({ created }) => created)).toHaveLength(1);
        const stored = await harness.readRaw('systemgrants');
        expect(stored).toHaveLength(1);
        for (const result of results) {
          expect(idOf(harness, result.grant?._id)).toBe(stored[0]._id);
        }
      });
    });

    describe('revokeCapability', () => {
      it('removes the grant, counting it, and is a no-op the second time', async () => {
        await grant(ROLE, 'editor', caps.READ_USERS);
        await grant(ROLE, 'editor', caps.READ_CONFIGS);
        const revoke = () =>
          stores().revokeCapability({
            principalType: ROLE,
            principalId: 'editor',
            capability: caps.READ_USERS,
          });
        expect(await revoke()).toEqual({ deletedCount: 1 });
        expect(await revoke()).toEqual({ deletedCount: 0 });
        expect(await held(ROLE, 'editor')).toEqual([`-:${caps.READ_CONFIGS}`]);
      });

      it('revokes a user grant given its id in either form', async () => {
        const userId = harness.ids.generate();
        await grant(USER, userId, caps.READ_USERS);
        await grant(USER, userId, caps.READ_GROUPS);
        expect(
          (
            await stores().revokeCapability({
              principalType: USER,
              principalId: userId,
              capability: caps.READ_USERS,
            })
          ).deletedCount,
        ).toBe(1);
        expect(
          (
            await stores().revokeCapability({
              principalType: USER,
              principalId: harness.ids.toStoreId(userId),
              capability: caps.READ_GROUPS,
            })
          ).deletedCount,
        ).toBe(1);
        expect(await held(USER, userId)).toEqual([]);
      });

      it('revokes exactly one scope', async () => {
        await grant(ROLE, 'editor', caps.READ_USERS);
        await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-a');
        await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-b');
        await stores().revokeCapability({
          principalType: ROLE,
          principalId: 'editor',
          capability: caps.READ_USERS,
          tenantId: 'tenant-a',
        });
        expect(await held(ROLE, 'editor')).toEqual([
          `-:${caps.READ_USERS}`,
          `tenant-b:${caps.READ_USERS}`,
        ]);
        await stores().revokeCapability({
          principalType: ROLE,
          principalId: 'editor',
          capability: caps.READ_USERS,
        });
        expect(await held(ROLE, 'editor')).toEqual([`tenant-b:${caps.READ_USERS}`]);
      });

      it('throws for a user id string that is not a valid id', async () => {
        await expect(
          stores().revokeCapability({
            principalType: USER,
            principalId: 'bad',
            capability: caps.READ_USERS,
          }),
        ).rejects.toThrow();
      });
    });

    describe('hasCapabilityForPrincipals', () => {
      const has = (
        principals: Array<{ principalType: PrincipalType; principalId?: string }>,
        capability: SystemCapability,
        tenantId?: string,
      ) => stores().hasCapabilityForPrincipals({ principals, capability, tenantId });

      it('is true when any principal holds the capability', async () => {
        const userId = harness.ids.generate();
        const groupId = harness.ids.generate();
        await grant(ROLE, SystemRoles.ADMIN, caps.ACCESS_ADMIN);
        await grant(USER, userId, caps.READ_USERS);
        await grant(GROUP, groupId, caps.READ_GROUPS);
        expect(
          await has(
            [
              { principalType: USER, principalId: harness.ids.generate() },
              { principalType: ROLE, principalId: SystemRoles.ADMIN },
            ],
            caps.ACCESS_ADMIN,
          ),
        ).toBe(true);
        expect(await has([{ principalType: USER, principalId: userId }], caps.READ_USERS)).toBe(
          true,
        );
        expect(
          await stores().hasCapabilityForPrincipals({
            principals: [{ principalType: GROUP, principalId: harness.ids.toStoreId(groupId) }],
            capability: caps.READ_GROUPS,
          }),
        ).toBe(true);
      });

      it('is false without a match, without principals, or with public principals only', async () => {
        await grant(ROLE, SystemRoles.ADMIN, caps.ACCESS_ADMIN);
        expect(
          await has([{ principalType: ROLE, principalId: SystemRoles.USER }], caps.ACCESS_ADMIN),
        ).toBe(false);
        expect(await has([], caps.ACCESS_ADMIN)).toBe(false);
        expect(await has([{ principalType: PrincipalType.PUBLIC }], caps.ACCESS_ADMIN)).toBe(false);
        expect(await has([{ principalType: ROLE }], caps.ACCESS_ADMIN)).toBe(false);
      });

      it.each(
        (
          Object.entries(CapabilityImplications) as [SystemCapability, SystemCapability[]][]
        ).flatMap(([broad, implied]) => implied.map((narrow) => [broad, narrow] as const)),
      )('%s implies %s, never the reverse', async (broad, narrow) => {
        const holder = harness.ids.generate();
        const other = harness.ids.generate();
        await grant(USER, holder, broad);
        await grant(USER, other, narrow);
        expect(await has([{ principalType: USER, principalId: holder }], narrow)).toBe(true);
        expect(await has([{ principalType: USER, principalId: other }], broad)).toBe(false);
      });

      it('resolves config sections from the broad and section grants', async () => {
        const manager = harness.ids.generate();
        const reader = harness.ids.generate();
        const assigner = harness.ids.generate();
        await grant(USER, manager, caps.MANAGE_CONFIGS);
        await grant(USER, reader, caps.READ_CONFIGS);
        await grant(USER, assigner, caps.ASSIGN_CONFIGS);
        const of = (principalId: string) => [{ principalType: USER, principalId }];
        expect(await has(of(manager), 'manage:configs:endpoints' as SystemCapability)).toBe(true);
        expect(await has(of(manager), 'read:configs:endpoints' as SystemCapability)).toBe(true);
        expect(await has(of(reader), 'read:configs:endpoints' as SystemCapability)).toBe(true);
        expect(await has(of(reader), 'manage:configs:endpoints' as SystemCapability)).toBe(false);
        expect(await has(of(assigner), 'assign:configs:user' as SystemCapability)).toBe(true);
      });

      it('resolves a section read from the same-section manage grant only', async () => {
        const userId = harness.ids.generate();
        await grant(USER, userId, 'manage:configs:endpoints' as SystemCapability);
        const of = [{ principalType: USER, principalId: userId }];
        expect(await has(of, 'read:configs:endpoints' as SystemCapability)).toBe(true);
        expect(await has(of, 'read:configs:interface' as SystemCapability)).toBe(false);
        expect(await has(of, caps.READ_CONFIGS)).toBe(false);
      });

      it('scopes by tenant: platform grants serve every tenant, tenant grants only theirs', async () => {
        await grant(ROLE, 'platform-role', caps.READ_USERS);
        await grant(ROLE, 'tenant-role', caps.READ_USERS, 'tenant-a');
        const platform = [{ principalType: ROLE, principalId: 'platform-role' }];
        const tenant = [{ principalType: ROLE, principalId: 'tenant-role' }];
        expect(await has(tenant, caps.READ_USERS)).toBe(false);
        expect(await has(platform, caps.READ_USERS, 'tenant-a')).toBe(true);
        expect(await has(tenant, caps.READ_USERS, 'tenant-a')).toBe(true);
        expect(await has(tenant, caps.READ_USERS, 'tenant-b')).toBe(false);
      });
    });

    describe('hasAnyConfigReadAccess', () => {
      const access = (capability: SystemCapability | null, tenantId?: string) => async () => {
        const userId = harness.ids.generate();
        if (capability) {
          await grant(USER, userId, capability, tenantId);
        }
        return stores().hasAnyConfigReadAccess({
          principals: [{ principalType: USER, principalId: userId }],
          tenantId,
        });
      };

      it.each([
        [caps.READ_CONFIGS, true],
        [caps.MANAGE_CONFIGS, true],
        ['read:configs:endpoints', true],
        ['manage:configs:interface', true],
        [caps.ASSIGN_CONFIGS, false],
        [caps.READ_USERS, false],
      ])('is %j → %j', async (capability, expected) => {
        expect(await access(capability as SystemCapability)()).toBe(expected);
      });

      it('is false without any grant, principals or non-public principals', async () => {
        expect(await access(null)()).toBe(false);
        expect(await stores().hasAnyConfigReadAccess({ principals: [] })).toBe(false);
        expect(
          await stores().hasAnyConfigReadAccess({
            principals: [{ principalType: PrincipalType.PUBLIC }],
          }),
        ).toBe(false);
      });

      it('scopes by tenant', async () => {
        await grant(ROLE, 'reader', caps.READ_CONFIGS, 'tenant-a');
        const principals = [{ principalType: ROLE, principalId: 'reader' }];
        expect(await stores().hasAnyConfigReadAccess({ principals })).toBe(false);
        expect(await stores().hasAnyConfigReadAccess({ principals, tenantId: 'tenant-a' })).toBe(
          true,
        );
        expect(await stores().hasAnyConfigReadAccess({ principals, tenantId: 'tenant-b' })).toBe(
          false,
        );
      });
    });

    describe('getHeldCapabilities', () => {
      const heldBy = (
        principals: Array<{ principalType: PrincipalType; principalId?: string }>,
        capabilities: SystemCapability[],
        tenantId?: string,
      ) =>
        stores()
          .getHeldCapabilities({ principals, capabilities, tenantId })
          .then((set) => [...set].sort());

      it('resolves the subset held, directly, by implication or by section parent', async () => {
        await grant(ROLE, 'admin', caps.ACCESS_ADMIN);
        await grant(ROLE, 'admin', caps.MANAGE_USERS);
        await grant(ROLE, 'admin', caps.MANAGE_CONFIGS);
        await grant(ROLE, 'admin', 'manage:configs:endpoints' as SystemCapability);
        const principals = [{ principalType: ROLE, principalId: 'admin' }];
        expect(
          await heldBy(principals, [
            caps.ACCESS_ADMIN,
            caps.READ_USERS,
            caps.READ_GROUPS,
            'read:configs:interface' as SystemCapability,
            'read:configs:endpoints' as SystemCapability,
          ]),
        ).toEqual(
          [
            caps.ACCESS_ADMIN,
            caps.READ_USERS,
            'read:configs:interface',
            'read:configs:endpoints',
          ].sort(),
        );
      });

      it("never resolves a section read from another verb's or section's grant", async () => {
        const userId = harness.ids.generate();
        await grant(USER, userId, caps.ASSIGN_CONFIGS);
        await grant(USER, userId, 'manage:configs:endpoints' as SystemCapability);
        expect(
          await heldBy(
            [{ principalType: USER, principalId: userId }],
            [
              'manage:configs:interface' as SystemCapability,
              'read:configs:interface' as SystemCapability,
            ],
          ),
        ).toEqual([]);
      });

      it('is empty for no principals, no capabilities, or only public or id-less principals', async () => {
        await grant(ROLE, 'admin', caps.ACCESS_ADMIN);
        expect(await heldBy([], [caps.ACCESS_ADMIN])).toEqual([]);
        expect(await heldBy([{ principalType: ROLE, principalId: 'admin' }], [])).toEqual([]);
        expect(
          await heldBy(
            [{ principalType: PrincipalType.PUBLIC }, { principalType: ROLE }],
            [caps.ACCESS_ADMIN],
          ),
        ).toEqual([]);
      });

      it('scopes by tenant', async () => {
        await grant(ROLE, 'admin', caps.READ_USERS);
        await grant(ROLE, 'admin', caps.READ_GROUPS, 'tenant-a');
        const principals = [{ principalType: ROLE, principalId: 'admin' }];
        const asked = [caps.READ_USERS, caps.READ_GROUPS];
        expect(await heldBy(principals, asked)).toEqual([caps.READ_USERS]);
        expect(await heldBy(principals, asked, 'tenant-a')).toEqual(
          [caps.READ_USERS, caps.READ_GROUPS].sort(),
        );
        expect(await heldBy(principals, asked, 'tenant-b')).toEqual([caps.READ_USERS]);
      });
    });

    describe('listGrants and countGrants', () => {
      const seedGrants = async () => {
        await grant(ROLE, 'admin', caps.READ_USERS);
        await grant(ROLE, 'admin', caps.ACCESS_ADMIN);
        await grant(USER, harness.ids.generate(), caps.MANAGE_USERS);
        await grant(GROUP, harness.ids.generate(), caps.READ_GROUPS);
        await grant(ROLE, 'tenant-role', caps.READ_CONFIGS, 'tenant-a');
      };

      it('lists platform grants by principal type then capability, and counts them', async () => {
        await seedGrants();
        const listed = await stores().listGrants();
        expect(listed.map((record) => `${record.principalType}:${record.capability}`)).toEqual([
          `${GROUP}:${caps.READ_GROUPS}`,
          `${ROLE}:${caps.ACCESS_ADMIN}`,
          `${ROLE}:${caps.READ_USERS}`,
          `${USER}:${caps.MANAGE_USERS}`,
        ]);
        expect(await stores().countGrants()).toBe(4);
      });

      it('includes the tenant grants when a tenant is given', async () => {
        await seedGrants();
        expect(await stores().listGrants({ tenantId: 'tenant-a' })).toHaveLength(5);
        expect(await stores().countGrants({ tenantId: 'tenant-a' })).toBe(5);
        expect(await stores().countGrants({ tenantId: 'tenant-b' })).toBe(4);
      });

      it('filters by principal types', async () => {
        await seedGrants();
        expect(capabilitiesOf(await stores().listGrants({ principalTypes: [ROLE] }))).toEqual(
          [caps.ACCESS_ADMIN, caps.READ_USERS].sort(),
        );
        expect(await stores().countGrants({ principalTypes: [USER, GROUP] })).toBe(2);
        expect(await stores().listGrants({ principalTypes: [PrincipalType.PUBLIC] })).toEqual([]);
        expect(await stores().countGrants({ principalTypes: [PrincipalType.PUBLIC] })).toBe(0);
      });

      it('pages with limit and offset, holding the limit to 1..200', async () => {
        await stores().seedSystemGrants();
        const total = Object.values(SystemCapabilities).length;
        expect(await stores().listGrants({ limit: 3 })).toHaveLength(3);
        expect(await stores().listGrants({ limit: 0 })).toHaveLength(1);
        expect(await stores().listGrants({ limit: -5 })).toHaveLength(1);
        const all = await stores().listGrants({ limit: 1000 });
        expect(all).toHaveLength(Math.min(total, 200));
        const page = await stores().listGrants({ limit: 2, offset: 1 });
        expect(capabilitiesOf(page)).toEqual(capabilitiesOf(all.slice(1, 3)));
        expect(await stores().listGrants()).toHaveLength(Math.min(total, 50));
      });
    });

    describe('getCapabilitiesForPrincipal', () => {
      it("lists the principal's grants visible in the scope", async () => {
        const userId = harness.ids.generate();
        await grant(USER, userId, caps.READ_USERS);
        await grant(USER, userId, caps.READ_GROUPS, 'tenant-a');
        await grant(USER, userId, caps.READ_ROLES, 'tenant-b');
        await grant(USER, harness.ids.generate(), caps.MANAGE_USERS);
        const read = (tenantId?: string) =>
          stores()
            .getCapabilitiesForPrincipal({ principalType: USER, principalId: userId, tenantId })
            .then(capabilitiesOf);
        expect(await read()).toEqual([caps.READ_USERS]);
        expect(await read('tenant-a')).toEqual([caps.READ_GROUPS, caps.READ_USERS].sort());
        const viaId = await stores().getCapabilitiesForPrincipal({
          principalType: USER,
          principalId: harness.ids.toStoreId(userId),
        });
        expect(capabilitiesOf(viaId)).toEqual([caps.READ_USERS]);
        expect(idOf(harness, viaId[0].principalId)).toBe(userId);
      });

      it('lists every seeded ADMIN capability, and nothing for a principal without grants', async () => {
        await stores().seedSystemGrants();
        expect(
          capabilitiesOf(
            await stores().getCapabilitiesForPrincipal({
              principalType: ROLE,
              principalId: SystemRoles.ADMIN,
            }),
          ),
        ).toEqual(Object.values(SystemCapabilities).sort());
        expect(
          await stores().getCapabilitiesForPrincipal({
            principalType: ROLE,
            principalId: SystemRoles.USER,
          }),
        ).toEqual([]);
      });

      it('throws for a user id string that is not a valid id', async () => {
        await expect(
          stores().getCapabilitiesForPrincipal({ principalType: USER, principalId: 'bad' }),
        ).rejects.toThrow();
      });
    });

    describe('getCapabilitiesForPrincipals', () => {
      it('lists the grants of every principal visible in the scope, skipping the public', async () => {
        const userId = harness.ids.generate();
        const groupId = harness.ids.generate();
        await grant(USER, userId, caps.READ_USERS);
        await grant(USER, userId, caps.READ_ROLES);
        await grant(GROUP, groupId, caps.READ_GROUPS, 'tenant-a');
        await grant(ROLE, 'other', caps.ACCESS_ADMIN);
        const principals = [
          { principalType: USER, principalId: userId },
          { principalType: GROUP, principalId: groupId },
          { principalType: PrincipalType.PUBLIC, principalId: 'anyone' },
        ];
        expect(capabilitiesOf(await stores().getCapabilitiesForPrincipals({ principals }))).toEqual(
          [caps.READ_ROLES, caps.READ_USERS].sort(),
        );
        expect(
          capabilitiesOf(
            await stores().getCapabilitiesForPrincipals({ principals, tenantId: 'tenant-a' }),
          ),
        ).toEqual([caps.READ_GROUPS, caps.READ_ROLES, caps.READ_USERS].sort());
      });

      it('is empty for no principals or public principals only', async () => {
        await grant(ROLE, 'admin', caps.ACCESS_ADMIN);
        expect(await stores().getCapabilitiesForPrincipals({ principals: [] })).toEqual([]);
        expect(
          await stores().getCapabilitiesForPrincipals({
            principals: [{ principalType: PrincipalType.PUBLIC, principalId: 'x' }],
          }),
        ).toEqual([]);
      });
    });

    describe('findGrantsForPrincipal and deleteGrantsForPrincipal', () => {
      const seedScopes = async () => {
        await grant(ROLE, 'editor', caps.READ_USERS);
        await grant(ROLE, 'editor', caps.READ_CONFIGS);
        await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-a');
        await grant(ROLE, 'editor', caps.READ_GROUPS, 'tenant-b');
        await grant(ROLE, 'writer', caps.READ_USERS);
      };

      it('reads the grants of exactly one scope without removing them', async () => {
        await seedScopes();
        expect(capabilitiesOf(await stores().findGrantsForPrincipal(ROLE, 'editor'))).toEqual(
          [caps.READ_CONFIGS, caps.READ_USERS].sort(),
        );
        expect(
          capabilitiesOf(
            await stores().findGrantsForPrincipal(ROLE, 'editor', { tenantId: 'tenant-a' }),
          ),
        ).toEqual([caps.READ_USERS]);
        expect(await harness.readRaw('systemgrants')).toHaveLength(5);
      });

      it('deletes the platform grants only without a tenant, resolving them as they were', async () => {
        await seedScopes();
        const removed = await stores().deleteGrantsForPrincipal(ROLE, 'editor');
        expect(capabilitiesOf(removed)).toEqual([caps.READ_CONFIGS, caps.READ_USERS].sort());
        expect(removed.every((record) => record.principalId === 'editor')).toBe(true);
        expect(await held(ROLE, 'editor')).toEqual([
          `tenant-a:${caps.READ_USERS}`,
          `tenant-b:${caps.READ_GROUPS}`,
        ]);
        expect(await held(ROLE, 'writer')).toEqual([`-:${caps.READ_USERS}`]);
      });

      it("deletes exactly the tenant's grants with a tenant", async () => {
        await seedScopes();
        const removed = await stores().deleteGrantsForPrincipal(ROLE, 'editor', {
          tenantId: 'tenant-a',
        });
        expect(capabilitiesOf(removed)).toEqual([caps.READ_USERS]);
        expect(await held(ROLE, 'editor')).toEqual([
          `-:${caps.READ_CONFIGS}`,
          `-:${caps.READ_USERS}`,
          `tenant-b:${caps.READ_GROUPS}`,
        ]);
      });

      it('deletes a group principal given its id in either form, and nothing for others', async () => {
        const groupId = harness.ids.generate();
        await grant(GROUP, groupId, caps.READ_GROUPS);
        await grant(GROUP, groupId, caps.READ_USERS);
        expect(await stores().deleteGrantsForPrincipal(GROUP, harness.ids.generate())).toEqual([]);
        expect(
          capabilitiesOf(
            await stores().findGrantsForPrincipal(GROUP, harness.ids.toStoreId(groupId)),
          ),
        ).toEqual([caps.READ_GROUPS, caps.READ_USERS].sort());
        expect(
          await stores().deleteGrantsForPrincipal(GROUP, harness.ids.toStoreId(groupId)),
        ).toHaveLength(2);
        expect(await harness.readRaw('systemgrants')).toEqual([]);
      });
    });

    describe('moveGrantsToPrincipal and restoreMovedGrants', () => {
      it('re-keys every grant to the new name, keeping identity and history', async () => {
        const { grant: readUsers } = await grant(ROLE, 'editor', caps.READ_USERS);
        await grant(ROLE, 'editor', caps.READ_CONFIGS);
        const move = await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer');
        expect(capabilitiesOf(move.moved)).toEqual([caps.READ_CONFIGS, caps.READ_USERS].sort());
        expect(move.superseded).toEqual([]);
        expect(await held(ROLE, 'editor')).toEqual([]);
        expect(await held(ROLE, 'writer')).toEqual(
          [`-:${caps.READ_CONFIGS}`, `-:${caps.READ_USERS}`].sort(),
        );
        const after = (
          await readRawWhere(harness, 'systemgrants', { _id: idOf(harness, readUsers?._id) })
        )[0];
        expect(after.principalId).toBe('writer');
        expect(timeOf(after.grantedAt)).toBe(timeOf(readUsers?.grantedAt));
      });

      it('moves one scope only: the tenant given, or the platform-level grants', async () => {
        await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-a');
        await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-b');
        await grant(ROLE, 'editor', caps.READ_CONFIGS);
        await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer', { tenantId: 'tenant-a' });
        expect(await held(ROLE, 'writer')).toEqual([`tenant-a:${caps.READ_USERS}`]);
        const move = await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer');
        expect(capabilitiesOf(move.moved)).toEqual([caps.READ_CONFIGS]);
        expect(await held(ROLE, 'editor')).toEqual([`tenant-b:${caps.READ_USERS}`]);
        expect(await held(ROLE, 'writer')).toEqual([
          `-:${caps.READ_CONFIGS}`,
          `tenant-a:${caps.READ_USERS}`,
        ]);
      });

      it('removes a grant the new name already holds instead of duplicating it', async () => {
        await grant(ROLE, 'editor', caps.READ_USERS);
        await grant(ROLE, 'editor', caps.READ_CONFIGS);
        await grant(ROLE, 'writer', caps.READ_USERS);
        const move = await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer');
        expect(capabilitiesOf(move.moved)).toEqual([caps.READ_CONFIGS]);
        expect(capabilitiesOf(move.superseded)).toEqual([caps.READ_USERS]);
        expect(move.superseded[0].principalId).toBe('editor');
        expect(await held(ROLE, 'editor')).toEqual([]);
        expect(await held(ROLE, 'writer')).toEqual(
          [`-:${caps.READ_CONFIGS}`, `-:${caps.READ_USERS}`].sort(),
        );
      });

      it('resolves nothing and writes nothing for a principal without grants', async () => {
        await grant(ROLE, 'writer', caps.READ_USERS);
        expect(await stores().moveGrantsToPrincipal(ROLE, 'none', 'writer')).toEqual({
          moved: [],
          superseded: [],
        });
        expect(await held(ROLE, 'writer')).toEqual([`-:${caps.READ_USERS}`]);
      });

      it('restores the source exactly, leaving grants the target held before untouched', async () => {
        const { grant: readUsers } = await grant(ROLE, 'editor', caps.READ_USERS);
        const { grant: readConfigs } = await grant(ROLE, 'editor', caps.READ_CONFIGS);
        await grant(ROLE, 'writer', caps.READ_USERS);
        const move = await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer');
        await stores().restoreMovedGrants(ROLE, 'editor', 'writer', move);
        expect(await held(ROLE, 'editor')).toEqual(
          [`-:${caps.READ_CONFIGS}`, `-:${caps.READ_USERS}`].sort(),
        );
        expect(await held(ROLE, 'writer')).toEqual([`-:${caps.READ_USERS}`]);
        const restored = await readRawWhere(harness, 'systemgrants', { principalId: 'editor' });
        expect(restored.map((record) => record._id).sort()).toEqual(
          [idOf(harness, readUsers?._id), idOf(harness, readConfigs?._id)].sort(),
        );
        const recreated = restored.find((record) => record._id === idOf(harness, readUsers?._id));
        expect(timeOf(recreated?.grantedAt)).toBe(timeOf(readUsers?.grantedAt));
      });

      it('never re-creates a moved grant that was revoked before the undo', async () => {
        await grant(ROLE, 'editor', caps.READ_USERS);
        await grant(ROLE, 'editor', caps.READ_CONFIGS);
        const move = await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer');
        await stores().revokeCapability({
          principalType: ROLE,
          principalId: 'writer',
          capability: caps.READ_USERS,
        });
        await stores().restoreMovedGrants(ROLE, 'editor', 'writer', move);
        expect(await held(ROLE, 'editor')).toEqual([`-:${caps.READ_CONFIGS}`]);
        expect(await held(ROLE, 'writer')).toEqual([]);
      });

      it('re-creates a superseded grant only while the target still holds its replacement', async () => {
        await grant(ROLE, 'editor', caps.READ_USERS);
        await grant(ROLE, 'editor', caps.READ_CONFIGS);
        await grant(ROLE, 'writer', caps.READ_USERS);
        await grant(ROLE, 'writer', caps.READ_CONFIGS);
        const move = await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer');
        await stores().revokeCapability({
          principalType: ROLE,
          principalId: 'writer',
          capability: caps.READ_USERS,
        });
        await stores().restoreMovedGrants(ROLE, 'editor', 'writer', move);
        expect(move.superseded).toHaveLength(2);
        expect(await held(ROLE, 'editor')).toEqual([`-:${caps.READ_CONFIGS}`]);
        expect(await held(ROLE, 'writer')).toEqual([`-:${caps.READ_CONFIGS}`]);
      });

      it('restores tenant-scoped moves in their scope', async () => {
        await grant(ROLE, 'editor', caps.READ_USERS, 'tenant-a');
        await grant(ROLE, 'writer', caps.READ_USERS, 'tenant-a');
        await grant(ROLE, 'editor', caps.READ_GROUPS, 'tenant-a');
        const move = await stores().moveGrantsToPrincipal(ROLE, 'editor', 'writer', {
          tenantId: 'tenant-a',
        });
        await stores().restoreMovedGrants(ROLE, 'editor', 'writer', move);
        expect(await held(ROLE, 'editor')).toEqual([
          `tenant-a:${caps.READ_GROUPS}`,
          `tenant-a:${caps.READ_USERS}`,
        ]);
        expect(await held(ROLE, 'writer')).toEqual([`tenant-a:${caps.READ_USERS}`]);
      });
    });
  });
}

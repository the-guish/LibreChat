/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `PrincipalStore` contract (`~/ports/principal`), ported from `methods/principal.spec.ts`:
 * existence of roles, groups and users in the caller's tenant partition (unclaimed principals as
 * platform-level, system roles without documents, canonical ids only) and the user lookup of
 * principal resolution. The method spec's checks that no query is made for a non-canonical id
 * use spies on the models and stay there; here only the answers are pinned. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import { tenantStorage } from '~/config/tenantContext';
import { useContractHarness } from './support';

export function describePrincipalContract(harness: ContractHarness): void {
  describe(`PrincipalStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().principals;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);

    /** A role, group and user seeded raw with the given tenant fields. */
    const seedPrincipals = async (
      label: string,
      tenant: RawRecord = {},
    ): Promise<{ groupId: string; userId: string }> => {
      const groupId = harness.ids.generate();
      const userId = harness.ids.generate();
      await harness.seedRaw('roles', [
        { _id: harness.ids.generate(), name: `${label}-role`, permissions: {}, ...tenant },
      ]);
      await harness.seedRaw('groups', [
        { _id: groupId, name: `${label} group`, source: 'local', memberIds: [], ...tenant },
      ]);
      await harness.seedRaw('users', [
        {
          _id: userId,
          email: `${label}@example.com`,
          provider: 'local',
          role: SystemRoles.USER,
          ...tenant,
        },
      ]);
      return { groupId, userId };
    };
    const existence = ({ groupId, userId }: { groupId: string; userId: string }, label: string) =>
      Promise.all([
        stores().principalExists(PrincipalType.ROLE, `${label}-role`),
        stores().principalExists(PrincipalType.GROUP, groupId),
        stores().principalExists(PrincipalType.USER, userId),
      ]);

    describe('principalExists', () => {
      it('finds platform-level principals, and never a tenant one, for a caller without a tenant', async () => {
        const platform = await seedPrincipals('platform');
        const tenant = await seedPrincipals('tenant', { tenantId: 'tenant-a' });

        expect(await existence(platform, 'platform')).toEqual([true, true, true]);
        expect(await existence(tenant, 'tenant')).toEqual([false, false, false]);
      });

      it('finds only the active tenant principals inside a tenant', async () => {
        const platform = await seedPrincipals('platform');
        const tenantA = await seedPrincipals('a', { tenantId: 'tenant-a' });
        const tenantB = await seedPrincipals('b', { tenantId: 'tenant-b' });

        const [ownA, otherB, platformFromA] = await inTenant('tenant-a', () =>
          Promise.all([
            existence(tenantA, 'a'),
            existence(tenantB, 'b'),
            existence(platform, 'platform'),
          ]),
        );

        expect(ownA).toEqual([true, true, true]);
        expect(otherB).toEqual([false, false, false]);
        expect(platformFromA).toEqual([false, false, false]);
      });

      it('treats an unclaimed principal (null or empty tenant) as platform-level', async () => {
        const nullTenant = await seedPrincipals('null', { tenantId: null });
        const emptyTenant = await seedPrincipals('empty', { tenantId: '' });

        expect(await existence(nullTenant, 'null')).toEqual([true, true, true]);
        expect(await existence(emptyTenant, 'empty')).toEqual([true, true, true]);
      });

      it('matches a role by its exact name only', async () => {
        await harness.seedRaw('roles', [
          { _id: harness.ids.generate(), name: 'Editor', permissions: {} },
        ]);

        expect(await stores().principalExists(PrincipalType.ROLE, 'Editor')).toBe(true);
        expect(await stores().principalExists(PrincipalType.ROLE, 'editor')).toBe(false);
        expect(await stores().principalExists(PrincipalType.ROLE, 'Edit.*')).toBe(false);
      });

      it('counts the system roles as existing without creating their documents', async () => {
        const found = await inTenant('tenant-a', () =>
          Promise.all(
            Object.values(SystemRoles).map((name) =>
              stores().principalExists(PrincipalType.ROLE, name),
            ),
          ),
        );

        expect(found.every(Boolean)).toBe(true);
        expect(await harness.readRaw('roles')).toEqual([]);
      });

      it('refuses an uppercase spelling of a real group or user id', async () => {
        const { groupId, userId } = await seedPrincipals('upper');

        expect(await stores().principalExists(PrincipalType.GROUP, groupId.toUpperCase())).toBe(
          false,
        );
        expect(await stores().principalExists(PrincipalType.USER, userId.toUpperCase())).toBe(
          false,
        );
        expect(await stores().principalExists(PrincipalType.GROUP, groupId)).toBe(true);
        expect(await stores().principalExists(PrincipalType.USER, userId)).toBe(true);
      });

      it('answers false for an id that cannot name a group or user, and for other types', async () => {
        expect(await stores().principalExists(PrincipalType.GROUP, 'grp_engineering')).toBe(false);
        expect(await stores().principalExists(PrincipalType.USER, 'not-an-id')).toBe(false);
        expect(await stores().principalExists(PrincipalType.PUBLIC, 'anyone')).toBe(false);
        expect(await stores().principalExists(PrincipalType.GROUP, harness.ids.generate())).toBe(
          false,
        );
      });

      it('does not find a group id as a user, or a user id as a group', async () => {
        const { groupId, userId } = await seedPrincipals('crossed');
        expect(await stores().principalExists(PrincipalType.USER, groupId)).toBe(false);
        expect(await stores().principalExists(PrincipalType.GROUP, userId)).toBe(false);
      });
    });

    describe('findPrincipalUser', () => {
      it('returns what principal resolution reads and the tenant that holds the user', async () => {
        const platform = await seedPrincipals('platform');
        const tenant = harness.ids.generate();
        await harness.seedRaw('users', [
          {
            _id: tenant,
            email: 'sso@example.com',
            provider: 'openid',
            role: 'EDITOR',
            idOnTheSource: 'entra-oid',
            tenantId: 'tenant-a',
          },
        ]);
        const tenantUser = {
          id: tenant,
          role: 'EDITOR',
          idOnTheSource: 'entra-oid',
          tenantId: 'tenant-a',
        };

        expect(await stores().findPrincipalUser(platform.userId)).toEqual({
          id: platform.userId,
          role: SystemRoles.USER,
          idOnTheSource: null,
        });
        /** Outside a tenant a user is addressed by id, as group and user profiles are. */
        expect(await stores().findPrincipalUser(tenant)).toEqual(tenantUser);
        expect(await inTenant('tenant-a', () => stores().findPrincipalUser(tenant))).toEqual(
          tenantUser,
        );
        expect(await inTenant('tenant-b', () => stores().findPrincipalUser(tenant))).toBeNull();
        expect(
          await inTenant('tenant-a', () => stores().findPrincipalUser(platform.userId)),
        ).toBeNull();
      });

      it('treats an unclaimed user (null or empty tenant) as platform-level', async () => {
        const unset = harness.ids.generate();
        const empty = harness.ids.generate();
        await harness.seedRaw('users', [
          { _id: unset, email: 'u0@example.com', provider: 'local', role: 'USER', tenantId: null },
          { _id: empty, email: 'u1@example.com', provider: 'local', role: 'USER', tenantId: '' },
        ]);

        for (const userId of [unset, empty]) {
          expect(await stores().findPrincipalUser(userId)).toEqual({
            id: userId,
            role: 'USER',
            idOnTheSource: null,
          });
        }
      });

      it('answers null for an id that cannot name a user, an uppercase id, or a missing user', async () => {
        const { userId } = await seedPrincipals('upper');
        expect(await stores().findPrincipalUser('not-an-id')).toBeNull();
        expect(await stores().findPrincipalUser(userId.toUpperCase())).toBeNull();
        expect(await stores().findPrincipalUser(harness.ids.generate())).toBeNull();
      });
    });
  });
}

/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `RoleStore` contract (`~/ports/role`), ported from `methods/role.methods.spec.ts`,
 * `methods/role.cache.spec.ts` and `methods/role.startup.spec.ts`: listings and counts of the
 * caller's tenant partition, the platform defaults (`initializeRoles`, with the legacy
 * `SHARED_GLOBAL` permission and missing permission types), reads by name (the role cache, system
 * roles created on read, projections), the flattened permission updates (legacy top-level
 * permission types and `SHARED_GLOBAL` migrated), custom role creation, rename and deletion
 * (`RoleConflictError`, members moved back to `USER`), and role membership with the auth user
 * document cache every membership change evicts. Legacy shapes are seeded raw. Cases that spy on
 * the cache's call arguments or make it fail, or that turn on strict tenant isolation (a MongoDB
 * plugin cache), stay in the method specs. Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import {
  CacheKeys,
  SystemRoles,
  Permissions,
  roleDefaults,
  PermissionTypes,
  AUTH_USER_DOC_BY_ID_PREFIX,
  AUTH_USER_DOC_EVICTED_PREFIX,
} from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { CacheStore, IRole } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, readRawWhere, useContractHarness } from './support';

type PermissionBlocks = Record<string, Record<string, unknown> | undefined>;

/** A `Map`-backed cache store, with the entries for inspection. */
function fakeCache(): CacheStore & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: async (key) => entries.get(key),
    set: async (key, value) => entries.set(key, value),
    delete: async (key) => entries.delete(key),
  };
}

export function describeRoleContract(harness: ContractHarness): void {
  describe(`RoleStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const originalCacheMode = process.env.AUTH_USER_CACHE_MODE;
    afterEach(() => {
      if (originalCacheMode === undefined) {
        delete process.env.AUTH_USER_CACHE_MODE;
      } else {
        process.env.AUTH_USER_CACHE_MODE = originalCacheMode;
      }
    });

    const stores = () => harness.createStores().roles;
    /** The role store with a fake role cache. */
    const cachedStores = () => {
      const cache = fakeCache();
      const roles = harness.createStores({
        getCache: (key) => (key === CacheKeys.ROLES ? cache : undefined),
      }).roles;
      return { roles, cache };
    };
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);

    /** Seeds a role raw and resolves its id. */
    const seedRole = async (record: RawRecord): Promise<string> => {
      const _id = harness.ids.generate();
      await harness.seedRaw('roles', [{ _id, ...record }]);
      return _id;
    };
    /** Seeds a user raw and resolves its id. */
    const seedUser = async (record: RawRecord): Promise<string> => {
      const _id = harness.ids.generate();
      await harness.seedRaw('users', [
        { _id, email: `${_id}@example.com`, provider: 'local', ...record },
      ]);
      return _id;
    };
    const rawRole = async (id: string) => (await readRawWhere(harness, 'roles', { _id: id }))[0];
    const rawRoles = (name: string) => readRawWhere(harness, 'roles', { name });
    const userRole = async (id: string) =>
      (await readRawWhere(harness, 'users', { _id: id }))[0]?.role;
    const permissionsOf = (record: RawRecord | IRole | null | undefined): PermissionBlocks =>
      ((record as RawRecord | null | undefined)?.permissions ?? {}) as PermissionBlocks;

    /** An `editor` role and member at platform level and in tenant-a, and a tenant-only role. */
    const seedPartitions = async () => ({
      platformRoleId: await seedRole({ name: 'editor', description: 'platform' }),
      platformUserId: await seedUser({ role: 'editor' }),
      tenantRoleId: await seedRole({ name: 'editor', description: 'tenant', tenantId: 'tenant-a' }),
      tenantUserId: await seedUser({ role: 'editor', tenantId: 'tenant-a' }),
      tenantOnlyId: await seedRole({ name: 'tenant-only', tenantId: 'tenant-a' }),
    });

    /**
     * Runs `action` with the auth user document cache on and a cached document for each user,
     * and resolves the users whose cached documents it evicted.
     */
    const evicted = async (
      userIds: string[],
      action: (roles: ReturnType<typeof stores>) => Promise<unknown>,
    ): Promise<string[]> => {
      process.env.AUTH_USER_CACHE_MODE = 'on';
      const cache = fakeCache();
      for (const userId of userIds) {
        cache.entries.set(`${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`, [`doc-${userId}`]);
        cache.entries.set(`doc-${userId}`, { _id: userId });
      }
      const { roles } = harness.createStores({
        getCache: (key) => (key === CacheKeys.AUTH_USER_DOC ? cache : undefined),
      });
      await action(roles);
      return userIds.filter(
        (userId) =>
          !cache.entries.has(`doc-${userId}`) &&
          cache.entries.has(`${AUTH_USER_DOC_EVICTED_PREFIX}:${userId}`),
      );
    };

    describe('listRoles', () => {
      it('returns roles sorted by name, with only their id, name and description', async () => {
        await seedRole({ name: 'zeta', description: 'z', permissions: {} });
        await seedRole({ name: 'alpha', description: 'a', permissions: {} });
        await seedRole({ name: 'mid' });

        const roles = await stores().listRoles();
        expect(roles.map(({ name }) => name)).toEqual(['alpha', 'mid', 'zeta']);
        expect(roles[0].description).toBe('a');
        for (const role of roles) {
          expect(Object.keys(role).sort()).toEqual(
            Object.keys(role).includes('description')
              ? ['_id', 'description', 'name']
              : ['_id', 'name'],
          );
        }
        /** A role stored without a description lists without one. */
        expect(roles[1].description).toBeUndefined();
      });

      it('pages with limit and offset, 50 by default', async () => {
        for (let index = 0; index < 55; index++) {
          await seedRole({ name: `role-${String(index).padStart(2, '0')}` });
        }
        expect(await stores().listRoles()).toHaveLength(50);
        const page = await stores().listRoles({ limit: 2, offset: 3 });
        expect(page.map(({ name }) => name)).toEqual(['role-03', 'role-04']);
        expect(await stores().listRoles({ offset: 54 })).toHaveLength(1);
      });

      it('returns nothing when there are no roles', async () => {
        expect(await stores().listRoles()).toEqual([]);
      });

      it("lists only the caller's partition", async () => {
        await seedPartitions();
        await seedRole({ name: 'unclaimed', tenantId: null });
        expect((await stores().listRoles()).map(({ name }) => name)).toEqual([
          'editor',
          'unclaimed',
        ]);
        expect(
          (await inTenant('tenant-a', () => stores().listRoles())).map(({ name }) => name),
        ).toEqual(['editor', 'tenant-only']);
      });
    });

    describe('countRoles', () => {
      it("counts the caller's partition", async () => {
        expect(await stores().countRoles()).toBe(0);
        await seedPartitions();
        expect(await stores().countRoles()).toBe(1);
        expect(await inTenant('tenant-a', () => stores().countRoles())).toBe(2);
      });
    });

    describe('initializeRoles', () => {
      it('creates the default roles with every permission type', async () => {
        await stores().initializeRoles();
        const admin = (await rawRoles(SystemRoles.ADMIN))[0];
        const user = (await rawRoles(SystemRoles.USER))[0];
        expect(admin.description).toBe('');
        for (const permType of Object.values(PermissionTypes)) {
          expect(permissionsOf(admin)[permType]).toBeDefined();
          expect(permissionsOf(user)[permType]).toBeDefined();
        }
        expect(permissionsOf(admin)[PermissionTypes.PROMPTS]?.SHARE).toBe(true);
        expect(permissionsOf(admin)[PermissionTypes.BOOKMARKS]?.USE).toBe(true);
        expect(permissionsOf(admin)[PermissionTypes.AGENTS]?.CREATE).toBe(true);
        expect(await harness.readRaw('roles')).toHaveLength(2);
      });

      it('keeps existing permissions and adds missing permission types', async () => {
        const prompts = {
          [Permissions.USE]: false,
          [Permissions.CREATE]: true,
          [Permissions.SHARE]: true,
          [Permissions.SHARE_PUBLIC]: false,
        };
        await seedRole({
          name: SystemRoles.USER,
          permissions: {
            [PermissionTypes.PROMPTS]: prompts,
            [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: false },
          },
        });
        await stores().initializeRoles();

        const user = permissionsOf((await rawRoles(SystemRoles.USER))[0]);
        expect(user[PermissionTypes.PROMPTS]).toEqual(prompts);
        expect(user[PermissionTypes.BOOKMARKS]).toEqual({ [Permissions.USE]: false });
        expect(user[PermissionTypes.AGENTS]).toEqual(
          roleDefaults[SystemRoles.USER].permissions[PermissionTypes.AGENTS],
        );
        expect(user[PermissionTypes.MULTI_CONVO]).toEqual(
          roleDefaults[SystemRoles.USER].permissions[PermissionTypes.MULTI_CONVO],
        );
        expect(await rawRoles(SystemRoles.USER)).toHaveLength(1);
      });

      it('fills missing fields of a block without clobbering present ones', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: { [PermissionTypes.AGENTS]: { [Permissions.SHARE]: true } },
        });
        await stores().initializeRoles();
        expect(
          permissionsOf((await rawRoles(SystemRoles.USER))[0])[PermissionTypes.AGENTS],
        ).toEqual({
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
          [Permissions.SHARE]: true,
          [Permissions.SHARE_PUBLIC]: false,
        });
      });

      it('fills an empty block with the defaults', async () => {
        await seedRole({ name: SystemRoles.USER, permissions: { [PermissionTypes.AGENTS]: {} } });
        await stores().initializeRoles();
        const agents = permissionsOf((await rawRoles(SystemRoles.USER))[0])[PermissionTypes.AGENTS];
        expect(agents?.[Permissions.SHARE]).toBe(false);
        expect(agents?.[Permissions.USE]).toBe(true);
      });

      it('sets a missing description to the empty string', async () => {
        await seedRole({ name: SystemRoles.ADMIN, permissions: {} });
        await stores().initializeRoles();
        expect((await rawRoles(SystemRoles.ADMIN))[0].description).toBe('');
      });

      it('is idempotent', async () => {
        await stores().initializeRoles();
        const first = await harness.readRaw('roles');
        await stores().initializeRoles();
        const second = await harness.readRaw('roles');
        expect(second.map(({ _id, permissions }) => ({ _id, permissions }))).toEqual(
          first.map(({ _id, permissions }) => ({ _id, permissions })),
        );
      });

      it.each([
        ['AGENTS', { SHARED_GLOBAL: true }, { SHARE: true, SHARE_PUBLIC: false }],
        ['AGENTS', { SHARED_GLOBAL: false }, { SHARE: false }],
        ['AGENTS', { SHARE: false, SHARED_GLOBAL: true }, { SHARE: false }],
        ['PROMPTS', { SHARED_GLOBAL: true }, { SHARE: true }],
      ])(
        'migrates a legacy %s block %j seeded raw, removing SHARED_GLOBAL',
        async (permType, block, expected) => {
          await seedRole({ name: SystemRoles.USER, permissions: { [permType]: block } });
          await stores().initializeRoles();
          const migrated = permissionsOf((await rawRoles(SystemRoles.USER))[0])[permType];
          expect(migrated).toMatchObject(expected);
          expect(migrated).not.toHaveProperty('SHARED_GLOBAL');
        },
      );

      it('keeps the migrated SHARE across a second run', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: { [PermissionTypes.AGENTS]: { SHARED_GLOBAL: true } },
        });
        await stores().initializeRoles();
        await stores().initializeRoles();
        const agents = permissionsOf((await rawRoles(SystemRoles.USER))[0])[PermissionTypes.AGENTS];
        expect(agents?.[Permissions.SHARE]).toBe(true);
        expect(agents).not.toHaveProperty('SHARED_GLOBAL');
      });

      it("works on the platform roles only, never a tenant's copy, even inside a tenant", async () => {
        const tenantUser = await seedRole({
          name: SystemRoles.USER,
          permissions: { [PermissionTypes.AGENTS]: { SHARED_GLOBAL: true } },
          tenantId: 'tenant-a',
        });
        await inTenant('tenant-a', () => stores().initializeRoles());
        const platform = (await rawRoles(SystemRoles.USER)).filter(
          (role) => role._id !== tenantUser,
        );
        expect(platform).toHaveLength(1);
        expect(platform[0].tenantId ?? null).toBeNull();
        expect(permissionsOf(await rawRole(tenantUser))[PermissionTypes.AGENTS]).toEqual({
          SHARED_GLOBAL: true,
        });
      });
    });

    describe('getRoleByName', () => {
      it('reads the role with the fields the projection selects', async () => {
        const id = await seedRole({
          name: 'editor',
          description: 'Can edit',
          permissions: { [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: true } },
        });
        const role = await stores().getRoleByName('editor');
        expect(idOf(harness, role._id)).toBe(id);
        expect(role).toMatchObject({
          name: 'editor',
          description: 'Can edit',
          permissions: { [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: true } },
        });
        const named = await stores().getRoleByName('editor', 'name');
        expect(named.name).toBe('editor');
        expect(named).not.toHaveProperty('description');
        expect(named).not.toHaveProperty('permissions');
        const withoutId = await stores().getRoleByName('editor', '-_id -__v');
        expect(withoutId).not.toHaveProperty('_id');
        expect(withoutId.description).toBe('Can edit');
      });

      it('creates a missing system role with its defaults, once', async () => {
        const role = await stores().getRoleByName(SystemRoles.USER);
        expect(role.name).toBe(SystemRoles.USER);
        expect(role.permissions).toMatchObject(roleDefaults[SystemRoles.USER].permissions);
        await stores().getRoleByName(SystemRoles.USER);
        expect(await rawRoles(SystemRoles.USER)).toHaveLength(1);
      });

      it('resolves null for a missing custom role, creating nothing', async () => {
        expect(await stores().getRoleByName('missing')).toBeNull();
        expect(await harness.readRaw('roles')).toEqual([]);
      });

      it('reads the platform role outside a tenant, though an older tenant role has its name', async () => {
        await seedRole({ name: 'editor', description: 'tenant', tenantId: 'tenant-a' });
        const platformId = await seedRole({ name: 'editor', description: 'platform' });
        await seedRole({ name: 'tenant-only', tenantId: 'tenant-a' });
        expect(idOf(harness, (await stores().getRoleByName('editor'))._id)).toBe(platformId);
        expect(await stores().getRoleByName('tenant-only')).toBeNull();
      });

      it('creates a missing system role at platform level outside a tenant', async () => {
        await seedRole({ name: SystemRoles.USER, tenantId: 'tenant-a' });
        const role = await stores().getRoleByName(SystemRoles.USER);
        expect(role.tenantId ?? null).toBeNull();
        expect(await rawRoles(SystemRoles.USER)).toHaveLength(2);
      });

      it('serves a cached role as it was first read, whatever the projection', async () => {
        const { roles } = cachedStores();
        const id = await seedRole({ name: 'editor', description: 'first' });
        const first = await roles.getRoleByName('editor', 'name');
        expect(first).not.toHaveProperty('description');
        await harness.reset();
        await seedRole({ name: 'editor', description: 'changed' });
        const cached = await roles.getRoleByName('editor');
        expect(idOf(harness, cached._id)).toBe(id);
        expect(cached).not.toHaveProperty('description');
      });

      it('does not serve one tenant a cached role of another tenant', async () => {
        const { roles } = cachedStores();
        await seedRole({ name: 'editor', description: 'a', tenantId: 'tenant-a' });
        await seedRole({ name: 'editor', description: 'b', tenantId: 'tenant-b' });
        await seedRole({ name: 'editor', description: 'platform' });
        expect((await inTenant('tenant-a', () => roles.getRoleByName('editor'))).description).toBe(
          'a',
        );
        expect((await inTenant('tenant-b', () => roles.getRoleByName('editor'))).description).toBe(
          'b',
        );
        expect((await roles.getRoleByName('editor')).description).toBe('platform');
        expect((await inTenant('tenant-a', () => roles.getRoleByName('editor'))).description).toBe(
          'a',
        );
      });
    });

    describe('getPartitionRole', () => {
      it("reads the caller's partition only, and null for a missing custom role", async () => {
        const ids = await seedPartitions();
        expect(idOf(harness, (await stores().getPartitionRole('editor'))?._id)).toBe(
          ids.platformRoleId,
        );
        expect(await stores().getPartitionRole('tenant-only')).toBeNull();
        const tenant = await inTenant('tenant-a', () => stores().getPartitionRole('editor'));
        expect(idOf(harness, tenant?._id)).toBe(ids.tenantRoleId);
        expect(tenant).toMatchObject({ name: 'editor', description: 'tenant' });
        expect(tenant).not.toHaveProperty('__v');
      });

      it('creates a missing system role in the partition that reads it, past the cache', async () => {
        const { roles, cache } = cachedStores();
        await seedRole({ name: SystemRoles.USER, tenantId: 'tenant-a' });
        cache.entries.set(SystemRoles.USER, { name: SystemRoles.USER, description: 'cached' });

        const platform = await roles.getPartitionRole(SystemRoles.USER);
        expect(platform?.name).toBe(SystemRoles.USER);
        expect(platform?.tenantId ?? null).toBeNull();
        expect(platform?.description).not.toBe('cached');
        expect(await rawRoles(SystemRoles.USER)).toHaveLength(2);

        await inTenant('tenant-b', () => roles.getPartitionRole(SystemRoles.ADMIN));
        const created = await rawRoles(SystemRoles.ADMIN);
        expect(created).toHaveLength(1);
        expect(created[0].tenantId).toBe('tenant-b');
      });

      it('resolves the existing system role when two reads race to create it', async () => {
        const reads = await Promise.all([
          stores().getPartitionRole(SystemRoles.ADMIN),
          stores().getPartitionRole(SystemRoles.ADMIN),
          stores().getPartitionRole(SystemRoles.ADMIN),
        ]);
        expect(reads.every((role) => role?.name === SystemRoles.ADMIN)).toBe(true);
        const stored = await rawRoles(SystemRoles.ADMIN);
        expect(stored).toHaveLength(1);
        expect(new Set(reads.map((role) => idOf(harness, role?._id)))).toEqual(
          new Set([stored[0]._id]),
        );
      });
    });

    describe('findRolesByNames', () => {
      it('matches names ignoring case, past the role cache and any page size', async () => {
        const { roles, cache } = cachedStores();
        for (let index = 0; index < 75; index++) {
          await seedRole({ name: `ROLE-${index}`, permissions: {} });
        }
        await seedRole({ name: 'STANDARD-USER', permissions: {} });
        await seedRole({ name: 'BASIC-USER', permissions: {} });

        const found = await roles.findRolesByNames(['standard-user', ' BASIC-user ', ''], 'name');
        expect(found.map(({ name }) => name).sort()).toEqual(['BASIC-USER', 'STANDARD-USER']);
        expect(found[0]).not.toHaveProperty('permissions');
        expect(cache.entries.size).toBe(0);
      });

      it('matches names literally, never as patterns', async () => {
        await seedRole({ name: 'editor' });
        expect(await stores().findRolesByNames(['edit.*', 'EDITO'])).toEqual([]);
      });

      it('resolves nothing for blank names', async () => {
        await seedRole({ name: 'editor' });
        expect(await stores().findRolesByNames(['', '  '])).toEqual([]);
        expect(await stores().findRolesByNames([])).toEqual([]);
      });

      it('reads the active tenant only, and outside a tenant only platform roles', async () => {
        await seedRole({ name: 'TENANT-ROLE', tenantId: 'tenant-a' });
        await seedRole({ name: 'TENANT-ROLE', tenantId: 'tenant-b' });
        await seedRole({ name: 'BASE-ROLE' });
        await seedRole({ name: 'NULL-ROLE', tenantId: null });

        const inA = await inTenant('tenant-a', () =>
          stores().findRolesByNames(['tenant-role', 'base-role']),
        );
        expect(inA.map((role) => [role.name, role.tenantId])).toEqual([
          ['TENANT-ROLE', 'tenant-a'],
        ]);
        const base = await stores().findRolesByNames(['tenant-role', 'base-role', 'null-role']);
        expect(base.map(({ name }) => name).sort()).toEqual(['BASE-ROLE', 'NULL-ROLE']);
      });
    });

    describe('updateRoleByName', () => {
      it('sets the given fields and resolves the role updated, without __v', async () => {
        const id = await seedRole({ name: 'editor', description: 'old', permissions: {} });
        const updated = await stores().updateRoleByName('editor', { description: 'new' });
        expect(idOf(harness, updated._id)).toBe(id);
        expect(updated).toMatchObject({ name: 'editor', description: 'new' });
        expect(updated).not.toHaveProperty('__v');
        expect((await rawRole(id)).description).toBe('new');
      });

      it('resolves null for a missing role', async () => {
        expect(await stores().updateRoleByName('missing', { description: 'x' })).toBeNull();
        expect(await harness.readRaw('roles')).toEqual([]);
      });

      it('updates only the role an id names, and nothing once it no longer has the name', async () => {
        const tenantRole = await seedRole({
          name: 'editor',
          description: 'tenant',
          tenantId: 'tenant-a',
        });
        const platformRole = await seedRole({ name: 'editor', description: 'platform' });
        const updated = await stores().updateRoleByName(
          'editor',
          { description: 'changed' },
          { id: platformRole },
        );
        const missed = await stores().updateRoleByName(
          'writer',
          { description: 'never' },
          { id: platformRole },
        );
        expect(idOf(harness, updated._id)).toBe(platformRole);
        expect(missed).toBeNull();
        expect((await rawRole(platformRole)).description).toBe('changed');
        expect((await rawRole(tenantRole)).description).toBe('tenant');
      });

      it('refuses a rename to a name the partition holds with a RoleConflictError', async () => {
        await seedRole({ name: 'editor' });
        await seedRole({ name: 'writer' });
        const failure = await stores()
          .updateRoleByName('editor', { name: 'writer' })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(failure).toMatchObject({
          name: 'RoleConflictError',
          message: 'Role "writer" already exists',
        });
        expect(await rawRoles('editor')).toHaveLength(1);
      });

      it('renames into a name only another tenant holds', async () => {
        await seedRole({ name: 'writer', tenantId: 'tenant-a' });
        await seedRole({ name: 'editor' });
        const renamed = await stores().updateRoleByName('editor', { name: 'writer' });
        expect(renamed.name).toBe('writer');
        expect(await rawRoles('writer')).toHaveLength(2);
      });

      it('moves the cached role to its new name on a rename', async () => {
        const { roles } = cachedStores();
        await seedRole({ name: 'editor', description: 'old' });
        await roles.getRoleByName('editor');
        await roles.updateRoleByName('editor', { name: 'writer', description: 'renamed' });
        expect(await roles.getRoleByName('editor')).toBeNull();
        expect((await roles.getRoleByName('writer')).description).toBe('renamed');
      });

      it('refreshes the cached role on an update', async () => {
        const { roles } = cachedStores();
        await seedRole({ name: 'editor', description: 'old' });
        await roles.getRoleByName('editor');
        await roles.updateRoleByName('editor', { description: 'new' });
        expect((await roles.getRoleByName('editor')).description).toBe('new');
      });
    });

    describe('updateAccessPermissions', () => {
      it('sets the given permissions and keeps the others', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: {
            [PermissionTypes.PROMPTS]: { CREATE: true, USE: true, SHARE: false },
            [PermissionTypes.BOOKMARKS]: { USE: true },
          },
        });
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.PROMPTS]: { SHARE: true },
          [PermissionTypes.MULTI_CONVO]: { USE: true },
        });
        const permissions = permissionsOf((await rawRoles(SystemRoles.USER))[0]);
        expect(permissions[PermissionTypes.PROMPTS]).toEqual({
          CREATE: true,
          USE: true,
          SHARE: true,
        });
        expect(permissions[PermissionTypes.BOOKMARKS]).toEqual({ USE: true });
        expect(permissions[PermissionTypes.MULTI_CONVO]).toEqual({ USE: true });
      });

      it('changes nothing when the values are already set', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: { [PermissionTypes.MULTI_CONVO]: { USE: true } },
        });
        const before = await harness.readRaw('roles');
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.MULTI_CONVO]: { USE: true },
        });
        expect(await harness.readRaw('roles')).toEqual(before);
      });

      it('ignores unknown permission types and nullish values', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: { [PermissionTypes.PROMPTS]: { USE: true } },
        });
        await stores().updateAccessPermissions(SystemRoles.USER, {
          NOT_A_TYPE: { USE: true },
          [PermissionTypes.PROMPTS]: { USE: null as unknown as boolean, CREATE: true },
        });
        const permissions = permissionsOf((await rawRoles(SystemRoles.USER))[0]);
        expect(permissions).not.toHaveProperty('NOT_A_TYPE');
        expect(permissions[PermissionTypes.PROMPTS]).toEqual({ USE: true, CREATE: true });
      });

      it('neither throws nor creates a missing custom role', async () => {
        await expect(
          stores().updateAccessPermissions('NON_EXISTENT_ROLE', {
            [PermissionTypes.PROMPTS]: { CREATE: true },
          }),
        ).resolves.toBeUndefined();
        expect(await harness.readRaw('roles')).toEqual([]);
      });

      it('creates a missing system role and updates it', async () => {
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.BOOKMARKS]: { USE: false },
        });
        const stored = await rawRoles(SystemRoles.USER);
        expect(stored).toHaveLength(1);
        expect(permissionsOf(stored[0])[PermissionTypes.BOOKMARKS]).toEqual({ USE: false });
      });

      it('inherits a legacy SHARED_GLOBAL into SHARE when neither the role nor the update has SHARE', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: {
            [PermissionTypes.PROMPTS]: { USE: true, CREATE: true, SHARED_GLOBAL: true },
            [PermissionTypes.AGENTS]: { USE: true, CREATE: true, SHARED_GLOBAL: false },
          },
        });
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.PROMPTS]: { SHARE_PUBLIC: false },
          [PermissionTypes.AGENTS]: { SHARE_PUBLIC: false },
        });
        const permissions = permissionsOf((await rawRoles(SystemRoles.USER))[0]);
        expect(permissions[PermissionTypes.PROMPTS]).toEqual({
          USE: true,
          CREATE: true,
          SHARE: true,
          SHARE_PUBLIC: false,
        });
        expect(permissions[PermissionTypes.AGENTS]).toEqual({
          USE: true,
          CREATE: true,
          SHARE: false,
          SHARE_PUBLIC: false,
        });
      });

      it('keeps an explicit SHARE of the update over a legacy SHARED_GLOBAL', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: { [PermissionTypes.PROMPTS]: { USE: true, SHARED_GLOBAL: true } },
        });
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.PROMPTS]: { SHARE: false },
        });
        expect(
          permissionsOf((await rawRoles(SystemRoles.USER))[0])[PermissionTypes.PROMPTS],
        ).toEqual({ USE: true, SHARE: false });
      });

      it('migrates SHARED_GLOBAL of a permission type the update does not name', async () => {
        await seedRole({
          name: SystemRoles.USER,
          permissions: {
            [PermissionTypes.PROMPTS]: { USE: true, SHARED_GLOBAL: true },
            [PermissionTypes.AGENTS]: { USE: true, SHARE: true, SHARED_GLOBAL: false },
            [PermissionTypes.MULTI_CONVO]: { USE: false },
          },
        });
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.MULTI_CONVO]: { USE: true },
        });
        const permissions = permissionsOf((await rawRoles(SystemRoles.USER))[0]);
        expect(permissions[PermissionTypes.PROMPTS]).toEqual({ USE: true, SHARE: true });
        expect(permissions[PermissionTypes.AGENTS]).toEqual({ USE: true, SHARE: true });
        expect(permissions[PermissionTypes.MULTI_CONVO]).toEqual({ USE: true });
      });

      it('migrates a legacy top-level permission type into the permissions', async () => {
        const id = await seedRole({
          name: SystemRoles.USER,
          permissions: { [PermissionTypes.BOOKMARKS]: { USE: true } },
          [PermissionTypes.PROMPTS]: { USE: false, CREATE: true },
        });
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.BOOKMARKS]: { USE: false },
        });
        const stored = await rawRole(id);
        expect(permissionsOf(stored)[PermissionTypes.PROMPTS]).toEqual({
          USE: false,
          CREATE: true,
        });
        expect(permissionsOf(stored)[PermissionTypes.BOOKMARKS]).toEqual({ USE: false });
        // NOTE(contract): the migration's `$unset` of the legacy top-level field goes through the
        // strict model, which strips undeclared paths, so the old top-level copy stays stored,
        // and every later update merges it over the permissions again: a value set since then
        // reverts to the legacy one on the next update of any permission type.
        expect(stored[PermissionTypes.PROMPTS]).toEqual({ USE: false, CREATE: true });
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.PROMPTS]: { USE: true },
        });
        expect(permissionsOf(await rawRole(id))[PermissionTypes.PROMPTS]?.USE).toBe(true);
        await stores().updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.BOOKMARKS]: { USE: true },
        });
        expect(permissionsOf(await rawRole(id))[PermissionTypes.PROMPTS]?.USE).toBe(false);
      });

      it('writes to the role it was given, never another of its name', async () => {
        const tenantRole = await seedRole({
          name: 'editor',
          permissions: {},
          tenantId: 'tenant-a',
        });
        const platformRole = await seedRole({ name: 'editor', permissions: {} });
        const platform = await inTenant('tenant-a', () => stores().getPartitionRole('editor'));
        expect(idOf(harness, platform?._id)).toBe(tenantRole);

        await stores().updateAccessPermissions(
          'editor',
          { [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: true } },
          platform as IRole,
        );
        expect(permissionsOf(await rawRole(tenantRole))[PermissionTypes.BOOKMARKS]).toEqual({
          [Permissions.USE]: true,
        });
        expect(
          permissionsOf(await rawRole(platformRole))[PermissionTypes.BOOKMARKS],
        ).toBeUndefined();
      });

      it('writes by name the platform role outside a tenant, also with a role read without its id', async () => {
        const tenantRole = await seedRole({
          name: 'editor',
          description: 'tenant',
          permissions: {},
          tenantId: 'tenant-a',
        });
        const platformRole = await seedRole({
          name: 'editor',
          description: 'platform',
          permissions: {},
        });
        await stores().updateAccessPermissions('editor', {
          [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: true },
        });
        const withoutId = await stores().getRoleByName('editor', '-_id -__v');
        await stores().updateAccessPermissions(
          'editor',
          { [PermissionTypes.PROMPTS]: { [Permissions.USE]: false } },
          withoutId,
        );
        expect(permissionsOf(await rawRole(platformRole))).toMatchObject({
          [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: true },
          [PermissionTypes.PROMPTS]: { [Permissions.USE]: false },
        });
        expect(permissionsOf(await rawRole(tenantRole))).toEqual({});
      });

      it('refreshes the cached role', async () => {
        const { roles } = cachedStores();
        await seedRole({ name: SystemRoles.USER, permissions: {} });
        await roles.getRoleByName(SystemRoles.USER);
        await roles.updateAccessPermissions(SystemRoles.USER, {
          [PermissionTypes.BOOKMARKS]: { USE: true },
        });
        expect(
          permissionsOf(await roles.getRoleByName(SystemRoles.USER))[PermissionTypes.BOOKMARKS],
        ).toEqual({ USE: true });
      });
    });

    describe('createRoleByName', () => {
      it('creates a custom role with its name trimmed and resolves it as stored', async () => {
        const role = await stores().createRoleByName({
          name: '  editor ',
          description: 'Can edit',
        });
        expect(role).toMatchObject({ name: 'editor', description: 'Can edit' });
        const stored = await rawRoles('editor');
        expect(stored).toHaveLength(1);
        expect(stored[0]._id).toBe(idOf(harness, role._id));
      });

      it('caches the created role', async () => {
        const { roles } = cachedStores();
        await roles.createRoleByName({ name: 'editor', description: 'Can edit' });
        await harness.reset();
        expect((await roles.getRoleByName('editor'))?.description).toBe('Can edit');
      });

      it.each([[''], ['   '], [undefined]])('requires a name (%j)', async (name) => {
        await expect(stores().createRoleByName({ name } as Partial<IRole>)).rejects.toThrow(
          'Role name is required',
        );
      });

      it.each([[SystemRoles.ADMIN], [SystemRoles.USER], ['admin'], [' user ']])(
        'refuses the reserved system name %j',
        async (name) => {
          const failure = await stores()
            .createRoleByName({ name })
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          expect(failure).toMatchObject({ name: 'RoleConflictError' });
          expect((failure as Error).message).toMatch(/reserved system name/);
        },
      );

      it('refuses a name the partition holds, and allows one only another tenant holds', async () => {
        await seedPartitions();
        await expect(stores().createRoleByName({ name: 'editor' })).rejects.toMatchObject({
          name: 'RoleConflictError',
          message: 'Role "editor" already exists',
        });
        await expect(
          inTenant('tenant-a', () => stores().createRoleByName({ name: 'tenant-only' })),
        ).rejects.toMatchObject({ name: 'RoleConflictError' });
        const created = await stores().createRoleByName({ name: 'tenant-only' });
        expect(created.tenantId ?? null).toBeNull();
        const inB = await inTenant('tenant-b', () => stores().createRoleByName({ name: 'editor' }));
        expect(inB.tenantId).toBe('tenant-b');
      });

      it('creates one role when two requests race for a name', async () => {
        const results = await Promise.allSettled([
          stores().createRoleByName({ name: 'racer' }),
          stores().createRoleByName({ name: 'racer' }),
        ]);
        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(
          ({ status }) => status === 'rejected',
        ) as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ name: 'RoleConflictError' });
        expect(await rawRoles('racer')).toHaveLength(1);
      });
    });

    describe('deleteRoleByName', () => {
      it('deletes a custom role and moves its members back to USER', async () => {
        const roleId = await seedRole({ name: 'editor', description: 'x' });
        const member = await seedUser({ role: 'editor' });
        const other = await seedUser({ role: 'writer' });
        const deleted = await stores().deleteRoleByName('editor');
        expect(idOf(harness, deleted?._id)).toBe(roleId);
        expect(deleted?.name).toBe('editor');
        expect(await rawRoles('editor')).toEqual([]);
        expect(await userRole(member)).toBe(SystemRoles.USER);
        expect(await userRole(other)).toBe('writer');
      });

      it('resolves null for a missing role', async () => {
        expect(await stores().deleteRoleByName('missing')).toBeNull();
      });

      it('leaves a role recreated under the name when the expected id no longer matches', async () => {
        await seedRole({ name: 'editor' });
        const member = await seedUser({ role: 'editor' });
        expect(
          await stores().deleteRoleByName('editor', { id: harness.ids.generate() }),
        ).toBeNull();
        expect(await rawRoles('editor')).toHaveLength(1);
        expect(await userRole(member)).toBe('editor');
      });

      it('deletes the role when the expected id matches', async () => {
        const roleId = await seedRole({ name: 'editor' });
        const deleted = await stores().deleteRoleByName('editor', { id: roleId });
        expect(idOf(harness, deleted?._id)).toBe(roleId);
        expect(await rawRoles('editor')).toEqual([]);
      });

      it.each([[SystemRoles.ADMIN], [SystemRoles.USER], ['user']])(
        'refuses to delete the system role %j',
        async (name) => {
          await expect(stores().deleteRoleByName(name)).rejects.toThrow(
            `Cannot delete system role: ${name}`,
          );
        },
      );

      it('evicts the cached role', async () => {
        const { roles } = cachedStores();
        await seedRole({ name: 'editor' });
        await roles.getRoleByName('editor');
        await roles.deleteRoleByName('editor');
        expect(await roles.getRoleByName('editor')).toBeNull();
      });

      it('evicts the cached auth documents of the members it moves', async () => {
        await seedRole({ name: 'editor' });
        const member = await seedUser({ role: 'editor' });
        const other = await seedUser({ role: 'writer' });
        expect(await evicted([member, other], (roles) => roles.deleteRoleByName('editor'))).toEqual(
          [member],
        );
      });

      it("deletes only the platform role and its members' roles, leaving the tenant's", async () => {
        const ids = await seedPartitions();
        const deleted = await stores().deleteRoleByName('editor');
        const refused = await stores().deleteRoleByName('editor', { id: ids.tenantRoleId });
        expect(idOf(harness, deleted?._id)).toBe(ids.platformRoleId);
        expect(refused).toBeNull();
        expect(await userRole(ids.platformUserId)).toBe(SystemRoles.USER);
        expect(await userRole(ids.tenantUserId)).toBe('editor');
        expect((await rawRole(ids.tenantRoleId)).description).toBe('tenant');
      });

      it("deletes only the active tenant's role inside it", async () => {
        const ids = await seedPartitions();
        await inTenant('tenant-a', () => stores().deleteRoleByName('editor'));
        expect(await rawRole(ids.tenantRoleId)).toBeUndefined();
        expect(await userRole(ids.tenantUserId)).toBe(SystemRoles.USER);
        expect((await rawRole(ids.platformRoleId)).description).toBe('platform');
        expect(await userRole(ids.platformUserId)).toBe('editor');
      });
    });

    describe('updateUsersByRole', () => {
      it('moves every member of the role to the new one', async () => {
        const first = await seedUser({ role: 'editor' });
        const second = await seedUser({ role: 'editor' });
        const other = await seedUser({ role: SystemRoles.ADMIN });
        await stores().updateUsersByRole('editor', 'writer');
        expect(await userRole(first)).toBe('writer');
        expect(await userRole(second)).toBe('writer');
        expect(await userRole(other)).toBe(SystemRoles.ADMIN);
      });

      it('is a no-op when nobody holds the role', async () => {
        const other = await seedUser({ role: SystemRoles.USER });
        await stores().updateUsersByRole('editor', 'writer');
        expect(await userRole(other)).toBe(SystemRoles.USER);
      });

      it('evicts the cached auth documents of the members it moves', async () => {
        const member = await seedUser({ role: 'editor' });
        const other = await seedUser({ role: 'writer' });
        expect(
          await evicted([member, other], (roles) => roles.updateUsersByRole('editor', 'writer')),
        ).toEqual([member]);
      });

      it("moves only the caller's partition", async () => {
        const ids = await seedPartitions();
        await stores().updateUsersByRole('editor', 'writer');
        expect(await userRole(ids.platformUserId)).toBe('writer');
        expect(await userRole(ids.tenantUserId)).toBe('editor');
        await inTenant('tenant-a', () => stores().updateUsersByRole('editor', 'author'));
        expect(await userRole(ids.tenantUserId)).toBe('author');
        expect(await userRole(ids.platformUserId)).toBe('writer');
      });
    });

    describe('findUserIdsByRole', () => {
      it("resolves the ids of the role's members in the caller's partition", async () => {
        const ids = await seedPartitions();
        const extra = await seedUser({ role: 'editor' });
        await seedUser({ role: 'writer' });
        expect((await stores().findUserIdsByRole('editor')).sort()).toEqual(
          [ids.platformUserId, extra].sort(),
        );
        expect(await inTenant('tenant-a', () => stores().findUserIdsByRole('editor'))).toEqual([
          ids.tenantUserId,
        ]);
        expect(await stores().findUserIdsByRole('nobody')).toEqual([]);
      });
    });

    describe('updateUsersRoleByIds', () => {
      it('sets the role of the given users only', async () => {
        const first = await seedUser({ role: 'editor' });
        const second = await seedUser({ role: SystemRoles.USER });
        const untouched = await seedUser({ role: 'editor' });
        await stores().updateUsersRoleByIds([first, second], 'writer');
        expect(await userRole(first)).toBe('writer');
        expect(await userRole(second)).toBe('writer');
        expect(await userRole(untouched)).toBe('editor');
      });

      it('with fromRole, changes only the users still on that role', async () => {
        const kept = await seedUser({ role: 'editor' });
        const moved = await seedUser({ role: SystemRoles.ADMIN });
        await stores().updateUsersRoleByIds([kept, moved], 'writer', { fromRole: 'editor' });
        expect(await userRole(kept)).toBe('writer');
        expect(await userRole(moved)).toBe(SystemRoles.ADMIN);
      });

      it('accepts an empty list', async () => {
        await expect(stores().updateUsersRoleByIds([], 'writer')).resolves.toBeUndefined();
      });

      it('evicts the cached auth documents of the users it names', async () => {
        const first = await seedUser({ role: 'editor' });
        const second = await seedUser({ role: 'editor' });
        const other = await seedUser({ role: 'editor' });
        expect(
          (
            await evicted([first, second, other], (roles) =>
              roles.updateUsersRoleByIds([first, second], 'writer'),
            )
          ).sort(),
        ).toEqual([first, second].sort());
      });
    });

    describe('listUsersByRole', () => {
      it('lists the members by id with their id, name, email and avatar only', async () => {
        const first = await seedUser({
          role: 'editor',
          name: 'Ada',
          email: 'ada@example.com',
          avatar: 'a.png',
          username: 'ada',
        });
        const second = await seedUser({ role: 'editor', name: 'Bob', email: 'bob@example.com' });
        await seedUser({ role: 'writer' });
        const users = await stores().listUsersByRole('editor');
        expect(users.map((user) => idOf(harness, user._id))).toEqual([first, second].sort());
        const ada = users.find((user) => idOf(harness, user._id) === first);
        expect(ada).toMatchObject({ name: 'Ada', email: 'ada@example.com', avatar: 'a.png' });
        expect(Object.keys(ada ?? {}).sort()).toEqual(['_id', 'avatar', 'email', 'name']);
        expect(await stores().listUsersByRole('nobody')).toEqual([]);
      });

      it('pages with limit and offset', async () => {
        const ids: string[] = [];
        for (let index = 0; index < 5; index++) {
          ids.push(await seedUser({ role: 'editor' }));
        }
        ids.sort();
        const page = await stores().listUsersByRole('editor', { limit: 2, offset: 1 });
        expect(page.map((user) => idOf(harness, user._id))).toEqual(ids.slice(1, 3));
      });

      it("lists only the caller's partition", async () => {
        const ids = await seedPartitions();
        expect(
          (await stores().listUsersByRole('editor')).map((user) => idOf(harness, user._id)),
        ).toEqual([ids.platformUserId]);
        expect(
          (await inTenant('tenant-a', () => stores().listUsersByRole('editor'))).map((user) =>
            idOf(harness, user._id),
          ),
        ).toEqual([ids.tenantUserId]);
      });
    });

    describe('countUsersByRole', () => {
      it("counts the role's members in the caller's partition", async () => {
        expect(await stores().countUsersByRole('editor')).toBe(0);
        await seedPartitions();
        await seedUser({ role: 'editor' });
        expect(await stores().countUsersByRole('editor')).toBe(2);
        expect(await inTenant('tenant-a', () => stores().countUsersByRole('editor'))).toBe(1);
      });
    });
  });
}

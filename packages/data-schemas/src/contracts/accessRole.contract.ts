/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AccessRoleStore` contract (`~/ports/accessRole`), ported from `methods/accessRole.spec.ts`
 * and `methods/accessRole.tenant.spec.ts`: create, update and delete by `accessRoleId`, the
 * idempotent seeding of the defaults, and the tenant view (defaults with the tenant's own copies
 * substituted by `accessRoleId`, even when a copy moves the id to another resource type). Cases
 * that switch on strict tenant isolation (a MongoDB plugin cache) or spy on the driver's queries
 * stay in the method specs. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { AccessRoleIds, ResourceType, PermissionBits } from 'librechat-data-provider';
import type { ContractHarness } from './harness';
import type { IAccessRole } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { readRawWhere, useContractHarness } from './support';
import { RoleBits } from '~/common';

/** Every default access role `seedDefaultRoles` provides. */
const DEFAULT_ROLE_IDS = [
  AccessRoleIds.AGENT_EDITOR,
  AccessRoleIds.AGENT_OWNER,
  AccessRoleIds.AGENT_VIEWER,
  AccessRoleIds.CODE_ENVIRONMENT_EDITOR,
  AccessRoleIds.CODE_ENVIRONMENT_OWNER,
  AccessRoleIds.CODE_ENVIRONMENT_VIEWER,
  AccessRoleIds.PROMPTGROUP_EDITOR,
  AccessRoleIds.PROMPTGROUP_OWNER,
  AccessRoleIds.PROMPTGROUP_VIEWER,
  AccessRoleIds.MCPSERVER_EDITOR,
  AccessRoleIds.MCPSERVER_OWNER,
  AccessRoleIds.MCPSERVER_VIEWER,
  AccessRoleIds.REMOTE_AGENT_EDITOR,
  AccessRoleIds.REMOTE_AGENT_OWNER,
  AccessRoleIds.REMOTE_AGENT_VIEWER,
  AccessRoleIds.SHARED_LINK_OWNER,
  AccessRoleIds.SHARED_LINK_VIEWER,
  AccessRoleIds.SKILL_EDITOR,
  AccessRoleIds.SKILL_OWNER,
  AccessRoleIds.SKILL_VIEWER,
];

export function describeAccessRoleContract(harness: ContractHarness): void {
  describe(`AccessRoleStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().accessRoles;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const sampleRole: Partial<IAccessRole> = {
      accessRoleId: 'test_viewer',
      name: 'Test Viewer',
      description: 'Test role for viewer permissions',
      resourceType: ResourceType.AGENT,
      permBits: RoleBits.VIEWER,
    };
    const createTenantRole = (tenantId: string, role: Partial<IAccessRole>) =>
      inTenant(tenantId, () => stores().createRole(role));
    /** A tenant that redefines `agent_owner` with EDITOR bits, shadowing the global OWNER row. */
    const shadowAgentOwnerAsEditor = (tenantId: string) =>
      createTenantRole(tenantId, {
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        name: 'tenant-owner',
        resourceType: ResourceType.AGENT,
        permBits: RoleBits.EDITOR,
      });
    const roleIdsOf = (roles: IAccessRole[]) => roles.map((role) => role.accessRoleId).sort();

    describe('createRole', () => {
      it('creates the role as given and stores it', async () => {
        const role = await stores().createRole(sampleRole);
        expect(role).toMatchObject({
          accessRoleId: 'test_viewer',
          name: 'Test Viewer',
          description: 'Test role for viewer permissions',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.VIEWER,
        });
        const stored = await readRawWhere(harness, 'accessroles', { accessRoleId: 'test_viewer' });
        expect(stored).toHaveLength(1);
        expect(stored[0]._id).toBe(harness.ids.toCanonicalString(role._id));
        expect(stored[0].createdAt).toBeInstanceOf(Date);
      });

      it('creates a code environment role', async () => {
        const role = await stores().createRole({
          accessRoleId: AccessRoleIds.CODE_ENVIRONMENT_OWNER,
          name: 'Code Environment Owner',
          resourceType: ResourceType.CODE_ENVIRONMENT,
          permBits: PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE,
        });
        expect(role.resourceType).toBe(ResourceType.CODE_ENVIRONMENT);
      });

      it('stamps the active tenant on a role created inside a tenant', async () => {
        await createTenantRole('tenant-a', sampleRole);
        const stored = await readRawWhere(harness, 'accessroles', { accessRoleId: 'test_viewer' });
        expect(stored[0].tenantId).toBe('tenant-a');
      });

      it('refuses a second role with the same id in the same partition', async () => {
        await stores().createRole(sampleRole);
        const failure = await stores()
          .createRole({ ...sampleRole, name: 'Again' })
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(harness.errors.isDuplicateKey(failure)).toBe(true);
        /** Another tenant may reuse the id. */
        await expect(createTenantRole('tenant-a', sampleRole)).resolves.toBeDefined();
      });
    });

    describe('findRoleByIdentifier', () => {
      it('finds a role by its identifier, and null for an unknown one', async () => {
        await stores().createRole(sampleRole);
        const found = await stores().findRoleByIdentifier('test_viewer');
        expect(found).toMatchObject({ accessRoleId: 'test_viewer', name: 'Test Viewer' });
        expect(await stores().findRoleByIdentifier('missing_role')).toBeNull();
      });

      it('resolves a global default role from inside a tenant context', async () => {
        await stores().seedDefaultRoles();
        const role = await inTenant('tenant-a', () =>
          stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
        );
        expect(role).toMatchObject({
          accessRoleId: AccessRoleIds.AGENT_OWNER,
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.OWNER,
        });
      });

      it("prefers the tenant's own copy of a role over the global one", async () => {
        await stores().seedDefaultRoles();
        await shadowAgentOwnerAsEditor('tenant-a');

        const scoped = await inTenant('tenant-a', () =>
          stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
        );
        const other = await inTenant('tenant-b', () =>
          stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
        );

        expect(scoped).toMatchObject({ tenantId: 'tenant-a', permBits: RoleBits.EDITOR });
        expect(other).toMatchObject({ permBits: RoleBits.OWNER });
        expect(other?.tenantId ?? undefined).toBeUndefined();
      });

      it('prefers the tenant copy whichever was stored first', async () => {
        /** The tenant copy holds the lower id, so it is stored before the global row. */
        const [first, second] = [harness.ids.generate(), harness.ids.generate()].sort();
        await harness.seedRaw('accessroles', [
          {
            _id: first,
            accessRoleId: AccessRoleIds.AGENT_OWNER,
            name: 'tenant-owner',
            resourceType: ResourceType.AGENT,
            permBits: RoleBits.EDITOR,
            tenantId: 'tenant-a',
          },
          {
            _id: second,
            accessRoleId: AccessRoleIds.AGENT_OWNER,
            name: 'com_ui_role_owner',
            resourceType: ResourceType.AGENT,
            permBits: RoleBits.OWNER,
          },
        ]);
        const role = await inTenant('tenant-a', () =>
          stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
        );
        expect(role).toMatchObject({ tenantId: 'tenant-a', permBits: RoleBits.EDITOR });
      });

      it('sees a global role stored with an explicit null tenant from a tenant', async () => {
        await harness.seedRaw('accessroles', [
          {
            _id: harness.ids.generate(),
            accessRoleId: AccessRoleIds.AGENT_OWNER,
            name: 'com_ui_role_owner',
            resourceType: ResourceType.AGENT,
            permBits: RoleBits.OWNER,
            tenantId: null,
          },
        ]);
        const role = await inTenant('tenant-a', () =>
          stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
        );
        expect(role).toMatchObject({ permBits: RoleBits.OWNER });
        expect(role?.tenantId ?? null).toBeNull();
      });

      it("does not resolve another tenant's role", async () => {
        await createTenantRole('tenant-b', {
          accessRoleId: 'tenant_b_owner',
          name: 'tenant-b-owner',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.OWNER,
        });
        expect(
          await inTenant('tenant-a', () => stores().findRoleByIdentifier('tenant_b_owner')),
        ).toBeNull();
      });

      it('isolates tenant-only provisioning', async () => {
        for (const tenantId of ['tenant-a', 'tenant-b']) {
          await inTenant(tenantId, () => stores().seedDefaultRoles());
        }
        await inTenant('tenant-a', async () => {
          const role = await stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER);
          const roles = await stores().findRolesByResourceType(ResourceType.AGENT);
          expect(role?.tenantId).toBe('tenant-a');
          expect(roles).toHaveLength(3);
          expect(roles.every((entry) => entry.tenantId === 'tenant-a')).toBe(true);
        });
        await inTenant('tenant-c', async () => {
          expect(await stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER)).toBeNull();
          expect(await stores().findRolesByResourceType(ResourceType.AGENT)).toEqual([]);
        });
      });
    });

    describe('findRolesByResourceType', () => {
      it('lists the roles of the resource type', async () => {
        for (const role of [
          [AccessRoleIds.AGENT_VIEWER, ResourceType.AGENT, RoleBits.VIEWER],
          [AccessRoleIds.AGENT_EDITOR, ResourceType.AGENT, RoleBits.EDITOR],
          ['project_viewer', 'project', RoleBits.VIEWER],
          ['project_editor', 'project', RoleBits.EDITOR],
        ] as const) {
          await stores().createRole({
            accessRoleId: role[0],
            name: role[0],
            resourceType: role[1],
            permBits: role[2],
          });
        }
        expect(roleIdsOf(await stores().findRolesByResourceType('agent'))).toEqual(
          [AccessRoleIds.AGENT_EDITOR, AccessRoleIds.AGENT_VIEWER].sort(),
        );
        expect(roleIdsOf(await stores().findRolesByResourceType('project'))).toEqual([
          'project_editor',
          'project_viewer',
        ]);
        expect(await stores().findRolesByResourceType('file')).toEqual([]);
      });

      it('returns the global roles for a tenant, with tenant copies overriding', async () => {
        await stores().seedDefaultRoles();
        await createTenantRole('tenant-a', {
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          name: 'tenant-viewer',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.VIEWER,
        });

        const roles = await inTenant('tenant-a', () =>
          stores().findRolesByResourceType(ResourceType.AGENT),
        );
        expect(roleIdsOf(roles)).toEqual(
          [
            AccessRoleIds.AGENT_EDITOR,
            AccessRoleIds.AGENT_OWNER,
            AccessRoleIds.AGENT_VIEWER,
          ].sort(),
        );
        expect(
          roles.find((role) => role.accessRoleId === AccessRoleIds.AGENT_VIEWER),
        ).toMatchObject({ name: 'tenant-viewer', tenantId: 'tenant-a' });
      });

      it('excludes roles belonging to another tenant', async () => {
        await stores().seedDefaultRoles();
        await createTenantRole('tenant-b', {
          accessRoleId: 'tenant_b_role',
          name: 'tenant-b-role',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.VIEWER,
        });
        const roles = await inTenant('tenant-a', () =>
          stores().findRolesByResourceType(ResourceType.AGENT),
        );
        expect(roleIdsOf(roles)).not.toContain('tenant_b_role');
      });

      describe('a tenant override that moves an identifier to another resource type', () => {
        const moveAgentOwnerToSkill = (tenantId: string) =>
          createTenantRole(tenantId, {
            accessRoleId: AccessRoleIds.AGENT_OWNER,
            name: 'tenant-skill-owner',
            resourceType: ResourceType.SKILL,
            permBits: RoleBits.OWNER,
          });

        it('withdraws the shadowed global role from its old resource type', async () => {
          await stores().seedDefaultRoles();
          await moveAgentOwnerToSkill('tenant-a');
          const roles = await inTenant('tenant-a', () =>
            stores().findRolesByResourceType(ResourceType.AGENT),
          );
          expect(roleIdsOf(roles)).not.toContain(AccessRoleIds.AGENT_OWNER);
          /** Other tenants still see the global row. */
          const other = await inTenant('tenant-b', () =>
            stores().findRolesByResourceType(ResourceType.AGENT),
          );
          expect(roleIdsOf(other)).toContain(AccessRoleIds.AGENT_OWNER);
        });

        it('lists the override under its new resource type', async () => {
          await stores().seedDefaultRoles();
          await moveAgentOwnerToSkill('tenant-a');
          const roles = await inTenant('tenant-a', () =>
            stores().findRolesByResourceType(ResourceType.SKILL),
          );
          expect(
            roles.find((role) => role.accessRoleId === AccessRoleIds.AGENT_OWNER),
          ).toMatchObject({ tenantId: 'tenant-a', resourceType: ResourceType.SKILL });
        });

        it('agrees with findRoleByIdentifier on the identifier’s new meaning', async () => {
          await stores().seedDefaultRoles();
          await moveAgentOwnerToSkill('tenant-a');
          const role = await inTenant('tenant-a', () =>
            stores().findRoleByIdentifier(AccessRoleIds.AGENT_OWNER),
          );
          expect(role).toMatchObject({ tenantId: 'tenant-a', resourceType: ResourceType.SKILL });
        });
      });
    });

    describe('updateRole', () => {
      it('sets the given fields and keeps the others', async () => {
        await stores().createRole(sampleRole);
        const updated = await stores().updateRole('test_viewer', {
          name: 'Updated Test Role',
          description: 'Updated description',
        });
        expect(updated).toMatchObject({
          accessRoleId: 'test_viewer',
          name: 'Updated Test Role',
          description: 'Updated description',
          permBits: RoleBits.VIEWER,
        });
        const stored = await readRawWhere(harness, 'accessroles', { accessRoleId: 'test_viewer' });
        expect(stored[0]).toMatchObject({ name: 'Updated Test Role', permBits: RoleBits.VIEWER });
      });

      it('resolves null and creates nothing for an unknown role', async () => {
        expect(await stores().updateRole('missing_role', { name: 'x' })).toBeNull();
        expect(await harness.readRaw('accessroles')).toEqual([]);
      });
    });

    describe('deleteRole', () => {
      it('deletes the role, counting it', async () => {
        await stores().createRole(sampleRole);
        expect((await stores().deleteRole('test_viewer')).deletedCount).toBe(1);
        expect(await stores().findRoleByIdentifier('test_viewer')).toBeNull();
        expect((await stores().deleteRole('test_viewer')).deletedCount).toBe(0);
      });

      it("deletes only the caller's tenant copy inside a tenant", async () => {
        await stores().seedDefaultRoles();
        await shadowAgentOwnerAsEditor('tenant-a');
        expect(
          (await inTenant('tenant-a', () => stores().deleteRole(AccessRoleIds.AGENT_OWNER)))
            .deletedCount,
        ).toBe(1);
        const remaining = await readRawWhere(harness, 'accessroles', {
          accessRoleId: AccessRoleIds.AGENT_OWNER,
        });
        expect(remaining).toHaveLength(1);
        expect(remaining[0].tenantId ?? null).toBeNull();
      });
    });

    describe('seedDefaultRoles', () => {
      it('seeds every default role and resolves them by id', async () => {
        const result = await stores().seedDefaultRoles();
        expect(Object.keys(result).sort()).toEqual([...DEFAULT_ROLE_IDS].sort());
        expect(result[AccessRoleIds.AGENT_OWNER]).toMatchObject({
          accessRoleId: AccessRoleIds.AGENT_OWNER,
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.OWNER,
        });
        expect(await harness.readRaw('accessroles')).toHaveLength(DEFAULT_ROLE_IDS.length);
        expect((await stores().findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER))?.permBits).toBe(
          RoleBits.VIEWER,
        );
        expect((await stores().findRoleByIdentifier(AccessRoleIds.AGENT_EDITOR))?.permBits).toBe(
          RoleBits.EDITOR,
        );
      });

      it('does not modify existing roles, and is idempotent', async () => {
        await stores().createRole({
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          name: 'Custom Viewer',
          description: 'Custom viewer description',
          resourceType: ResourceType.AGENT,
          permBits: RoleBits.VIEWER,
        });
        const result = await stores().seedDefaultRoles();
        expect(result[AccessRoleIds.AGENT_VIEWER]).toMatchObject({ name: 'Custom Viewer' });
        await stores().seedDefaultRoles();
        const role = await stores().findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
        expect(role).toMatchObject({
          name: 'Custom Viewer',
          description: 'Custom viewer description',
        });
        expect(await harness.readRaw('accessroles')).toHaveLength(DEFAULT_ROLE_IDS.length);
      });
    });
  });
}

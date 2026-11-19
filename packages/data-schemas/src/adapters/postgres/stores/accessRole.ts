/**
 * The PostgreSQL `AccessRoleStore` (`~/ports/accessRole`): the access roles on the `accessroles`
 * table, through the collection primitive, with the defaults and the tenant merge of
 * `~/methods/accessRoleRules`. Must not import `mongoose`, `mongodb` or `bson`.
 */
import type { AccessRoleStore } from '~/ports/accessRole';
import type { PostgresStoreContext } from './context';
import type { IAccessRole } from '~/types';
import {
  inTenantScope,
  DEFAULT_ACCESS_ROLES,
  mergeTenantAccessRoles,
} from '~/methods/accessRoleRules';
import { getTenantId, runAsSystem } from '~/config/tenantContext';
import { asRecord } from './context';

export function createPostgresAccessRoleStore(context: PostgresStoreContext): AccessRoleStore {
  const roles = () => context.collections().collection('accessroles');
  const asRole = (record: unknown) => record as IAccessRole;

  /**
   * Every access role visible inside the active tenant: the global defaults with the tenant's
   * own copies substituted by `accessRoleId` (unfiltered first, as on MongoDB, so a copy that
   * changes a field the caller selects on still displaces the default).
   */
  async function visibleTenantRoles(): Promise<IAccessRole[]> {
    const tenantId = getTenantId();
    const found = await runAsSystem(() => roles().find({ tenantId: { $in: [tenantId, null] } }));
    return mergeTenantAccessRoles(found as unknown as IAccessRole[], tenantId);
  }

  const store: AccessRoleStore = {
    async createRole(roleData) {
      return asRole(await roles().insertOne(asRecord(roleData)));
    },

    async updateRole(accessRoleId, updateData) {
      return asRole(
        await roles().findOneAndUpdate(
          { accessRoleId: String(accessRoleId) },
          { $set: asRecord(updateData) },
          { returnDocument: 'after' },
        ),
      );
    },

    async deleteRole(accessRoleId) {
      return roles().deleteOne({ accessRoleId: String(accessRoleId) });
    },

    async seedDefaultRoles() {
      const result: Record<string, IAccessRole> = {};
      for (const role of DEFAULT_ACCESS_ROLES) {
        const upserted = await roles().findOneAndUpdate(
          { accessRoleId: role.accessRoleId },
          { $setOnInsert: { ...role } },
          { upsert: true, returnDocument: 'after' },
        );
        if (upserted) {
          result[role.accessRoleId] = asRole(upserted);
        }
      }
      return result;
    },

    async findRoleByIdentifier(accessRoleId) {
      if (!inTenantScope()) {
        return asRole(await roles().findOne({ accessRoleId: String(accessRoleId) }));
      }
      const visible = await visibleTenantRoles();
      return visible.find((role) => String(role.accessRoleId) === String(accessRoleId)) ?? null;
    },

    async findRolesByResourceType(resourceType) {
      if (!inTenantScope()) {
        return (await roles().find({ resourceType })) as unknown as IAccessRole[];
      }
      const visible = await visibleTenantRoles();
      return visible.filter((role) => role.resourceType === resourceType);
    },
  };
  return store;
}

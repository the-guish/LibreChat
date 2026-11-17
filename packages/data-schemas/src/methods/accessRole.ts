import type { Model, Types, DeleteResult } from 'mongoose';
import type { IAccessRole } from '~/types';
import { DEFAULT_ACCESS_ROLES, inTenantScope, mergeTenantAccessRoles } from './accessRoleRules';
import { getTenantId, runAsSystem } from '~/config/tenantContext';

export function createAccessRoleMethods(mongoose: typeof import('mongoose')): {
  createRole: (roleData: Partial<IAccessRole>) => Promise<IAccessRole>;
  updateRole: (
    accessRoleId: string | Types.ObjectId,
    updateData: Partial<IAccessRole>,
  ) => Promise<IAccessRole | null>;
  deleteRole: (accessRoleId: string | Types.ObjectId) => Promise<DeleteResult>;
  seedDefaultRoles: () => Promise<Record<string, IAccessRole>>;
  findRoleByIdentifier: (accessRoleId: string | Types.ObjectId) => Promise<IAccessRole | null>;
  findRolesByResourceType: (resourceType: string) => Promise<IAccessRole[]>;
} {
  /**
   * Every access role visible inside the active tenant: the global defaults with the
   * tenant's own copies substituted by `accessRoleId`.
   *
   * The default roles are seeded once, globally, with no `tenantId`. A request
   * running inside a tenant context has its queries scoped to `{ tenantId: T }` by
   * the isolation plugin, so those seeded roles never match and every caller that
   * resolves a role by identifier — the owner grant on resource creation above all
   * — fails with `Role <id> not found`.
   *
   * Unfiltered by design: the merge happens first and every selection is applied to
   * its result. Substitution by identifier is only total that way — a tenant copy
   * that changes a field the caller selects on, `resourceType` above all, still has
   * to displace the global row it overrides, and a query that narrowed both sides
   * first would miss the copy and leave that row visible under its old type. The
   * read is bounded to one tenant's roles plus the global defaults, so this is a
   * few dozen small documents rather than a collection scan.
   *
   * The unique index on `(accessRoleId, tenantId)` makes the substitution unambiguous.
   */
  async function visibleTenantRoles(): Promise<IAccessRole[]> {
    const tenantId = getTenantId();
    const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;

    /** Capture the tenant before entering system context, and execute the bounded
     * query inside it. MongoDB's null match includes absent tenantId fields. */
    const roles = await runAsSystem(async () =>
      AccessRole.find({ tenantId: { $in: [tenantId, null] } })
        .lean<IAccessRole[]>()
        .exec(),
    );

    return mergeTenantAccessRoles(roles, tenantId);
  }

  /**
   * Find an access role by its unique identifier
   * @param accessRoleId - The unique identifier (e.g., "agent_viewer")
   * @returns The role document or null if not found
   */
  async function findRoleByIdentifier(
    accessRoleId: string | Types.ObjectId,
  ): Promise<IAccessRole | null> {
    const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;
    if (!inTenantScope()) {
      return await AccessRole.findOne({ accessRoleId }).lean<IAccessRole>().exec();
    }
    const roles = await visibleTenantRoles();
    return roles.find((role) => String(role.accessRoleId) === String(accessRoleId)) ?? null;
  }

  /**
   * Find all access roles for a specific resource type
   *
   * The tenant's own copies are merged over the global default roles by
   * `accessRoleId`, so a tenant that overrides one role still sees the rest.
   *
   * @param resourceType - The type of resource ('agent', 'project', 'file')
   * @returns Array of role documents
   */
  async function findRolesByResourceType(resourceType: string): Promise<IAccessRole[]> {
    const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;
    if (!inTenantScope()) {
      return await AccessRole.find({ resourceType }).lean<IAccessRole[]>().exec();
    }
    /** Filtered after the merge, so a tenant copy that moves an identifier to another
     * resource type withdraws the global row from this list instead of leaving it
     * visible — and callers such as `bulkUpdatePermissions`, which key this result by
     * `accessRoleId`, cannot grant bits the tenant has superseded. */
    const roles = await visibleTenantRoles();
    return roles.filter((role) => role.resourceType === resourceType);
  }

  /**
   * Create a new access role
   * @param roleData - Role data (accessRoleId, name, description, resourceType, permBits)
   * @returns The created role document
   */
  async function createRole(roleData: Partial<IAccessRole>): Promise<IAccessRole> {
    const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;
    return await AccessRole.create(roleData);
  }

  /**
   * Update an existing access role
   * @param accessRoleId - The unique identifier of the role to update
   * @param updateData - Data to update
   * @returns The updated role document or null if not found
   */
  async function updateRole(
    accessRoleId: string | Types.ObjectId,
    updateData: Partial<IAccessRole>,
  ): Promise<IAccessRole | null> {
    const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;
    return await AccessRole.findOneAndUpdate(
      { accessRoleId },
      { $set: updateData },
      { new: true },
    ).lean<IAccessRole>();
  }

  /**
   * Delete an access role
   * @param accessRoleId - The unique identifier of the role to delete
   * @returns The result of the delete operation
   */
  async function deleteRole(accessRoleId: string | Types.ObjectId): Promise<DeleteResult> {
    const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;
    return await AccessRole.deleteOne({ accessRoleId });
  }

  /**
   * Seed default roles if they don't exist
   * @returns Object containing created roles
   */
  async function seedDefaultRoles(): Promise<Record<string, IAccessRole>> {
    const AccessRole = mongoose.models.AccessRole as Model<IAccessRole>;

    const result: Record<string, IAccessRole> = {};

    for (const role of DEFAULT_ACCESS_ROLES) {
      const upsertedRole = await AccessRole.findOneAndUpdate(
        { accessRoleId: role.accessRoleId },
        { $setOnInsert: { ...role } },
        { upsert: true, new: true },
      ).lean<IAccessRole>();

      if (upsertedRole) {
        result[role.accessRoleId] = upsertedRole;
      }
    }

    return result;
  }

  return {
    createRole,
    updateRole,
    deleteRole,
    seedDefaultRoles,
    findRoleByIdentifier,
    findRolesByResourceType,
  };
}

export type AccessRoleMethods = ReturnType<typeof createAccessRoleMethods>;

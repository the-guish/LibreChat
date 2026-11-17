import { CacheKeys, SystemRoles, roleDefaults } from 'librechat-data-provider';
import type { FilterQuery, Model } from 'mongoose';
import type { CacheStore, IRole, IUser } from '~/types';
import {
  roleNamesFilter,
  uniqueRoleNames,
  isSystemRoleName,
  RoleConflictError,
  SYSTEM_ROLE_NAMES,
  filterPermissionsUpdate,
  mergeDefaultPermissions,
  legacySharedGlobalUpdate,
  planRolePermissionsUpdate,
  ROLE_PAGE_DEFAULT_LIMIT,
} from './roleRules';
import { scopedCacheKey, getTenantId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { evictAuthUserDocsForUsers } from '~/utils/eviction';
import logger from '~/config/winston';

export { RoleConflictError } from './roleRules';

const systemRoleValues = SYSTEM_ROLE_NAMES;

export interface RoleDeps {
  /** Returns a cache store for the given key. Injected from getLogStores. */
  getCache?: (key: string) => CacheStore | undefined;
}

export function createRoleMethods(
  mongoose: typeof import('mongoose'),
  deps: RoleDeps = {},
): {
  listRoles: (options?: {
    limit?: number;
    offset?: number;
  }) => Promise<Pick<IRole, '_id' | 'name' | 'description'>[]>;
  countRoles: () => Promise<number>;
  initializeRoles: () => Promise<void>;
  getRoleByName: (roleName: string, fieldsToSelect?: string | string[] | null) => Promise<IRole>;
  getPartitionRole: (roleName: string) => Promise<IRole | null>;
  findRolesByNames: (
    roleNames: string[],
    fieldsToSelect?: string | string[] | null,
  ) => Promise<IRole[]>;
  updateRoleByName: (
    roleName: string,
    updates: Partial<IRole>,
    options?: { id?: string },
  ) => Promise<IRole>;
  updateAccessPermissions: (
    roleName: string,
    permissionsUpdate: Record<string, Record<string, boolean>>,
    roleData?: IRole,
  ) => Promise<void>;
  createRoleByName: (roleData: Partial<IRole>) => Promise<IRole>;
  deleteRoleByName: (roleName: string, options?: { id?: string }) => Promise<IRole | null>;
  updateUsersByRole: (oldRole: string, newRole: string) => Promise<void>;
  findUserIdsByRole: (roleName: string) => Promise<string[]>;
  updateUsersRoleByIds: (
    userIds: string[],
    newRole: string,
    options?: { fromRole?: string },
  ) => Promise<void>;
  listUsersByRole: (
    roleName: string,
    options?: { limit?: number; offset?: number },
  ) => Promise<IUser[]>;
  countUsersByRole: (roleName: string) => Promise<number>;
} {
  /**
   * The users holding `roleName` in the caller's tenant partition (`tenantPartitionFilter`): the
   * active tenant's, or outside a tenant only platform-level ones. Role names are reused across
   * tenants (the role index is unique on name plus `tenantId`), and outside a tenant the tenant
   * plugin scopes nothing, so a filter on the name alone would reach the members of each
   * tenant's own role of that name; the role reads and writes by name below keep to the same
   * partition for the same reason.
   */
  function roleMembersFilter(roleName: string, operation: string): FilterQuery<IUser> {
    return { role: roleName, ...tenantPartitionFilter(operation) };
  }

  /**
   * The role named `roleName` in the caller's tenant partition, or with `id` exactly that role
   * document (which a caller read in its own partition) as long as it still has the name.
   */
  function roleDocumentFilter(
    roleName: string,
    operation: string,
    id?: string,
  ): FilterQuery<IRole> {
    return id
      ? { name: roleName, _id: id }
      : { name: roleName, ...tenantPartitionFilter(operation) };
  }

  /**
   * Initialize platform default roles, never tenant copies, regardless of caller context.
   * Creates the default roles (ADMIN, USER) if they don't exist in the database.
   * Updates existing roles with new permission types if they're missing.
   */
  async function initializeRoles(): Promise<void> {
    return runAsSystem(async () => {
      const Role = mongoose.models.Role;

      for (const roleName of [SystemRoles.ADMIN, SystemRoles.USER]) {
        // Strict mode hides off-schema SHARED_GLOBAL and won't $unset it on save; migrate it via the raw driver.
        const filter = roleDocumentFilter(roleName, 'initializeRoles');
        // eslint-disable-next-line no-restricted-syntax -- Platform-only filter; raw read exposes the off-schema field.
        const legacyDoc = await Role.collection.findOne(filter);
        const legacyUpdate = legacySharedGlobalUpdate(legacyDoc?.permissions);
        if (legacyDoc && legacyUpdate) {
          // eslint-disable-next-line no-restricted-syntax -- Platform-only filter; raw $unset drops the off-schema field.
          await Role.collection.updateOne({ ...filter, _id: legacyDoc._id }, legacyUpdate);
        }
        let role = await Role.findOne(filter);
        const defaultPerms = roleDefaults[roleName].permissions;

        if (!role) {
          role = new Role({ ...roleDefaults[roleName], description: '' });
        } else {
          if (role.description == null) {
            role.description = '';
          }
          const permissions = role.toObject()?.permissions ?? {};
          role.permissions = role.permissions || {};
          const merged = mergeDefaultPermissions(permissions, defaultPerms);
          for (const [permType, block] of Object.entries(merged)) {
            role.permissions[permType] = block;
          }
        }
        await role.save();
      }
    });
  }

  /**
   * List the roles of the caller's tenant partition (`tenantPartitionFilter`), the ones a role
   * name addresses. Returns only name and description (projected).
   */
  async function listRoles(options?: {
    limit?: number;
    offset?: number;
  }): Promise<Pick<IRole, '_id' | 'name' | 'description'>[]> {
    const Role = mongoose.models.Role as Model<IRole>;
    const limit = options?.limit ?? ROLE_PAGE_DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    return await Role.find(tenantPartitionFilter('listRoles'))
      .select('name description')
      .sort({ name: 1 })
      .skip(offset)
      .limit(limit)
      .lean();
  }

  /** Counts the roles {@link listRoles} lists. */
  async function countRoles(): Promise<number> {
    const Role = mongoose.models.Role;
    return await Role.countDocuments(tenantPartitionFilter('countRoles'));
  }

  /**
   * Retrieve the role named `roleName` in the caller's tenant partition (`tenantPartitionFilter`)
   * as a plain object: the active tenant's, or outside a tenant (and under the system context)
   * the platform-level one, never a tenant's role of the same name, which the tenant plugin
   * would not filter out there. The cache key carries the same partition (`scopedCacheKey`).
   * If the role doesn't exist there and the name is a system defined role, it is created there.
   */
  async function getRoleByName(
    roleName: string,
    fieldsToSelect: string | string[] | null = null,
  ): Promise<IRole> {
    const cache = deps.getCache?.(CacheKeys.ROLES);
    try {
      if (cache) {
        const cachedRole = await cache.get(scopedCacheKey(roleName));
        if (cachedRole) {
          return cachedRole as IRole;
        }
      }
      const Role = mongoose.models.Role;
      let query = Role.findOne(roleDocumentFilter(roleName, 'getRoleByName'));
      if (fieldsToSelect) {
        query = query.select(fieldsToSelect);
      }
      const role = await query.lean().exec();

      if (!role && systemRoleValues.has(roleName)) {
        const newRole = await new Role(roleDefaults[roleName as keyof typeof roleDefaults]).save();
        if (cache) {
          await cache.set(scopedCacheKey(roleName), newRole);
        }
        return newRole.toObject() as IRole;
      }
      if (cache) {
        await cache.set(scopedCacheKey(roleName), role);
      }
      return role as unknown as IRole;
    } catch (error) {
      throw new Error(`Failed to retrieve or create role: ${(error as Error).message}`);
    }
  }

  /**
   * The role named exactly `roleName` in the caller's tenant partition (`tenantPartitionFilter`),
   * as the admin roles API addresses it: never a tenant's role of the same name outside that
   * tenant. A system role with no document there is created there, as {@link getRoleByName}
   * creates it. Reads no cache, so an admin read never returns another partition's cached role.
   */
  async function getPartitionRole(roleName: string): Promise<IRole | null> {
    const Role = mongoose.models.Role as Model<IRole>;
    const read = () =>
      Role.findOne(roleDocumentFilter(roleName, 'getPartitionRole'))
        .select('-__v')
        .lean<IRole>()
        .exec();
    const role = await read();
    if (role || !systemRoleValues.has(roleName)) {
      return role;
    }
    try {
      const created = await new Role(roleDefaults[roleName as keyof typeof roleDefaults]).save();
      return created.toObject() as IRole;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
        return read();
      }
      throw error;
    }
  }

  /**
   * Find roles by name without using or populating the shared role-name cache.
   * Use this for tenant-scoped authorization lookups where the active ALS tenant context must control the query.
   *
   * When a non-system tenant context is active, the tenant-isolation plugin scopes the
   * query to that tenant. When no tenant context is active (base/global users), the lookup
   * runs under an explicit system context — so strict-mode isolation does not reject the
   * context-less query — while an explicit base-role filter (`tenantId` unset) ensures a
   * base user cannot match, and be assigned, a role that only exists within some tenant.
   */
  async function findRolesByNames(
    roleNames: string[],
    fieldsToSelect: string | string[] | null = null,
  ): Promise<IRole[]> {
    try {
      const names = uniqueRoleNames(roleNames);
      if (names.length === 0) {
        return [] as IRole[];
      }

      const Role = mongoose.models.Role;
      const nameFilter = roleNamesFilter(names) as Record<string, unknown>;

      const runQuery = (filter: Record<string, unknown>) => {
        let query = Role.find(filter);
        if (fieldsToSelect) {
          query = query.select(fieldsToSelect);
        }
        return query.lean<IRole[]>().exec();
      };

      const tenantId = getTenantId();
      if (tenantId && tenantId !== SYSTEM_TENANT_ID) {
        return await runQuery(nameFilter);
      }

      return await runAsSystem(() =>
        runQuery({ ...nameFilter, tenantId: { $in: [null, undefined] } }),
      );
    } catch (error) {
      throw new Error(`Failed to retrieve roles: ${(error as Error).message}`);
    }
  }

  /**
   * Update the values of the role named `roleName` in the caller's tenant partition, as
   * {@link getRoleByName} reads it. With `options.id`, only the role document with that `_id`
   * changes (`null` when it no longer has the name), so a caller that read one role writes that
   * role and never another tenant's role of the same name.
   */
  async function updateRoleByName(
    roleName: string,
    updates: Partial<IRole>,
    options?: { id?: string },
  ): Promise<IRole> {
    const cache = deps.getCache?.(CacheKeys.ROLES);
    try {
      const Role = mongoose.models.Role;
      const role = await Role.findOneAndUpdate(
        roleDocumentFilter(roleName, 'updateRoleByName', options?.id),
        { $set: updates },
        { new: true },
      )
        .select('-__v')
        .lean()
        .exec();
      if (cache) {
        if (updates.name && updates.name !== roleName) {
          await Promise.all([
            cache.set(scopedCacheKey(roleName), null),
            cache.set(scopedCacheKey(updates.name), role),
          ]);
        } else {
          await cache.set(scopedCacheKey(roleName), role);
        }
      }
      return role as unknown as IRole;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
        const targetName = updates.name ?? roleName;
        throw new RoleConflictError(`Role "${targetName}" already exists`);
      }
      const updateError = new Error(
        `Failed to update role: ${(error as Error).message}`,
      ) as Error & {
        cause?: unknown;
      };
      updateError.cause = error;
      throw updateError;
    }
  }

  /**
   * Updates access permissions for a specific role and multiple permission types.
   */
  async function updateAccessPermissions(
    roleName: string,
    permissionsUpdate: Record<string, Record<string, boolean>>,
    roleData?: IRole,
  ): Promise<void> {
    const updates = filterPermissionsUpdate(permissionsUpdate);
    if (!Object.keys(updates).length) {
      return;
    }

    try {
      const role = roleData ?? (await getRoleByName(roleName));
      if (!role) {
        return;
      }
      /** The role read is the one written, whichever tenant partition it was read in. */
      const id = role._id != null ? String(role._id) : undefined;
      const target = roleDocumentFilter(roleName, 'updateAccessPermissions', id);

      const { hasChanges, updatedPermissions, unsetFields } = planRolePermissionsUpdate(
        roleName,
        role,
        updates,
      );

      if (hasChanges) {
        const Role = mongoose.models.Role;
        const updateObj = { permissions: updatedPermissions };

        if (Object.keys(unsetFields).length > 0) {
          logger.info(
            `Unsetting old schema fields for '${roleName}' role: ${Object.keys(unsetFields).join(', ')}`,
          );

          try {
            await Role.updateOne(target, {
              $set: updateObj,
              $unset: unsetFields,
            });

            const cache = deps.getCache?.(CacheKeys.ROLES);
            const updatedRole = await Role.findOne(target).select('-__v').lean().exec();
            if (cache) {
              await cache.set(scopedCacheKey(roleName), updatedRole);
            }

            logger.info(`Updated role '${roleName}' and removed old schema fields`);
          } catch (updateError) {
            logger.error(`Error during role migration update: ${(updateError as Error).message}`);
            throw updateError;
          }
        } else {
          await updateRoleByName(roleName, updateObj as unknown as Partial<IRole>, { id });
        }

        logger.info(`Updated '${roleName}' role permissions`);
      } else {
        logger.info(`No changes needed for '${roleName}' role permissions`);
      }
    } catch (error) {
      logger.error(`Failed to update ${roleName} role permissions:`, error);
    }
  }

  /**
   * Rejects names that match system roles, and a name the caller's tenant partition already holds
   * (`tenantPartitionFilter`); another tenant's role of that name is a different role.
   */
  async function createRoleByName(roleData: Partial<IRole>): Promise<IRole> {
    const { name } = roleData;
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('Role name is required');
    }
    const trimmed = name.trim();
    if (isSystemRoleName(trimmed)) {
      throw new RoleConflictError(`Cannot create role with reserved system name: ${name}`);
    }
    const Role = mongoose.models.Role;
    const existing = await Role.findOne(roleDocumentFilter(trimmed, 'createRoleByName')).lean();
    if (existing) {
      throw new RoleConflictError(`Role "${trimmed}" already exists`);
    }
    let role;
    try {
      role = await new Role({ ...roleData, name: trimmed }).save();
    } catch (err) {
      /**
       * The compound unique index `{ name: 1, tenantId: 1 }` on the role schema
       * (roleSchema.index in schema/role.ts) triggers error 11000 when a concurrent
       * request races past the findOne check above. This catch converts it into
       * the same user-facing message as the application-level duplicate check.
       */
      if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
        throw new RoleConflictError(`Role "${trimmed}" already exists`);
      }
      throw err;
    }
    try {
      const cache = deps.getCache?.(CacheKeys.ROLES);
      if (cache) {
        await cache.set(scopedCacheKey(role.name), role.toObject());
      }
    } catch (cacheError) {
      logger.error(`[createRoleByName] cache set failed for "${role.name}":`, cacheError);
    }
    return role.toObject() as IRole;
  }

  /**
   * Guards against deleting system roles. Reassigns affected users back to USER. Only the role
   * of the caller's tenant partition and its members there are touched
   * (`tenantPartitionFilter`).
   *
   * No existence pre-check is performed: for a nonexistent role the `updateMany`
   * is a harmless no-op and `findOneAndDelete` returns null. This makes the
   * function idempotent — a retry after a partial failure will still clean up
   * orphaned user references and cache entries.
   *
   * Without a MongoDB transaction the two writes are non-atomic — if the delete
   * fails after the reassignment, users will already have been moved to USER
   * while the role document still exists. Recovery requires the caller to retry
   * the delete call, which will succeed since the `updateMany` is a no-op on
   * the second pass.
   */
  async function deleteRoleByName(
    roleName: string,
    options?: { id?: string },
  ): Promise<IRole | null> {
    if (isSystemRoleName(roleName)) {
      throw new Error(`Cannot delete system role: ${roleName}`);
    }
    const Role = mongoose.models.Role;
    const role = { name: roleName, ...tenantPartitionFilter('deleteRoleByName') };
    /** A role recreated under this name has another `_id`: leave it and its members alone. */
    if (options?.id && !(await Role.exists({ ...role, _id: options.id }))) {
      return null;
    }
    const User = mongoose.models.User as Model<IUser>;
    const affectedUserIds = await findUserIdsByRole(roleName);
    await User.updateMany(roleMembersFilter(roleName, 'deleteRoleByName'), {
      $set: { role: SystemRoles.USER },
    });
    await invalidateAuthUserDocCache(affectedUserIds);
    const deleted = await Role.findOneAndDelete({
      ...role,
      ...(options?.id ? { _id: options.id } : {}),
    }).lean();
    try {
      const cache = deps.getCache?.(CacheKeys.ROLES);
      if (cache) {
        // Setting null evicts the stale document. getRoleByName treats falsy cached
        // values as a miss and falls through to the DB, so this does not provide
        // negative caching — it only prevents serving the pre-deletion document.
        await cache.set(scopedCacheKey(roleName), null);
      }
    } catch (cacheError) {
      logger.error(`[deleteRoleByName] cache invalidation failed for "${roleName}":`, cacheError);
    }
    return deleted as IRole | null;
  }

  /** Moves the members of `oldRole` in the caller's tenant partition to `newRole` (a rename). */
  async function updateUsersByRole(oldRole: string, newRole: string): Promise<void> {
    const User = mongoose.models.User as Model<IUser>;
    const affectedUserIds = await findUserIdsByRole(oldRole);
    await User.updateMany(roleMembersFilter(oldRole, 'updateUsersByRole'), {
      $set: { role: newRole },
    });
    await invalidateAuthUserDocCache(affectedUserIds);
  }

  /** The ids of the users holding `roleName` in the caller's tenant partition. */
  async function findUserIdsByRole(roleName: string): Promise<string[]> {
    const User = mongoose.models.User as Model<IUser>;
    const users = await User.find(roleMembersFilter(roleName, 'findUserIdsByRole'))
      .select('_id')
      .lean();
    return users.map((u) => u._id.toString());
  }

  /**
   * Sets the role of the given users. With `fromRole`, only users whose role is still that one
   * change, so undoing a migration never overwrites a reassignment made since.
   */
  async function updateUsersRoleByIds(
    userIds: string[],
    newRole: string,
    options?: { fromRole?: string },
  ): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    const User = mongoose.models.User as Model<IUser>;
    await User.updateMany(
      {
        _id: { $in: userIds },
        ...(options?.fromRole !== undefined ? { role: options.fromRole } : {}),
      },
      { $set: { role: newRole } },
    );
    await invalidateAuthUserDocCache(userIds);
  }

  async function invalidateAuthUserDocCache(userIds: string[]): Promise<void> {
    await evictAuthUserDocsForUsers(deps.getCache, userIds);
  }

  /** The users holding `roleName` in the caller's tenant partition, a page at a time. */
  async function listUsersByRole(
    roleName: string,
    options?: { limit?: number; offset?: number },
  ): Promise<IUser[]> {
    const User = mongoose.models.User as Model<IUser>;
    const limit = options?.limit ?? ROLE_PAGE_DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    return await User.find(roleMembersFilter(roleName, 'listUsersByRole'))
      .select('_id name email avatar')
      .sort({ _id: 1 })
      .skip(offset)
      .limit(limit)
      .lean<IUser[]>();
  }

  /** Counts the users {@link listUsersByRole} lists. */
  async function countUsersByRole(roleName: string): Promise<number> {
    const User = mongoose.models.User as Model<IUser>;
    return await User.countDocuments(roleMembersFilter(roleName, 'countUsersByRole'));
  }

  return {
    listRoles,
    countRoles,
    initializeRoles,
    getRoleByName,
    getPartitionRole,
    findRolesByNames,
    updateRoleByName,
    updateAccessPermissions,
    createRoleByName,
    deleteRoleByName,
    updateUsersByRole,
    findUserIdsByRole,
    updateUsersRoleByIds,
    listUsersByRole,
    countUsersByRole,
  };
}

export type RoleMethods = ReturnType<typeof createRoleMethods>;

/**
 * The PostgreSQL `RoleStore` (`~/ports/role`): the roles on the `roles` table (permissions as
 * flattened boolean columns, §1.4) and their members on `users`, through the collection
 * primitive, with the rules of `~/methods/roleRules`. Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * Every read and write by name keeps to the caller's tenant partition, as on MongoDB. Legacy
 * shapes: an off-schema `permissions.<type>.SHARED_GLOBAL` lives in `_extra` (D7); document-mode
 * reads return it, as MongoDB's lean reads do, and `initializeRoles` migrates it through the raw
 * collection, as the MongoDB method does through the driver. A legacy top-level permission type
 * is read and merged, but not unset: MongoDB's strict model strips that `$unset`, so the old copy
 * stays stored (pinned by the contract).
 */
import { CacheKeys, SystemRoles, roleDefaults } from 'librechat-data-provider';
import type { CacheFactoryDeps } from '~/compose/types';
import type { PostgresStoreContext } from './context';
import type { RoleStore } from '~/ports/role';
import type { PgFilter } from '../collection';
import type { IRole, IUser } from '~/types';
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
} from '~/methods/roleRules';
import { scopedCacheKey, getTenantId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { evictAuthUserDocsForUsers } from '~/utils/eviction';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { tenantPartitionFilter } from '../collection/tenant';
import logger from '~/config/winston';
import { asRecord } from './context';

type PermissionBlocks = Record<string, Record<string, unknown> | null | undefined>;

export function createPostgresRoleStore(
  context: PostgresStoreContext,
  deps: CacheFactoryDeps = {},
): RoleStore {
  const roles = () => context.collections().collection('roles');
  const rawRoles = () => context.collections().raw('roles');
  const users = () => context.collections().collection('users');
  const roleCache = () => deps.getCache?.(CacheKeys.ROLES);
  const asRole = (record: unknown) => record as IRole;

  /** The users holding `roleName` in the caller's tenant partition. */
  const roleMembersFilter = (roleName: string, operation: string): PgFilter => ({
    role: roleName,
    ...tenantPartitionFilter(operation),
  });

  /**
   * The role named `roleName` in the caller's tenant partition, or with `id` exactly that role
   * (which a caller read in its own partition) as long as it still has the name.
   */
  const roleDocumentFilter = (roleName: string, operation: string, id?: string): PgFilter =>
    id ? { name: roleName, _id: id } : { name: roleName, ...tenantPartitionFilter(operation) };

  const isDuplicateKey = (error: unknown) => error instanceof StoreDuplicateKeyError;

  async function findUserIdsByRole(roleName: string): Promise<string[]> {
    const members = await users().find(roleMembersFilter(roleName, 'findUserIdsByRole'), {
      projection: '_id',
    });
    return members.map((user) => String(user._id));
  }

  const invalidateAuthUserDocCache = (userIds: string[]) =>
    evictAuthUserDocsForUsers(deps.getCache, userIds);

  async function getRoleByName(
    roleName: string,
    fieldsToSelect: string | null = null,
  ): Promise<IRole> {
    const cache = roleCache();
    try {
      if (cache) {
        const cachedRole = await cache.get(scopedCacheKey(roleName));
        if (cachedRole) {
          return cachedRole as IRole;
        }
      }
      const role = await roles().findOne(
        roleDocumentFilter(roleName, 'getRoleByName'),
        fieldsToSelect ? { projection: fieldsToSelect } : {},
      );
      if (!role && SYSTEM_ROLE_NAMES.has(roleName)) {
        const created = await roles().insertOne(
          asRecord(roleDefaults[roleName as keyof typeof roleDefaults]),
        );
        if (cache) {
          await cache.set(scopedCacheKey(roleName), created);
        }
        return asRole(created);
      }
      if (cache) {
        await cache.set(scopedCacheKey(roleName), role);
      }
      return asRole(role);
    } catch (error) {
      throw new Error(`Failed to retrieve or create role: ${(error as Error).message}`);
    }
  }

  async function updateRoleByName(
    roleName: string,
    updates: Partial<IRole>,
    options?: { id?: string },
  ): Promise<IRole> {
    const cache = roleCache();
    try {
      const role = await roles().findOneAndUpdate(
        roleDocumentFilter(roleName, 'updateRoleByName', options?.id),
        { $set: asRecord(updates) },
        { returnDocument: 'after', projection: '-__v' },
      );
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
      return asRole(role);
    } catch (error) {
      if (isDuplicateKey(error)) {
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

  const store: RoleStore = {
    async listRoles(options) {
      const limit = options?.limit ?? ROLE_PAGE_DEFAULT_LIMIT;
      const offset = options?.offset ?? 0;
      return (await roles().find(tenantPartitionFilter('listRoles'), {
        projection: 'name description',
        sort: { name: 1 },
        skip: offset,
        limit,
      })) as unknown as Array<Pick<IRole, '_id' | 'name' | 'description'>>;
    },

    async countRoles() {
      return roles().count(tenantPartitionFilter('countRoles'));
    },

    /** The platform default roles, never tenant copies, regardless of caller context. */
    async initializeRoles() {
      return runAsSystem(async () => {
        for (const roleName of [SystemRoles.ADMIN, SystemRoles.USER]) {
          const filter = roleDocumentFilter(roleName, 'initializeRoles');
          /** The raw read exposes the off-schema `SHARED_GLOBAL`; the raw write drops it. */
          const legacyDoc = await rawRoles().findOne(filter);
          const legacyUpdate = legacySharedGlobalUpdate(
            legacyDoc?.permissions as PermissionBlocks | undefined,
          );
          if (legacyDoc && legacyUpdate) {
            await rawRoles().updateOne({ ...filter, _id: legacyDoc._id }, legacyUpdate);
          }
          const role = await roles().findOne(filter);
          const defaultPerms = roleDefaults[roleName].permissions;
          if (!role) {
            await roles().insertOne(asRecord({ ...roleDefaults[roleName], description: '' }));
            continue;
          }
          /** What saving the role with its defaults merged in changes (nothing, usually). */
          const set: Record<string, unknown> = {};
          if (role.description == null) {
            set.description = '';
          }
          const permissions = (role.permissions ?? {}) as PermissionBlocks;
          const merged = mergeDefaultPermissions(permissions, defaultPerms);
          for (const [permType, block] of Object.entries(merged)) {
            if (JSON.stringify(block) !== JSON.stringify(permissions[permType])) {
              set[`permissions.${permType}`] = block;
            }
          }
          if (Object.keys(set).length > 0) {
            await roles().updateOne({ _id: role._id }, { $set: set });
          }
        }
      });
    },

    getRoleByName,

    async getPartitionRole(roleName) {
      const read = async () =>
        asRole(
          await roles().findOne(roleDocumentFilter(roleName, 'getPartitionRole'), {
            projection: '-__v',
          }),
        );
      const role = await read();
      if (role || !SYSTEM_ROLE_NAMES.has(roleName)) {
        return role;
      }
      try {
        return asRole(
          await roles().insertOne(asRecord(roleDefaults[roleName as keyof typeof roleDefaults])),
        );
      } catch (error) {
        if (isDuplicateKey(error)) {
          return read();
        }
        throw error;
      }
    },

    async findRolesByNames(roleNames, fieldsToSelect = null) {
      try {
        const names = uniqueRoleNames(roleNames);
        if (names.length === 0) {
          return [] as IRole[];
        }
        const nameFilter = roleNamesFilter(names);
        const runQuery = async (filter: PgFilter) =>
          (await roles().find(
            filter,
            fieldsToSelect ? { projection: fieldsToSelect } : {},
          )) as unknown as IRole[];

        const tenantId = getTenantId();
        if (tenantId && tenantId !== SYSTEM_TENANT_ID) {
          return await runQuery(nameFilter);
        }
        /** Outside a tenant only base roles (no `tenantId`, or `null`) may match. */
        return await runAsSystem(() => runQuery({ ...nameFilter, tenantId: { $in: [null] } }));
      } catch (error) {
        throw new Error(`Failed to retrieve roles: ${(error as Error).message}`);
      }
    },

    updateRoleByName,

    async updateAccessPermissions(roleName, permissionsUpdate, roleData) {
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
        if (!hasChanges) {
          logger.info(`No changes needed for '${roleName}' role permissions`);
          return;
        }
        const updateObj = { permissions: updatedPermissions };
        if (Object.keys(unsetFields).length > 0) {
          logger.info(
            `Unsetting old schema fields for '${roleName}' role: ${Object.keys(unsetFields).join(', ')}`,
          );
          try {
            /**
             * The legacy top-level fields are off-schema: MongoDB's strict model strips their
             * `$unset`, so the write sets the permissions only and the old copies stay stored.
             */
            await roles().updateOne(target, { $set: updateObj });
            const updatedRole = await roles().findOne(target, { projection: '-__v' });
            const cache = roleCache();
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
      } catch (error) {
        logger.error(`Failed to update ${roleName} role permissions:`, error);
      }
    },

    async createRoleByName(roleData) {
      const { name } = roleData;
      if (!name || typeof name !== 'string' || !name.trim()) {
        throw new Error('Role name is required');
      }
      const trimmed = name.trim();
      if (isSystemRoleName(trimmed)) {
        throw new RoleConflictError(`Cannot create role with reserved system name: ${name}`);
      }
      const existing = await roles().exists(roleDocumentFilter(trimmed, 'createRoleByName'));
      if (existing) {
        throw new RoleConflictError(`Role "${trimmed}" already exists`);
      }
      let role: IRole;
      try {
        role = asRole(await roles().insertOne(asRecord({ ...roleData, name: trimmed })));
      } catch (error) {
        /** A concurrent request raced past the check above (the `{ name, tenantId }` index). */
        if (isDuplicateKey(error)) {
          throw new RoleConflictError(`Role "${trimmed}" already exists`);
        }
        throw error;
      }
      try {
        const cache = roleCache();
        if (cache) {
          await cache.set(scopedCacheKey(role.name), role);
        }
      } catch (cacheError) {
        logger.error(`[createRoleByName] cache set failed for "${role.name}":`, cacheError);
      }
      return role;
    },

    async deleteRoleByName(roleName, options) {
      if (isSystemRoleName(roleName)) {
        throw new Error(`Cannot delete system role: ${roleName}`);
      }
      const role = { name: roleName, ...tenantPartitionFilter('deleteRoleByName') };
      /** A role recreated under this name has another `_id`: leave it and its members alone. */
      if (options?.id && !(await roles().exists({ ...role, _id: options.id }))) {
        return null;
      }
      const affectedUserIds = await findUserIdsByRole(roleName);
      await users().updateMany(roleMembersFilter(roleName, 'deleteRoleByName'), {
        $set: { role: SystemRoles.USER },
      });
      await invalidateAuthUserDocCache(affectedUserIds);
      const deleted = await roles().findOneAndDelete({
        ...role,
        ...(options?.id ? { _id: options.id } : {}),
      });
      try {
        const cache = roleCache();
        if (cache) {
          /** Evicts the stale role; a falsy cached value reads as a miss. */
          await cache.set(scopedCacheKey(roleName), null);
        }
      } catch (cacheError) {
        logger.error(`[deleteRoleByName] cache invalidation failed for "${roleName}":`, cacheError);
      }
      return deleted as IRole | null;
    },

    async updateUsersByRole(oldRole, newRole) {
      const affectedUserIds = await findUserIdsByRole(oldRole);
      await users().updateMany(roleMembersFilter(oldRole, 'updateUsersByRole'), {
        $set: { role: newRole },
      });
      await invalidateAuthUserDocCache(affectedUserIds);
    },

    findUserIdsByRole,

    async updateUsersRoleByIds(userIds, newRole, options) {
      if (userIds.length === 0) {
        return;
      }
      await users().updateMany(
        {
          _id: { $in: userIds },
          ...(options?.fromRole !== undefined ? { role: options.fromRole } : {}),
        },
        { $set: { role: newRole } },
      );
      await invalidateAuthUserDocCache(userIds);
    },

    async listUsersByRole(roleName, options) {
      const limit = options?.limit ?? ROLE_PAGE_DEFAULT_LIMIT;
      const offset = options?.offset ?? 0;
      return (await users().find(roleMembersFilter(roleName, 'listUsersByRole'), {
        projection: '_id name email avatar',
        sort: { _id: 1 },
        skip: offset,
        limit,
      })) as unknown as IUser[];
    },

    async countUsersByRole(roleName) {
      return users().count(roleMembersFilter(roleName, 'countUsersByRole'));
    },
  };
  return store;
}

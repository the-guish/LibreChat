/**
 * Role store port: the named roles users hold (`ADMIN`, `USER` and custom ones) with their
 * permissions, and the assignment of users to them. Nothing here may import `mongoose`.
 * Signatures are those of `RoleMethods` (`~/methods/role`), with the projections of
 * `getRoleByName` and `findRolesByNames` stated as store query language strings
 * ({@link StoreProjectionString}; the MongoDB methods also take a list of field names);
 * `role.spec.ts` fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * A role name addresses the role of the caller's tenant partition: the active tenant's, or
 * outside a tenant the platform-level one, never another tenant's role of the same name; the
 * members a role name reaches are the users of the same partition. System roles cannot be
 * created or deleted, and a missing system role is created on read. A name already taken in the
 * partition is refused with a `RoleConflictError`. Every change to a user's role evicts that
 * user's cached auth documents; any store keeps that.
 *
 * Known leaks kept for now so callers stay unchanged: `IRole` and `IUser` extend mongoose's
 * `Document`, and `updateRoleByName` and `createRoleByName` take `IRole` fields.
 */
import type { StoreProjectionString } from './query';
import type { IRole, IUser } from '~/types';
import { listPortMethods } from './common';

/** A page of a listing: `limit` (50 by default) records after the first `offset`. */
interface RolePage {
  limit?: number;
  offset?: number;
}

export interface RoleStore {
  /** A page of the partition's roles by name, with their name and description only. */
  listRoles(options?: RolePage): Promise<Pick<IRole, '_id' | 'name' | 'description'>[]>;
  /** Counts the roles {@link RoleStore.listRoles} lists. */
  countRoles(): Promise<number>;
  /**
   * Creates the platform default roles that are missing and adds the permission types new
   * since an existing one was stored; never touches a tenant's copies.
   */
  initializeRoles(): Promise<void>;
  /**
   * The role named `roleName`, with the fields `projection` selects, from the role cache when it
   * holds one (the cache keeps the role as it was first read, whatever the projection); a missing
   * system role is created. Resolves to `null` for any other missing role, although the declared
   * type omits it.
   */
  getRoleByName(roleName: string, projection?: StoreProjectionString | null): Promise<IRole>;
  /**
   * The partition's role named exactly `roleName`, read past any cache; a missing system role
   * is created. `null` when there is none.
   */
  getPartitionRole(roleName: string): Promise<IRole | null>;
  /**
   * The roles whose names equal one of `roleNames` ignoring case (trimmed; blanks skipped), with
   * the fields `projection` selects, read past the role cache: the active tenant's roles, or
   * outside a tenant only the platform-level ones.
   */
  findRolesByNames(
    roleNames: string[],
    projection?: StoreProjectionString | null,
  ): Promise<IRole[]>;
  /**
   * Sets the given fields on the role named `roleName`, or with `options.id` only on that role
   * while it still has the name; resolves to it updated.
   */
  updateRoleByName(
    roleName: string,
    updates: Partial<IRole>,
    options?: { id?: string },
  ): Promise<IRole>;
  /**
   * Sets the given permissions of the role named `roleName` (`roleData` when the caller already
   * read it), keeping the others and migrating legacy permission fields. Unknown permission
   * types are ignored; failures are logged, not thrown.
   */
  updateAccessPermissions(
    roleName: string,
    permissionsUpdate: Record<string, Record<string, boolean>>,
    roleData?: IRole,
  ): Promise<void>;
  /** Creates a custom role in the partition; its name is trimmed and required. */
  createRoleByName(roleData: Partial<IRole>): Promise<IRole>;
  /**
   * Deletes the custom role named `roleName` (with `options.id`, only that role), moving its
   * members back to `USER`; resolves to it, or `null` when there was none.
   */
  deleteRoleByName(roleName: string, options?: { id?: string }): Promise<IRole | null>;
  /** Moves every member of `oldRole` to `newRole` (a rename). */
  updateUsersByRole(oldRole: string, newRole: string): Promise<void>;
  /** The ids of the members of `roleName`. */
  findUserIdsByRole(roleName: string): Promise<string[]>;
  /**
   * Sets the role of the given users; with `fromRole`, only of those whose role is still that
   * one.
   */
  updateUsersRoleByIds(
    userIds: string[],
    newRole: string,
    options?: { fromRole?: string },
  ): Promise<void>;
  /** A page of the members of `roleName` by id, with their id, name, email and avatar only. */
  listUsersByRole(roleName: string, options?: RolePage): Promise<IUser[]>;
  /** Counts the users {@link RoleStore.listUsersByRole} lists. */
  countUsersByRole(roleName: string): Promise<number>;
}

/** Every method of {@link RoleStore}, for adapters and conformance checks. */
export const ROLE_STORE_METHODS: ReadonlyArray<keyof RoleStore> = listPortMethods<RoleStore>({
  listRoles: true,
  countRoles: true,
  initializeRoles: true,
  getRoleByName: true,
  getPartitionRole: true,
  findRolesByNames: true,
  updateRoleByName: true,
  updateAccessPermissions: true,
  createRoleByName: true,
  deleteRoleByName: true,
  updateUsersByRole: true,
  findUserIdsByRole: true,
  updateUsersRoleByIds: true,
  listUsersByRole: true,
  countUsersByRole: true,
});

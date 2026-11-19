/**
 * Access role store port: the roles a principal can be granted on a resource (viewer, editor,
 * owner of an agent, prompt group, MCP server, ...) and the permission bits each carries. Nothing
 * here may import `mongoose`. Signatures are those of `AccessRoleMethods` (`~/methods/accessRole`)
 * with role ids stated as `IdLike` and the delete result as `DeleteCount`; `accessRole.spec.ts`
 * fails the typecheck if the MongoDB methods stop satisfying them.
 *
 * Roles are addressed by `accessRoleId` (e.g. `agent_viewer`). The defaults are seeded once,
 * globally; inside a tenant the reads see the defaults with the tenant's own copies substituted
 * by `accessRoleId`, and a copy that moves an id to another resource type withdraws the default
 * from that type's listing.
 *
 * Known leak kept for now so callers stay unchanged: `IAccessRole` extends mongoose's `Document`,
 * and `createRole` and `updateRole` take `IAccessRole` fields.
 */
import type { DeleteCount, IdLike } from './common';
import type { IAccessRole } from '~/types';
import { listPortMethods } from './common';

export interface AccessRoleStore {
  /** Creates an access role. */
  createRole(roleData: Partial<IAccessRole>): Promise<IAccessRole>;
  /** Sets the given fields on the access role; resolves to it updated, or `null`. */
  updateRole(accessRoleId: IdLike, updateData: Partial<IAccessRole>): Promise<IAccessRole | null>;
  /** Deletes the access role; `deletedCount` is 0 when there was none. */
  deleteRole(accessRoleId: IdLike): Promise<DeleteCount>;
  /**
   * Creates each default access role that is missing, leaving stored ones unchanged; resolves
   * to every default role by `accessRoleId`.
   */
  seedDefaultRoles(): Promise<Record<string, IAccessRole>>;
  /** The access role visible to the caller under this id, or `null`. */
  findRoleByIdentifier(accessRoleId: IdLike): Promise<IAccessRole | null>;
  /** The access roles visible to the caller for the resource type. */
  findRolesByResourceType(resourceType: string): Promise<IAccessRole[]>;
}

/** Every method of {@link AccessRoleStore}, for adapters and conformance checks. */
export const ACCESS_ROLE_STORE_METHODS: ReadonlyArray<keyof AccessRoleStore> =
  listPortMethods<AccessRoleStore>({
    createRole: true,
    updateRole: true,
    deleteRole: true,
    seedDefaultRoles: true,
    findRoleByIdentifier: true,
    findRolesByResourceType: true,
  });

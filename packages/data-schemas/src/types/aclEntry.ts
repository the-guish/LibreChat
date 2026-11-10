import { PrincipalType, PrincipalModel, ResourceType } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export type AclEntry = {
  /** The type of principal (PrincipalType.USER, PrincipalType.GROUP, PrincipalType.PUBLIC) */
  principalType: PrincipalType;
  /** The ID of the principal (null for PrincipalType.PUBLIC, string for PrincipalType.ROLE) */
  principalId?: Types.ObjectId | string;
  /** The model name for the principal (`PrincipalModel`) */
  principalModel?: PrincipalModel;
  /** The type of resource (`ResourceType`) */
  resourceType: ResourceType;
  /** The ID of the resource */
  resourceId: Types.ObjectId;
  /** Permission bits for this entry */
  permBits: number;
  /** Optional role ID for predefined roles */
  roleId?: Types.ObjectId;
  /** ID of the resource this permission is inherited from */
  inheritedFrom?: Types.ObjectId;
  /** ID of the user who granted this permission */
  grantedBy?: Types.ObjectId;
  /** When this permission was granted */
  grantedAt?: Date;
  /** Optional expiration date for permissions tied to expiring resources */
  expiredAt?: Date;
  tenantId?: string;
};

export type IAclEntry = AclEntry &
  Document & {
    _id: Types.ObjectId;
  };

/**
 * A user's or group's stored record as an ACL read joins it to an entry: every field the record
 * holds, hidden ones included (a user's password hash and second-factor secrets among them), as a
 * plain object. Callers pick the fields they expose. Not scoped to the active tenant: its
 * `tenantId` is the record's own.
 */
export type AclJoinedPrincipalRecord = {
  _id: Types.ObjectId;
  tenantId?: string;
  [field: string]: unknown;
};

/**
 * One entry on a resource with what `listResourcePermissionPrincipals` joins to it: the access
 * role's id (`accessRoleId`) and the user (`userInfo`) or group (`groupInfo`) its principal id
 * names. A field whose source is missing (no role id, no such role, no such user or group) is
 * absent, never `null`.
 */
export type AclResourcePermissionPrincipal = Pick<
  AclEntry,
  'principalType' | 'principalId' | 'permBits'
> & {
  /** The entry's id. */
  _id: Types.ObjectId;
  accessRoleId?: string;
  userInfo?: AclJoinedPrincipalRecord;
  groupInfo?: AclJoinedPrincipalRecord;
};

/**
 * One user entry on a resource with the user its principal id names (`userInfo`, absent when no
 * such user exists), as `listUserPermissionHolders` reads it.
 */
export type AclUserPermissionHolder = Pick<AclEntry, 'principalId'> & {
  /** The entry's id. */
  _id: Types.ObjectId;
  userInfo?: AclJoinedPrincipalRecord;
};

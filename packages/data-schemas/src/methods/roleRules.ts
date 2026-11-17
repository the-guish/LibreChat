/**
 * The role rules every backend's `RoleStore` shares (docs/postgres-port/PHASE4.md §4, "Domain
 * rules"): the system role names, `RoleConflictError`, the platform defaults' merge and the
 * legacy `SHARED_GLOBAL` migration of `initializeRoles`, the plan of `updateAccessPermissions`
 * (legacy top-level permission types and `SHARED_GLOBAL` migrated), and the case-insensitive
 * name match of `findRolesByNames`. Nothing here may import `mongoose`.
 */
import { SystemRoles, permissionsSchema, removeNullishValues } from 'librechat-data-provider';
import type { StoreFilter } from '~/ports/query';
import { escapeRegExp } from '~/utils/string';
import logger from '~/config/winston';

/** The system role names (`ADMIN`, `USER`). */
export const SYSTEM_ROLE_NAMES: ReadonlySet<string> = new Set<string>(Object.values(SystemRoles));

/** Case-insensitive check — the legacy roles route uppercases params. */
export function isSystemRoleName(name: string): boolean {
  return SYSTEM_ROLE_NAMES.has(name.toUpperCase());
}

export class RoleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConflictError';
  }
}

/** The permission types whose legacy `SHARED_GLOBAL` permission became `SHARE`. */
export const LEGACY_SHARED_GLOBAL_TYPES: readonly string[] = ['PROMPTS', 'AGENTS'];

type PermissionBlock = Record<string, unknown>;
type PermissionBlocks = Record<string, PermissionBlock | null | undefined>;

/**
 * The raw update that migrates a stored role's legacy `SHARED_GLOBAL` (an off-schema field)
 * to `SHARE` (when `SHARE` is absent) and removes it, by dotted path; `null` when there is none.
 */
export function legacySharedGlobalUpdate(
  permissions: PermissionBlocks | null | undefined,
): { $unset: Record<string, ''>; $set?: Record<string, unknown> } | null {
  if (!permissions) {
    return null;
  }
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  for (const permType of LEGACY_SHARED_GLOBAL_TYPES) {
    const block = permissions[permType];
    if (block && 'SHARED_GLOBAL' in block) {
      if (!('SHARE' in block)) {
        set[`permissions.${permType}.SHARE`] = block.SHARED_GLOBAL;
      }
      unset[`permissions.${permType}.SHARED_GLOBAL`] = '';
    }
  }
  if (!Object.keys(unset).length) {
    return null;
  }
  return Object.keys(set).length ? { $unset: unset, $set: set } : { $unset: unset };
}

/**
 * The permission blocks `initializeRoles` writes for each permission type of `defaults`: the
 * default block when the stored one is missing, otherwise the stored block with its missing
 * (or nullish) fields taken from the defaults.
 */
export function mergeDefaultPermissions(
  existing: PermissionBlocks,
  defaults: Record<string, unknown>,
): Record<string, PermissionBlock> {
  const merged: Record<string, PermissionBlock> = {};
  for (const permType of Object.keys(defaults)) {
    const defaultBlock = defaults[permType] as PermissionBlock;
    const existingBlock = existing[permType];
    if (existingBlock == null) {
      merged[permType] = defaultBlock;
      continue;
    }
    const mergedBlock: PermissionBlock = { ...existingBlock };
    for (const field of Object.keys(defaultBlock)) {
      if (mergedBlock[field] == null) {
        mergedBlock[field] = defaultBlock[field];
      }
    }
    merged[permType] = mergedBlock;
  }
  return merged;
}

/** The known permission types of `permissionsUpdate`, with their nullish values dropped. */
export function filterPermissionsUpdate(
  permissionsUpdate: Record<string, Record<string, boolean>>,
): Record<string, Record<string, boolean>> {
  const updates: Record<string, Record<string, boolean>> = {};
  for (const [permissionType, permissions] of Object.entries(permissionsUpdate)) {
    if (
      permissionsSchema.shape &&
      permissionsSchema.shape[permissionType as keyof typeof permissionsSchema.shape]
    ) {
      updates[permissionType] = removeNullishValues(permissions) as Record<string, boolean>;
    }
  }
  return updates;
}

/** What `updateAccessPermissions` writes. */
export interface RolePermissionsPlan {
  hasChanges: boolean;
  /** The whole `permissions` object to `$set`. */
  updatedPermissions: Record<string, Record<string, boolean>>;
  /** The legacy top-level permission types to `$unset`. */
  unsetFields: Record<string, number>;
}

/**
 * The plan of `updateAccessPermissions` for `role` (as read, legacy fields included) and the
 * filtered `updates` (which it may extend with an inherited `SHARE`): legacy top-level
 * permission types merged into the permissions and unset, a legacy `SHARED_GLOBAL` inherited
 * into `SHARE` and removed, then the requested values.
 */
export function planRolePermissionsUpdate(
  roleName: string,
  role: object,
  updates: Record<string, Record<string, boolean>>,
): RolePermissionsPlan {
  const roleRecord = role as Record<string, unknown>;
  const currentPermissions =
    (roleRecord.permissions as Record<string, Record<string, boolean>>) || {};
  const updatedPermissions: Record<string, Record<string, boolean>> = { ...currentPermissions };
  let hasChanges = false;

  const unsetFields: Record<string, number> = {};
  const permissionTypes = Object.keys(permissionsSchema.shape || {});
  for (const permType of permissionTypes) {
    if (roleRecord[permType] && typeof roleRecord[permType] === 'object') {
      logger.info(`Migrating '${roleName}' role from old schema: found '${permType}' at top level`);

      updatedPermissions[permType] = {
        ...updatedPermissions[permType],
        ...(roleRecord[permType] as Record<string, boolean>),
      };

      unsetFields[permType] = 1;
      hasChanges = true;
    }
  }

  // Migrate legacy SHARED_GLOBAL → SHARE for PROMPTS and AGENTS.
  // SHARED_GLOBAL was removed in favour of SHARE in PR #11283. If the DB still has
  // SHARED_GLOBAL but not SHARE, inherit the value so sharing intent is preserved.
  for (const legacyPermType of LEGACY_SHARED_GLOBAL_TYPES) {
    const existingTypePerms = currentPermissions[legacyPermType];
    if (
      existingTypePerms &&
      'SHARED_GLOBAL' in existingTypePerms &&
      !('SHARE' in existingTypePerms) &&
      updates[legacyPermType] &&
      // Don't override an explicit SHARE value the caller already provided
      !('SHARE' in updates[legacyPermType])
    ) {
      const inheritedValue = existingTypePerms['SHARED_GLOBAL'];
      updates[legacyPermType]['SHARE'] = inheritedValue;
      logger.info(
        `Migrating '${roleName}' role ${legacyPermType}.SHARED_GLOBAL=${inheritedValue} → SHARE`,
      );
    }
  }

  for (const [permissionType, permissions] of Object.entries(updates)) {
    const currentTypePermissions = currentPermissions[permissionType] || {};
    updatedPermissions[permissionType] = { ...currentTypePermissions };

    for (const [permission, value] of Object.entries(permissions)) {
      if (currentTypePermissions[permission] !== value) {
        updatedPermissions[permissionType][permission] = value;
        hasChanges = true;
        logger.info(
          `Updating '${roleName}' role permission '${permissionType}' '${permission}' from ${currentTypePermissions[permission]} to: ${value}`,
        );
      }
    }
  }

  // Clean up orphaned SHARED_GLOBAL fields left in DB after the schema rename.
  // Since we $set the full permissions object, deleting from updatedPermissions
  // is sufficient to remove the field from MongoDB.
  for (const legacyPermType of LEGACY_SHARED_GLOBAL_TYPES) {
    const existingTypePerms = currentPermissions[legacyPermType];
    if (existingTypePerms && 'SHARED_GLOBAL' in existingTypePerms) {
      if (!updates[legacyPermType]) {
        // permType wasn't in the update payload so the migration block above didn't run.
        // Create a writable copy and handle the SHARED_GLOBAL → SHARE inheritance here
        // to avoid removing SHARED_GLOBAL without writing SHARE (data loss).
        updatedPermissions[legacyPermType] = { ...existingTypePerms };
        if (!('SHARE' in existingTypePerms)) {
          updatedPermissions[legacyPermType]['SHARE'] = existingTypePerms['SHARED_GLOBAL'];
          logger.info(
            `Migrating '${roleName}' role ${legacyPermType}.SHARED_GLOBAL=${existingTypePerms['SHARED_GLOBAL']} → SHARE`,
          );
        }
      }
      delete updatedPermissions[legacyPermType]['SHARED_GLOBAL'];
      hasChanges = true;
      logger.info(
        `Removed legacy SHARED_GLOBAL field from '${roleName}' role ${legacyPermType} permissions`,
      );
    }
  }

  return { hasChanges, updatedPermissions, unsetFields };
}

/** The distinct trimmed, non-blank names of `roleNames`. */
export function uniqueRoleNames(roleNames: readonly string[]): string[] {
  return [...new Set(roleNames.map((roleName) => roleName.trim()).filter(Boolean))];
}

/** The roles named exactly one of `names`, ignoring case (literal names, never patterns). */
export function roleNamesFilter(names: readonly string[]): StoreFilter {
  return {
    $or: names.map((roleName) => ({
      name: new RegExp(`^${escapeRegExp(roleName)}$`, 'i'),
    })),
  };
}

/** The default page of the role and member listings. */
export const ROLE_PAGE_DEFAULT_LIMIT = 50;

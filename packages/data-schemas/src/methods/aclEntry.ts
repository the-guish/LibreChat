import { Types } from 'mongoose';
import { PrincipalType, PrincipalModel, PermissionBits } from 'librechat-data-provider';
import type {
  AnyBulkWriteOperation,
  ClientSession,
  PipelineStage,
  DeleteResult,
  UpdateResult,
  UpdateQuery,
  Model,
} from 'mongoose';
import type { AclResourcePermissionPrincipal, AclUserPermissionHolder, IAclEntry } from '~/types';
import type { RoleBitsWrite } from './aclEntryRules';
import {
  OBJECT_ID_HEX,
  permissionBitSupersets,
  createPermissionWrites,
  aclPrincipalConditions,
  OWNER_ACL_PERMISSION_BIT_SUPERSETS,
} from './aclEntryRules';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { getSafeErrorFields } from '~/utils/errors';
import logger from '~/config/winston';

export {
  OWNER_ACL_PERMISSION_BIT_SUPERSETS,
  OWNER_ACL_PERMISSION_BITS,
  PERM_BITS_WRITE_ATTEMPTS,
  permissionBitSupersets,
} from './aclEntryRules';
export type { RoleBitsWrite } from './aclEntryRules';

export function createAclEntryMethods(mongoose: typeof import('mongoose')): {
  findEntriesByResource: (
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IAclEntry[]>;
  findEntriesByPrincipalsAndResource: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
    readPrimary?: boolean,
  ) => Promise<IAclEntry[]>;
  hasPermission: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permissionBit: number,
  ) => Promise<boolean>;
  getEffectivePermissions: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ) => Promise<number>;
  getEffectivePermissionsForResources: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceIds: Array<string | Types.ObjectId>,
  ) => Promise<Map<string, number>>;
  grantPermission: (
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permBits: number,
    grantedBy?: string | Types.ObjectId,
    session?: ClientSession,
    roleId?: string | Types.ObjectId,
    expiredAt?: Date,
  ) => Promise<IAclEntry | null>;
  modifyPermissionBits: (
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    addBits?: number | null,
    removeBits?: number | null,
    session?: ClientSession,
    maxAttempts?: number,
  ) => Promise<IAclEntry | null>;
  findAccessibleResources: (
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    requiredPermBit: number,
    resourceIds?: Types.ObjectId[],
    readPrimary?: boolean,
  ) => Promise<Types.ObjectId[]>;
  deleteAclEntries: (
    filter: Record<string, unknown>,
    options?: { session?: ClientSession },
  ) => Promise<DeleteResult>;
  setResourceEntriesExpiration: (
    resourceType: string,
    resourceId: string | Types.ObjectId,
    expiredAt: Date | null,
  ) => Promise<UpdateResult>;
  deletePrincipalAclEntries: (principal: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }) => Promise<void>;
  moveAclEntriesToPrincipal: (
    principalType: PrincipalType,
    fromPrincipalId: string,
    toPrincipalId: string,
    options?: { ids?: readonly string[] },
  ) => Promise<string[]>;
  replaceRoleBits: (
    writes: RoleBitsWrite[],
    options?: { session?: ClientSession; maxAttempts?: number },
  ) => Promise<{ upsertedWrites: Set<number> }>;
  bulkWriteAclEntries: (
    ops: AnyBulkWriteOperation[],
    options?: { session?: ClientSession },
  ) => Promise<import('mongodb').BulkWriteResult>;
  findPublicResourceIds: (
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: Types.ObjectId[],
    readPrimary?: boolean,
  ) => Promise<Types.ObjectId[]>;
  aggregateAclEntries: (pipeline: PipelineStage[]) => Promise<unknown[]>;
  listResourcePermissionPrincipals: (
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ) => Promise<AclResourcePermissionPrincipal[]>;
  listUserPermissionHolders: (
    resourceType: string,
    resourceId: string | Types.ObjectId,
    requiredPermBits: number,
  ) => Promise<AclUserPermissionHolder[]>;
  getFirstOwnerIdsByResource: (
    resourceType: string,
    resourceIds: Array<string | Types.ObjectId>,
  ) => Promise<Map<string, string>>;
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
} {
  /**
   * Find ACL entries for a specific resource
   * @param resourceType - The type of resource ('agent', 'project', 'file')
   * @param resourceId - The ID of the resource
   * @returns Array of ACL entries
   */
  async function findEntriesByResource(
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<IAclEntry[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query = AclEntry.find({ resourceType, resourceId });
    if (session) {
      query.session(session);
    }
    return await query.lean<IAclEntry[]>();
  }

  /**
   * Find all ACL entries for a set of principals (including public)
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @returns Array of matching ACL entries
   */
  async function findEntriesByPrincipalsAndResource(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    session?: ClientSession,
    readPrimary?: boolean,
  ): Promise<IAclEntry[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = aclPrincipalConditions(principalsList);

    const query = AclEntry.find({
      $or: principalsQuery,
      resourceType,
      resourceId,
    });
    if (session) {
      query.session(session);
    }
    if (readPrimary && !session?.inTransaction()) {
      /** Mutation snapshots must not come from a lagging secondary; a transaction already reads from the primary. */
      query.read('primary');
    }
    return await query.lean<IAclEntry[]>();
  }

  /**
   * Check if a set of principals has a specific permission on a resource.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param permissionBit - The permission bit to check (use PermissionBits enum)
   * @returns Whether any of the principals has the permission
   */
  async function hasPermission(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permissionBit: number,
  ): Promise<boolean> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = aclPrincipalConditions(principalsList);

    const entry = await AclEntry.findOne({
      $or: principalsQuery,
      resourceType,
      resourceId,
      permBits: { $in: permissionBitSupersets(permissionBit) },
    })
      .select('_id')
      .lean();

    return !!entry;
  }

  /**
   * Get the combined effective permissions for a set of principals on a resource
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @returns {Promise<number>} Effective permission bitmask
   */
  async function getEffectivePermissions(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ): Promise<number> {
    const aclEntries = await findEntriesByPrincipalsAndResource(
      principalsList,
      resourceType,
      resourceId,
    );

    let effectiveBits = 0;
    for (const entry of aclEntries) {
      effectiveBits |= entry.permBits;
    }
    return effectiveBits;
  }

  /**
   * Get effective permissions for multiple resources in a single query (BATCH)
   * Returns a map of resourceId → effectivePermissionBits
   *
   * @param principalsList - List of principals (user + groups + public)
   * @param resourceType - The type of resource ('MCPSERVER', 'AGENT', etc.)
   * @param resourceIds - Array of resource IDs to check
   * @returns {Promise<Map<string, number>>} Map of resourceId → permission bits
   *
   * @example
   * const principals = await getUserPrincipals({ userId, role });
   * const serverIds = [id1, id2, id3];
   * const permMap = await getEffectivePermissionsForResources(
   *   principals,
   *   ResourceType.MCPSERVER,
   *   serverIds
   * );
   * // permMap.get(id1.toString()) → 7 (VIEW|EDIT|DELETE)
   */
  async function getEffectivePermissionsForResources(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    resourceIds: Array<string | Types.ObjectId>,
  ): Promise<Map<string, number>> {
    if (!Array.isArray(resourceIds) || resourceIds.length === 0) {
      return new Map();
    }

    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = aclPrincipalConditions(principalsList);

    // Batch query for all resources at once
    const aclEntries = await AclEntry.find({
      $or: principalsQuery,
      resourceType,
      resourceId: { $in: resourceIds },
    }).lean();

    // Compute effective permissions per resource
    const permissionsMap = new Map<string, number>();
    for (const entry of aclEntries) {
      const rid = entry.resourceId.toString();
      const currentBits = permissionsMap.get(rid) || 0;
      permissionsMap.set(rid, currentBits | entry.permBits);
    }

    return permissionsMap;
  }

  /**
   * Grant permission to a principal for a resource
   * @param principalType - The type of principal ('user', 'group', 'public')
   * @param principalId - The ID of the principal (null for 'public')
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param permBits - The permission bits to grant
   * @param grantedBy - The ID of the user granting the permission
   * @param session - Optional MongoDB session for transactions
   * @param roleId - Optional role ID to associate with this permission
   * @returns The created or updated ACL entry
   */
  async function grantPermission(
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    permBits: number,
    grantedBy?: string | Types.ObjectId,
    session?: ClientSession,
    roleId?: string | Types.ObjectId,
    expiredAt?: Date,
  ): Promise<IAclEntry | null> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query: Record<string, unknown> = {
      principalType,
      resourceType,
      resourceId,
    };

    if (principalType !== PrincipalType.PUBLIC) {
      query.principalId =
        typeof principalId === 'string' && principalType !== PrincipalType.ROLE
          ? new Types.ObjectId(principalId)
          : principalId;
      if (principalType === PrincipalType.USER) {
        query.principalModel = PrincipalModel.USER;
      } else if (principalType === PrincipalType.GROUP) {
        query.principalModel = PrincipalModel.GROUP;
      } else if (principalType === PrincipalType.ROLE) {
        query.principalModel = PrincipalModel.ROLE;
      }
    }

    const update = {
      $set: {
        permBits,
        grantedAt: new Date(),
        ...(grantedBy && { grantedBy }),
        ...(roleId && { roleId }),
        ...(expiredAt && { expiredAt }),
      },
    };

    const options = {
      upsert: true,
      new: true,
      ...(session ? { session } : {}),
    };

    return await AclEntry.findOneAndUpdate(query, update, options);
  }

  /**
   * Modify existing permission bits for a principal on a resource
   * @param principalType - The type of principal ('user', 'group', 'public')
   * @param principalId - The ID of the principal (null for 'public')
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param addBits - Permission bits to add
   * @param removeBits - Permission bits to remove
   * @param session - Optional MongoDB session for transactions
   * @returns The updated ACL entry
   */
  async function modifyPermissionBits(
    principalType: string,
    principalId: string | Types.ObjectId | null,
    resourceType: string,
    resourceId: string | Types.ObjectId,
    addBits?: number | null,
    removeBits?: number | null,
    session?: ClientSession,
    maxAttempts?: number,
  ): Promise<IAclEntry | null> {
    const query: Record<string, unknown> = {
      principalType,
      resourceType,
      resourceId,
    };

    if (principalType !== PrincipalType.PUBLIC) {
      query.principalId =
        typeof principalId === 'string' && principalType !== PrincipalType.ROLE
          ? new Types.ObjectId(principalId)
          : principalId;
    }

    return permissionWrites.modifyEntryBits(query, addBits, removeBits, session, maxAttempts);
  }

  /**
   * Find all resources of a specific type that a set of principals has access to.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   * @param principalsList - List of principals, each containing { principalType, principalId }
   * @param resourceType - The type of resource
   * @param requiredPermBit - Required permission bit (use PermissionBits enum)
   * @param resourceIds - Optional candidate bound. When provided, only these
   *   resources are considered, so the query cost scales with the candidate set
   *   instead of every accessible resource of the type. An empty array matches
   *   nothing rather than lifting the bound.
   * @param readPrimary - Read from the primary so a lagging secondary cannot
   *   pin pre-mutation IDs into a caller's cache.
   * @returns Array of resource IDs
   */
  async function findAccessibleResources(
    principalsList: Array<{ principalType: string; principalId?: string | Types.ObjectId }>,
    resourceType: string,
    requiredPermBit: number,
    resourceIds?: Types.ObjectId[],
    readPrimary = false,
  ): Promise<Types.ObjectId[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const principalsQuery = aclPrincipalConditions(principalsList);

    const query = AclEntry.find({
      $or: principalsQuery,
      ...(resourceIds !== undefined && { resourceId: { $in: resourceIds } }),
      resourceType,
      permBits: { $in: permissionBitSupersets(requiredPermBit) },
    });
    if (readPrimary) {
      /** Cache builds must not capture a lagging secondary's pre-mutation state */
      query.read('primary');
    }
    return await query.distinct('resourceId');
  }

  /**
   * Deletes ACL entries matching the given filter.
   * @param filter - MongoDB filter query
   * @param options - Optional query options (e.g., { session })
   */
  async function deleteAclEntries(
    filter: Record<string, unknown>,
    options?: { session?: ClientSession },
  ): Promise<DeleteResult> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return AclEntry.deleteMany(filter, options || {});
  }

  /**
   * Sets the expiry of every entry on the resource, of every principal: `expiredAt` when it is a
   * `Date`, otherwise removes it.
   */
  async function setResourceEntriesExpiration(
    resourceType: string,
    resourceId: string | Types.ObjectId,
    expiredAt: Date | null,
  ): Promise<UpdateResult> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const update: UpdateQuery<IAclEntry> =
      expiredAt instanceof Date ? { $set: { expiredAt } } : { $unset: { expiredAt: 1 } };
    return AclEntry.updateMany({ resourceType, resourceId }, update);
  }

  /**
   * Removes every ACL entry a principal holds, as the principal's deletion does. A role is keyed
   * by a name every tenant reuses, so only its entries in the caller's tenant partition
   * (`tenantPartitionFilter`) go: that tenant's, or without a tenant only platform-level ones,
   * never those of each tenant's own role that shares the name (as `moveAclEntriesToPrincipal`
   * moves them on a rename). A group or user is addressed by id, passed as stored (an ObjectId).
   */
  async function deletePrincipalAclEntries(principal: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }): Promise<void> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const { principalType, principalId } = principal;
    await AclEntry.deleteMany({
      principalType,
      principalId,
      ...(principalType === PrincipalType.ROLE &&
        tenantPartitionFilter('deletePrincipalAclEntries')),
    });
  }

  /**
   * Re-keys a role principal's entries to another name (a role rename) and returns the ids it
   * moved; with `ids`, moves only those (how a caller undoes a move). Entries keep their
   * identity and bits. A move that fails part-way is undone before it rethrows; an undo that
   * fails too is logged with the entry ids, so an operator can finish it.
   *
   * Only the caller's tenant partition moves (`tenantPartitionFilter`): that tenant's entries,
   * or without a tenant only platform-level ones. A rename re-keys one role, and must not re-key
   * the entries of each tenant's own role that happens to share the name.
   */
  async function moveAclEntriesToPrincipal(
    principalType: PrincipalType,
    fromPrincipalId: string,
    toPrincipalId: string,
    options?: { ids?: readonly string[] },
  ): Promise<string[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const source = {
      principalType,
      principalId: fromPrincipalId,
      ...tenantPartitionFilter('moveAclEntriesToPrincipal'),
    };
    const ids: Types.ObjectId[] = options?.ids
      ? options.ids.map((id) => new Types.ObjectId(id))
      : (await AclEntry.find(source).select('_id').lean<Array<{ _id: Types.ObjectId }>>()).map(
          ({ _id }) => _id,
        );
    if (ids.length === 0) {
      return [];
    }
    try {
      await AclEntry.updateMany(
        { ...source, _id: { $in: ids } },
        { $set: { principalId: toPrincipalId } },
      );
    } catch (error) {
      await AclEntry.updateMany(
        { principalType, principalId: toPrincipalId, _id: { $in: ids } },
        { $set: { principalId: fromPrincipalId } },
      ).catch((undoError: unknown) =>
        logger.error('[moveAclEntriesToPrincipal] undo after a failed move failed', {
          principalType,
          fromPrincipalId,
          toPrincipalId,
          entryIds: ids.map((id) => id.toString()).join(','),
          ...getSafeErrorFields(undoError),
        }),
      );
      throw error;
    }
    return ids.map((id) => id.toString());
  }

  /** Pin nontransactional reads to the write authority, including explicit sessions. */
  async function readPermissionEntries(filter: Record<string, unknown>, session?: ClientSession) {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query = AclEntry.find(filter, null, session ? { session } : {}).sort({ _id: 1 });
    if (!session?.inTransaction()) query.read('primary');
    return query.lean();
  }

  /** The guarded permission writes (`./aclEntryRules`) on this collection. */
  const permissionWrites = createPermissionWrites<
    Awaited<ReturnType<typeof readPermissionEntries>>[number],
    ClientSession
  >({
    readEntries: readPermissionEntries,
    updateGuarded: async (guard, set, session) =>
      (
        await bulkWriteAclEntries(
          [{ updateOne: { filter: guard, update: { $set: set } } }],
          session ? { session } : {},
        )
      ).matchedCount,
    insertIfMissing: async (filter, setOnInsert, session) =>
      (
        await bulkWriteAclEntries(
          [{ updateOne: { filter, update: { $setOnInsert: setOnInsert }, upsert: true } }],
          session ? { session } : {},
        )
      ).upsertedCount,
    toEntry: (entry) => (mongoose.models.AclEntry as Model<IAclEntry>).hydrate(entry),
    inTransaction: (session) => session?.inTransaction() === true,
  });

  /**
   * Process each observed ACL once, including duplicates. Completion is tracked
   * per document; a later failure may leave earlier writes committed on standalone
   * databases and reports that fact without replaying them. This is not a batch transaction.
   */
  async function replaceRoleBits(
    writes: RoleBitsWrite[],
    options?: { session?: ClientSession; maxAttempts?: number },
  ): Promise<{ upsertedWrites: Set<number> }> {
    return permissionWrites.replaceRoleBits(writes, {
      tx: options?.session,
      maxAttempts: options?.maxAttempts,
    });
  }

  /**
   * Performs a bulk write operation on ACL entries.
   * @param ops - Array of bulk write operations
   * @param options - Optional query options (e.g., { session })
   */
  async function bulkWriteAclEntries(
    ops: AnyBulkWriteOperation[],
    options?: { session?: ClientSession },
  ): Promise<import('mongodb').BulkWriteResult> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return tenantSafeBulkWrite(AclEntry, ops as AnyBulkWriteOperation[], options || {});
  }

  /**
   * Finds all publicly accessible resource IDs for a given resource type.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   * @param resourceType - The type of resource
   * @param requiredPermissions - Required permission bits
   * @param resourceIds - Optional candidate bound; see {@link findAccessibleResources}
   * @param readPrimary - Read from the primary; see {@link findAccessibleResources}
   */
  async function findPublicResourceIds(
    resourceType: string,
    requiredPermissions: number,
    resourceIds?: Types.ObjectId[],
    readPrimary = false,
  ): Promise<Types.ObjectId[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const query = AclEntry.find({
      principalType: PrincipalType.PUBLIC,
      ...(resourceIds !== undefined && { resourceId: { $in: resourceIds } }),
      resourceType,
      permBits: { $in: permissionBitSupersets(requiredPermissions) },
    });
    if (readPrimary) {
      /** Cache builds must not capture a lagging secondary's pre-mutation state */
      query.read('primary');
    }
    return await query.distinct('resourceId');
  }

  /**
   * Runs an aggregation pipeline on the AclEntry collection. No production caller is left: its
   * two pipelines are the named reads below. Kept for now; not in the store port.
   * @param pipeline - MongoDB aggregation pipeline stages
   */
  async function aggregateAclEntries(pipeline: PipelineStage[]): Promise<unknown[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return AclEntry.aggregate(pipeline);
  }

  /**
   * A resource id as an aggregation `$match` needs it: a stringified ObjectId becomes the
   * ObjectId (`$match` inside an aggregation does no schema casting), anything else is matched
   * as given.
   */
  function toResourceMatchId(resourceId: string | Types.ObjectId): string | Types.ObjectId {
    return typeof resourceId === 'string' && OBJECT_ID_HEX.test(resourceId)
      ? Types.ObjectId.createFromHexString(resourceId)
      : resourceId;
  }

  /**
   * Every entry on the resource with its access role's id and the user or group its principal
   * id names: the pipeline the permissions controller's `getResourcePermissions` used to run
   * through `aggregateAclEntries`, unchanged.
   */
  async function listResourcePermissionPrincipals(
    resourceType: string,
    resourceId: string | Types.ObjectId,
  ): Promise<AclResourcePermissionPrincipal[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return AclEntry.aggregate<AclResourcePermissionPrincipal>([
      { $match: { resourceType, resourceId: toResourceMatchId(resourceId) } },
      {
        $lookup: { from: 'accessroles', localField: 'roleId', foreignField: '_id', as: 'role' },
      },
      {
        $lookup: { from: 'users', localField: 'principalId', foreignField: '_id', as: 'userInfo' },
      },
      {
        $lookup: {
          from: 'groups',
          localField: 'principalId',
          foreignField: '_id',
          as: 'groupInfo',
        },
      },
      {
        $project: {
          principalType: 1,
          principalId: 1,
          accessRoleId: { $arrayElemAt: ['$role.accessRoleId', 0] },
          userInfo: { $arrayElemAt: ['$userInfo', 0] },
          groupInfo: { $arrayElemAt: ['$groupInfo', 0] },
          permBits: 1,
        },
      },
    ]);
  }

  /**
   * The user entries on the resource that hold every bit of `requiredPermBits`, each with the
   * user its principal id names: the pipeline `enrichRemoteAgentPrincipals` (`packages/api`)
   * used to run through `aggregateAclEntries` for an agent's SHARE holders, unchanged.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   */
  async function listUserPermissionHolders(
    resourceType: string,
    resourceId: string | Types.ObjectId,
    requiredPermBits: number,
  ): Promise<AclUserPermissionHolder[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    return AclEntry.aggregate<AclUserPermissionHolder>([
      {
        $match: {
          resourceType,
          resourceId: toResourceMatchId(resourceId),
          principalType: PrincipalType.USER,
          permBits: { $in: permissionBitSupersets(requiredPermBits) },
        },
      },
      {
        $lookup: { from: 'users', localField: 'principalId', foreignField: '_id', as: 'userInfo' },
      },
      { $project: { principalId: 1, userInfo: { $arrayElemAt: ['$userInfo', 0] } } },
    ]);
  }

  /**
   * The earliest user owner of each resource, keyed by stringified resource id.
   * An ownership transfer grants a second owner entry before revoking the first, and a
   * revocation that fails leaves both behind, so the earliest `(grantedAt, createdAt, _id)`
   * entry is the one that decides the resource's public author — the same tie-break the
   * marketplace's author sort applies inside its own aggregation (`agent.ts`).
   */
  async function getFirstOwnerIdsByResource(
    resourceType: string,
    resourceIds: Array<string | Types.ObjectId>,
  ): Promise<Map<string, string>> {
    /* `$match` inside an aggregation does no schema casting, so a caller that passes
       stringified ids — the shape every module outside data-schemas uses — would match
       nothing at all rather than fail loudly. */
    const matchIds: Types.ObjectId[] = [];
    for (const id of resourceIds) {
      if (typeof id !== 'string') {
        matchIds.push(id);
      } else if (OBJECT_ID_HEX.test(id)) {
        matchIds.push(new Types.ObjectId(id));
      }
    }
    if (matchIds.length === 0) {
      return new Map();
    }
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const entries = (await AclEntry.aggregate([
      {
        $match: {
          resourceType,
          resourceId: { $in: matchIds },
          principalType: PrincipalType.USER,
          permBits: { $in: [...OWNER_ACL_PERMISSION_BIT_SUPERSETS] },
        },
      },
      { $sort: { grantedAt: 1, createdAt: 1, _id: 1 } },
      { $group: { _id: '$resourceId', principalId: { $first: '$principalId' } } },
    ])) as Array<{ _id?: Types.ObjectId | string; principalId?: Types.ObjectId | string }>;
    const owners = new Map<string, string>();
    for (const entry of entries) {
      const resourceId = entry?._id?.toString();
      const ownerId = entry?.principalId?.toString();
      if (resourceId && ownerId) {
        owners.set(resourceId, ownerId);
      }
    }
    return owners;
  }

  /**
   * Returns resource IDs solely owned by the given user (no other principals
   * hold DELETE on the same resource). Handles both single and array resource types.
   * See {@link permissionBitSupersets} for the Cosmos-compatible bit filter.
   */
  async function getSoleOwnedResourceIds(
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ): Promise<Types.ObjectId[]> {
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    const types = Array.isArray(resourceTypes) ? resourceTypes : [resourceTypes];
    const deleteSupersets = permissionBitSupersets(PermissionBits.DELETE);

    const ownedEntries = await AclEntry.find({
      principalType: PrincipalType.USER,
      principalId: userObjectId,
      resourceType: { $in: types },
      permBits: { $in: deleteSupersets },
    })
      .select('resourceId')
      .lean();

    if (ownedEntries.length === 0) {
      return [];
    }

    const ownedIds = ownedEntries.map((e) => e.resourceId);

    const otherOwners = await AclEntry.aggregate([
      {
        $match: {
          resourceType: { $in: types },
          resourceId: { $in: ownedIds },
          permBits: { $in: deleteSupersets },
          $or: [
            { principalId: { $ne: userObjectId } },
            { principalType: { $ne: PrincipalType.USER } },
          ],
        },
      },
      { $group: { _id: '$resourceId' } },
    ]);

    const multiOwnerIds = new Set(
      otherOwners.map((doc: { _id: Types.ObjectId }) => doc._id.toString()),
    );
    return ownedIds.filter((id) => !multiOwnerIds.has(id.toString()));
  }

  return {
    findEntriesByResource,
    findEntriesByPrincipalsAndResource,
    hasPermission,
    getEffectivePermissions,
    getEffectivePermissionsForResources,
    grantPermission,
    modifyPermissionBits,
    findAccessibleResources,
    deleteAclEntries,
    setResourceEntriesExpiration,
    deletePrincipalAclEntries,
    replaceRoleBits,
    bulkWriteAclEntries,
    findPublicResourceIds,
    aggregateAclEntries,
    listResourcePermissionPrincipals,
    listUserPermissionHolders,
    getFirstOwnerIdsByResource,
    getSoleOwnedResourceIds,
    moveAclEntriesToPrincipal,
  };
}

export type AclEntryMethods = ReturnType<typeof createAclEntryMethods>;

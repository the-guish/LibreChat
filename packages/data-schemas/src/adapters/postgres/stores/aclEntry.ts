/**
 * The PostgreSQL `AclEntryStore` (`~/ports/aclEntry`): the permission bits principals hold on
 * resources, on the `aclentries` table, through the collection primitive, with the bit masks and
 * guarded permission writes of `~/methods/aclEntryRules`. Must not import `mongoose`, `mongodb`
 * or `bson`.
 *
 * - **Principal ids** are a text column (the `objectIdOrString` override, §1.6): a user's or
 *   group's id is stored as its hex, a role's name as given, so an id object and its hex string
 *   match the same entries (on MongoDB only the stored form does, R7).
 * - **Bit masks**: a permission check matches the enumerated supersets of the required bits
 *   (`permissionBitSupersets`), as on MongoDB, which keeps its rules: a required mask made of
 *   unknown bits, and a stored value above the known bits, match nothing.
 * - **Transactions**: every method that takes a `session` runs its reads and writes on that
 *   `StoreTransaction` (`DataStore.transactions`), and the guarded writes' reads see the
 *   transaction's own writes; without one, each write commits on its own.
 * - **Bulk writes** go through the primitive's `bulk` (one transaction, each operation in a
 *   savepoint, MongoDB's ordered and unordered semantics), with tenant ids stripped from the
 *   updates first, as MongoDB's `tenantSafeBulkWrite` does; the primitive scopes the filters and
 *   the upserted entries to the active tenant.
 * - **Joins** (`listResourcePermissionPrincipals`, `listUserPermissionHolders`): the entries are
 *   read through the primitive (scoped to the active tenant), then the access roles, users and
 *   groups they name are read whole by id, one batched read per table, in raw mode (every stored
 *   field, hidden ones included, any tenant), as MongoDB's `$lookup` stages return them.
 * - **Owner reads**: `getFirstOwnerIdsByResource` is hand-written SQL (`DISTINCT ON` the
 *   resource, earliest grant first); `getSoleOwnedResourceIds` reads the user's entries, then the
 *   other holders' resources with the primitive's `distinct`.
 */
import { PrincipalType, PrincipalModel, PermissionBits } from 'librechat-data-provider';
import type { AclResourcePermissionPrincipal, AclUserPermissionHolder, IAclEntry } from '~/types';
import type { PgBulkOperation, PgFilter, PgRecord } from '../collection';
import type { StoreTransaction, IdLike } from '~/ports/common';
import type { RoleBitsWrite } from '~/methods/aclEntryRules';
import type { AclEntryStore } from '~/ports/aclEntry';
import type { PostgresStoreContext } from './context';
import {
  OBJECT_ID_HEX,
  permissionBitSupersets,
  createPermissionWrites,
  aclPrincipalConditions,
  OWNER_ACL_PERMISSION_BIT_SUPERSETS,
} from '~/methods/aclEntryRules';
import { resolveTenantScope, sanitizeTenantMutation } from '~/tenant/policy';
import { isOpenPostgresTransaction } from '../storeTransactions';
import { tenantPartitionFilter } from '../collection/tenant';
import { getSafeErrorFields } from '~/utils/errors';
import { runStoreSql, storeWhere } from './context';
import { toIdColumn } from '../values';
import logger from '~/config/winston';
import { sql } from '../query/sql';

/** An entry as the primitive reads it. */
type EntryRecord = PgRecord & { _id: string; permBits?: number };

/** The hex of an id value (a hex string of any case, or an id object); `undefined` otherwise. */
function hexOf(value: IdLike | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return OBJECT_ID_HEX.test(value) ? value.toLowerCase() : undefined;
  }
  return toIdColumn(value);
}

export function createPostgresAclEntryStore(context: PostgresStoreContext): AclEntryStore {
  const entries = () => context.collections().collection<EntryRecord>('aclentries');
  const raw = (collection: 'accessroles' | 'users' | 'groups') =>
    context.collections().raw(collection);
  const asEntries = (records: unknown) => records as IAclEntry[];

  /**
   * The principal's identity on the resource, as `grantPermission` and `modifyPermissionBits`
   * address it: a user's or group's id given as a string is the id it names.
   */
  function principalIdentity(
    principalType: string,
    principalId: IdLike | null,
    resourceType: string,
    resourceId: IdLike,
    withModel: boolean,
  ): Record<string, unknown> {
    const query: Record<string, unknown> = { principalType, resourceType, resourceId };
    if (principalType !== PrincipalType.PUBLIC) {
      query.principalId =
        typeof principalId === 'string' && principalType !== PrincipalType.ROLE
          ? toIdColumn(principalId)
          : principalId;
      if (withModel) {
        if (principalType === PrincipalType.USER) {
          query.principalModel = PrincipalModel.USER;
        } else if (principalType === PrincipalType.GROUP) {
          query.principalModel = PrincipalModel.GROUP;
        } else if (principalType === PrincipalType.ROLE) {
          query.principalModel = PrincipalModel.ROLE;
        }
      }
    }
    return query;
  }

  async function findEntriesByPrincipalsAndResource(
    principalsList: Array<{ principalType: string; principalId?: IdLike }>,
    resourceType: string,
    resourceId: IdLike,
    session?: StoreTransaction,
  ): Promise<IAclEntry[]> {
    return asEntries(
      await entries().find(
        { $or: aclPrincipalConditions(principalsList), resourceType, resourceId },
        { tx: session },
      ),
    );
  }

  /**
   * MongoDB's `tenantSafeBulkWrite`: tenant ids are stripped from every update (silently), and an
   * update left empty is dropped; the primitive restricts every filter and upsert to the tenant.
   */
  async function bulkWriteAclEntries(
    ops: readonly PgBulkOperation[],
    options?: { session?: StoreTransaction; ordered?: boolean },
  ) {
    const scope = resolveTenantScope('bulkWrite on AclEntry');
    const sanitized: PgBulkOperation[] = [];
    for (const op of ops) {
      if ('updateOne' in op || 'updateMany' in op) {
        const [kind, write] =
          'updateOne' in op
            ? (['updateOne', op.updateOne] as const)
            : (['updateMany', op.updateMany] as const);
        const result = sanitizeTenantMutation(scope, write.update as PgRecord, 'strip');
        if (!result.emptied) {
          sanitized.push({ [kind]: { ...write, update: result.update } } as PgBulkOperation);
        }
        continue;
      }
      sanitized.push(op);
    }
    if (sanitized.length === 0) {
      return {
        insertedCount: 0,
        matchedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        upsertedCount: 0,
        insertedIds: {},
        upsertedIds: {},
      };
    }
    return entries().bulk(sanitized, {
      tx: options?.session,
      ...(options?.ordered !== undefined ? { ordered: options.ordered } : {}),
    });
  }

  /** Reads made for a guarded write, oldest first; on `tx` when given (its own writes seen). */
  const readPermissionEntries = async (filter: Record<string, unknown>, tx?: StoreTransaction) =>
    (await entries().find(filter, { sort: { _id: 1 }, tx })) as EntryRecord[];

  /** The guarded permission writes (`~/methods/aclEntryRules`) on this table. */
  const permissionWrites = createPermissionWrites<EntryRecord, StoreTransaction>({
    readEntries: readPermissionEntries,
    updateGuarded: async (guard, set, tx) =>
      (
        await bulkWriteAclEntries([{ updateOne: { filter: guard, update: { $set: set } } }], {
          session: tx,
        })
      ).matchedCount,
    insertIfMissing: async (filter, setOnInsert, tx) =>
      (
        await bulkWriteAclEntries(
          [{ updateOne: { filter, update: { $setOnInsert: setOnInsert }, upsert: true } }],
          { session: tx },
        )
      ).upsertedCount,
    toEntry: (entry) => entry as unknown as IAclEntry,
    inTransaction: (tx) => isOpenPostgresTransaction(tx),
  });

  /** The access roles, users or groups with the given ids, whole and unscoped, by id. */
  async function recordsById(
    collection: 'accessroles' | 'users' | 'groups',
    ids: Iterable<string>,
  ): Promise<Map<string, PgRecord>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
      return new Map();
    }
    const found = await raw(collection).find({ _id: { $in: wanted } });
    return new Map(found.map((record) => [String(record._id), record]));
  }

  /**
   * The resource id of a named read: a stringified id is the resource with that id; any other
   * string names no resource (it can never equal a stored id).
   */
  const namedReadResourceId = (resourceId: IdLike): string | null =>
    typeof resourceId === 'string' ? (hexOf(resourceId) ?? null) : toIdColumn(resourceId);

  const store: AclEntryStore = {
    async findEntriesByResource(resourceType, resourceId, session) {
      return asEntries(await entries().find({ resourceType, resourceId }, { tx: session }));
    },

    findEntriesByPrincipalsAndResource,

    async hasPermission(principalsList, resourceType, resourceId, permissionBit) {
      const entry = await entries().exists({
        $or: aclPrincipalConditions(principalsList),
        resourceType,
        resourceId,
        permBits: { $in: permissionBitSupersets(permissionBit) },
      });
      return !!entry;
    },

    async getEffectivePermissions(principalsList, resourceType, resourceId) {
      const found = await findEntriesByPrincipalsAndResource(
        principalsList,
        resourceType,
        resourceId,
      );
      let effectiveBits = 0;
      for (const entry of found) {
        effectiveBits |= entry.permBits;
      }
      return effectiveBits;
    },

    async getEffectivePermissionsForResources(principalsList, resourceType, resourceIds) {
      if (!Array.isArray(resourceIds) || resourceIds.length === 0) {
        return new Map();
      }
      const found = await entries().find(
        {
          $or: aclPrincipalConditions(principalsList),
          resourceType,
          resourceId: { $in: resourceIds },
        },
        { projection: 'resourceId permBits' },
      );
      const permissionsMap = new Map<string, number>();
      for (const entry of found) {
        const rid = String(entry.resourceId);
        permissionsMap.set(rid, (permissionsMap.get(rid) || 0) | (entry.permBits as number));
      }
      return permissionsMap;
    },

    async grantPermission(
      principalType,
      principalId,
      resourceType,
      resourceId,
      permBits,
      grantedBy,
      session,
      roleId,
      expiredAt,
    ) {
      const query = principalIdentity(principalType, principalId, resourceType, resourceId, true);
      const update = {
        $set: {
          permBits,
          grantedAt: new Date(),
          ...(grantedBy && { grantedBy }),
          ...(roleId && { roleId }),
          ...(expiredAt && { expiredAt }),
        },
      };
      return (await entries().findOneAndUpdate(query, update, {
        upsert: true,
        returnDocument: 'after',
        tx: session,
      })) as unknown as IAclEntry | null;
    },

    async modifyPermissionBits(
      principalType,
      principalId,
      resourceType,
      resourceId,
      addBits,
      removeBits,
      session,
      maxAttempts,
    ) {
      const query = principalIdentity(principalType, principalId, resourceType, resourceId, false);
      return permissionWrites.modifyEntryBits(query, addBits, removeBits, session, maxAttempts);
    },

    async findAccessibleResources(
      principalsList,
      resourceType,
      requiredPermBit,
      resourceIds,
      _readPrimary,
    ) {
      return (await entries().distinct('resourceId', {
        $or: aclPrincipalConditions(principalsList),
        ...(resourceIds !== undefined && { resourceId: { $in: resourceIds } }),
        resourceType,
        permBits: { $in: permissionBitSupersets(requiredPermBit) },
      })) as string[];
    },

    async deleteAclEntries(filter, options) {
      return entries().deleteMany(filter, { tx: options?.session });
    },

    async setResourceEntriesExpiration(resourceType, resourceId, expiredAt) {
      return entries().updateMany(
        { resourceType, resourceId },
        expiredAt instanceof Date ? { $set: { expiredAt } } : { $unset: { expiredAt: 1 } },
      );
    },

    async deletePrincipalAclEntries({ principalType, principalId }) {
      await entries().deleteMany({
        principalType,
        principalId,
        ...(principalType === PrincipalType.ROLE &&
          tenantPartitionFilter('deletePrincipalAclEntries')),
      });
    },

    async replaceRoleBits(writes, options) {
      return permissionWrites.replaceRoleBits(writes as unknown as RoleBitsWrite[], {
        tx: options?.session,
        maxAttempts: options?.maxAttempts,
      });
    },

    async bulkWriteAclEntries(ops, options) {
      return bulkWriteAclEntries(ops as unknown as PgBulkOperation[], options);
    },

    async moveAclEntriesToPrincipal(principalType, fromPrincipalId, toPrincipalId, options) {
      const source: PgFilter = {
        principalType,
        principalId: fromPrincipalId,
        ...tenantPartitionFilter('moveAclEntriesToPrincipal'),
      };
      const ids: string[] = options?.ids
        ? options.ids.map((id) => toIdColumn(id))
        : (await entries().find(source, { projection: '_id' })).map(({ _id }) => String(_id));
      if (ids.length === 0) {
        return [];
      }
      try {
        await entries().updateMany(
          { ...source, _id: { $in: ids } },
          { $set: { principalId: toPrincipalId } },
        );
      } catch (error) {
        await entries()
          .updateMany(
            { principalType, principalId: toPrincipalId, _id: { $in: ids } },
            { $set: { principalId: fromPrincipalId } },
          )
          .catch((undoError: unknown) =>
            logger.error('[moveAclEntriesToPrincipal] undo after a failed move failed', {
              principalType,
              fromPrincipalId,
              toPrincipalId,
              entryIds: ids.join(','),
              ...getSafeErrorFields(undoError),
            }),
          );
        throw error;
      }
      return ids;
    },

    async findPublicResourceIds(resourceType, requiredPermissions, resourceIds, _readPrimary) {
      return (await entries().distinct('resourceId', {
        principalType: PrincipalType.PUBLIC,
        ...(resourceIds !== undefined && { resourceId: { $in: resourceIds } }),
        resourceType,
        permBits: { $in: permissionBitSupersets(requiredPermissions) },
      })) as string[];
    },

    async getFirstOwnerIdsByResource(resourceType, resourceIds) {
      /** Only ids the store generated can name a resource (a stray identifier is dropped). */
      const matchIds = resourceIds.flatMap((id) => {
        const hex = hexOf(id);
        return hex === undefined ? [] : [hex];
      });
      if (matchIds.length === 0) {
        return new Map();
      }
      const where = storeWhere(context, 'aclentries', {
        resourceType,
        resourceId: { $in: matchIds },
        principalType: PrincipalType.USER,
        permBits: { $in: [...OWNER_ACL_PERMISSION_BIT_SUPERSETS] },
      });
      /** The earliest `(grantedAt, createdAt, _id)` owner entry of each resource. */
      const { rows } = await runStoreSql<{ resourceId: string; principalId: string | null }>(
        context,
        sql`SELECT DISTINCT ON (t."resourceId") t."resourceId"::text AS "resourceId", t."principalId" AS "principalId" FROM "aclentries" AS t WHERE ${where} ORDER BY t."resourceId", t."grantedAt" ASC NULLS FIRST, t."createdAt" ASC NULLS FIRST, t."_id" ASC`,
      );
      const owners = new Map<string, string>();
      for (const row of rows) {
        if (row.resourceId && row.principalId) {
          owners.set(row.resourceId, row.principalId);
        }
      }
      return owners;
    },

    async getSoleOwnedResourceIds(userObjectId, resourceTypes) {
      const types = Array.isArray(resourceTypes) ? resourceTypes : [resourceTypes];
      const deleteSupersets = permissionBitSupersets(PermissionBits.DELETE);
      const owned = await entries().find(
        {
          principalType: PrincipalType.USER,
          principalId: userObjectId,
          resourceType: { $in: types },
          permBits: { $in: deleteSupersets },
        },
        { projection: 'resourceId' },
      );
      if (owned.length === 0) {
        return [];
      }
      const ownedIds = owned.map((entry) => String(entry.resourceId));
      const otherOwners = await entries().distinct('resourceId', {
        resourceType: { $in: types },
        resourceId: { $in: ownedIds },
        permBits: { $in: deleteSupersets },
        $or: [
          { principalId: { $ne: userObjectId } },
          { principalType: { $ne: PrincipalType.USER } },
        ],
      });
      const multiOwnerIds = new Set(otherOwners.map(String));
      return ownedIds.filter((id) => !multiOwnerIds.has(id));
    },

    async listResourcePermissionPrincipals(resourceType, resourceId) {
      const rid = namedReadResourceId(resourceId);
      if (rid === null) {
        return [];
      }
      const found = await entries().find(
        { resourceType, resourceId: rid },
        { projection: '_id principalType principalId permBits roleId' },
      );
      const principalHex = (entry: PgRecord, type: string) =>
        entry.principalType === type ? hexOf(entry.principalId as string | undefined) : undefined;
      const [roles, users, groups] = await Promise.all([
        recordsById(
          'accessroles',
          found.flatMap((entry) => (entry.roleId ? [String(entry.roleId)] : [])),
        ),
        recordsById(
          'users',
          found.flatMap((entry) => principalHex(entry, PrincipalType.USER) ?? []),
        ),
        recordsById(
          'groups',
          found.flatMap((entry) => principalHex(entry, PrincipalType.GROUP) ?? []),
        ),
      ]);
      return found.map((entry) => {
        const accessRoleId = entry.roleId
          ? roles.get(String(entry.roleId))?.accessRoleId
          : undefined;
        const userHex = principalHex(entry, PrincipalType.USER);
        const groupHex = principalHex(entry, PrincipalType.GROUP);
        const userInfo = userHex ? users.get(userHex) : undefined;
        const groupInfo = groupHex ? groups.get(groupHex) : undefined;
        return {
          _id: entry._id,
          ...(entry.principalType !== undefined && { principalType: entry.principalType }),
          ...(entry.principalId !== undefined && { principalId: entry.principalId }),
          ...(accessRoleId !== undefined && { accessRoleId }),
          ...(userInfo !== undefined && { userInfo }),
          ...(groupInfo !== undefined && { groupInfo }),
          ...(entry.permBits !== undefined && { permBits: entry.permBits }),
        } as unknown as AclResourcePermissionPrincipal;
      });
    },

    async listUserPermissionHolders(resourceType, resourceId, requiredPermBits) {
      const rid = namedReadResourceId(resourceId);
      if (rid === null) {
        return [];
      }
      const found = await entries().find(
        {
          resourceType,
          resourceId: rid,
          principalType: PrincipalType.USER,
          permBits: { $in: permissionBitSupersets(requiredPermBits) },
        },
        { projection: '_id principalId' },
      );
      const users = await recordsById(
        'users',
        found.flatMap((entry) => hexOf(entry.principalId as string | undefined) ?? []),
      );
      return found.map((entry) => {
        const hex = hexOf(entry.principalId as string | undefined);
        const userInfo = hex ? users.get(hex) : undefined;
        return {
          _id: entry._id,
          ...(entry.principalId !== undefined && { principalId: entry.principalId }),
          ...(userInfo !== undefined && { userInfo }),
        } as unknown as AclUserPermissionHolder;
      });
    },
  };
  return store;
}

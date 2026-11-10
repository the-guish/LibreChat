import { Types } from 'mongoose';
import { PrincipalType, PrincipalModel, ResourceType } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { AclEntryStore, AclEntryStoreBulkWrite, AclRoleBitsStoreWrite } from './aclEntry';
import type { AclEntryMethods } from '~/methods/aclEntry';
import type { StoreTransaction } from './common';
import type { Assert } from './conformance';
import { assertStoreFilter, assertStoreUpdate } from './query';

/**
 * Whether the MongoDB method `K` accepts every value the port's method `K` admits as its
 * parameter `I`, checked one way (the port specs compare whole signatures, whose parameters
 * TypeScript checks in either direction).
 */
type AcceptsParam<
  K extends keyof AclEntryStore & keyof AclEntryMethods,
  I extends number,
> = Parameters<AclEntryStore[K]>[I] extends Parameters<AclEntryMethods[K]>[I] ? true : false;

/** A MongoDB session is a valid store transaction, as `DataStore.transactions` hands it out. */
type SessionIsStoreTransaction = [ClientSession] extends [StoreTransaction] ? true : false;

/* Type-level conformance: fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<AcceptsParam<'deleteAclEntries', 0>>,
  Assert<AcceptsParam<'replaceRoleBits', 0>>,
  Assert<AcceptsParam<'bulkWriteAclEntries', 0>>,
  Assert<SessionIsStoreTransaction>,
];

/** The shapes the non-test callers pass today, as recorded for this port. */
const resourceId = new Types.ObjectId();
const principalId = new Types.ObjectId();
const roleId = new Types.ObjectId();

const deleteFilters = [
  /* `removeAllPermissions` (`accessControlService.ts`, `createMethods`), `PermissionService.js` */
  { resourceType: ResourceType.AGENT, resourceId },
  /* a revoke of `bulkUpdateResourcePermissions` (with the public principal: no `principalId`) */
  { principalType: PrincipalType.USER, resourceType: ResourceType.AGENT, resourceId, principalId },
  { principalType: PrincipalType.PUBLIC, resourceType: ResourceType.AGENT, resourceId },
  /* admin user and group deletion (`admin/users.ts`, `admin/groups.ts`) */
  { principalType: PrincipalType.GROUP, principalId },
  /* user erasure (`user/erasure.ts`) */
  { principalId },
];

const bulkWrites: AclEntryStoreBulkWrite[] = [
  /* a grant of `bulkUpdateResourcePermissions` */
  {
    updateMany: {
      filter: {
        principalType: PrincipalType.USER,
        resourceType: ResourceType.AGENT,
        resourceId,
        principalId,
      },
      update: {
        $set: { permBits: 3, roleId, grantedBy: principalId, grantedAt: new Date() },
        $setOnInsert: {
          principalType: PrincipalType.USER,
          resourceType: ResourceType.AGENT,
          resourceId,
          principalId,
          principalModel: PrincipalModel.USER,
        },
      },
      upsert: true,
    },
  },
  /* the remote agent owner backfill (`apiKeys/permissions.ts`), with `{ ordered: false }` */
  {
    updateOne: {
      filter: {
        principalType: PrincipalType.USER,
        principalId,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId,
      },
      update: {
        $setOnInsert: {
          principalType: PrincipalType.USER,
          principalId,
          principalModel: 'User',
          resourceType: ResourceType.REMOTE_AGENT,
          resourceId,
          permBits: 15,
          roleId,
          grantedBy: principalId,
          grantedAt: new Date(),
        },
      },
      upsert: true,
    },
  },
];

const roleBitsWrites: AclRoleBitsStoreWrite[] = [
  /* a role-only edit of `bulkUpdateResourcePermissions` */
  {
    filter: {
      principalType: PrincipalType.USER,
      resourceType: ResourceType.AGENT,
      resourceId,
      principalId,
    },
    insert: {
      principalType: PrincipalType.USER,
      resourceType: ResourceType.AGENT,
      resourceId,
      principalId,
      principalModel: PrincipalModel.USER,
    },
    roleBits: 3,
    metadata: { roleId, grantedBy: principalId, grantedAt: new Date() },
  },
];

describe('ACL entry store writes', () => {
  it('are accepted by the MongoDB methods for every criterion the port admits (type level)', () => {
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('take filters the callers pass in the store query language', () => {
    for (const filter of deleteFilters) {
      expect(() => assertStoreFilter(filter)).not.toThrow();
    }
    for (const write of roleBitsWrites) {
      expect(() => assertStoreFilter(write.filter)).not.toThrow();
    }
  });

  it('take bulk updates the callers pass in the store query language', () => {
    for (const op of bulkWrites) {
      const { filter, update } = 'updateOne' in op ? op.updateOne : op.updateMany;
      expect(() => assertStoreFilter(filter)).not.toThrow();
      expect(() => assertStoreUpdate(update)).not.toThrow();
    }
  });
});

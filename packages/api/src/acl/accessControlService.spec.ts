import { CacheKeys } from 'librechat-data-provider';
import { createTestDataStore } from '@librechat/data-schemas/testing';
import { getDataStoreBackend, logger, RoleBits } from '@librechat/data-schemas';
import {
  ResourceType,
  AccessRoleIds,
  PermissionBits,
  PrincipalModel,
  PrincipalType,
} from 'librechat-data-provider';
import type { TestDataStore, RawRecord } from '@librechat/data-schemas/testing';
import type { StoreIdValue } from '@librechat/data-schemas';
import type { AccessControlMethods } from './accessControlService';
import {
  AccessControlService,
  permissionErrorCode,
  ResourcePermissionsBusyError,
} from './accessControlService';
import { userPrincipalsCache } from '~/cache';

// Mock the logger
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

/** The test data store (`createTestDataStore()`), on the backend `DATABASE_BACKEND` selects. */
let store: TestDataStore;
let service: AccessControlService;
let dbMethods: TestDataStore['methods'];

/** The backend's id format, which needs no connection (the fixture ids below exist before it). */
const ids = getDataStoreBackend().ids;
/** A new id, as the store's id value (an ObjectId on MongoDB, its hex string on PostgreSQL). */
const newId = () => ids.toStoreId(ids.generate()) as StoreIdValue;

// Mock getUserPrincipals to control test scenarios
const mockGetUserPrincipals = jest.fn();

beforeAll(async () => {
  /** The data methods the ACL service builds on: with the user principals cache. */
  store = await createTestDataStore({
    deps: {
      getCache: (key) => (key === CacheKeys.USER_PRINCIPALS ? userPrincipalsCache() : undefined),
    },
  });

  // Seed default roles
  dbMethods = store.methods;
  await dbMethods.seedDefaultRoles();

  // Create service instance
  service = new AccessControlService(dbMethods as unknown as AccessControlMethods);

  // Mock getUserPrincipals in the dbMethods
  const originalMethods = service['_dbMethods'];
  service['_dbMethods'] = {
    ...originalMethods,
    getUserPrincipals: mockGetUserPrincipals,
  };
}, 180000);

afterAll(async () => {
  await store?.close();
}, 60000);

beforeEach(async () => {
  // Clear test data but keep seeded roles
  await store.reset();
  await dbMethods.seedDefaultRoles();
  mockGetUserPrincipals.mockReset();
});

/** Whether `record` (read raw) holds every field of `match`, ids compared as their hex. */
function matches(record: RawRecord, match: Record<string, unknown>): boolean {
  return Object.entries(match).every(
    ([key, value]) => record[key] != null && String(record[key]) === String(value),
  );
}

/** Every ACL entry (read raw) whose fields equal `match`. */
async function findAclEntries(match: Record<string, unknown>): Promise<RawRecord[]> {
  return (await store.read('aclentries')).filter((entry) => matches(entry, match));
}

/** The first ACL entry (read raw) whose fields equal `match`, or `null`. */
async function findAclEntry(match: Record<string, unknown>): Promise<RawRecord | null> {
  return (await findAclEntries(match))[0] ?? null;
}

/** How many ACL entries (read raw) have the fields of `match`. */
async function countAclEntries(match: Record<string, unknown>): Promise<number> {
  return (await findAclEntries(match)).length;
}

/**
 * Seeds ACL entries in raw mode, each with a new id. The principal id is kept as given (the
 * store's id value for a user or group), as the ACL store matches it.
 */
async function seedAclEntries(entries: RawRecord[]): Promise<void> {
  await store.seed(
    'aclentries',
    entries.map((entry) => ({ ...entry, _id: ids.generate() })),
  );
}

/**
 * Makes the store one that cannot run transactions, as the store transactions port allows
 * (`transaction` runs `fn` once, with no transaction): the update then serializes itself with a
 * per-resource lease, which the lease cases test. MongoDB's in-memory server (a standalone
 * server) is such a store already; on a store that runs transactions (PostgreSQL, a MongoDB
 * replica set) the update joins one instead and takes no lease.
 */
function withoutTransactions(): void {
  jest
    .spyOn(service['_dbMethods'], 'transaction')
    .mockImplementation(<T>(fn: (tx: undefined) => Promise<T>) => fn(undefined));
}

describe('AccessControlService', () => {
  // Common test data
  const userId = newId();
  const groupId = newId();
  const resourceId = newId();
  const grantedById = newId();

  describe('bulkUpdateResourcePermissions', () => {
    test('plans the Insights revocation per request and leaves the access removed', async () => {
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        grantedBy: grantedById,
      });

      const revoke = () =>
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.AGENT,
          resourceId,
          revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
          grantedBy: grantedById,
        });
      const results = await Promise.all([revoke(), revoke()]);

      /** Audit precedes the write: a racing request plans the revocation it read, or none if it read after the delete. */
      const planned = results.flatMap((result) => result.insightsChanges);
      expect(planned.length).toBeGreaterThanOrEqual(1);
      expect(planned.every((change) => change.action === 'removed')).toBe(true);
      const withInsights = (
        await findAclEntries({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
        })
      ).filter(
        (entry) =>
          ((entry.permBits as number) & PermissionBits.VIEW_INSIGHTS) ===
          PermissionBits.VIEW_INSIGHTS,
      );
      expect(withInsights).toEqual([]);
    });

    test('removes duplicate ACL entries for a revoked principal', async () => {
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        grantedBy: grantedById,
      });
      const entry = await findAclEntry({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      });
      await seedAclEntries([{ ...entry, principalId: userId }]);

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toHaveLength(1);
      await expect(
        countAclEntries({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
        }),
      ).resolves.toBe(0);
    });

    test('removes Insights access from every duplicate ACL entry', async () => {
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: true,
          },
        ],
        grantedBy: grantedById,
      });
      const entry = await findAclEntry({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      });
      await seedAclEntries([
        {
          ...entry,
          principalId: userId,
          permBits: PermissionBits.VIEW,
        },
      ]);

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            id: userId.toString(),
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            viewInsights: false,
          },
        ],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toEqual([expect.objectContaining({ action: 'removed' })]);
      const entries = await findAclEntries({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId,
      });
      expect(entries).toHaveLength(2);
      expect(
        entries.every(
          (candidate) => ((candidate.permBits as number) & PermissionBits.VIEW_INSIGHTS) === 0,
        ),
      ).toBe(true);
    });

    test('audits a revoke when any duplicate ACL entry has Insights access', async () => {
      const viewerRole = await dbMethods.findRoleByIdentifier(AccessRoleIds.AGENT_VIEWER);
      await seedAclEntries([
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId,
          permBits: PermissionBits.VIEW,
          roleId: viewerRole?._id,
          grantedBy: grantedById,
          grantedAt: new Date(),
        },
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId,
          permBits: PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
          roleId: viewerRole?._id,
          grantedBy: grantedById,
          grantedAt: new Date(),
        },
      ]);

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toEqual([
        expect.objectContaining({
          action: 'removed',
          previous: expect.objectContaining({
            permBits: PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
          }),
        }),
      ]);
    });

    test('reports every effective ACL change as plain ids and bits', async () => {
      const principal = { type: PrincipalType.USER, id: userId.toString() };
      const grant = (accessRoleId: AccessRoleIds) =>
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [{ ...principal, accessRoleId }],
          grantedBy: grantedById,
        });
      const entryBits = async () =>
        (
          await findAclEntry({
            principalId: userId,
            resourceType: ResourceType.PROMPTGROUP,
            resourceId,
          })
        )?.permBits;

      const created = await grant(AccessRoleIds.PROMPTGROUP_VIEWER);
      expect(created.insightsChanges).toEqual([]);
      expect(created.aclChanges).toEqual([
        { action: 'assigned', previous: null, written: expect.any(Object), principal },
      ]);
      const viewerBits = await entryBits();

      const updated = await grant(AccessRoleIds.PROMPTGROUP_EDITOR);
      expect(updated.aclChanges).toEqual([
        expect.objectContaining({
          action: 'assigned',
          previous: { permBits: viewerBits, roleId: expect.any(String) },
          written: { permBits: await entryBits(), roleId: expect.any(String) },
        }),
      ]);

      const revoked = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [principal],
        grantedBy: grantedById,
      });
      expect(revoked.aclChanges).toEqual([
        expect.objectContaining({ action: 'removed', written: null }),
      ]);
      expect(await entryBits()).toBeUndefined();

      const noop = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: newId().toString() }],
        grantedBy: grantedById,
      });
      expect(noop.aclChanges).toEqual([]);
    });

    test('calls beforeWrite with the changes before any ACL write, and a throw leaves the ACL untouched', async () => {
      const seen: unknown[] = [];
      const entryCount = () =>
        countAclEntries({ resourceType: ResourceType.PROMPTGROUP, resourceId });

      await expect(
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [
            {
              type: PrincipalType.USER,
              id: userId.toString(),
              accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
            },
          ],
          grantedBy: grantedById,
          beforeWrite: async (plan) => {
            seen.push(plan.aclChanges.length, await entryCount());
            throw new Error('audit unavailable');
          },
        }),
      ).rejects.toThrow('audit unavailable');

      expect(seen).toEqual([1, 0]);
      expect(await entryCount()).toBe(0);
    });

    test('a revoke with nothing audited does not delete an entry that appeared after the read', async () => {
      const viewerRole = await dbMethods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_VIEWER);

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
        beforeWrite: async () => {
          throw new Error('beforeWrite must not run for an empty plan');
        },
      });
      expect(result.aclChanges).toEqual([]);

      const entry = {
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits: PermissionBits.VIEW,
        roleId: viewerRole?._id,
        grantedBy: grantedById,
        grantedAt: new Date(),
      };
      const spy = jest
        .spyOn(service['_dbMethods'], 'findEntriesByPrincipalsAndResource')
        .mockImplementationOnce(async () => {
          await seedAclEntries([entry]);
          return [];
        });
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });
      spy.mockRestore();

      await expect(
        findAclEntry({
          principalId: userId,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
        }),
      ).resolves.not.toBeNull();
    });

    test('audits a revoke whose principal id differs only in case from the stored id', async () => {
      const viewerRole = await dbMethods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_VIEWER);
      await seedAclEntries([
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          permBits: PermissionBits.VIEW,
          roleId: viewerRole?._id,
          grantedBy: grantedById,
          grantedAt: new Date(),
        },
      ]);
      const planned: number[] = [];

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString().toUpperCase() }],
        grantedBy: grantedById,
        beforeWrite: async (plan) => {
          planned.push(plan.aclChanges.length);
        },
      });

      expect(planned).toEqual([1]);
      expect(result.aclChanges).toEqual([expect.objectContaining({ action: 'removed' })]);
      await expect(
        findAclEntry({
          principalId: userId,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
        }),
      ).resolves.toBeNull();
    });

    test('an explicit public disable wins over a public update in the same request', async () => {
      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        updatedPrincipals: [
          { type: PrincipalType.PUBLIC, accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER },
        ],
        revokedPrincipals: [{ type: PrincipalType.PUBLIC }],
        grantedBy: grantedById,
      });

      expect(result.aclChanges).toEqual([]);
      await expect(
        findAclEntry({
          principalType: PrincipalType.PUBLIC,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
        }),
      ).resolves.toBeNull();
    });

    test('audits duplicate ACL rows as their combined permissions and ignores Insights on non-agents', async () => {
      const viewerRole = await dbMethods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_VIEWER);
      const row = (permBits: number) => ({
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        permBits,
        roleId: viewerRole?._id,
        grantedBy: grantedById,
        grantedAt: new Date(),
      });
      await seedAclEntries([
        row(PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS),
        row(PermissionBits.VIEW | PermissionBits.EDIT),
      ]);

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toEqual([]);
      expect(result.aclChanges).toEqual([
        expect.objectContaining({
          previous: expect.objectContaining({
            permBits: PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.VIEW_INSIGHTS,
          }),
        }),
      ]);
    });

    test('plans one revocation when the same principal is revoked twice', async () => {
      const viewerRole = await dbMethods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_VIEWER);
      await seedAclEntries([
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          permBits: PermissionBits.VIEW,
          roleId: viewerRole?._id,
          grantedBy: grantedById,
          grantedAt: new Date(),
        },
      ]);
      const principal = { type: PrincipalType.USER, id: userId.toString() };

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [principal, { ...principal, id: principal.id.toUpperCase() }],
        grantedBy: grantedById,
      });

      expect(result.aclChanges).toHaveLength(1);
    });

    test('serializes concurrent updates of one resource so each audit precedes its own write', async () => {
      withoutTransactions();
      const events: string[] = [];
      const acquire = jest.spyOn(service['_dbMethods'], 'acquireResourceLock');
      const update = (label: string, id: StoreIdValue, hold: number) =>
        service
          .bulkUpdateResourcePermissions({
            resourceType: ResourceType.PROMPTGROUP,
            resourceId,
            updatedPrincipals: [
              {
                type: PrincipalType.USER,
                id: id.toString(),
                accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
              },
            ],
            grantedBy: grantedById,
            beforeWrite: async () => {
              events.push(`${label}:audit`);
              await new Promise((resolve) => setTimeout(resolve, hold));
            },
          })
          .then(() => events.push(`${label}:done`));

      await Promise.all([update('A', userId, 150), update('B', newId(), 0)]);

      const first = events[0].split(':')[0];
      expect(events.slice(0, 2)).toEqual([`${first}:audit`, `${first}:done`]);
      expect(events).toHaveLength(4);
      expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(2);
      acquire.mockRestore();
    });

    test('runs afterWrite even when the post-commit prompt invalidation throws', async () => {
      const invalidate = jest
        .spyOn(service['_dbMethods'], 'invalidatePromptGroupAccessContext')
        .mockRejectedValue(new Error('cache down'));
      const afterWrite = jest.fn().mockResolvedValue(undefined);

      await expect(
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [],
          grantedBy: grantedById,
          afterWrite,
        }),
      ).rejects.toThrow('cache down');

      expect(afterWrite).toHaveBeenCalledTimes(1);
      invalidate.mockRestore();
    });

    test('answers a retryable 503 when the lock store fails', async () => {
      withoutTransactions();
      const acquire = jest
        .spyOn(service['_dbMethods'], 'acquireResourceLock')
        .mockRejectedValue(new Error('mongo secret detail'));

      await expect(
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [],
          grantedBy: grantedById,
        }),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'RESOURCE_PERMISSIONS_UNAVAILABLE',
        message: expect.not.stringContaining('secret'),
      });
      acquire.mockRestore();
    });

    test('answers a retryable 503 when the lease renewal fails', async () => {
      withoutTransactions();
      const renew = jest
        .spyOn(service['_dbMethods'], 'renewResourceLock')
        .mockRejectedValue(new Error('mongo secret detail'));

      await expect(
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [],
          grantedBy: grantedById,
          maxWriteAttempts: 1,
          beforeWrite: async () => undefined,
        }),
      ).rejects.toMatchObject({ statusCode: 503, message: expect.not.stringContaining('secret') });
      renew.mockRestore();
    });

    test('honors the configured lease wait and TTL', async () => {
      withoutTransactions();
      const key = `acl:${ResourceType.PROMPTGROUP.toLowerCase()}:${resourceId}`;
      await service['_dbMethods'].acquireResourceLock({ key, ownerId: 'other', ttlMs: 60_000 });
      const started = Date.now();

      await expect(
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [],
          grantedBy: grantedById,
          leaseWaitMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_PERMISSIONS_BUSY' });
      expect(Date.now() - started).toBeLessThan(1000);

      await service['_dbMethods'].releaseResourceLock({ key, ownerId: 'other' });
      const acquire = jest.spyOn(service['_dbMethods'], 'acquireResourceLock');
      await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        updatedPrincipals: [],
        grantedBy: grantedById,
        leaseTtlMs: 12_345,
      });
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: 12_345 }));
      acquire.mockRestore();
    });

    test('exposes the busy code for the HTTP error body only', () => {
      expect(permissionErrorCode(new ResourcePermissionsBusyError())).toEqual({
        code: 'RESOURCE_PERMISSIONS_BUSY',
      });
      expect(
        permissionErrorCode(
          Object.assign(new Error('x'), { code: 'PERMISSION_AUDIT_UNAVAILABLE' }),
        ),
      ).toEqual({
        code: 'PERMISSION_AUDIT_UNAVAILABLE',
      });
      expect(
        permissionErrorCode(Object.assign(new Error('x'), { code: 'EOTHER' })),
      ).toBeUndefined();
      expect(permissionErrorCode(new Error('x'))).toBeUndefined();
    });

    test('keys the lease on the canonical resource id', async () => {
      withoutTransactions();
      const acquire = jest.spyOn(service['_dbMethods'], 'acquireResourceLock');
      for (const id of [resourceId.toString(), resourceId.toString().toUpperCase()]) {
        await service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: id,
          updatedPrincipals: [],
          grantedBy: grantedById,
        });
      }
      const keys = acquire.mock.calls.map(([data]) => data.key);
      expect(new Set(keys).size).toBe(1);
      acquire.mockRestore();
    });

    test('refuses to write once the lease was taken over', async () => {
      withoutTransactions();
      const key = `acl:${ResourceType.PROMPTGROUP.toLowerCase()}:${resourceId}`;
      await expect(
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [
            {
              type: PrincipalType.USER,
              id: userId.toString(),
              accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
            },
          ],
          grantedBy: grantedById,
          beforeWrite: async () => {
            /** The service's lease ends (released under its own holder, read raw, as one that
             *  expired would), and another holder takes the key over. */
            const lease = (await store.read('resourcelocks')).find((lock) => lock.key === key);
            await expect(
              service['_dbMethods'].releaseResourceLock({ key, ownerId: String(lease?.ownerId) }),
            ).resolves.toBe(true);
            await service['_dbMethods'].acquireResourceLock({
              key,
              ownerId: 'taker',
              ttlMs: 60_000,
            });
          },
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_PERMISSIONS_BUSY' });
      await expect(
        findAclEntry({
          principalId: userId,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
        }),
      ).resolves.toBeNull();
      await service['_dbMethods'].releaseResourceLock({ key, ownerId: 'taker' });
    });

    test('reports a conflict when the resource lease cannot be taken in time', async () => {
      withoutTransactions();
      const key = `acl:${ResourceType.PROMPTGROUP.toLowerCase()}:${resourceId}`;
      await service['_dbMethods'].acquireResourceLock({ key, ownerId: 'other', ttlMs: 60_000 });

      await expect(
        service.bulkUpdateResourcePermissions({
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          updatedPrincipals: [
            {
              type: PrincipalType.USER,
              id: userId.toString(),
              accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
            },
          ],
          grantedBy: grantedById,
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_PERMISSIONS_BUSY' });
      await service['_dbMethods'].releaseResourceLock({ key, ownerId: 'other' });
    }, 15000);

    test('revoking snapshots the principal without loading the rest of the ACL', async () => {
      const otherUserId = newId();
      const viewerRole = await dbMethods.findRoleByIdentifier(AccessRoleIds.PROMPTGROUP_VIEWER);
      for (const principalId of [userId, otherUserId]) {
        await seedAclEntries([
          {
            principalType: PrincipalType.USER,
            principalId,
            principalModel: PrincipalModel.USER,
            resourceType: ResourceType.PROMPTGROUP,
            resourceId,
            permBits: PermissionBits.VIEW,
            roleId: viewerRole?._id,
            grantedBy: grantedById,
            grantedAt: new Date(),
          },
        ]);
      }

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.aclChanges).toHaveLength(1);
      expect(result.aclChanges[0].principal.id).toBe(userId.toString());
      await expect(
        findAclEntry({ principalId: otherUserId, resourceType: ResourceType.PROMPTGROUP }),
      ).resolves.not.toBeNull();
    });

    test('does not treat a non-agent permission bit as an Insights revocation', async () => {
      await seedAclEntries([
        {
          principalType: PrincipalType.USER,
          principalId: userId,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId,
          permBits: PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
          grantedBy: grantedById,
          grantedAt: new Date(),
        },
      ]);

      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.PROMPTGROUP,
        resourceId,
        revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
        grantedBy: grantedById,
      });

      expect(result.insightsChanges).toEqual([]);
      await expect(
        findAclEntry({ resourceType: ResourceType.PROMPTGROUP, resourceId }),
      ).resolves.toBeNull();
    });

    test('rejects a missing user id instead of generating an orphan ACL id', async () => {
      const result = await service.bulkUpdateResourcePermissions({
        resourceType: ResourceType.AGENT,
        resourceId,
        updatedPrincipals: [
          {
            type: PrincipalType.USER,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
          },
        ],
        grantedBy: grantedById,
      });

      expect(result.granted).toEqual([]);
      expect(result.errors).toEqual([
        expect.objectContaining({ error: 'Invalid principal ID: undefined' }),
      ]);
      await expect(
        findAclEntry({ resourceType: ResourceType.AGENT, resourceId }),
      ).resolves.toBeNull();
    });
  });

  describe('grantPermission', () => {
    describe('validation', () => {
      test('should throw error for invalid principal type', async () => {
        await expect(
          service.grantPermission({
            principalType: 'invalid' as PrincipalType,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid principal type: invalid');
      });

      test('should throw error for missing principalId with user type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: null,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for missing principalId with group type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.GROUP,
            principalId: null,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for missing principalId with role type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.ROLE,
            principalId: null,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for invalid role ID (empty string)', async () => {
        // Empty string is falsy, so it triggers the "principalId required" check first
        await expect(
          service.grantPermission({
            principalType: PrincipalType.ROLE,
            principalId: '',
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Principal ID is required for user, group, and role principals');
      });

      test('should throw error for invalid role ID (whitespace only)', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.ROLE,
            principalId: '   ',
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid role ID:');
      });

      test('should throw error for invalid user principal ID (non-ObjectId)', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: 'invalid-id',
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid principal ID: invalid-id');
      });

      test('should throw error for invalid resource ID', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId: 'invalid-id',
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid resource ID: invalid-id');
      });

      test('should throw error for invalid resource type', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: 'invalidType' as ResourceType,
            resourceId,
            accessRoleId: AccessRoleIds.AGENT_VIEWER,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Invalid resourceType: invalidType');
      });
    });

    describe('role lookup', () => {
      test('should throw error for non-existent role', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: 'non_existent_role' as AccessRoleIds,
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Role non_existent_role not found');
      });

      test('should throw error for role-resource type mismatch', async () => {
        await expect(
          service.grantPermission({
            principalType: PrincipalType.USER,
            principalId: userId,
            resourceType: ResourceType.AGENT,
            resourceId,
            accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER, // PromptGroup role for agent resource
            grantedBy: grantedById,
          }),
        ).rejects.toThrow('Role promptGroup_viewer is for promptGroup resources, not agent');
      });
    });

    describe('successful grant', () => {
      test('should grant permission to a user with a role', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.USER);
        expect(entry!.principalId!.toString()).toBe(userId.toString());
        expect(entry!.resourceType).toBe(ResourceType.AGENT);
        expect(entry!.resourceId.toString()).toBe(resourceId.toString());
        expect(entry!.permBits).toBe(RoleBits.VIEWER);
      });

      test('should grant permission to a group with a role', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.GROUP,
          principalId: groupId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.GROUP);
        expect(entry!.principalId!.toString()).toBe(groupId.toString());
        expect(entry!.permBits).toBe(RoleBits.EDITOR);
      });

      test('should grant public permission with a role', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.PUBLIC);
        expect(entry!.principalId).toBeUndefined();
        expect(entry!.permBits).toBe(RoleBits.VIEWER);
      });

      test('should grant permission to a role principal', async () => {
        const entry = await service.grantPermission({
          principalType: PrincipalType.ROLE,
          principalId: 'admin',
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          grantedBy: grantedById,
        });

        expect(entry).toBeDefined();
        expect(entry!.principalType).toBe(PrincipalType.ROLE);
        expect(entry!.principalId).toBe('admin');
        expect(entry!.permBits).toBe(RoleBits.EDITOR);
      });

      test('should update existing permission when granting to same principal and resource', async () => {
        // First grant with viewer role
        await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        // Then update to editor role
        const updated = await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_EDITOR,
          grantedBy: grantedById,
        });

        expect(updated!.permBits).toBe(RoleBits.EDITOR);

        // Verify there's only one entry
        const entries = await findAclEntries({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId,
        });
        expect(entries).toHaveLength(1);
      });
    });
  });

  describe('findAccessibleResources', () => {
    const resource1 = newId();
    const resource2 = newId();
    const resource3 = newId();

    beforeEach(async () => {
      // User can view resource 1
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource1,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // User can edit resource 2
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource2,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      // Group can view resource 3
      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: resource3,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });
    });

    describe('validation errors', () => {
      test('should throw error when requiredPermissions is not a positive number', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        await expect(
          service.findAccessibleResources({
            userId,
            resourceType: ResourceType.AGENT,
            requiredPermissions: 0,
          }),
        ).rejects.toThrow('requiredPermissions must be a positive number');
      });

      test('should throw error when requiredPermissions is negative', async () => {
        await expect(
          service.findAccessibleResources({
            userId,
            resourceType: ResourceType.AGENT,
            requiredPermissions: -1,
          }),
        ).rejects.toThrow('requiredPermissions must be a positive number');
      });

      test('should return empty array for invalid resource type (error is caught)', async () => {
        // The service catches invalid resourceType errors and returns empty array
        const result = await service.findAccessibleResources({
          userId,
          resourceType: 'invalid' as ResourceType,
          requiredPermissions: 1,
        });

        expect(result).toEqual([]);
      });
    });

    describe('empty principals', () => {
      test('should return empty array when no principals found', async () => {
        mockGetUserPrincipals.mockResolvedValue([]);

        const result = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1,
        });

        expect(result).toEqual([]);
      });
    });

    describe('successful queries', () => {
      test('should find resources user can view', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const viewableResources = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1, // VIEW
        });

        expect(viewableResources).toHaveLength(2);
        const resourceIds = viewableResources.map((id) => id.toString());
        expect(resourceIds).toContain(resource1.toString());
        expect(resourceIds).toContain(resource2.toString());
      });

      test('should find resources user can edit', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const editableResources = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 3, // EDIT
        });

        expect(editableResources).toHaveLength(1);
        expect(editableResources[0].toString()).toBe(resource2.toString());
      });

      test('should find resources accessible via group membership', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ]);

        const viewableResources = await service.findAccessibleResources({
          userId,
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1, // VIEW
        });

        expect(viewableResources).toHaveLength(3);
      });

      test('should pass role when provided', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: 'admin' },
        ]);

        await service.findAccessibleResources({
          userId,
          role: 'admin',
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1,
        });

        expect(mockGetUserPrincipals).toHaveBeenCalledWith({
          userId,
          role: 'admin',
        });
      });
    });
  });

  describe('findPubliclyAccessibleResources', () => {
    const publicResource1 = newId();
    const publicResource2 = newId();
    const privateResource = newId();

    beforeEach(async () => {
      // Public can view resource 1
      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: publicResource1,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // Public can edit resource 2
      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: publicResource2,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      // Private resource - only user access
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: privateResource,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: grantedById,
      });
    });

    describe('validation', () => {
      test('should throw error when requiredPermissions is not a positive number', async () => {
        await expect(
          service.findPubliclyAccessibleResources({
            resourceType: ResourceType.AGENT,
            requiredPermissions: 0,
          }),
        ).rejects.toThrow('requiredPermissions must be a positive number');
      });

      test('should return empty array for invalid resource type (error is caught)', async () => {
        // The service catches invalid resourceType errors and returns empty array
        const result = await service.findPubliclyAccessibleResources({
          resourceType: 'invalid' as ResourceType,
          requiredPermissions: 1,
        });

        expect(result).toEqual([]);
      });
    });

    describe('finding public resources', () => {
      test('should find publicly viewable resources', async () => {
        const publicResources = await service.findPubliclyAccessibleResources({
          resourceType: ResourceType.AGENT,
          requiredPermissions: 1, // VIEW
        });

        expect(publicResources).toHaveLength(2);
        const resourceIds = publicResources.map((id) => id.toString());
        expect(resourceIds).toContain(publicResource1.toString());
        expect(resourceIds).toContain(publicResource2.toString());
        expect(resourceIds).not.toContain(privateResource.toString());
      });

      test('should find publicly editable resources', async () => {
        const editableResources = await service.findPubliclyAccessibleResources({
          resourceType: ResourceType.AGENT,
          requiredPermissions: 3, // EDIT
        });

        expect(editableResources).toHaveLength(1);
        expect(editableResources[0].toString()).toBe(publicResource2.toString());
      });

      test('should return empty array when no public permissions exist', async () => {
        const noPublicResources = await service.findPubliclyAccessibleResources({
          resourceType: ResourceType.PROMPTGROUP,
          requiredPermissions: 1,
        });

        expect(noPublicResources).toEqual([]);
      });
    });
  });

  describe('getResourcePermissionsMap', () => {
    const resource1 = newId();
    const resource2 = newId();
    const resource3 = newId();

    beforeEach(async () => {
      // User has VIEW on resource1
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource1,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // User has EDIT on resource2
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resource2,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      // Group has EDIT on resource1 (higher permission)
      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: resource1,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });
      // resource3 has no permissions
    });

    describe('empty arrays', () => {
      test('should return empty map for empty resourceIds array', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const permissionsMap = await service.getResourcePermissionsMap({
          userId,
          role: 'user',
          resourceType: ResourceType.AGENT,
          resourceIds: [],
        });

        expect(permissionsMap).toBeInstanceOf(Map);
        expect(permissionsMap.size).toBe(0);
      });

      test('should throw on invalid resource type', async () => {
        await expect(
          service.getResourcePermissionsMap({
            userId,
            role: 'user',
            resourceType: 'invalid' as ResourceType,
            resourceIds: [resource1],
          }),
        ).rejects.toThrow('Invalid resourceType: invalid');
      });
    });

    describe('batch queries', () => {
      test('should get permissions for multiple resources in single query', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.PUBLIC },
        ]);

        const permissionsMap = await service.getResourcePermissionsMap({
          userId,
          role: 'user',
          resourceType: ResourceType.AGENT,
          resourceIds: [resource1, resource2, resource3],
        });

        expect(permissionsMap).toBeInstanceOf(Map);
        expect(permissionsMap.size).toBe(2); // resource1 and resource2
        expect(permissionsMap.get(resource1.toString())).toBe(RoleBits.VIEWER);
        expect(permissionsMap.get(resource2.toString())).toBe(RoleBits.EDITOR);
        expect(permissionsMap.get(resource3.toString())).toBeUndefined();
      });

      test('should combine permissions from multiple principals', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ]);

        const permissionsMap = await service.getResourcePermissionsMap({
          userId,
          role: 'user',
          resourceType: ResourceType.AGENT,
          resourceIds: [resource1, resource2],
        });

        expect(permissionsMap.size).toBe(2);
        // Resource1 should have VIEW (1) | EDIT (3) = 3 from combined user+group
        expect(permissionsMap.get(resource1.toString())).toBe(RoleBits.EDITOR);
        expect(permissionsMap.get(resource2.toString())).toBe(RoleBits.EDITOR);
      });

      test('should use role optimization when provided', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: 'admin' },
        ]);

        await service.getResourcePermissionsMap({
          userId,
          role: 'admin',
          resourceType: ResourceType.AGENT,
          resourceIds: [resource1],
        });

        expect(mockGetUserPrincipals).toHaveBeenCalledWith({ userId, role: 'admin' });
      });

      test('logs principal resolution failures before propagating them', async () => {
        const error = new Error('principal lookup unavailable');
        mockGetUserPrincipals.mockRejectedValue(error);

        await expect(
          service.getResourcePermissionsMap({
            userId,
            role: 'user',
            resourceType: ResourceType.AGENT,
            resourceIds: [resource1],
          }),
        ).rejects.toBe(error);

        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('Error resolving principals: principal lookup unavailable'),
          error,
        );
      });
    });
  });

  describe('removeAllPermissions', () => {
    const resourceToDelete = newId();

    beforeEach(async () => {
      // Grant multiple permissions to the resource
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: resourceToDelete,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: resourceToDelete,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });

      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: resourceToDelete,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });
    });

    describe('validation', () => {
      test('should throw error for invalid resource type', async () => {
        await expect(
          service.removeAllPermissions({
            resourceType: 'invalid' as ResourceType,
            resourceId: resourceToDelete,
          }),
        ).rejects.toThrow('Invalid resourceType: invalid');
      });

      test('should throw error for invalid resource ID', async () => {
        await expect(
          service.removeAllPermissions({
            resourceType: ResourceType.AGENT,
            resourceId: 'invalid-id',
          }),
        ).rejects.toThrow('Invalid resource ID: invalid-id');
      });
    });

    describe('cleanup', () => {
      test('should delete all permissions for a resource', async () => {
        // Verify permissions exist
        const beforeCount = await countAclEntries({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });
        expect(beforeCount).toBe(3);

        const result = await service.removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });

        expect(result.acknowledged).toBe(true);
        expect(result.deletedCount).toBe(3);

        // Verify permissions are deleted
        const afterCount = await countAclEntries({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });
        expect(afterCount).toBe(0);
      });

      test('should return result even when no permissions existed', async () => {
        const newResourceId = newId();

        const result = await service.removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: newResourceId,
        });

        expect(result.acknowledged).toBe(true);
        expect(result.deletedCount).toBe(0);
      });

      test('should not affect other resources permissions', async () => {
        const otherResource = newId();

        // Grant permission to another resource
        await service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: ResourceType.AGENT,
          resourceId: otherResource,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        await service.removeAllPermissions({
          resourceType: ResourceType.AGENT,
          resourceId: resourceToDelete,
        });

        // Verify other resource still has permissions
        const otherResourcePerms = await countAclEntries({
          resourceType: ResourceType.AGENT,
          resourceId: otherResource,
        });
        expect(otherResourcePerms).toBe(1);
      });
    });
  });

  describe('hasPublicAccess', () => {
    const publicResource = newId();
    const privateResource = newId();

    beforeEach(async () => {
      await service.grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.AGENT,
        resourceId: publicResource,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: privateResource,
        accessRoleId: AccessRoleIds.AGENT_OWNER,
        grantedBy: grantedById,
      });
    });

    test('should return true for resource with PUBLIC AclEntry', async () => {
      const findPublicResourceIdsSpy = jest.spyOn(service['_dbMethods'], 'findPublicResourceIds');
      const result = await service.hasPublicAccess({
        resourceType: ResourceType.AGENT,
        resourceId: publicResource,
      });
      expect(result).toBe(true);
      expect(findPublicResourceIdsSpy).not.toHaveBeenCalled();
      findPublicResourceIdsSpy.mockRestore();
    });

    test('should return false for resource with only user AclEntry', async () => {
      const result = await service.hasPublicAccess({
        resourceType: ResourceType.AGENT,
        resourceId: privateResource,
      });
      expect(result).toBe(false);
    });

    test('should return false for non-existent resource', async () => {
      const result = await service.hasPublicAccess({
        resourceType: ResourceType.AGENT,
        resourceId: newId(),
      });
      expect(result).toBe(false);
    });

    test('should return false for invalid resource type', async () => {
      const result = await service.hasPublicAccess({
        resourceType: 'invalid' as ResourceType,
        resourceId: publicResource,
      });
      expect(result).toBe(false);
    });
  });

  describe('checkPermission', () => {
    const testResource = newId();
    const groupResource = newId();

    beforeEach(async () => {
      // User has VIEW on testResource
      await service.grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.AGENT,
        resourceId: testResource,
        accessRoleId: AccessRoleIds.AGENT_VIEWER,
        grantedBy: grantedById,
      });

      // Group has EDIT on groupResource
      await service.grantPermission({
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        resourceType: ResourceType.AGENT,
        resourceId: groupResource,
        accessRoleId: AccessRoleIds.AGENT_EDITOR,
        grantedBy: grantedById,
      });
    });

    describe('validation', () => {
      test('should throw error when requiredPermission is not a positive number', async () => {
        await expect(
          service.checkPermission({
            userId: userId.toString(),
            resourceType: ResourceType.AGENT,
            resourceId: testResource,
            requiredPermission: 0,
          }),
        ).rejects.toThrow('requiredPermission must be a positive number');
      });

      test('should throw error when requiredPermission is negative', async () => {
        await expect(
          service.checkPermission({
            userId: userId.toString(),
            resourceType: ResourceType.AGENT,
            resourceId: testResource,
            requiredPermission: -1,
          }),
        ).rejects.toThrow('requiredPermission must be a positive number');
      });

      test('should return false for invalid resource type (error is caught)', async () => {
        // The service catches invalid resourceType errors and returns false
        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: 'invalid' as ResourceType,
          resourceId: testResource,
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(false);
      });
    });

    describe('permission scenarios', () => {
      test('should return true when user has required permission', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 1, // VIEW
        });

        expect(hasPermission).toBe(true);
      });

      test('should return false when user lacks required permission', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 3, // EDIT
        });

        expect(hasPermission).toBe(false);
      });

      test('should return false when no principals found', async () => {
        mockGetUserPrincipals.mockResolvedValue([]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(false);
      });

      test('should check permission via group membership', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.GROUP, principalId: groupId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: groupResource,
          requiredPermission: 1, // VIEW (editor includes view)
        });

        expect(hasPermission).toBe(true);
      });

      test('should return false for non-existent resource', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: newId(),
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(false);
      });

      test('should pass role when provided for optimization', async () => {
        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.ROLE, principalId: 'admin' },
        ]);

        await service.checkPermission({
          userId: userId.toString(),
          role: 'admin',
          resourceType: ResourceType.AGENT,
          resourceId: testResource,
          requiredPermission: 1,
        });

        expect(mockGetUserPrincipals).toHaveBeenCalledWith({
          userId: userId.toString(),
          role: 'admin',
        });
      });
    });

    describe('public access', () => {
      test('should check permission for public access', async () => {
        const publicResource = newId();

        await service.grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.AGENT,
          resourceId: publicResource,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        });

        mockGetUserPrincipals.mockResolvedValue([
          { principalType: PrincipalType.USER, principalId: userId },
          { principalType: PrincipalType.PUBLIC },
        ]);

        const hasPermission = await service.checkPermission({
          userId: userId.toString(),
          resourceType: ResourceType.AGENT,
          resourceId: publicResource,
          requiredPermission: 1,
        });

        expect(hasPermission).toBe(true);
      });
    });
  });

  describe('validateResourceType (via public methods)', () => {
    test('should accept AGENT resource type', async () => {
      mockGetUserPrincipals.mockResolvedValue([]);

      const result = await service.findAccessibleResources({
        userId,
        resourceType: ResourceType.AGENT,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should accept PROMPTGROUP resource type', async () => {
      mockGetUserPrincipals.mockResolvedValue([]);

      const result = await service.findAccessibleResources({
        userId,
        resourceType: ResourceType.PROMPTGROUP,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should accept MCPSERVER resource type', async () => {
      mockGetUserPrincipals.mockResolvedValue([]);

      const result = await service.findAccessibleResources({
        userId,
        resourceType: ResourceType.MCPSERVER,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should return empty array for unknown resource type (error caught)', async () => {
      // findAccessibleResources catches invalid resource type and returns empty array
      const result = await service.findAccessibleResources({
        userId,
        resourceType: 'unknown_type' as ResourceType,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should return empty array for empty string resource type (error caught)', async () => {
      // findAccessibleResources catches invalid resource type and returns empty array
      const result = await service.findAccessibleResources({
        userId,
        resourceType: '' as ResourceType,
        requiredPermissions: 1,
      });

      expect(result).toEqual([]);
    });

    test('should throw for invalid resource type in grantPermission', async () => {
      // grantPermission throws directly for invalid resource type
      await expect(
        service.grantPermission({
          principalType: PrincipalType.USER,
          principalId: userId,
          resourceType: 'unknown_type' as ResourceType,
          resourceId,
          accessRoleId: AccessRoleIds.AGENT_VIEWER,
          grantedBy: grantedById,
        }),
      ).rejects.toThrow('Invalid resourceType: unknown_type');
    });

    test('should throw for empty string resource type in removeAllPermissions', async () => {
      // removeAllPermissions throws directly for invalid resource type
      await expect(
        service.removeAllPermissions({
          resourceType: '' as ResourceType,
          resourceId,
        }),
      ).rejects.toThrow('Invalid resourceType:');
    });
  });
});

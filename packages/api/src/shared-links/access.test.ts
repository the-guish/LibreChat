jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { tenantStorage } from '@librechat/data-schemas';
import { createTestDataStore } from '@librechat/data-schemas/testing';
import {
  CacheKeys,
  ResourceType,
  PrincipalType,
  AccessRoleIds,
  PermissionBits,
} from 'librechat-data-provider';
import type { Request, Response, NextFunction } from 'express';
import type { TestDataStore, RawRecord } from '@librechat/data-schemas/testing';
import type { AccessControlMethods } from '~/acl/accessControlService';
import { AccessControlService } from '~/acl/accessControlService';
import type { SharedLinkAccessDeps } from './access';
import { createSharedLinkAccessMiddleware } from './access';
import { userPrincipalsCache } from '~/cache';

/** The test data store (`createTestDataStore()`), on the backend `DATABASE_BACKEND` selects. */
let store: TestDataStore;
let aclService: AccessControlService;
let canAccessSharedLink: ReturnType<typeof createSharedLinkAccessMiddleware>;

/** The links' owner; ids are in the store's id format, as hex strings. */
let userId: string;
const mockGetUserPrincipals = jest.fn();

/** A new id, as a hex string. */
const newId = () => store.ids.generate();
/** `id` as the store's id value, as `getUserPrincipals` and the request user carry it. */
const storeId = (id: string) => store.ids.toStoreId(id);

beforeAll(async () => {
  /** The data methods the ACL service builds on: with the user principals cache. */
  store = await createTestDataStore({
    deps: {
      getCache: (key) => (key === CacheKeys.USER_PRINCIPALS ? userPrincipalsCache() : undefined),
    },
  });
  const methods = store.methods;
  await methods.seedDefaultRoles();
  userId = newId();

  aclService = new AccessControlService(methods as unknown as AccessControlMethods);
  const originalMethods = aclService['_dbMethods'];
  aclService['_dbMethods'] = {
    ...originalMethods,
    getUserPrincipals: mockGetUserPrincipals,
  };

  /** The store methods, typed as the middleware's slice (its ids are `IdLike`, not `ObjectId`). */
  const accessDeps: SharedLinkAccessDeps = {
    db: methods as unknown as SharedLinkAccessDeps['db'],
    aclService,
  };
  canAccessSharedLink = createSharedLinkAccessMiddleware(accessDeps);
}, 180000);

afterAll(async () => {
  await store?.close();
}, 60000);

beforeEach(async () => {
  // Clear the ACL entries and the links (keep the default roles)
  await store.reset();
  await store.methods.seedDefaultRoles();
  mockGetUserPrincipals.mockReset();
  delete process.env.ALLOW_SHARED_LINKS_PUBLIC;
  delete process.env.SHARED_LINKS_AUTO_MIGRATE;
});

function createReq(overrides: Record<string, unknown> = {}): Request {
  return { params: {}, user: undefined, ...overrides } as unknown as Request;
}

function createRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

/** Every ACL entry (read raw) on the resource, of the principal type when given. */
async function findAclEntries(resourceId: string, principalType?: string): Promise<RawRecord[]> {
  return (await store.read('aclentries')).filter(
    (entry) =>
      entry.resourceId === resourceId &&
      (principalType === undefined || entry.principalType === principalType),
  );
}

/** A shared link, seeded in raw mode (its tenant, when it has one, given in `overrides`). */
async function createTestLink(overrides: RawRecord = {}) {
  const link = {
    _id: newId(),
    shareId: `share-${Date.now()}-${Math.random()}`,
    conversationId: 'convo1',
    user: userId,
    messages: [],
    ...overrides,
  };
  await store.seed('sharedlinks', [link]);
  return link;
}

async function grantPublicViewer(resourceId: string) {
  await aclService.grantPermission({
    principalType: PrincipalType.PUBLIC,
    principalId: null,
    resourceType: ResourceType.SHARED_LINK,
    resourceId,
    accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    grantedBy: userId,
  });
}

async function grantUserViewer(resourceId: string, uid: string) {
  await aclService.grantPermission({
    principalType: PrincipalType.USER,
    principalId: uid,
    resourceType: ResourceType.SHARED_LINK,
    resourceId,
    accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    grantedBy: userId,
  });
}

/**
 * Writes a USER VIEW grant directly through the ACL entry store (bypassing the role-name
 * lookup). Inherits the caller's tenant context so the entry is tenant-scoped on save.
 */
async function grantTenantUserViewer(resourceId: string, uid: string) {
  await store.methods.grantPermission(
    PrincipalType.USER,
    uid,
    ResourceType.SHARED_LINK,
    resourceId,
    PermissionBits.VIEW,
    userId,
  );
}

/**
 * Writes a ROLE VIEW grant directly through the ACL entry store (bypassing the role-name
 * lookup, which is tenant-scoped and would miss the globally seeded roles under a tenant
 * context). Inherits the caller's tenant context so the entry is tenant-scoped on save.
 */
async function grantRoleViewer(resourceId: string, role: string) {
  await store.methods.grantPermission(
    PrincipalType.ROLE,
    role,
    ResourceType.SHARED_LINK,
    resourceId,
    PermissionBits.VIEW,
    userId,
  );
}

/** Mirrors getUserPrincipals: a ROLE principal is only added when a role is supplied. */
function mockPrincipalsWithRole(viewer: string) {
  mockGetUserPrincipals.mockImplementation(({ role }: { role?: string | null }) =>
    Promise.resolve([
      { principalType: PrincipalType.USER, principalId: storeId(viewer) },
      ...(role ? [{ principalType: PrincipalType.ROLE, principalId: role }] : []),
    ]),
  );
}

describe('canAccessSharedLink', () => {
  describe('input validation', () => {
    test('returns 400 when shareId is missing', async () => {
      const req = createReq({ params: {} });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);
      expect(res._status).toBe(400);
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 404 when share does not exist', async () => {
      const req = createReq({ params: { shareId: 'nonexistent' } });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);
      expect(res._status).toBe(404);
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 404 when share is expired but ACL still exists', async () => {
      const link = await createTestLink({ expiredAt: new Date('2020-01-01T00:00:00.000Z') });
      await grantPublicViewer(link._id);
      process.env.ALLOW_SHARED_LINKS_PUBLIC = 'true';

      const req = createReq({ params: { shareId: link.shareId } });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(res._status).toBe(404);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('public links', () => {
    test('calls next() for anonymous access when ALLOW_SHARED_LINKS_PUBLIC is true', async () => {
      const link = await createTestLink();
      await grantPublicViewer(link._id);
      process.env.ALLOW_SHARED_LINKS_PUBLIC = 'true';

      const req = createReq({ params: { shareId: link.shareId } });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalled();
      expect(req).toMatchObject({
        shareResourceId: link._id,
        shareConversationId: 'convo1',
        shareOwnerId: userId,
      });
    });

    test('returns 401 for anonymous access when ALLOW_SHARED_LINKS_PUBLIC is not set', async () => {
      const link = await createTestLink();
      await grantPublicViewer(link._id);

      const req = createReq({ params: { shareId: link.shareId } });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('calls next() for authenticated access to public link even without ALLOW_SHARED_LINKS_PUBLIC', async () => {
      const link = await createTestLink();
      await grantPublicViewer(link._id);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: userId, _id: storeId(userId) },
      });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as unknown as Record<string, unknown>).shareResourceId).toBe(link._id);
    });
  });

  describe('private links', () => {
    test('returns 401 for unauthenticated user', async () => {
      const link = await createTestLink();

      const req = createReq({ params: { shareId: link.shareId } });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 403 for authenticated user without ACL entry', async () => {
      const link = await createTestLink();
      const otherUser = newId();

      mockGetUserPrincipals.mockResolvedValue([
        { principalType: PrincipalType.USER, principalId: storeId(otherUser) },
      ]);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: otherUser, _id: storeId(otherUser), role: 'USER' },
      });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(res._status).toBe(403);
      expect(res._json).toBeNull();
      expect(next).not.toHaveBeenCalled();
    });

    test('calls next() for authenticated user with ACL entry', async () => {
      const link = await createTestLink();
      const viewer = newId();
      await grantUserViewer(link._id, viewer);

      mockGetUserPrincipals.mockResolvedValue([
        { principalType: PrincipalType.USER, principalId: storeId(viewer) },
      ]);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: viewer, _id: storeId(viewer), role: 'USER' },
      });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as unknown as Record<string, unknown>).shareResourceId).toBe(link._id);
    });
  });

  describe('cross-tenant lookup', () => {
    test('exposes the share tenant after a cross-tenant user grant succeeds', async () => {
      const viewer = newId();
      const link = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        const tenantLink = await createTestLink({ tenantId: 'tenant-a' });
        await grantTenantUserViewer(tenantLink._id, viewer);
        return tenantLink;
      });
      mockGetUserPrincipals.mockResolvedValue([
        { principalType: PrincipalType.USER, principalId: storeId(viewer) },
      ]);
      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: viewer, _id: storeId(viewer), role: 'USER', tenantId: 'tenant-b' },
      });
      const res = createRes();
      const next = jest.fn();

      await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        canAccessSharedLink(req, res, next as unknown as NextFunction),
      );

      expect(next).toHaveBeenCalled();
      expect((req as unknown as Record<string, unknown>).shareTenantId).toBe('tenant-a');
      expect((req as unknown as Record<string, unknown>).shareResourceId).toBe(link._id);
    });

    test('does not let a cross-tenant viewer role satisfy a ROLE ACL from another tenant', async () => {
      // Share owned by tenant-a, granted VIEW to role USER. A tenant-b viewer whose
      // own role is also USER must not inherit that grant: role principals are just
      // name strings, so the middleware suppresses the viewer's role for cross-tenant
      // views. getUserPrincipals is called with role: null, so no ROLE principal is
      // built and the tenant-a ROLE:USER grant never matches → 403.
      const link = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        const tenantLink = await createTestLink({ tenantId: 'tenant-a' });
        await grantRoleViewer(tenantLink._id, 'USER');
        return tenantLink;
      });
      const viewer = newId();
      mockPrincipalsWithRole(viewer);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: viewer, _id: storeId(viewer), role: 'USER', tenantId: 'tenant-b' },
      });
      const res = createRes();
      const next = jest.fn();
      await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        canAccessSharedLink(req, res, next as unknown as NextFunction),
      );

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(mockGetUserPrincipals).toHaveBeenCalledWith({
        userId: viewer,
        role: null,
      });
    });

    test('still honors a ROLE ACL for a same-tenant viewer with that role', async () => {
      // Same-tenant view: the viewer's role is trusted, so the tenant-a ROLE:USER
      // grant matches and access is allowed. Confirms the cross-tenant fix does not
      // break legitimate role-based sharing within a tenant.
      const link = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        const tenantLink = await createTestLink({ tenantId: 'tenant-a' });
        await grantRoleViewer(tenantLink._id, 'USER');
        return tenantLink;
      });
      const viewer = newId();
      mockPrincipalsWithRole(viewer);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: viewer, _id: storeId(viewer), role: 'USER', tenantId: 'tenant-a' },
      });
      const res = createRes();
      const next = jest.fn();
      await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        canAccessSharedLink(req, res, next as unknown as NextFunction),
      );

      expect(next).toHaveBeenCalled();
      expect((req as unknown as Record<string, unknown>).shareResourceId).toBe(link._id);
      expect(mockGetUserPrincipals).toHaveBeenCalledWith({
        userId: viewer,
        role: 'USER',
      });
    });

    test('honors a same-tenant ROLE grant when no ALS tenant context is set (cookie-auth file request)', async () => {
      // Share file routes (<img>/download) authenticate via optionalShareFileAuth,
      // which sets req.user from the refresh cookie but establishes no tenant ALS
      // context, so getTenantId() is undefined here. The comparison must use the
      // authenticated user's own tenantId, else a same-tenant viewer is wrongly denied
      // their ROLE grant. No tenantStorage.run wrapper mirrors the file route.
      const link = await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        const tenantLink = await createTestLink({ tenantId: 'tenant-a' });
        await grantRoleViewer(tenantLink._id, 'USER');
        return tenantLink;
      });
      const viewer = newId();
      mockPrincipalsWithRole(viewer);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: viewer, _id: storeId(viewer), role: 'USER', tenantId: 'tenant-a' },
      });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as unknown as Record<string, unknown>).shareResourceId).toBe(link._id);
      expect(mockGetUserPrincipals).toHaveBeenCalledWith({
        userId: viewer,
        role: 'USER',
      });
    });

    test('resolves a share owned by another tenant via system fallback, then enforces the ACL', async () => {
      // Share created under tenant-a; an authenticated viewer from tenant-b would
      // miss the tenant-scoped lookup and previously get a 404 before access could
      // be evaluated. The system fallback now resolves the share, and the ACL check
      // (run under the share's own tenant) denies the viewer who has no grant. A 403
      // rather than a 404 confirms the share was found cross-tenant but not authorized
      // — the fallback broadens the lookup, never the authorization.
      const link = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        createTestLink({ tenantId: 'tenant-a' }),
      );
      const viewer = newId();
      mockGetUserPrincipals.mockResolvedValue([
        { principalType: PrincipalType.USER, principalId: storeId(viewer) },
      ]);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: viewer, _id: storeId(viewer), role: 'USER' },
      });
      const res = createRes();
      const next = jest.fn();
      await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        canAccessSharedLink(req, res, next as unknown as NextFunction),
      );

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._status).not.toBe(404);
    });
  });

  describe('legacy link auto-migration', () => {
    async function createLegacyLink(isPublic: boolean) {
      // Seed isPublic directly (raw mode) to simulate a legacy document
      return createTestLink({ isPublic });
    }

    test('auto-migrates public legacy link and calls next()', async () => {
      const link = await createLegacyLink(true);
      process.env.ALLOW_SHARED_LINKS_PUBLIC = 'true';

      const req = createReq({ params: { shareId: link.shareId } });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalled();

      const entries = await findAclEntries(link._id);
      const hasOwner = entries.some((e) => e.principalType === PrincipalType.USER);
      const hasPublic = entries.some((e) => e.principalType === PrincipalType.PUBLIC);
      expect(hasOwner).toBe(true);
      expect(hasPublic).toBe(true);

      const rawDoc = (await store.read('sharedlinks')).find((doc) => doc._id === link._id);
      expect(rawDoc).not.toHaveProperty('isPublic');
    });

    test('does not re-create PUBLIC after owner removes it', async () => {
      const link = await createLegacyLink(true);
      process.env.ALLOW_SHARED_LINKS_PUBLIC = 'true';

      const next1 = jest.fn();
      const req1 = createReq({ params: { shareId: link.shareId } });
      await canAccessSharedLink(req1, createRes(), next1 as unknown as NextFunction);

      await store.methods.deleteAclEntries({
        resourceId: storeId(link._id),
        principalType: PrincipalType.PUBLIC,
      });

      const next2 = jest.fn();
      const req2 = createReq({ params: { shareId: link.shareId } });
      const res2 = createRes();
      await canAccessSharedLink(req2, res2, next2 as unknown as NextFunction);

      const publicEntries = await findAclEntries(link._id, PrincipalType.PUBLIC);
      expect(publicEntries).toHaveLength(0);
    });

    test('auto-migrates legacy link with isPublic: false — no PUBLIC grant', async () => {
      const link = await createLegacyLink(false);
      const viewer = newId();
      await grantUserViewer(link._id, viewer);

      mockGetUserPrincipals.mockResolvedValue([
        { principalType: PrincipalType.USER, principalId: storeId(viewer) },
      ]);

      const req = createReq({
        params: { shareId: link.shareId },
        user: { id: viewer, _id: storeId(viewer), role: 'USER' },
      });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      const publicEntries = await findAclEntries(link._id, PrincipalType.PUBLIC);
      expect(publicEntries).toHaveLength(0);
    });

    test('returns 403 when auto-migration is disabled', async () => {
      const link = await createLegacyLink(true);
      process.env.SHARED_LINKS_AUTO_MIGRATE = 'false';

      const req = createReq({ params: { shareId: link.shareId } });
      const res = createRes();
      const next = jest.fn();
      await canAccessSharedLink(req, res, next as unknown as NextFunction);

      expect(res._status).toBe(403);
      expect(next).not.toHaveBeenCalled();
      expect((res._json as Record<string, string>).message).toContain('migration');
    });
  });
});

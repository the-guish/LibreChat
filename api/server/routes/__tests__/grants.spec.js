const express = require('express');
const request = require('supertest');
const { PrincipalType, SystemRoles } = require('librechat-data-provider');
const { createTestDataStore } = require('@librechat/data-schemas/testing');

/**
 * Integration test for the admin grants routes.
 *
 * Validates the full Express wiring: route registration → middleware →
 * handler → real database (the test data store, on the backend
 * `DATABASE_BACKEND` selects). Auth middleware is injected (matching the
 * repo pattern in keys.spec.js) so we can control the caller identity
 * without a real JWT, while the handler DI deps use real DB methods.
 */

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (_req, _res, next) => next(),
}));

let store;
let db;

/** The admin seed: the system grants of the ADMIN role and the default roles. */
async function seed() {
  await db.seedSystemGrants();
  await db.initializeRoles();
  await db.seedDefaultRoles();
}

beforeAll(async () => {
  store = await createTestDataStore();
  db = store.methods;
  await seed();
}, 180000);

afterAll(async () => {
  await store?.close();
}, 60000);

afterEach(async () => {
  // Clean non-seed grants and roles (keep admin seed)
  await store.reset();
  await seed();
});

function createApp(user) {
  const { createAdminGrantsHandlers, getCachedPrincipals } = require('@librechat/api');

  const handlers = createAdminGrantsHandlers({
    listGrants: db.listGrants,
    countGrants: db.countGrants,
    getCapabilitiesForPrincipal: db.getCapabilitiesForPrincipal,
    getCapabilitiesForPrincipals: db.getCapabilitiesForPrincipals,
    grantCapability: db.grantCapability,
    revokeCapability: db.revokeCapability,
    getUserPrincipals: db.getUserPrincipals,
    hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
    getHeldCapabilities: db.getHeldCapabilities,
    getCachedPrincipals,
    checkRoleExists: async (name) => (await db.getPartitionRole(name)) != null,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });

  const router = express.Router();
  router.get('/', handlers.listGrants);
  router.get('/effective', handlers.getEffectiveCapabilities);
  router.get('/:principalType/:principalId', handlers.getPrincipalGrants);
  router.post('/', handlers.assignGrant);
  router.delete('/:principalType/:principalId/:capability', handlers.revokeGrant);
  app.use('/api/admin/grants', router);

  return app;
}

describe('Admin Grants Routes — Integration', () => {
  const adminUser = { role: SystemRoles.ADMIN };

  beforeAll(() => {
    const adminUserId = store.ids.generate();
    adminUser._id = store.ids.toStoreId(adminUserId);
    adminUser.id = adminUserId;
  });

  it('GET / returns seeded admin grants', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/api/admin/grants').expect(200);

    expect(res.body).toHaveProperty('grants');
    expect(res.body).toHaveProperty('total');
    expect(res.body.grants.length).toBeGreaterThan(0);
    // Seeded grants are for the ADMIN role
    expect(res.body.grants[0].principalType).toBe(PrincipalType.ROLE);
  });

  it('GET /effective returns capabilities for admin', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/api/admin/grants/effective').expect(200);

    expect(res.body).toHaveProperty('capabilities');
    expect(res.body.capabilities).toContain('access:admin');
    expect(res.body.capabilities).toContain('manage:roles');
  });

  it('POST / assigns a grant and DELETE / revokes it', async () => {
    const app = createApp(adminUser);

    // Assign
    const assignRes = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: 'read:users',
      })
      .expect(201);

    expect(assignRes.body.grant).toMatchObject({
      principalType: PrincipalType.ROLE,
      principalId: SystemRoles.USER,
      capability: 'read:users',
    });

    // Verify via GET
    const getRes = await request(app)
      .get(`/api/admin/grants/${PrincipalType.ROLE}/${SystemRoles.USER}`)
      .expect(200);

    expect(getRes.body.grants.some((g) => g.capability === 'read:users')).toBe(true);

    // Revoke
    await request(app)
      .delete(`/api/admin/grants/${PrincipalType.ROLE}/${SystemRoles.USER}/read:users`)
      .expect(200);

    // Verify revoked
    const afterRes = await request(app)
      .get(`/api/admin/grants/${PrincipalType.ROLE}/${SystemRoles.USER}`)
      .expect(200);

    expect(afterRes.body.grants.some((g) => g.capability === 'read:users')).toBe(false);
  });

  it('POST / returns 400 for non-existent role when checkRoleExists is wired', async () => {
    const app = createApp(adminUser);

    const res = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: 'nonexistent-role',
        capability: 'read:users',
      })
      .expect(400);

    expect(res.body.error).toBe('Role not found');
  });

  it('POST / returns 400 for a role only a tenant holds, as the roles API addresses it', async () => {
    const { tenantStorage } = require('@librechat/data-schemas');
    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      db.createRoleByName({ name: 'tenant-only-role' }),
    );
    const app = createApp(adminUser);

    const res = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: 'tenant-only-role',
        capability: 'read:users',
      })
      .expect(400);

    expect(res.body.error).toBe('Role not found');
    const grants = await store.read('systemgrants');
    expect(grants.filter((grant) => grant.principalId === 'tenant-only-role')).toHaveLength(0);
  });

  it('POST / returns 401 without authenticated user', async () => {
    const app = createApp(undefined);

    const res = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: 'read:users',
      })
      .expect(401);

    expect(res.body).toHaveProperty('error', 'Authentication required');
  });
});

const express = require('express');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { ResourceType, PermissionBits } = require('librechat-data-provider');
const { createTestDataStore } = require('@librechat/data-schemas/testing');
const { createAgent } = require('~/models');

/**
 * Mock the PermissionsController to isolate route testing
 */
jest.mock('~/server/controllers/PermissionsController', () => ({
  getUserEffectivePermissions: jest.fn((req, res) => res.json({ permissions: [] })),
  getAllEffectivePermissions: jest.fn((req, res) => res.json({ permissions: [] })),
  updateResourcePermissions: jest.fn((req, res) => res.json({ success: true })),
  getResourcePermissions: jest.fn((req, res) =>
    res.json({
      resourceType: req.params.resourceType,
      resourceId: req.params.resourceId,
      principals: [],
      public: false,
    }),
  ),
  getResourceRoles: jest.fn((req, res) => res.json({ roles: [] })),
  searchPrincipals: jest.fn((req, res) => res.json({ principals: [] })),
}));

jest.mock('~/server/middleware/checkPeoplePickerAccess', () => ({
  checkPeoplePickerAccess: jest.fn((req, res, next) => next()),
}));

// Import actual middleware to get canAccessResource
const { canAccessResource } = require('~/server/middleware');
const { findMCPServerByObjectId } = require('~/models');

/**
 * Security Tests for SBA-ADV-20251203-02
 *
 * These tests verify that users cannot query or modify agent permissions
 * without proper SHARE permission.
 */
describe('Access Permissions Routes - Security Tests (SBA-ADV-20251203-02)', () => {
  let app;
  let store;
  let authorId;
  let attackerId;
  let agentId;
  let methods;

  beforeAll(async () => {
    // The test data store, on the backend DATABASE_BACKEND selects
    store = await createTestDataStore();
    methods = store.methods;

    await methods.seedDefaultRoles();
  }, 180000);

  afterAll(async () => {
    await store?.close();
  }, 60000);

  beforeEach(async () => {
    // Clear all collections
    await store.reset();
    await methods.seedDefaultRoles();

    // Create author (owner of the agent)
    authorId = store.ids.generate();
    // Create attacker (should not have access)
    attackerId = store.ids.generate();
    await store.seed('users', [
      {
        _id: authorId,
        name: 'Agent Owner',
        email: 'owner@example.com',
        username: 'owner@example.com',
        provider: 'local',
      },
      {
        _id: attackerId,
        name: 'Attacker',
        email: 'attacker@example.com',
        username: 'attacker@example.com',
        provider: 'local',
      },
    ]);

    // Create private agent owned by author
    const customAgentId = `agent_${uuidv4().replace(/-/g, '').substring(0, 20)}`;
    await createAgent({
      id: customAgentId,
      name: 'Private Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: authorId,
    });
    agentId = customAgentId;

    // Create Express app with attacker as current user
    app = express();
    app.use(express.json());

    // Mock authentication middleware - attacker is the current user
    app.use((req, res, next) => {
      req.user = { id: attackerId, role: 'USER' };
      req.app = { locals: {} };
      next();
    });

    // Middleware factory for permission access check (mirrors actual implementation)
    const checkResourcePermissionAccess = (requiredPermission) => (req, res, next) => {
      const { resourceType } = req.params;
      let middleware;

      if (resourceType === ResourceType.AGENT) {
        middleware = canAccessResource({
          resourceType: ResourceType.AGENT,
          requiredPermission,
          resourceIdParam: 'resourceId',
        });
      } else if (resourceType === ResourceType.PROMPTGROUP) {
        middleware = canAccessResource({
          resourceType: ResourceType.PROMPTGROUP,
          requiredPermission,
          resourceIdParam: 'resourceId',
        });
      } else if (resourceType === ResourceType.MCPSERVER) {
        middleware = canAccessResource({
          resourceType: ResourceType.MCPSERVER,
          requiredPermission,
          resourceIdParam: 'resourceId',
          idResolver: findMCPServerByObjectId,
        });
      } else {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Unsupported resource type: ${resourceType}`,
        });
      }

      middleware(req, res, next);
    };

    // GET route with access control (THE FIX)
    app.get(
      '/permissions/:resourceType/:resourceId',
      checkResourcePermissionAccess(PermissionBits.SHARE),
      (req, res) =>
        res.json({
          resourceType: req.params.resourceType,
          resourceId: req.params.resourceId,
          principals: [],
          public: false,
        }),
    );

    // PUT route with access control
    app.put(
      '/permissions/:resourceType/:resourceId',
      checkResourcePermissionAccess(PermissionBits.SHARE),
      (req, res) => res.json({ success: true }),
    );
  });

  describe('GET /permissions/:resourceType/:resourceId', () => {
    it('should deny permission query for user without access (main vulnerability test)', async () => {
      /**
       * SECURITY TEST: This is the core test for SBA-ADV-20251203-02
       *
       * Before the fix, any authenticated user could query permissions for
       * any agent by just knowing the agent ID, exposing information about
       * who has access to private agents.
       *
       * After the fix, users must have SHARE permission to view permissions.
       */
      const response = await request(app)
        .get(`/permissions/agent/${agentId}`)
        .set('Content-Type', 'application/json');

      // Should be denied - attacker has no permission on the agent
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
    });

    it('should return 400 for unsupported resource type', async () => {
      const response = await request(app)
        .get(`/permissions/unsupported/${agentId}`)
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Unsupported resource type');
    });
  });

  describe('PUT /permissions/:resourceType/:resourceId', () => {
    it('should deny permission update for user without access', async () => {
      const response = await request(app)
        .put(`/permissions/agent/${agentId}`)
        .set('Content-Type', 'application/json')
        .send({ principals: [] });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Forbidden');
    });
  });
});

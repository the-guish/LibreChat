const express = require('express');
const request = require('supertest');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
} = require('librechat-data-provider');
const { SystemCapabilities, BASE_CONFIG_PRINCIPAL_ID } = require('@librechat/data-schemas');
const { createTestDataStore } = require('@librechat/data-schemas/testing');

let mockAppConfig = {};

// Mock modules before importing
jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({}),
  getAppConfig: jest.fn().mockResolvedValue({}),
}));

/**
 * The server's data methods, on the test data store (`createTestDataStore()`, on the backend
 * `DATABASE_BACKEND` selects), with the role lookup stubbed. Their default `removeAllPermissions`
 * deletes the resource's ACL entries.
 */
jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  getRoleByName: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: jest.fn((req, res, next) => {
    req.config = mockAppConfig;
    next();
  }),
  promptUsageLimiter: (req, res, next) => next(),
  promptResolveLimiter: (req, res, next) => next(),
  canAccessPromptViaGroup: jest.requireActual('~/server/middleware').canAccessPromptViaGroup,
  canAccessPromptGroupResource:
    jest.requireActual('~/server/middleware').canAccessPromptGroupResource,
  checkBan: (_req, _res, next) => next(),
  uaParser: (_req, _res, next) => next(),
  canAccessResource: jest.requireActual('~/server/middleware').canAccessResource,
}));

const { configMiddleware } = require('~/server/middleware');

let app;
let store;
let promptRoutes;
let accessPermissionsRoutes;
let testUsers, testRoles;
/** The ids of the base fixtures (roles and users), kept across resets, from the store's id format. */
let roleIds, userIds;
let grantPermission;
let db;
let currentTestUser; // Track current user for middleware

// Helper function to set user in middleware
function setTestUser(app, user) {
  currentTestUser = user;
}

beforeAll(async () => {
  store = await createTestDataStore();
  db = require('~/models');

  // Import permission service
  const permissionService = require('~/server/services/PermissionService');
  grantPermission = permissionService.grantPermission;

  // Create test data
  await setupTestData();

  // Setup Express app
  app = express();
  app.use(express.json());

  // Add user middleware before routes
  app.use((req, res, next) => {
    if (currentTestUser) {
      req.user = {
        ...currentTestUser,
        id: currentTestUser._id.toString(),
        _id: currentTestUser._id,
        name: currentTestUser.name,
        role: currentTestUser.role,
      };
    }
    next();
  });

  // Set default user
  currentTestUser = testUsers.owner;

  // Import routes after middleware is set up
  promptRoutes = require('./prompts');
  app.use('/api/prompts', promptRoutes);

  // Mounted so the sharing test below can call the real access-permissions router
  // (and its real `updateResourcePermissions` controller) instead of the service layer.
  accessPermissionsRoutes = require('./accessPermissions');
  app.use('/api/permissions', accessPermissionsRoutes);
}, 180000);

afterEach(() => {
  mockAppConfig = {};
  // Always reset to owner user after each test for isolation
  if (currentTestUser !== testUsers.owner) {
    currentTestUser = testUsers.owner;
  }
});

afterAll(async () => {
  await store?.close();
  jest.clearAllMocks();
}, 60000);

/** A record's `createdAt`/`updatedAt` as the models' timestamps set them on create. */
function timestamps(fields) {
  const createdAt = fields.createdAt ?? new Date();
  return { createdAt, updatedAt: fields.updatedAt ?? createdAt };
}

/** Seeds a prompt group in raw mode as the prompt group model creates one, and returns it. */
async function createGroup(fields) {
  const record = {
    _id: store.ids.generate(),
    numberOfGenerations: 0,
    oneliner: '',
    category: '',
    source: 'native',
    __v: 0,
    ...fields,
    ...timestamps(fields),
  };
  await store.seed('promptgroups', [record]);
  return record;
}

/**
 * Seeds a prompt (a revision) in raw mode as the prompt model creates one, and returns it. The
 * model declares no `name`, so a prompt is created without one.
 */
async function createPrompt(fields) {
  const record = { _id: store.ids.generate(), __v: 0, ...fields, ...timestamps(fields) };
  await store.seed('prompts', [record]);
  return record;
}

/** Seeds a user in raw mode and returns it as the request user fixture (id as the store's id). */
async function createUser(fields) {
  const _id = fields._id ?? store.ids.generate();
  await store.seed('users', [{ ...fields, _id }]);
  return { ...fields, _id: store.ids.toStoreId(_id) };
}

/** Whether two field values are equal, comparing ids by their string. */
function sameValue(actual, expected) {
  if (actual == null || expected == null) {
    return actual == expected;
  }
  return String(actual) === String(expected);
}

/** Every record of `collection` (read raw) whose fields equal `match`. */
async function filterRaw(collection, match = {}) {
  return (await store.read(collection)).filter((record) =>
    Object.entries(match).every(([key, value]) => sameValue(record[key], value)),
  );
}

/** The first record of `collection` (read raw) whose fields equal `match`, or `null`. */
async function findRaw(collection, match) {
  return (await filterRaw(collection, match))[0] ?? null;
}

/** The record of `collection` (read raw) with the id `id`, or `null`. */
const findRecord = (collection, id) => findRaw(collection, { _id: id });

/** How many records of `collection` (read raw) have fields equal to `match`. */
async function countRaw(collection, match) {
  return (await filterRaw(collection, match)).length;
}

/** Seeds the prompt group roles, the users and the ADMIN role's prompt capabilities. */
async function seedBaseData() {
  // Create access roles for promptGroups
  const roleFields = [
    {
      _id: roleIds.viewer,
      accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
      name: 'Viewer',
      resourceType: ResourceType.PROMPTGROUP,
      permBits: PermissionBits.VIEW,
    },
    {
      _id: roleIds.editor,
      accessRoleId: AccessRoleIds.PROMPTGROUP_EDITOR,
      name: 'Editor',
      resourceType: ResourceType.PROMPTGROUP,
      permBits: PermissionBits.VIEW | PermissionBits.EDIT,
    },
    {
      _id: roleIds.owner,
      accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
      name: 'Owner',
      resourceType: ResourceType.PROMPTGROUP,
      permBits:
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
    },
  ];
  await store.seed(
    'accessroles',
    roleFields.map((fields) => ({ ...fields, ...timestamps(fields) })),
  );

  // Create test users
  await store.seed(
    'users',
    Object.entries(testUsers).map(([key, user]) => ({ ...user, _id: userIds[key] })),
  );

  // Seed capabilities for the ADMIN role
  await store.seed('systemgrants', [
    {
      _id: store.ids.generate(),
      principalType: PrincipalType.ROLE,
      principalId: SystemRoles.ADMIN,
      capability: SystemCapabilities.MANAGE_PROMPTS,
      grantedAt: new Date(),
    },
    {
      _id: store.ids.generate(),
      principalType: PrincipalType.ROLE,
      principalId: SystemRoles.ADMIN,
      capability: SystemCapabilities.READ_PROMPTS,
      grantedAt: new Date(),
    },
  ]);
}

/**
 * Clears the prompts, prompt groups, ACL entries and configs, by resetting the store and seeding
 * the base fixtures again under the same ids.
 */
async function resetStore() {
  await store.reset();
  await seedBaseData();
}

async function setupTestData() {
  roleIds = {
    viewer: store.ids.generate(),
    editor: store.ids.generate(),
    owner: store.ids.generate(),
  };
  userIds = {
    owner: store.ids.generate(),
    viewer: store.ids.generate(),
    editor: store.ids.generate(),
    noAccess: store.ids.generate(),
    admin: store.ids.generate(),
  };
  testRoles = {
    viewer: { _id: roleIds.viewer },
    editor: { _id: roleIds.editor },
    owner: { _id: roleIds.owner },
  };
  const user = (key, fields) => ({ _id: store.ids.toStoreId(userIds[key]), ...fields });
  testUsers = {
    owner: user('owner', {
      name: 'Prompt Owner',
      email: 'owner@example.com',
      role: SystemRoles.USER,
    }),
    viewer: user('viewer', {
      name: 'Prompt Viewer',
      email: 'viewer@example.com',
      role: SystemRoles.USER,
    }),
    editor: user('editor', {
      name: 'Prompt Editor',
      email: 'editor@example.com',
      role: SystemRoles.USER,
    }),
    noAccess: user('noAccess', {
      name: 'No Access',
      email: 'noaccess@example.com',
      role: SystemRoles.USER,
    }),
    admin: user('admin', {
      name: 'Admin',
      email: 'admin@example.com',
      role: SystemRoles.ADMIN,
    }),
  };
  await seedBaseData();

  // Mock getRoleByName
  const { getRoleByName } = require('~/models');
  getRoleByName.mockImplementation((roleName) => {
    switch (roleName) {
      case SystemRoles.USER:
        return { permissions: { PROMPTS: { USE: true, CREATE: true, SHARE: true } } };
      case SystemRoles.ADMIN:
        return { permissions: { PROMPTS: { USE: true, CREATE: true, SHARE: true } } };
      default:
        return null;
    }
  });
}

async function createAccessiblePromptGroup({
  name,
  prompt,
  production = true,
  groupId,
  type = 'text',
}) {
  // The revision's id comes first, so a new group is seeded with it as its Production revision.
  const promptId = store.ids.generate();
  let group;
  if (groupId) {
    group = await findRecord('promptgroups', groupId);
  } else {
    group = await createGroup({
      name,
      category: 'stored-filter-test',
      author: testUsers.owner._id,
      authorName: testUsers.owner.name,
      productionId: production ? promptId : store.ids.generate(),
    });

    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: testUsers.owner._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
      grantedBy: testUsers.owner._id,
    });
  }

  const promptRecord = await createPrompt({
    _id: promptId,
    prompt,
    author: testUsers.owner._id,
    type,
    groupId: group._id,
  });

  if (production && groupId) {
    await db.makePromptProduction(promptId);
    group = await findRecord('promptgroups', groupId);
  }

  return { group, prompt: promptRecord };
}

describe('Prompt Routes - ACL Permissions', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // Simple test to verify route is loaded
  it('should have routes loaded', async () => {
    // This should at least not crash
    const response = await request(app).get('/api/prompts/test-404');

    // We expect a 401 or 404, not 500
    expect(response.status).not.toBe(500);
  });

  describe('POST /api/prompts - Create Prompt', () => {
    afterEach(async () => {
      await resetStore();
    });

    it('should block configured prompt content before persistence', async () => {
      mockAppConfig = {
        filters: {
          prompts: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };

      const response = await request(app)
        .post('/api/prompts')
        .send({
          prompt: {
            prompt: 'Use sk-private-token for requests',
            type: 'text',
          },
          group: {
            name: 'Filtered Prompt Group',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'prompt',
          field: 'text',
        }),
      );
      await expect(countRaw('prompts')).resolves.toBe(0);
      await expect(countRaw('promptgroups')).resolves.toBe(0);
    });

    it('should create a prompt and grant owner permissions', async () => {
      const promptData = {
        prompt: {
          prompt: 'Test prompt content',
          type: 'text',
        },
        group: {
          name: 'Test Prompt Group',
        },
      };

      const response = await request(app).post('/api/prompts').send(promptData);

      expect(response.status).toBe(200);
      expect(response.body.prompt).toBeDefined();
      expect(response.body.prompt.prompt).toBe(promptData.prompt.prompt);

      // Check ACL entry was created
      const aclEntry = await findRaw('aclentries', {
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: response.body.prompt.groupId,
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
      });

      expect(aclEntry).toBeTruthy();
      expect(aclEntry.roleId.toString()).toBe(testRoles.owner._id.toString());
    });

    it('should create a prompt group with prompt and grant owner permissions', async () => {
      const promptData = {
        prompt: {
          prompt: 'Group prompt content',
          type: 'text',
        },
        group: {
          name: 'Test Group',
          category: 'testing',
        },
      };

      const response = await request(app).post('/api/prompts').send(promptData).expect(200);

      expect(response.body.prompt).toBeDefined();
      expect(response.body.group).toBeDefined();
      expect(response.body.group.name).toBe(promptData.group.name);

      // Check ACL entry was created for the promptGroup
      const aclEntry = await findRaw('aclentries', {
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: response.body.group._id,
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
      });

      expect(aclEntry).toBeTruthy();
    });
  });

  describe('GET /api/prompts/:promptId - Get Prompt', () => {
    let testPrompt;
    let testGroup;

    beforeEach(async () => {
      // Create a prompt group first
      testGroup = await createGroup({
        name: 'Test Group',
        category: 'testing',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        productionId: store.ids.generate(),
      });

      // Create a prompt
      testPrompt = await createPrompt({
        prompt: 'Test prompt for retrieval',
        author: testUsers.owner._id,
        type: 'text',
        groupId: testGroup._id,
      });
    });

    afterEach(async () => {
      await resetStore();
    });

    it('should retrieve prompt when user has view permissions', async () => {
      // Grant view permissions on the promptGroup
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: testUsers.owner._id,
      });

      const response = await request(app).get(`/api/prompts/${testPrompt._id}`);
      expect(response.status).toBe(200);
      expect(response.body._id).toBe(testPrompt._id.toString());
      expect(response.body.prompt).toBe(testPrompt.prompt);
    });

    it('should deny access when user has no permissions', async () => {
      // Change the user to one without access
      setTestUser(app, testUsers.noAccess);

      const response = await request(app).get(`/api/prompts/${testPrompt._id}`).expect(403);

      // Verify error response
      expect(response.body.error).toBe('Forbidden');
      expect(response.body.message).toBe('Insufficient permissions to access this promptGroup');
    });

    it('should allow admin access without explicit permissions', async () => {
      // Set admin user
      setTestUser(app, testUsers.admin);

      const response = await request(app).get(`/api/prompts/${testPrompt._id}`).expect(200);

      expect(response.body._id).toBe(testPrompt._id.toString());
    });

    it('should re-inspect an older stored prompt under prompt-only policy', async () => {
      const privateValue = 'sk-stored-prompt-value';
      // A revision of the group stored with the value (seeded in raw mode, past the route's filter)
      testPrompt = await createPrompt({
        prompt: `Use ${privateValue} for this request`,
        author: testUsers.owner._id,
        type: 'text',
        groupId: testGroup._id,
      });
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: testUsers.owner._id,
      });
      mockAppConfig = {
        filters: {
          prompts: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };

      const response = await request(app).get(`/api/prompts/${testPrompt._id}`).expect(400);

      expect(response.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'prompt',
          field: 'text',
        }),
      );
      expect(JSON.stringify(response.body)).not.toContain(privateValue);
    });
  });

  describe('Stored prompt policy enforcement', () => {
    afterEach(async () => {
      await resetStore();
    });

    it('should omit filtered variable and non-variable production prompts from reuse results', async () => {
      const safe = await createAccessiblePromptGroup({
        name: 'Safe prompt',
        prompt: 'Summarize this document',
      });
      const blockedPlain = await createAccessiblePromptGroup({
        name: 'Blocked plain prompt',
        prompt: 'Use sk-plain-stored-value for the request',
      });
      const blockedVariable = await createAccessiblePromptGroup({
        name: 'Blocked variable prompt',
        prompt: 'Use sk-variable-stored-value for {{customer}}',
      });
      mockAppConfig = {
        filters: {
          prompts: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };

      const response = await request(app).get('/api/prompts/all').expect(200);
      const responseIds = response.body.map((group) => group._id);

      expect(responseIds).toContain(safe.group._id.toString());
      expect(responseIds).not.toContain(blockedPlain.group._id.toString());
      expect(responseIds).not.toContain(blockedVariable.group._id.toString());
      expect(JSON.stringify(response.body)).not.toContain('sk-plain-stored-value');
      expect(JSON.stringify(response.body)).not.toContain('sk-variable-stored-value');
    });

    it('should keep prompt filtering disabled when the prompt scope is omitted', async () => {
      const stored = await createAccessiblePromptGroup({
        name: 'Stored prompt',
        prompt: 'Use sk-allowed-by-omission for the request',
      });
      mockAppConfig = {
        filters: {
          messages: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };

      const response = await request(app).get('/api/prompts/all').expect(200);

      expect(response.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _id: stored.group._id.toString(),
            productionPrompt: expect.objectContaining({
              prompt: 'Use sk-allowed-by-omission for the request',
            }),
          }),
        ]),
      );
    });

    it('should redact blocked versions while preserving safe records for remediation', async () => {
      const blocked = await createAccessiblePromptGroup({
        name: 'Prompt with history',
        prompt: 'Use sk-blocked-version for this request',
      });
      const safe = await createAccessiblePromptGroup({
        groupId: blocked.group._id,
        prompt: 'A safe replacement prompt',
        production: false,
      });
      mockAppConfig = {
        filters: {
          prompts: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };

      const [groupResponse, groupsResponse, promptsResponse] = await Promise.all([
        request(app).get(`/api/prompts/groups/${blocked.group._id}`).expect(200),
        request(app).get('/api/prompts/groups').query({ limit: '10' }).expect(200),
        request(app)
          .get('/api/prompts')
          .query({ groupId: blocked.group._id.toString() })
          .expect(200),
      ]);

      expect(groupResponse.body.productionPrompt).toEqual(
        expect.objectContaining({
          prompt: '',
          contentFilterBlocked: true,
        }),
      );
      const listedGroup = groupsResponse.body.promptGroups.find(
        (group) => group._id === blocked.group._id.toString(),
      );
      expect(listedGroup.productionPrompt).toEqual(
        expect.objectContaining({
          prompt: '',
          contentFilterBlocked: true,
        }),
      );
      const blockedVersion = promptsResponse.body.find(
        (prompt) => prompt._id === blocked.prompt._id.toString(),
      );
      const safeVersion = promptsResponse.body.find(
        (prompt) => prompt._id === safe.prompt._id.toString(),
      );
      expect(blockedVersion).toEqual(
        expect.objectContaining({
          prompt: '',
          contentFilterBlocked: true,
        }),
      );
      expect(safeVersion.prompt).toBe('A safe replacement prompt');
      expect(
        JSON.stringify([groupResponse.body, groupsResponse.body, promptsResponse.body]),
      ).not.toContain('sk-blocked-version');
    });

    it('should reject promoting an older blocked prompt without changing production', async () => {
      const safe = await createAccessiblePromptGroup({
        name: 'Production prompt',
        prompt: 'Current safe production prompt',
      });
      const blocked = await createAccessiblePromptGroup({
        groupId: safe.group._id,
        prompt: 'Use sk-blocked-production for this request',
        production: false,
      });
      mockAppConfig = {
        filters: {
          prompts: {
            pii: {
              starterPatterns: ['sk_prefix'],
            },
          },
        },
      };

      const response = await request(app)
        .patch(`/api/prompts/${blocked.prompt._id}/tags/production`)
        .expect(400);

      expect(response.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'prompt',
          field: 'text',
        }),
      );
      expect(JSON.stringify(response.body)).not.toContain('sk-blocked-production');
      const unchangedGroup = await findRecord('promptgroups', safe.group._id);
      expect(unchangedGroup.productionId.toString()).toBe(safe.prompt._id.toString());
    });
  });

  describe('DELETE /api/prompts/:promptId - Delete Prompt', () => {
    let testPrompt;
    let testGroup;

    beforeEach(async () => {
      // Create group with prompt (the prompt is the group's Production revision)
      const testPromptId = store.ids.generate();
      testGroup = await createGroup({
        name: 'Delete Test Group',
        category: 'testing',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        productionId: testPromptId,
      });

      testPrompt = await createPrompt({
        _id: testPromptId,
        prompt: 'Test prompt for deletion',
        author: testUsers.owner._id,
        type: 'text',
        groupId: testGroup._id,
      });

      // Grant owner permissions on the promptGroup
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });
    });

    afterEach(async () => {
      await resetStore();
    });

    it('should delete prompt when user has delete permissions', async () => {
      const response = await request(app)
        .delete(`/api/prompts/${testPrompt._id}`)
        .query({ groupId: testGroup._id.toString() })
        .expect(200);

      expect(response.body.prompt).toBe('Prompt deleted successfully');

      // Verify prompt was deleted
      const deletedPrompt = await findRecord('prompts', testPrompt._id);
      expect(deletedPrompt).toBeNull();

      // Verify ACL entries were removed
      const aclEntries = await filterRaw('aclentries', {
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
      });
      expect(aclEntries).toHaveLength(0);
    });

    it('should deny deletion when user lacks delete permissions', async () => {
      // Create a prompt as a different user (not the one trying to delete)
      const authorPrompt = await createPrompt({
        prompt: 'Test prompt by another user',
        author: testUsers.editor._id, // Different author
        type: 'text',
        groupId: testGroup._id,
      });

      // Grant only viewer permissions to viewer user on the promptGroup
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.viewer._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: testUsers.editor._id,
      });

      // Set viewer user
      setTestUser(app, testUsers.viewer);

      await request(app)
        .delete(`/api/prompts/${authorPrompt._id}`)
        .query({ groupId: testGroup._id.toString() })
        .expect(403);

      // Verify prompt still exists
      const prompt = await findRecord('prompts', authorPrompt._id);
      expect(prompt).toBeTruthy();
    });

    it('should run configMiddleware so the handler receives the configured value', async () => {
      configMiddleware.mockClear();

      await request(app)
        .delete(`/api/prompts/${testPrompt._id}`)
        .query({ groupId: testGroup._id.toString() })
        .expect(200);

      expect(configMiddleware).toHaveBeenCalledTimes(1);
    });
  });

  describe('DELETE /api/prompts/groups/:groupId - Delete Prompt Group', () => {
    let testGroup;

    beforeEach(async () => {
      testGroup = await createGroup({
        name: 'Delete Group Test Group',
        category: 'testing',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        productionId: store.ids.generate(),
      });

      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });
    });

    afterEach(async () => {
      await resetStore();
    });

    it('should run configMiddleware so the handler receives the configured value', async () => {
      configMiddleware.mockClear();

      await request(app).delete(`/api/prompts/groups/${testGroup._id}`).expect(200);

      expect(configMiddleware).toHaveBeenCalledTimes(1);
    });
  });

  describe('PATCH /api/prompts/:promptId/tags/production - Make Production', () => {
    let testPrompt;
    let testGroup;

    beforeEach(async () => {
      // Create group
      testGroup = await createGroup({
        name: 'Production Test Group',
        category: 'testing',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        productionId: store.ids.generate(),
      });

      testPrompt = await createPrompt({
        prompt: 'Test prompt for production',
        author: testUsers.owner._id,
        type: 'text',
        groupId: testGroup._id,
      });
    });

    afterEach(async () => {
      await resetStore();
    });

    it('should make prompt production when user has edit permissions', async () => {
      // Grant edit permissions on the promptGroup
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_EDITOR,
        grantedBy: testUsers.owner._id,
      });

      // Ensure owner user
      setTestUser(app, testUsers.owner);

      const response = await request(app)
        .patch(`/api/prompts/${testPrompt._id}/tags/production`)
        .expect(200);

      expect(response.body.message).toBe('Prompt production made successfully');

      // Verify the group was updated
      const updatedGroup = await findRecord('promptgroups', testGroup._id);
      expect(updatedGroup.productionId.toString()).toBe(testPrompt._id.toString());
    });

    it('should deny making production when user lacks edit permissions', async () => {
      // Grant only view permissions to viewer on the promptGroup
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.viewer._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: testUsers.owner._id,
      });

      // Set viewer user
      setTestUser(app, testUsers.viewer);

      await request(app).patch(`/api/prompts/${testPrompt._id}/tags/production`).expect(403);

      // Verify prompt hasn't changed
      const unchangedGroup = await findRecord('promptgroups', testGroup._id);
      expect(unchangedGroup.productionId.toString()).not.toBe(testPrompt._id.toString());
    });
  });

  describe('Public Access', () => {
    let publicPrompt;
    let publicGroup;

    beforeEach(async () => {
      // Create a prompt group
      publicGroup = await createGroup({
        name: 'Public Test Group',
        category: 'testing',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        productionId: store.ids.generate(),
      });

      // Create a public prompt
      publicPrompt = await createPrompt({
        prompt: 'Public prompt content',
        author: testUsers.owner._id,
        type: 'text',
        groupId: publicGroup._id,
      });

      // Grant public viewer access on the promptGroup
      await grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: publicGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: testUsers.owner._id,
      });
    });

    afterEach(async () => {
      await resetStore();
    });

    it('should allow any user to view public prompts', async () => {
      // Change user to someone without explicit permissions
      setTestUser(app, testUsers.noAccess);

      const response = await request(app).get(`/api/prompts/${publicPrompt._id}`).expect(200);

      expect(response.body._id).toBe(publicPrompt._id.toString());
    });
  });

  describe('PATCH /api/prompts/groups/:groupId - Update Prompt Group Security', () => {
    let testGroup;

    beforeEach(async () => {
      // Create a prompt group
      testGroup = await createGroup({
        name: 'Security Test Group',
        category: 'security-test',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        productionId: store.ids.generate(),
      });

      // Grant owner permissions
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: testGroup._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });
    });

    afterEach(async () => {
      await resetStore();
    });

    it('should allow updating allowed fields (name, category, oneliner)', async () => {
      const updateData = {
        name: 'Updated Group Name',
        category: 'updated-category',
        oneliner: 'Updated description',
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(updateData)
        .expect(200);

      expect(response.body.name).toBe(updateData.name);
      expect(response.body.category).toBe(updateData.category);
      expect(response.body.oneliner).toBe(updateData.oneliner);
    });

    it('should reject request with author field (400 Bad Request)', async () => {
      const maliciousUpdate = {
        name: 'Legit Update',
        author: testUsers.noAccess._id.toString(), // Try to change ownership
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(maliciousUpdate)
        .expect(400);

      // Verify the request was rejected
      expect(response.body.error).toBe('Invalid request body');
      expect(response.body.details).toBeDefined();
    });

    it('should reject request with authorName field (400 Bad Request)', async () => {
      const maliciousUpdate = {
        name: 'Legit Update',
        authorName: 'Malicious Author Name',
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(maliciousUpdate)
        .expect(400);

      // Verify the request was rejected
      expect(response.body.error).toBe('Invalid request body');
    });

    it('should reject request with _id field (400 Bad Request)', async () => {
      const newId = store.ids.generate();
      const maliciousUpdate = {
        name: 'Legit Update',
        _id: newId.toString(),
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(maliciousUpdate)
        .expect(400);

      // Verify the request was rejected
      expect(response.body.error).toBe('Invalid request body');
    });

    it('should reject request with productionId field (400 Bad Request)', async () => {
      const newProductionId = store.ids.generate();
      const maliciousUpdate = {
        name: 'Legit Update',
        productionId: newProductionId.toString(),
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(maliciousUpdate)
        .expect(400);

      // Verify the request was rejected
      expect(response.body.error).toBe('Invalid request body');
    });

    it('should reject request with createdAt field (400 Bad Request)', async () => {
      const maliciousDate = new Date('2020-01-01');
      const maliciousUpdate = {
        name: 'Legit Update',
        createdAt: maliciousDate.toISOString(),
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(maliciousUpdate)
        .expect(400);

      // Verify the request was rejected
      expect(response.body.error).toBe('Invalid request body');
    });

    it('should reject request with __v field (400 Bad Request)', async () => {
      const maliciousUpdate = {
        name: 'Legit Update',
        __v: 999,
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(maliciousUpdate)
        .expect(400);

      // Verify the request was rejected
      expect(response.body.error).toBe('Invalid request body');
    });

    it('should reject request with multiple sensitive fields (400 Bad Request)', async () => {
      const maliciousUpdate = {
        name: 'Legit Update',
        author: testUsers.noAccess._id.toString(),
        authorName: 'Hacker',
        _id: store.ids.generate(),
        productionId: store.ids.generate(),
        createdAt: new Date('2020-01-01').toISOString(),
        __v: 999,
      };

      const response = await request(app)
        .patch(`/api/prompts/groups/${testGroup._id}`)
        .send(maliciousUpdate)
        .expect(400);

      // Verify the request was rejected with validation errors
      expect(response.body.error).toBe('Invalid request body');
      expect(response.body.details).toBeDefined();
      expect(Array.isArray(response.body.details)).toBe(true);
    });
  });

  describe('Pagination', () => {
    beforeEach(async () => {
      // Create multiple prompt groups for pagination testing
      const groups = [];
      for (let i = 0; i < 15; i++) {
        const group = await createGroup({
          name: `Test Group ${i + 1}`,
          category: 'pagination-test',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: store.ids.generate(),
          updatedAt: new Date(Date.now() - i * 1000), // Stagger updatedAt for consistent ordering
        });
        groups.push(group);

        // Grant owner permissions on each group
        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: testUsers.owner._id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: testUsers.owner._id,
        });
      }
    });

    afterEach(async () => {
      await resetStore();
    });

    it('should correctly indicate hasMore when there are more pages', async () => {
      const response = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '10' })
        .expect(200);

      expect(response.body.promptGroups).toHaveLength(10);
      expect(response.body.has_more).toBe(true);
      expect(response.body.after).toBeTruthy();
      // Since has_more is true, pages should be a high number (9999 in our fix)
      expect(parseInt(response.body.pages)).toBeGreaterThan(1);
    });

    it('should correctly indicate no more pages on the last page', async () => {
      // First get the cursor for page 2
      const firstPage = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '10' })
        .expect(200);

      expect(firstPage.body.has_more).toBe(true);
      expect(firstPage.body.after).toBeTruthy();

      // Now fetch the second page using the cursor
      const response = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '10', cursor: firstPage.body.after })
        .expect(200);

      expect(response.body.promptGroups).toHaveLength(5); // 15 total, 10 on page 1, 5 on page 2
      expect(response.body.has_more).toBe(false);
    });

    it('should support cursor-based pagination', async () => {
      // First page
      const firstPage = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '5' })
        .expect(200);

      expect(firstPage.body.promptGroups).toHaveLength(5);
      expect(firstPage.body.has_more).toBe(true);
      expect(firstPage.body.after).toBeTruthy();

      // Second page using cursor
      const secondPage = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '5', cursor: firstPage.body.after })
        .expect(200);

      expect(secondPage.body.promptGroups).toHaveLength(5);
      expect(secondPage.body.has_more).toBe(true);
      expect(secondPage.body.after).toBeTruthy();

      // Verify different groups
      const firstPageIds = firstPage.body.promptGroups.map((g) => g._id);
      const secondPageIds = secondPage.body.promptGroups.map((g) => g._id);
      expect(firstPageIds).not.toEqual(secondPageIds);
    });

    it('should paginate correctly with category filtering', async () => {
      // Create groups with different categories
      await resetStore(); // Clear existing groups

      // Create 8 groups with category 'test-cat-1'
      for (let i = 0; i < 8; i++) {
        const group = await createGroup({
          name: `Category 1 Group ${i + 1}`,
          category: 'test-cat-1',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: store.ids.generate(),
          updatedAt: new Date(Date.now() - i * 1000),
        });

        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: testUsers.owner._id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: testUsers.owner._id,
        });
      }

      // Create 7 groups with category 'test-cat-2'
      for (let i = 0; i < 7; i++) {
        const group = await createGroup({
          name: `Category 2 Group ${i + 1}`,
          category: 'test-cat-2',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: store.ids.generate(),
          updatedAt: new Date(Date.now() - (i + 8) * 1000),
        });

        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: testUsers.owner._id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: testUsers.owner._id,
        });
      }

      // Test pagination with category filter
      const firstPage = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '5', category: 'test-cat-1' })
        .expect(200);

      expect(firstPage.body.promptGroups).toHaveLength(5);
      expect(firstPage.body.promptGroups.every((g) => g.category === 'test-cat-1')).toBe(true);
      expect(firstPage.body.has_more).toBe(true);
      expect(firstPage.body.after).toBeTruthy();

      const secondPage = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '5', cursor: firstPage.body.after, category: 'test-cat-1' })
        .expect(200);

      expect(secondPage.body.promptGroups).toHaveLength(3); // 8 total, 5 on page 1, 3 on page 2
      expect(secondPage.body.promptGroups.every((g) => g.category === 'test-cat-1')).toBe(true);
      expect(secondPage.body.has_more).toBe(false);
    });

    it('should paginate correctly with name/keyword filtering', async () => {
      // Create groups with specific names
      await resetStore(); // Clear existing groups

      // Create 12 groups with 'Search' in the name
      for (let i = 0; i < 12; i++) {
        const group = await createGroup({
          name: `Search Test Group ${i + 1}`,
          category: 'search-test',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: store.ids.generate(),
          updatedAt: new Date(Date.now() - i * 1000),
        });

        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: testUsers.owner._id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: testUsers.owner._id,
        });
      }

      // Create 5 groups without 'Search' in the name
      for (let i = 0; i < 5; i++) {
        const group = await createGroup({
          name: `Other Group ${i + 1}`,
          category: 'other-test',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: store.ids.generate(),
          updatedAt: new Date(Date.now() - (i + 12) * 1000),
        });

        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: testUsers.owner._id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: testUsers.owner._id,
        });
      }

      // Test pagination with name filter
      const firstPage = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '10', name: 'Search' })
        .expect(200);

      expect(firstPage.body.promptGroups).toHaveLength(10);
      expect(firstPage.body.promptGroups.every((g) => g.name.includes('Search'))).toBe(true);
      expect(firstPage.body.has_more).toBe(true);
      expect(firstPage.body.after).toBeTruthy();

      const secondPage = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '10', cursor: firstPage.body.after, name: 'Search' })
        .expect(200);

      expect(secondPage.body.promptGroups).toHaveLength(2); // 12 total, 10 on page 1, 2 on page 2
      expect(secondPage.body.promptGroups.every((g) => g.name.includes('Search'))).toBe(true);
      expect(secondPage.body.has_more).toBe(false);
    });

    it('should paginate correctly with combined filters', async () => {
      // Create groups with various combinations
      await resetStore(); // Clear existing groups

      // Create 6 groups matching both category and name filters
      for (let i = 0; i < 6; i++) {
        const group = await createGroup({
          name: `API Test Group ${i + 1}`,
          category: 'api-category',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: store.ids.generate(),
          updatedAt: new Date(Date.now() - i * 1000),
        });

        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: testUsers.owner._id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: testUsers.owner._id,
        });
      }

      // Create groups that only match one filter
      for (let i = 0; i < 4; i++) {
        const group = await createGroup({
          name: `API Other Group ${i + 1}`,
          category: 'other-category',
          author: testUsers.owner._id,
          authorName: testUsers.owner.name,
          productionId: store.ids.generate(),
          updatedAt: new Date(Date.now() - (i + 6) * 1000),
        });

        await grantPermission({
          principalType: PrincipalType.USER,
          principalId: testUsers.owner._id,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: group._id,
          accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
          grantedBy: testUsers.owner._id,
        });
      }

      // Test pagination with both filters
      const response = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '5', name: 'API', category: 'api-category' })
        .expect(200);

      expect(response.body.promptGroups).toHaveLength(5);
      expect(
        response.body.promptGroups.every(
          (g) => g.name.includes('API') && g.category === 'api-category',
        ),
      ).toBe(true);
      expect(response.body.has_more).toBe(true);
      expect(response.body.after).toBeTruthy();

      // Page 2
      const page2 = await request(app)
        .get('/api/prompts/groups')
        .query({ limit: '5', cursor: response.body.after, name: 'API', category: 'api-category' })
        .expect(200);

      expect(page2.body.promptGroups).toHaveLength(1); // 6 total, 5 on page 1, 1 on page 2
      expect(page2.body.has_more).toBe(false);
    });
  });
});

async function responseOf(pending) {
  const { status, body } = await pending;
  return { status, body };
}

describe('GET /api/prompts/groups/:groupId/resolve', () => {
  afterEach(async () => {
    await resetStore();
  });

  it('resolves the production revision for a native group', async () => {
    const { group, prompt } = await createAccessiblePromptGroup({
      name: 'Resolve native group',
      prompt: 'Native production text',
    });

    const response = await request(app).get(`/api/prompts/groups/${group._id}/resolve`).expect(200);

    expect(response.body).toEqual({
      source: 'native',
      groupId: group._id.toString(),
      promptId: prompt._id.toString(),
      prompt: 'Native production text',
      type: 'text',
    });
  });

  it('returns 403 without VIEW permission', async () => {
    const { group } = await createAccessiblePromptGroup({
      name: 'Resolve forbidden group',
      prompt: 'Native text',
    });
    setTestUser(app, testUsers.noAccess);

    const response = await request(app).get(`/api/prompts/groups/${group._id}/resolve`).expect(403);

    expect(response.body.error).toBe('Forbidden');
  });

  it('returns 404 for a missing group', async () => {
    const response = await request(app)
      .get(`/api/prompts/groups/${store.ids.generate()}/resolve`)
      .expect(404);

    expect(response.body).toEqual({
      error: 'Not Found',
      message: `${ResourceType.PROMPTGROUP} not found`,
    });
  });

  it('is not captured by GET /:promptId', async () => {
    const { group, prompt } = await createAccessiblePromptGroup({
      name: 'Resolve route segments',
      prompt: 'Native text',
    });

    const response = await request(app).get(`/api/prompts/groups/${group._id}/resolve`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      source: 'native',
      groupId: group._id.toString(),
      promptId: prompt._id.toString(),
      prompt: 'Native text',
      type: 'text',
    });
  });

  describe('a Langfuse-origin group', () => {
    const langfuseEnv = {
      LANGFUSE_PROMPT_SYNC_AVAILABLE: 'true',
      LANGFUSE_PUBLIC_KEY: 'pk-resolve',
      LANGFUSE_SECRET_KEY: 'sk-resolve',
      LANGFUSE_PROJECT_ID: 'resolve-project',
      LANGFUSE_BASE_URL: 'https://langfuse.resolve.test',
    };
    let fetchSpy;
    let group;
    let previousLangfuseEnv;

    beforeEach(async () => {
      previousLangfuseEnv = {};
      for (const key of Object.keys(langfuseEnv)) {
        previousLangfuseEnv[key] = process.env[key];
      }
      Object.assign(process.env, langfuseEnv);
      await db.upsertConfig(
        PrincipalType.ROLE,
        BASE_CONFIG_PRINCIPAL_ID,
        PrincipalModel.ROLE,
        { langfuse: { promptSync: { enabled: true } } },
        10,
      );
      group = await createGroup({
        name: 'Langfuse group',
        category: 'resolve-test',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        source: 'langfuse',
        sourcePromptName: 'greeting',
        sourceProjectId: 'resolve-project',
        sourceDestination: 'env',
      });
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: group._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: testUsers.owner._id,
      });
    });

    afterEach(async () => {
      for (const key of Object.keys(langfuseEnv)) {
        if (previousLangfuseEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousLangfuseEnv[key];
        }
      }
      if (fetchSpy) {
        fetchSpy.mockRestore();
        fetchSpy = undefined;
      }
      // The base config goes with the store reset of the enclosing afterEach.
    });

    function mockLangfuseFetch(responder) {
      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(responder);
    }

    function textPromptResponse(payload, status = 200) {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    it('resolves the production label, with no sourceUrl for a non-admin', async () => {
      mockLangfuseFetch(async () =>
        textPromptResponse({
          name: 'greeting',
          version: 1,
          type: 'text',
          labels: ['production'],
          prompt: 'Hello {{name}}',
        }),
      );

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .expect(200);

      expect(response.body).toEqual({
        source: 'langfuse',
        groupId: group._id.toString(),
        prompt: 'Hello {{name}}',
        type: 'text',
        version: 1,
        labels: ['production'],
      });
      expect(response.body.sourceUrl).toBeUndefined();
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('label=production');
      expect(url).not.toContain('version=');
    });

    it('resolves the production label with sourceUrl for an admin', async () => {
      setTestUser(app, testUsers.admin);
      mockLangfuseFetch(async () =>
        textPromptResponse({
          name: 'greeting',
          version: 1,
          type: 'text',
          labels: ['production'],
          prompt: 'Hello {{name}}',
        }),
      );

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .expect(200);

      expect(response.body).toEqual({
        source: 'langfuse',
        groupId: group._id.toString(),
        prompt: 'Hello {{name}}',
        type: 'text',
        version: 1,
        labels: ['production'],
        sourceUrl: 'https://langfuse.resolve.test/project/resolve-project/prompts/greeting',
      });
    });

    it('allows a public viewer with no explicit grant to resolve the group, with no sourceUrl', async () => {
      await grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: group._id,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: testUsers.owner._id,
      });
      setTestUser(app, testUsers.noAccess);
      mockLangfuseFetch(async () =>
        textPromptResponse({
          name: 'greeting',
          version: 1,
          type: 'text',
          labels: ['production'],
          prompt: 'Hello {{name}}',
        }),
      );

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .expect(200);

      expect(response.body).toEqual({
        source: 'langfuse',
        groupId: group._id.toString(),
        prompt: 'Hello {{name}}',
        type: 'text',
        version: 1,
        labels: ['production'],
      });
      expect(response.body.sourceUrl).toBeUndefined();
    });

    it('returns 403 for a user with no grant at all on the group', async () => {
      setTestUser(app, testUsers.noAccess);

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .expect(403);

      expect(response.body.error).toBe('Forbidden');
    });

    it('resolves an exact version and sends it with no label', async () => {
      mockLangfuseFetch(async () =>
        textPromptResponse({
          name: 'greeting',
          version: 3,
          type: 'text',
          labels: [],
          prompt: 'Hello v3',
        }),
      );

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .query({ version: 3 })
        .expect(200);

      expect(response.body).toEqual({
        source: 'langfuse',
        groupId: group._id.toString(),
        prompt: 'Hello v3',
        type: 'text',
        version: 3,
        labels: [],
      });
      expect(response.body.sourceUrl).toBeUndefined();
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('version=3');
      expect(url).not.toContain('label=');
    });

    it('rejects a chat prompt with 422', async () => {
      mockLangfuseFetch(async () =>
        textPromptResponse({
          name: 'greeting',
          version: 1,
          type: 'chat',
          labels: ['production'],
          prompt: [{ role: 'system', content: 'secret' }],
        }),
      );

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .expect(422);

      expect(response.body).toEqual({ code: 'unsupported_type' });
    });

    it('returns 404 with the Langfuse message for a missing prompt', async () => {
      mockLangfuseFetch(async () => new Response(null, { status: 404 }));

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .expect(404);

      expect(response.body).toEqual({
        code: 'not_found',
        message: 'Prompt not found in Langfuse',
      });
    });

    it('returns 404 not_available when prompt sync is gated off', async () => {
      delete process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE;
      mockLangfuseFetch(async () => textPromptResponse({}));

      const response = await request(app)
        .get(`/api/prompts/groups/${group._id}/resolve`)
        .expect(404);

      expect(response.body).toEqual({ code: 'not_available' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/prompts/groups/:groupId/revisions', () => {
  afterEach(async () => {
    await resetStore();
  });

  it('lists native revisions newest first with the Production entry marked', async () => {
    const { group, prompt: production } = await createAccessiblePromptGroup({
      name: 'Revisions native group',
      prompt: 'Production text',
    });
    const draft = await createPrompt({
      prompt: 'Draft text',
      author: testUsers.owner._id,
      type: 'text',
      groupId: group._id,
    });

    const response = await request(app)
      .get(`/api/prompts/groups/${group._id}/revisions`)
      .expect(200);

    expect(response.body).toEqual({
      source: 'native',
      groupId: group._id.toString(),
      revisions: [
        { source: 'native', promptId: draft._id.toString(), version: 2, isProduction: false },
        {
          source: 'native',
          promptId: production._id.toString(),
          version: 1,
          isProduction: true,
        },
      ],
    });
  });

  it('returns 403 without VIEW permission on the group', async () => {
    const { group } = await createAccessiblePromptGroup({
      name: 'Revisions forbidden group',
      prompt: 'Native text',
    });
    setTestUser(app, testUsers.noAccess);

    const response = await request(app)
      .get(`/api/prompts/groups/${group._id}/revisions`)
      .expect(403);

    expect(response.body.error).toBe('Forbidden');
  });

  it('returns 404 for a missing group', async () => {
    const response = await request(app)
      .get(`/api/prompts/groups/${store.ids.generate()}/revisions`)
      .expect(404);

    expect(response.body).toEqual({
      error: 'Not Found',
      message: `${ResourceType.PROMPTGROUP} not found`,
    });
  });

  it('allows a user with only VIEW access, not just the owner', async () => {
    const { group } = await createAccessiblePromptGroup({
      name: 'Revisions viewer group',
      prompt: 'Native text',
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: testUsers.viewer._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
      grantedBy: testUsers.owner._id,
    });
    setTestUser(app, testUsers.viewer);

    const response = await request(app)
      .get(`/api/prompts/groups/${group._id}/revisions`)
      .expect(200);

    expect(response.body.source).toBe('native');
  });

  it('returns 403 for a role without PROMPTS USE, before the group VIEW check', async () => {
    const { group } = await createAccessiblePromptGroup({
      name: 'Revisions no-PROMPTS-USE group',
      prompt: 'Native text',
    });
    // getRoleByName's mock returns null for any role besides USER/ADMIN, so this
    // role carries no PROMPTS.USE grant even though the user has group VIEW access.
    const noUseUser = await createUser({
      name: 'No Prompts Use',
      email: 'no-prompts-use@example.com',
      role: 'NoPromptsUseRole',
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: noUseUser._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
      grantedBy: testUsers.owner._id,
    });
    setTestUser(app, noUseUser);

    const response = await request(app)
      .get(`/api/prompts/groups/${group._id}/revisions`)
      .expect(403);

    expect(response.body).toEqual({ message: 'Forbidden: Insufficient permissions' });
  });
});

describe('Externally managed (Langfuse) prompt groups are read-only', () => {
  const readOnlyBody = { code: 'read_only', error: 'Externally managed prompts are read-only' };
  let group;

  async function seedLangfuseGroup(owner = testUsers.owner) {
    const langfuseGroup = await createGroup({
      name: 'Read-only Langfuse group',
      category: 'langfuse-read-only',
      author: owner._id,
      authorName: owner.name,
      source: 'langfuse',
      sourcePromptName: 'greeting',
      sourceProjectId: 'ro-project',
      sourceDestination: 'env',
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: owner._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: langfuseGroup._id,
      accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
      grantedBy: owner._id,
    });
    return langfuseGroup;
  }

  beforeEach(async () => {
    group = await seedLangfuseGroup();
  });

  afterEach(async () => {
    await resetStore();
  });

  it('rejects PATCH /groups/:groupId with 403 and leaves the group unchanged', async () => {
    const before = await findRecord('promptgroups', group._id);

    const response = await request(app)
      .patch(`/api/prompts/groups/${group._id}`)
      .send({ name: 'Hacked name' })
      .expect(403);

    expect(response.body).toEqual(readOnlyBody);
    const after = await findRecord('promptgroups', group._id);
    expect(after).toEqual(before);
  });

  it('rejects DELETE /groups/:groupId with 403 and leaves the group in place', async () => {
    const response = await request(app).delete(`/api/prompts/groups/${group._id}`).expect(403);

    expect(response.body).toEqual(readOnlyBody);
    await expect(findRecord('promptgroups', group._id)).resolves.not.toBeNull();
    const ownerEntry = await findRaw('aclentries', {
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      principalType: PrincipalType.USER,
      principalId: testUsers.owner._id,
    });
    expect(ownerEntry).toBeTruthy();
  });

  it('rejects POST /groups/:groupId/prompts (new revision) with 403 and adds no revision', async () => {
    const response = await request(app)
      .post(`/api/prompts/groups/${group._id}/prompts`)
      .send({ prompt: { prompt: 'New text', type: 'text' } })
      .expect(403);

    expect(response.body).toEqual(readOnlyBody);
    await expect(countRaw('prompts', { groupId: group._id })).resolves.toBe(0);
  });

  it('rejects PATCH /groups/:groupId for an admin too (MANAGE_PROMPTS ACL bypass still hits the service guard)', async () => {
    setTestUser(app, testUsers.admin);
    const before = await findRecord('promptgroups', group._id);

    const response = await request(app)
      .patch(`/api/prompts/groups/${group._id}`)
      .send({ name: 'Admin hack' })
      .expect(403);

    expect(response.body).toEqual(readOnlyBody);
    const after = await findRecord('promptgroups', group._id);
    expect(after).toEqual(before);
  });

  it('rejects DELETE /groups/:groupId for an admin too (MANAGE_PROMPTS ACL bypass still hits the service guard)', async () => {
    setTestUser(app, testUsers.admin);

    const response = await request(app).delete(`/api/prompts/groups/${group._id}`).expect(403);

    expect(response.body).toEqual(readOnlyBody);
    await expect(findRecord('promptgroups', group._id)).resolves.not.toBeNull();
  });

  describe('with a Prompt row inserted directly for the group', () => {
    let revision;

    beforeEach(async () => {
      revision = await createPrompt({
        prompt: 'Synced from Langfuse',
        author: testUsers.owner._id,
        type: 'text',
        groupId: group._id,
      });
    });

    it('rejects PATCH /:promptId/tags/production with 403 and does not promote', async () => {
      const response = await request(app)
        .patch(`/api/prompts/${revision._id}/tags/production`)
        .expect(403);

      expect(response.body).toEqual(readOnlyBody);
      const after = await findRecord('promptgroups', group._id);
      expect(after.productionId ?? null).toBeNull();
      await expect(findRecord('prompts', revision._id)).resolves.not.toBeNull();
    });

    it('rejects DELETE /:promptId with 403 and keeps the revision', async () => {
      const response = await request(app)
        .delete(`/api/prompts/${revision._id}`)
        .query({ groupId: group._id.toString() })
        .expect(403);

      expect(response.body).toEqual(readOnlyBody);
      await expect(findRecord('prompts', revision._id)).resolves.not.toBeNull();
      await expect(findRecord('promptgroups', group._id)).resolves.not.toBeNull();
    });

    it('rejects DELETE /:promptId for an admin too (MANAGE_PROMPTS ACL bypass still hits the service guard)', async () => {
      setTestUser(app, testUsers.admin);

      const response = await request(app)
        .delete(`/api/prompts/${revision._id}`)
        .query({ groupId: group._id.toString() })
        .expect(403);

      expect(response.body).toEqual(readOnlyBody);
      await expect(findRecord('prompts', revision._id)).resolves.not.toBeNull();
    });
  });

  it('keeps POST /groups/:groupId/use working: it increments numberOfGenerations', async () => {
    const response = await request(app).post(`/api/prompts/groups/${group._id}/use`).expect(200);

    expect(response.body).toEqual({ numberOfGenerations: 1 });
    const after = await findRecord('promptgroups', group._id);
    expect(after.numberOfGenerations).toBe(1);
  });

  it('keeps sharing working through the access-permissions routes', async () => {
    setTestUser(app, testUsers.owner);

    const response = await request(app)
      .put(`/api/permissions/${ResourceType.PROMPTGROUP}/${group._id}`)
      .send({
        updated: [
          {
            type: PrincipalType.USER,
            id: testUsers.viewer._id.toString(),
            accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
          },
        ],
      })
      .expect(200);

    expect(response.body.message).toBe('Permissions updated successfully');

    const sharedEntry = await findRaw('aclentries', {
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      principalType: PrincipalType.USER,
      principalId: testUsers.viewer._id,
    });
    expect(sharedEntry).toBeTruthy();

    // Sharing an externally managed group only grants an ACL entry; it never touches
    // the read-only group document itself.
    const after = await findRecord('promptgroups', group._id);
    expect(after.name).toBe(group.name);
  });
});

describe('A stored prompt group with no source (predates the field) stays editable', () => {
  let group;

  beforeEach(async () => {
    // Bypasses the schema's `source: 'native'` default (raw mode) to reproduce a group
    // written before the field existed.
    group = { _id: store.ids.generate() };
    await store.seed('promptgroups', [
      {
        _id: group._id,
        name: 'Pre-source Group',
        category: 'legacy-no-source',
        author: testUsers.owner._id,
        authorName: testUsers.owner.name,
        productionId: store.ids.generate(),
      },
    ]);

    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: testUsers.owner._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
      grantedBy: testUsers.owner._id,
    });
  });

  afterEach(async () => {
    await resetStore();
  });

  it('allows PATCH /groups/:groupId to rename it, same as a native group', async () => {
    const response = await request(app)
      .patch(`/api/prompts/groups/${group._id}`)
      .send({ name: 'Renamed legacy group' })
      .expect(200);

    expect(response.body.name).toBe('Renamed legacy group');
    const stored = await findRecord('promptgroups', group._id);
    expect(stored.name).toBe('Renamed legacy group');
  });

  it('allows POST /groups/:groupId/prompts to add a text prompt, same as a native group', async () => {
    const response = await request(app)
      .post(`/api/prompts/groups/${group._id}/prompts`)
      .send({ prompt: { prompt: 'New legacy prompt text', type: 'text' } })
      .expect(200);

    expect(response.body.prompt.prompt).toBe('New legacy prompt text');
    await expect(countRaw('prompts', { groupId: group._id })).resolves.toBe(1);
  });
});

describe('Prompt Routes - response and failure compatibility', () => {
  let consoleErrorSpy;
  let group;
  let revision;

  beforeEach(async () => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    ({ group, prompt: revision } = await createAccessiblePromptGroup({
      name: 'Compatibility Group',
      prompt: 'Compatibility prompt',
    }));
  });

  afterEach(async () => {
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
    await resetStore();
  });

  it('rejects a group whose initial prompt has no type', async () => {
    await request(app)
      .post('/api/prompts')
      .send({ prompt: { prompt: 'Untyped prompt' }, group: { name: 'Untyped Group' } })
      .expect(400, { error: 'Prompt type must be "text" or "chat"' });

    await expect(countRaw('promptgroups', { name: 'Untyped Group' })).resolves.toBe(0);
  });

  it('sends 404 from the access check for a malformed ID', async () => {
    const notFound = (resourceType) => ({
      status: 404,
      body: { error: 'Not Found', message: `${resourceType} not found` },
    });
    expect(await responseOf(request(app).get('/api/prompts/groups/not-an-id'))).toEqual(
      notFound(ResourceType.PROMPTGROUP),
    );
    expect(await responseOf(request(app).get('/api/prompts/not-an-id'))).toEqual(
      notFound(ResourceType.PROMPTGROUP),
    );
  });

  it('sends 500 from the access check when the database read fails', async () => {
    const accessFailure = {
      status: 500,
      body: {
        error: 'Internal Server Error',
        message: 'Failed to check resource access permissions',
      },
    };
    // The prompt store's reads (`~/models`, which the access check's resolvers call) fail once.
    jest.spyOn(db, 'getPromptGroup').mockRejectedValueOnce(new Error('database unavailable'));
    expect(await responseOf(request(app).get(`/api/prompts/groups/${group._id}`))).toEqual(
      accessFailure,
    );

    jest.spyOn(db, 'getPrompt').mockRejectedValueOnce(new Error('database unavailable'));
    expect(await responseOf(request(app).get(`/api/prompts/${revision._id}`))).toEqual(
      accessFailure,
    );
  });

  it('adds a revision from the editor payload, which includes groupId', async () => {
    const response = await request(app)
      .post(`/api/prompts/groups/${group._id}/prompts`)
      .send({ prompt: { prompt: 'Second revision', type: 'chat', groupId: group._id.toString() } })
      .expect(200);

    expect(response.body.prompt).toEqual(
      expect.objectContaining({
        prompt: 'Second revision',
        type: 'chat',
        groupId: group._id.toString(),
        author: testUsers.owner._id.toString(),
      }),
    );
    await expect(countRaw('prompts', { groupId: group._id })).resolves.toBe(2);
  });

  it('sends the legacy 200 message when saving a revision fails', async () => {
    jest.spyOn(db, 'savePrompt').mockRejectedValueOnce(new Error('database unavailable'));

    const response = await request(app)
      .post(`/api/prompts/groups/${group._id}/prompts`)
      .send({ prompt: { prompt: 'Lost revision', type: 'text' } })
      .expect(200);

    expect(response.body).toEqual({ message: 'Error saving prompt' });
  });

  it('returns the group detail with its full Production revision', async () => {
    const response = await request(app).get(`/api/prompts/groups/${group._id}`).expect(200);

    expect(response.body._id).toBe(group._id.toString());
    expect(response.body.productionPrompt).toEqual(
      expect.objectContaining({
        _id: revision._id.toString(),
        prompt: 'Compatibility prompt',
        type: 'text',
        groupId: group._id.toString(),
      }),
    );
  });

  it('returns 404 from the handler when a capability bypass reads a missing group', async () => {
    setTestUser(app, testUsers.admin);

    const response = await request(app)
      .get(`/api/prompts/groups/${store.ids.generate()}`)
      .expect(404);

    expect(response.body).toEqual({ message: 'Prompt group not found' });
  });

  it('returns an empty 200 when a capability bypass reads a missing revision', async () => {
    setTestUser(app, testUsers.admin);

    const response = await request(app).get(`/api/prompts/${store.ids.generate()}`).expect(200);

    expect(response.text).toBe('');
  });

  it('returns revision history newest first with management fields', async () => {
    const newer = await createPrompt({
      prompt: 'Newer revision',
      author: testUsers.owner._id,
      type: 'text',
      groupId: group._id,
      createdAt: new Date(Date.now() + 1000),
    });

    const response = await request(app)
      .get('/api/prompts')
      .query({ groupId: group._id.toString() })
      .expect(200);

    expect(response.body.map((item) => item._id)).toEqual([
      newer._id.toString(),
      revision._id.toString(),
    ]);
    expect(response.body[0]).toEqual(
      expect.objectContaining({ author: testUsers.owner._id.toString(), type: 'text' }),
    );
  });

  it('keeps the malformed and denied revision-history responses', async () => {
    expect(
      await responseOf(request(app).get('/api/prompts').query({ groupId: 'not-an-id' })),
    ).toEqual({ status: 400, body: { error: 'Invalid groupId' } });

    setTestUser(app, testUsers.noAccess);
    expect(
      await responseOf(request(app).get('/api/prompts').query({ groupId: group._id.toString() })),
    ).toEqual({
      status: 403,
      body: { error: 'Insufficient permissions to view prompts in this group' },
    });
  });

  it('sends the legacy 200 message when revision history fails', async () => {
    jest.spyOn(db, 'getPrompts').mockRejectedValueOnce(new Error('database unavailable'));

    const response = await request(app)
      .get('/api/prompts')
      .query({ groupId: group._id.toString() })
      .expect(200);

    expect(response.body).toEqual({ message: 'Error getting prompts' });
  });

  it('returns the updated group document fields from a metadata update', async () => {
    const response = await request(app)
      .patch(`/api/prompts/groups/${group._id}`)
      .send({ name: 'Renamed Group', command: 'renamed' })
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual(
      [
        '__v',
        '_id',
        'author',
        'authorName',
        'category',
        'command',
        'createdAt',
        'name',
        'numberOfGenerations',
        'oneliner',
        'productionId',
        'source',
        'updatedAt',
      ].sort(),
    );
    expect(response.body).toEqual(
      expect.objectContaining({ name: 'Renamed Group', command: 'renamed', source: 'native' }),
    );
  });

  it('sends the legacy 200 message when a metadata update fails', async () => {
    jest.spyOn(db, 'updatePromptGroup').mockRejectedValueOnce(new Error('database unavailable'));

    const response = await request(app)
      .patch(`/api/prompts/groups/${group._id}`)
      .send({ name: 'Renamed Group' })
      .expect(200);

    expect(response.body).toEqual({ message: 'Error updating prompt group' });
  });

  it('sends the legacy 200 message when a capability bypass promotes a missing revision', async () => {
    setTestUser(app, testUsers.admin);

    const response = await request(app)
      .patch(`/api/prompts/${store.ids.generate()}/tags/production`)
      .expect(200);

    expect(response.body).toEqual({ message: 'Error making prompt production' });
  });

  it('does not promote when the preliminary read of a capability bypass fails', async () => {
    const candidate = await createPrompt({
      prompt: 'Candidate revision',
      author: testUsers.owner._id,
      type: 'text',
      groupId: group._id,
    });
    setTestUser(app, testUsers.admin);
    jest.spyOn(db, 'getPrompt').mockRejectedValueOnce(new Error('database unavailable'));
    const promote = jest.spyOn(db, 'makePromptProduction');

    await request(app)
      .patch(`/api/prompts/${candidate._id}/tags/production`)
      .expect(500, { error: 'Error updating prompt production' });

    expect(promote).not.toHaveBeenCalled();
    const stored = await findRecord('promptgroups', group._id);
    expect(stored.productionId.toString()).toBe(revision._id.toString());
  });

  it('requires groupId for revision history, including READ_PROMPTS callers', async () => {
    const missingGroupId = { status: 400, body: { error: 'Invalid or missing groupId' } };
    expect(await responseOf(request(app).get('/api/prompts'))).toEqual(missingGroupId);

    setTestUser(app, testUsers.admin);
    expect(await responseOf(request(app).get('/api/prompts'))).toEqual(missingGroupId);
  });

  it('reuses the records that the access check loaded', async () => {
    // The prompt store's reads (`~/models`): the group read and the revision read.
    const readGroup = jest.spyOn(db, 'getPromptGroup');
    await request(app).get(`/api/prompts/groups/${group._id}`).expect(200);
    expect(readGroup).toHaveBeenCalledTimes(1);

    const readRevision = jest.spyOn(db, 'getPrompt');
    await request(app).get(`/api/prompts/${revision._id}`).expect(200);
    expect(readRevision).toHaveBeenCalledTimes(1);

    readRevision.mockClear();
    const promote = jest.spyOn(db, 'makePromptProduction');
    await request(app).patch(`/api/prompts/${revision._id}/tags/production`).expect(200);
    // The access check reads once; the mutation (`makePromptProduction`) reads the revision itself.
    expect(readRevision).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledTimes(1);
  });

  it('returns 500 for GET /groups without limit or pageSize', async () => {
    expect(await responseOf(request(app).get('/api/prompts/groups'))).toEqual({
      status: 500,
      body: { error: 'Error getting prompt groups' },
    });
  });

  it('returns the full catalog array from GET /all with the public flag', async () => {
    const response = await request(app).get('/api/prompts/all').expect(200);

    expect(response.body).toEqual([
      expect.objectContaining({
        _id: group._id.toString(),
        productionPrompt: { _id: revision._id.toString(), prompt: 'Compatibility prompt' },
      }),
    ]);
    expect(response.body[0].isPublic).toBeUndefined();
  });

  it('keeps the Usage responses', async () => {
    const recordUsage = () => request(app).post(`/api/prompts/groups/${group._id}/use`);
    expect(await responseOf(recordUsage())).toEqual({
      status: 200,
      body: { numberOfGenerations: 1 },
    });

    jest
      .spyOn(db, 'incrementPromptGroupUsage')
      .mockRejectedValueOnce(new Error('database unavailable'));
    expect(await responseOf(recordUsage())).toEqual({
      status: 500,
      body: { error: 'Error recording prompt usage' },
    });
  });

  it('keeps the revision and group deletion responses', async () => {
    await request(app)
      .delete(`/api/prompts/${revision._id}`)
      .expect(400, { error: 'Invalid or missing groupId' });

    const response = await request(app)
      .delete(`/api/prompts/${revision._id}`)
      .query({ groupId: group._id.toString() })
      .expect(200);

    expect(response.body).toEqual({
      prompt: 'Prompt deleted successfully',
      promptGroup: { message: 'Prompt group deleted successfully', id: group._id.toString() },
    });
    await expect(countRaw('promptgroups', { _id: group._id })).resolves.toBe(0);
  });

  it('keeps the group deletion response', async () => {
    expect(await responseOf(request(app).delete(`/api/prompts/groups/${group._id}`))).toEqual({
      status: 200,
      body: { message: 'Prompt group deleted successfully' },
    });
  });
});

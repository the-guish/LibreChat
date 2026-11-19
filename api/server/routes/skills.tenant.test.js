process.env.TENANT_ISOLATION_STRICT = 'true';

const express = require('express');
const request = require('supertest');
const JSZip = require('jszip');
const { createTestDataStore } = require('@librechat/data-schemas/testing');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} = require('librechat-data-provider');

const TEST_TENANT = 'tenant-skills-strict';

jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({}),
  getAppConfig: jest.fn().mockResolvedValue({
    fileStrategy: 'local',
    paths: { uploads: '/tmp/uploads', images: '/tmp/images' },
  }),
}));

jest.mock('~/server/middleware/config/app', () => (req, _res, next) => {
  req.config = {
    fileStrategy: 'local',
    paths: { uploads: '/tmp/uploads', images: '/tmp/images' },
  };
  next();
});

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn().mockReturnValue({
    saveBuffer: jest.fn(async ({ userId, fileName }) => `/uploads/${userId}/${fileName}`),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    getDownloadStream: jest.fn().mockResolvedValue({
      pipe: jest.fn(),
      on: jest.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from('test content');
      },
    }),
  }),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn().mockReturnValue('local'),
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

jest.mock('~/server/middleware', () => {
  const actual = jest.requireActual('~/server/middleware');
  const { tenantStorage } = require('@librechat/data-schemas');

  return {
    requireJwtAuth: (req, _res, next) => {
      const tenantId = req.tenantId ?? req.user?.tenantId;
      if (!tenantId) {
        next();
        return;
      }
      tenantStorage.run({ tenantId }, async () => next());
    },
    canAccessSkillResource: actual.canAccessSkillResource,
  };
});

let app;
let store;
/** The ids of the seeded owner and owner role, from the store's id format. */
let ownerId;
let ownerRoleId;
let testUsers;
let testRoles;
let currentTestUser;
let currentRequestTenantId;

function setTestUser(user) {
  currentTestUser = user;
}

function toRequestUser(user) {
  return {
    ...user,
    id: user._id.toString(),
    _id: user._id,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
  };
}

/** The first record of `collection` (read raw, across tenants) whose fields equal `match`. */
async function findRaw(collection, match) {
  return (await store.read(collection)).find((record) =>
    Object.entries(match).every(([key, value]) => record[key] === value),
  );
}

beforeAll(async () => {
  store = await createTestDataStore();
  ownerId = store.ids.generate();
  ownerRoleId = store.ids.generate();

  await setupTestData();

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentRequestTenantId) {
      req.tenantId = currentRequestTenantId;
    }
    if (currentTestUser) {
      req.user = toRequestUser(currentTestUser);
    }
    next();
  });

  currentTestUser = testUsers.owner;
  app.use('/api/skills', require('./skills'));
}, 180000);

afterEach(async () => {
  // Clean the skills, files and ACL entries (keep the owner and the owner role)
  await store.reset();
  await seedTestData();
  currentTestUser = testUsers.owner;
  currentRequestTenantId = undefined;
});

afterAll(async () => {
  await store?.close();
  delete process.env.TENANT_ISOLATION_STRICT;
  jest.clearAllMocks();
}, 60000);

/** Seeds the tenant's owner role and owner user, in raw mode with their tenant. */
async function seedTestData() {
  await store.seed('accessroles', [
    {
      _id: ownerRoleId,
      accessRoleId: AccessRoleIds.SKILL_OWNER,
      name: 'Owner',
      resourceType: ResourceType.SKILL,
      permBits:
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
      tenantId: TEST_TENANT,
    },
  ]);
  await store.seed('users', [
    {
      _id: ownerId,
      name: 'Strict Skill Owner',
      email: 'strict-skill-owner@test.com',
      role: SystemRoles.USER,
      tenantId: TEST_TENANT,
    },
  ]);
}

async function setupTestData() {
  await seedTestData();
  testRoles = { owner: { _id: ownerRoleId } };

  testUsers = {
    owner: {
      _id: store.ids.toStoreId(ownerId),
      name: 'Strict Skill Owner',
      email: 'strict-skill-owner@test.com',
      role: SystemRoles.USER,
      tenantId: TEST_TENANT,
    },
  };

  const { getRoleByName } = require('~/models');
  getRoleByName.mockImplementation((roleName) => {
    if (roleName === SystemRoles.USER || roleName === SystemRoles.ADMIN) {
      return {
        permissions: {
          SKILLS: {
            USE: true,
            CREATE: true,
            SHARE: true,
            SHARE_PUBLIC: true,
          },
        },
      };
    }
    return null;
  });
}

async function createSkillAsOwner(overrides = {}) {
  return request(app)
    .post('/api/skills')
    .send({
      name: 'strict-file-skill',
      description: 'A strict tenant skill used in multipart route tests.',
      body: '# Strict File Skill',
      ...overrides,
    });
}

describe('Skill multipart routes under strict tenant isolation', () => {
  it('imports a skill zip and writes skill, ACL, and files in the request tenant', async () => {
    const zip = new JSZip();
    zip.file(
      'SKILL.md',
      [
        '---',
        'name: strict-import',
        'description: Strict tenant import route test skill.',
        '---',
        '# Strict Import',
      ].join('\n'),
    );
    zip.file('scripts/run.sh', 'echo strict');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await request(app).post('/api/skills/import').attach('file', buffer, {
      filename: 'strict-import.skill',
      contentType: 'application/zip',
    });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(TEST_TENANT);
    expect(res.body._importSummary.filesSucceeded).toBe(1);

    const skill = await findRaw('skills', { name: 'strict-import' });
    const acl = await findRaw('aclentries', {
      resourceType: ResourceType.SKILL,
      resourceId: skill._id,
      principalType: PrincipalType.USER,
      principalId: ownerId,
    });
    const file = await findRaw('skillfiles', {
      skillId: skill._id,
      relativePath: 'scripts/run.sh',
    });

    expect(skill.tenantId).toBe(TEST_TENANT);
    expect(acl).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        roleId: testRoles.owner._id,
      }),
    );
    expect(file).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        relativePath: 'scripts/run.sh',
      }),
    );
  });

  it('imports using the resolved request tenant when user tenant differs', async () => {
    currentRequestTenantId = TEST_TENANT;
    setTestUser({
      ...testUsers.owner,
      tenantId: 'stale-user-tenant',
    });

    const res = await request(app)
      .post('/api/skills/import')
      .attach('file', Buffer.from('# Request Tenant Markdown'), {
        filename: 'request-tenant.md',
        contentType: 'text/markdown',
      });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(TEST_TENANT);

    const savedSkill = await findRaw('skills', { name: 'request-tenant' });
    expect(savedSkill).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
      }),
    );
  });

  it('rejects multipart import in strict mode when the request has no tenant', async () => {
    setTestUser({
      _id: store.ids.toStoreId(store.ids.generate()),
      name: 'No Tenant',
      role: SystemRoles.USER,
    });

    const res = await request(app)
      .post('/api/skills/import')
      .attach('file', Buffer.from('# No Tenant'), {
        filename: 'no-tenant.md',
        contentType: 'text/markdown',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Tenant context required/);
  });

  it('uploads an individual skill file in the request tenant', async () => {
    const created = await createSkillAsOwner();
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/skills/${created.body._id}/files`)
      .field('relativePath', 'scripts/manual.sh')
      .attach('file', Buffer.from('echo manual'), {
        filename: 'manual.sh',
        contentType: 'text/x-shellscript',
      });

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TEST_TENANT);

    const savedFile = await findRaw('skillfiles', {
      skillId: created.body._id,
      relativePath: 'scripts/manual.sh',
    });
    expect(savedFile).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        relativePath: 'scripts/manual.sh',
      }),
    );
  });

  it('uploads an individual skill file using the resolved request tenant', async () => {
    const created = await createSkillAsOwner({ name: 'request-tenant-file-skill' });
    expect(created.status).toBe(201);

    currentRequestTenantId = TEST_TENANT;
    setTestUser({
      ...testUsers.owner,
      tenantId: 'stale-user-tenant',
    });

    const res = await request(app)
      .post(`/api/skills/${created.body._id}/files`)
      .field('relativePath', 'scripts/request-tenant.sh')
      .attach('file', Buffer.from('echo request tenant'), {
        filename: 'request-tenant.sh',
        contentType: 'text/x-shellscript',
      });

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TEST_TENANT);

    const savedFile = await findRaw('skillfiles', {
      skillId: created.body._id,
      relativePath: 'scripts/request-tenant.sh',
    });
    expect(savedFile).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        relativePath: 'scripts/request-tenant.sh',
      }),
    );
  });
});

/**
 * Boots the real server (`api/server/index.js`) on PostgreSQL and drives it over HTTP: login, a
 * conversation, a message and an agent (docs/postgres-port/PHASE4.md §8 B1). The database is a
 * copy of the PostgreSQL test server's migrated template (`createTestDataStore()`), connected on
 * the process-wide connection state the server's `connectDb` reuses; the boot runs every startup
 * step on it (migrations, role seeding, the startup checks). Skips with a warning where no
 * PostgreSQL server can be started, unless `REQUIRE_POSTGRES_TESTS=true`.
 */
process.env.DATABASE_BACKEND = 'postgres';
process.env.POSTGRES_URI ??= 'postgresql://127.0.0.1:5432/dummy-uri';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const request = require('supertest');

/** The real configuration, with the client build the server serves pointed at a stub. */
jest.mock('~/server/services/Config', () => {
  const actual = jest.requireActual('~/server/services/Config');
  return {
    ...actual,
    getAppConfig: async (...args) => {
      const config = await actual.getAppConfig(...args);
      return {
        ...config,
        paths: { ...config.paths, dist: '/tmp/dist', fonts: '/tmp/fonts', assets: '/tmp/assets' },
      };
    },
  };
});

/**
 * The real startup checks, with what the run the boot starts logged as errors recorded once it
 * settles (Jest clears the mocks' calls before each test).
 */
const mockStartupChecks = [];
jest.mock('~/server/services/start/migration', () => {
  const actual = jest.requireActual('~/server/services/start/migration');
  return {
    checkMigrations: () => {
      const run = actual
        .checkMigrations()
        .then(() =>
          require('@librechat/data-schemas').logger.error.mock.calls.map(([message]) =>
            String(message),
          ),
        );
      mockStartupChecks.push(run);
      return run;
    },
  };
});

jest.mock('~/app/clients/tools', () => ({
  createOpenAIImageTools: jest.fn(() => []),
  createYouTubeTools: jest.fn(() => []),
  manifestToolMap: {},
  toolkits: [],
}));

jest.mock('~/config', () => ({
  createMCPServersRegistry: jest.fn(),
  createMCPManager: jest.fn().mockResolvedValue({
    getAppToolFunctions: jest.fn().mockResolvedValue({}),
  }),
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  initializeAgentTriggerService: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/server/services/Schedules', () => ({
  ...jest.requireActual('~/server/services/Schedules'),
  initializeScheduleEngine: jest.fn().mockResolvedValue(undefined),
}));

const { describePostgres } = require('@librechat/data-schemas/testing');

const PASSWORD = 'Smoke-test-password-123!';
/** The agent routes refuse clients that are not browsers (`uaParser`). */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const EMAIL = 'smoke@example.com';

/** Polls `/health` until the server answers, for up to 30 seconds. */
async function waitForHealth(app) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await request(app).get('/health');
      if (response.status === 200) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error('The server did not become healthy within 30 seconds.');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describePostgres('api/server on PostgreSQL', () => {
  const savedEnv = { ...process.env };
  let store;
  let app;
  let server;
  let token;
  let user;

  beforeAll(async () => {
    process.env.PORT = '0';
    process.env.BAN_VIOLATIONS = 'false';
    process.env.LOGIN_MAX = '1000';
    process.env.DOMAIN_CLIENT = 'http://localhost:3080';
    process.env.DOMAIN_SERVER = 'http://localhost:3080';
    /** No `librechat.yaml`: the defaults, whatever a local checkout holds at the root. */
    process.env.CONFIG_PATH = path.join(__dirname, 'missing-librechat.yaml');
    for (const dir of ['/tmp/dist', '/tmp/fonts', '/tmp/assets']) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      path.join('/tmp/dist', 'index.html'),
      '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>',
    );

    const { createTestDataStore } = require('@librechat/data-schemas/testing');
    store = await createTestDataStore();
    if (store.backend !== 'postgres') {
      throw new Error(`Expected the PostgreSQL test data store, got ${store.backend}`);
    }

    /** `index.js` listens at module scope and exports only the app: capture the server. */
    const listenSpy = jest.spyOn(express.application, 'listen');
    app = require('~/server');
    await waitForHealth(app);
    server = listenSpy.mock.results[0].value;
    listenSpy.mockRestore();

    const bcrypt = require('bcryptjs');
    const { runAsSystem } = require('@librechat/data-schemas');
    user = await runAsSystem(() =>
      store.methods.createUser(
        {
          email: EMAIL,
          name: 'Smoke User',
          username: 'smoke',
          password: bcrypt.hashSync(PASSWORD, 4),
          emailVerified: true,
          provider: 'local',
          role: 'USER',
        },
        undefined,
        true,
        true,
      ),
    );
  }, 180_000);

  afterAll(async () => {
    if (server) {
      await promisify(server.close).call(server);
    }
    await store?.close();
    process.env = savedEnv;
  }, 60_000);

  it('runs on the PostgreSQL backend, migrated and seeded at boot', async () => {
    const { getDataStoreBackend } = require('@librechat/data-schemas');
    expect(getDataStoreBackend().name).toBe('postgres');
    /** `seedDatabase` ran on PostgreSQL: the default roles exist. */
    const roles = await store.read('roles');
    expect(roles.map((role) => role.name)).toEqual(expect.arrayContaining(['ADMIN', 'USER']));
  });

  it('runs the startup checks on PostgreSQL after listening, without a failure', async () => {
    const deadline = Date.now() + 20_000;
    while (mockStartupChecks.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(mockStartupChecks).toHaveLength(1);
    const errors = await mockStartupChecks[0];
    expect(errors.filter((message) => /migration|Post-listen/i.test(message))).toEqual([]);
  });

  it('logs in with email and password, and serves the user', async () => {
    const login = await request(app).post('/api/auth/login').send({
      email: EMAIL,
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(login.body.token).toEqual(expect.any(String));
    expect(login.body.user).toMatchObject({ email: EMAIL });
    token = login.body.token;

    const me = await request(app).get('/api/user').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: EMAIL, username: 'smoke' });
    expect(me.body.id ?? me.body._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('serves a conversation and stores a message in it', async () => {
    expect(token).toEqual(expect.any(String));
    const conversationId = crypto.randomUUID();
    const userId = user._id.toString();
    await store.methods.saveConvo(
      { userId },
      { conversationId, endpoint: 'openAI', model: 'gpt-4o-mini', title: 'Smoke conversation' },
      { context: 'index.postgres.spec' },
    );
    const auth = { Authorization: `Bearer ${token}` };

    const conversation = await request(app).get(`/api/convos/${conversationId}`).set(auth);
    expect(conversation.status).toBe(200);
    expect(conversation.body).toMatchObject({ conversationId, title: 'Smoke conversation' });

    const list = await request(app).get('/api/convos').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((convo) => convo.conversationId)).toContain(conversationId);

    const messageId = crypto.randomUUID();
    const created = await request(app).post(`/api/messages/${conversationId}`).set(auth).send({
      messageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Hello from PostgreSQL',
      sender: 'User',
      isCreatedByUser: true,
      endpoint: 'openAI',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      messageId,
      conversationId,
      text: 'Hello from PostgreSQL',
    });

    const messages = await request(app).get(`/api/messages/${conversationId}`).set(auth);
    expect(messages.status).toBe(200);
    expect(messages.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId, text: 'Hello from PostgreSQL' }),
      ]),
    );
    const [stored] = (await store.read('messages')).filter((row) => row.messageId === messageId);
    expect(stored).toMatchObject({ conversationId, user: userId, text: 'Hello from PostgreSQL' });
  });

  it('creates an agent and reads it back', async () => {
    expect(token).toEqual(expect.any(String));
    const auth = { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT };
    const created = await request(app).post('/api/agents').set(auth).send({
      name: 'Smoke agent',
      provider: 'openAI',
      model: 'gpt-4o-mini',
      instructions: 'Answer briefly.',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Smoke agent', provider: 'openAI' });
    const agentId = created.body.id;
    expect(agentId).toEqual(expect.any(String));

    const read = await request(app).get(`/api/agents/${agentId}`).set(auth);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: agentId, name: 'Smoke agent' });

    const [stored] = (await store.read('agents')).filter((row) => row.id === agentId);
    expect(stored).toMatchObject({ name: 'Smoke agent', author: user._id.toString() });
    /** The owner's ACL entry was written on PostgreSQL too. */
    const entries = await store.read('aclentries');
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'agent', resourceId: stored._id }),
      ]),
    );
  });
});

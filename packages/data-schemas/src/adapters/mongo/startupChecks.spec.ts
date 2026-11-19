import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { DataStoreStartupChecks } from '~/ports/startupChecks';
import { DATA_STORE_STARTUP_CHECK_METHODS } from '~/ports/startupChecks';
import { createMongoDataStoreBackend } from './backend';
import { createMethods } from '~/methods';
import { createModels } from '~/models';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  await methods.seedDefaultRoles();
});

afterEach(async () => {
  await mongoose.models.Agent.deleteMany({});
  await mongoose.models.PromptGroup.deleteMany({});
  await mongoose.connection.db?.collection('projects').deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

function startupChecks(): DataStoreStartupChecks {
  return createMongoDataStoreBackend(mongoose).createStartupChecks({
    findRoleByIdentifier: methods.findRoleByIdentifier,
  });
}

describe('MongoDB startup checks', () => {
  it('has every port method, each listed once', () => {
    const checks = startupChecks();
    expect(Object.keys(checks).sort()).toEqual([...DATA_STORE_STARTUP_CHECK_METHODS].sort());
    expect(new Set(DATA_STORE_STARTUP_CHECK_METHODS).size).toBe(
      DATA_STORE_STARTUP_CHECK_METHODS.length,
    );
  });

  it('reports agents and prompt groups still to migrate', async () => {
    const author = new Types.ObjectId();
    await mongoose.models.Agent.create({
      id: 'agent-global',
      name: 'Global agent',
      author,
      provider: 'openAI',
      model: 'gpt-4',
    });
    await mongoose.models.Agent.create({
      id: 'agent-private',
      name: 'Private agent',
      author,
      provider: 'openAI',
      model: 'gpt-4',
    });
    const group = await mongoose.models.PromptGroup.create({
      name: 'Global group',
      author,
      authorName: 'Author',
      productionId: new Types.ObjectId(),
    });
    await mongoose.connection.db?.collection('projects').insertOne({
      name: 'instance',
      agentIds: ['agent-global'],
      promptGroupIds: [group._id],
    });

    const checks = startupChecks();
    await expect(checks.checkAgentPermissions()).resolves.toEqual({
      totalToMigrate: 2,
      globalEditAccess: 0,
      globalViewAccess: 1,
      privateAgents: 1,
      details: {
        globalEditAccess: [],
        globalViewAccess: [{ name: 'Global agent', id: 'agent-global' }],
        privateAgents: [{ name: 'Private agent', id: 'agent-private' }],
      },
    });
    await expect(checks.checkPromptPermissions()).resolves.toEqual({
      totalToMigrate: 1,
      globalViewAccess: 1,
      privateGroups: 0,
      details: {
        globalViewAccess: [
          { name: 'Global group', _id: group._id.toString(), category: 'uncategorized' },
        ],
        privateGroups: [],
      },
    });
  });

  it('reports nothing to migrate on an empty database', async () => {
    const checks = startupChecks();
    await expect(checks.checkAgentPermissions()).resolves.toEqual({
      totalToMigrate: 0,
      globalEditAccess: 0,
      globalViewAccess: 0,
      privateAgents: 0,
    });
    await expect(checks.checkPromptPermissions()).resolves.toEqual({
      totalToMigrate: 0,
      globalViewAccess: 0,
      privateGroups: 0,
    });
  });

  it('probes the search tokens on the default connection without failing', async () => {
    await expect(startupChecks().probeSearchTokens()).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalledWith(
      '[SearchTokenMigration] Failed to check search token migration:',
      expect.anything(),
    );
  });
});

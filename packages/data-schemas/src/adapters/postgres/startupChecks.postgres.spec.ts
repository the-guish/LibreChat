import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { DataStoreStartupChecks } from '~/ports/startupChecks';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { DATA_STORE_STARTUP_CHECK_METHODS } from '~/ports/startupChecks';
import { POSTGRES_LEGACY_MIGRATION_REMEDY } from './startupChecks';
import { createPostgresContractHarness } from './contractHarness';
import { createPostgresDataStoreBackend } from './backend';
import { useContractHarness } from '~/contracts/support';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const TOKEN_WARNING = expect.stringContaining('[SearchTokenMigration] Some ');
const TOKEN_FAILURE = '[SearchTokenMigration] Failed to check search token migration:';

/**
 * The PostgreSQL startup checks (`./startupChecks`, B1): the cases of the MongoDB spec
 * (`adapters/mongo/startupChecks.spec.ts`) that have a PostgreSQL meaning, on rows seeded raw as
 * a copy from MongoDB leaves them. There is no `projects` table, so nothing counts as formerly
 * global.
 */
describePostgres('PostgreSQL startup checks', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const engine = { connect: async () => database.uri, release: async () => undefined };
  const backend = createPostgresDataStoreBackend({ shadowCheck: true });
  const harness = createPostgresContractHarness(engine, { backend });
  useContractHarness(harness);
  const methods = backend.createMethods();
  const checks = (): DataStoreStartupChecks =>
    backend.createStartupChecks({ findRoleByIdentifier: methods.findRoleByIdentifier });

  beforeEach(async () => {
    jest.clearAllMocks();
    await methods.seedDefaultRoles();
  });

  it('has every port method, each listed once', () => {
    expect(Object.keys(checks()).sort()).toEqual([...DATA_STORE_STARTUP_CHECK_METHODS].sort());
  });

  it('reports agents and prompt groups without a user ACL entry, all as private', async () => {
    const author = harness.ids.generate();
    const migratedAgent = harness.ids.generate();
    const groupId = harness.ids.generate();
    await harness.seedRaw('agents', [
      {
        _id: harness.ids.generate(),
        id: 'agent-a',
        name: 'Agent A',
        author,
        isCollaborative: true,
      },
      { _id: harness.ids.generate(), id: 'agent-b', name: 'Agent B', author },
      { _id: migratedAgent, id: 'agent-migrated', name: 'Migrated', author },
      { _id: harness.ids.generate(), id: 'agent-orphan', name: 'No author' },
    ]);
    await harness.seedRaw('promptgroups', [
      { _id: groupId, name: 'Native group', author, authorName: 'Author' },
      { _id: harness.ids.generate(), name: 'Imported', author, source: 'skill' },
      { _id: harness.ids.generate(), name: 'Explicit', author, source: 'native', category: 'x' },
    ]);
    await harness.seedRaw('aclentries', [
      {
        _id: harness.ids.generate(),
        principalType: PrincipalType.USER,
        principalId: author,
        principalModel: 'User',
        resourceType: ResourceType.AGENT,
        resourceId: migratedAgent,
        permBits: 15,
      },
      {
        _id: harness.ids.generate(),
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: groupId,
        permBits: 1,
      },
    ]);

    const agents = await checks().checkAgentPermissions();
    expect(agents).toMatchObject({
      totalToMigrate: 2,
      globalEditAccess: 0,
      globalViewAccess: 0,
      privateAgents: 2,
      details: { globalEditAccess: [], globalViewAccess: [] },
    });
    expect(agents.details?.privateAgents).toEqual(
      expect.arrayContaining([
        { name: 'Agent A', id: 'agent-a' },
        { name: 'Agent B', id: 'agent-b' },
      ]),
    );
    const groups = await checks().checkPromptPermissions();
    expect(groups).toMatchObject({ totalToMigrate: 2, globalViewAccess: 0, privateGroups: 2 });
    expect(groups.details?.privateGroups).toEqual(
      expect.arrayContaining([
        { name: 'Native group', _id: groupId, category: 'uncategorized' },
        { name: 'Explicit', _id: expect.any(String), category: 'x' },
      ]),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `[checkMigrations] PostgreSQL: npm run migrate:agent-permissions: ${POSTGRES_LEGACY_MIGRATION_REMEDY}`,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `[checkMigrations] PostgreSQL: npm run migrate:prompt-permissions: ${POSTGRES_LEGACY_MIGRATION_REMEDY}`,
    );
  });

  it('reports nothing to migrate on an empty database, and logs no remedy', async () => {
    await expect(checks().checkAgentPermissions()).resolves.toEqual({
      totalToMigrate: 0,
      globalEditAccess: 0,
      globalViewAccess: 0,
      privateAgents: 0,
    });
    await expect(checks().checkPromptPermissions()).resolves.toEqual({
      totalToMigrate: 0,
      globalViewAccess: 0,
      privateGroups: 0,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports nothing while the permission roles are missing', async () => {
    await harness.reset();
    await harness.seedRaw('agents', [
      { _id: harness.ids.generate(), id: 'agent-a', name: 'A', author: harness.ids.generate() },
    ]);
    await expect(checks().checkAgentPermissions()).resolves.toEqual({
      totalToMigrate: 0,
      globalEditAccess: 0,
      globalViewAccess: 0,
      privateAgents: 0,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Required agent roles not found. Permission system may not be fully initialized.',
    );
    expect(await methods.findRoleByIdentifier(AccessRoleIds.AGENT_OWNER)).toBeNull();
  });

  it('warns about users and groups without search tokens', async () => {
    await harness.seedRaw('users', [
      {
        _id: harness.ids.generate(),
        email: 'tokens@example.com',
        nameTokens: [],
        emailTokens: ['tokens@example.com'],
        usernameTokens: [],
      },
    ]);
    await harness.seedRaw('groups', [
      { _id: harness.ids.generate(), name: 'Tokens', nameTokens: ['tokens'], emailTokens: [] },
    ]);
    await checks().probeSearchTokens();
    expect(logger.warn).not.toHaveBeenCalled();

    await harness.seedRaw('users', [{ _id: harness.ids.generate(), email: 'old@example.com' }]);
    await checks().probeSearchTokens();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[SearchTokenMigration] Some users lack search tokens'),
    );

    await harness.seedRaw('groups', [
      { _id: harness.ids.generate(), name: 'Old', nameTokens: ['old'] },
    ]);
    await checks().probeSearchTokens();
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('Some users and groups lack search tokens'),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and resolves while the backend is not connected', async () => {
    const disconnected = createPostgresDataStoreBackend();
    const offline = disconnected.createStartupChecks({
      findRoleByIdentifier: disconnected.createMethods().findRoleByIdentifier,
    });
    await expect(offline.probeSearchTokens()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(TOKEN_FAILURE, expect.any(Error));
    expect(logger.warn).not.toHaveBeenCalledWith(TOKEN_WARNING);
    await expect(offline.checkAgentPermissions()).resolves.toEqual({
      totalToMigrate: 0,
      globalEditAccess: 0,
      globalViewAccess: 0,
      privateAgents: 0,
    });
    await expect(offline.checkPromptPermissions()).resolves.toEqual({
      totalToMigrate: 0,
      globalViewAccess: 0,
      privateGroups: 0,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to check agent permissions migration',
      expect.any(Error),
    );
  });
});

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ResourceType, PrincipalType, PermissionBits } from 'librechat-data-provider';
import { tenantStorage } from '~/config/tenantContext';
import { createMCPServerMethods } from './mcpServer';
import { createModels } from '~/models';

/**
 * `findMCPServerTokenHolderIds` and `findMCPServerViewAclEntries`, the two reads the MCP server
 * delete controller ran on the `Token` and `AclEntry` models directly (each skipped when its model
 * is not registered): each runs that exact query.
 */

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMCPServerMethods>;

const deps = { getSoleOwnedResourceIds: async () => [] };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMCPServerMethods(mongoose, deps);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Token.collection.deleteMany({});
  await mongoose.models.AclEntry.collection.deleteMany({});
});

const oid = () => new mongoose.Types.ObjectId();

/** The controller's former token read, verbatim. */
const formerTokenRead = (serverName: string) => {
  const tokenIdentifier = `mcp:${serverName}`;
  return mongoose.models.Token.distinct('userId', {
    identifier: {
      $in: [tokenIdentifier, `${tokenIdentifier}:client`, `${tokenIdentifier}:refresh`],
    },
  });
};

/** The controller's former ACL read, verbatim. */
const formerAclRead = (dbId: string) =>
  mongoose.models.AclEntry.find({
    resourceType: ResourceType.MCPSERVER,
    resourceId: dbId,
    permBits: { $bitsAnySet: PermissionBits.VIEW },
  }).lean();

const token = (userId: mongoose.Types.ObjectId, identifier: string, tenantId?: string) => ({
  userId,
  identifier,
  token: `token-${oid().toString()}`,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  ...(tenantId ? { tenantId } : {}),
});

describe('findMCPServerTokenHolderIds', () => {
  it('returns the distinct holders of the server, client and refresh records, as stored', async () => {
    const [a, b, c, d] = [oid(), oid(), oid(), oid()];
    await mongoose.models.Token.collection.insertMany([
      token(a, 'mcp:github'),
      token(a, 'mcp:github:refresh'),
      token(b, 'mcp:github:client'),
      token(c, 'mcp:github:other'),
      token(d, 'mcp:gitlab'),
      token(c, 'mcp:git'),
    ]);

    const holders = await methods.findMCPServerTokenHolderIds('github');

    expect(holders.map(String).sort()).toEqual([a, b].map(String).sort());
    expect(holders.every((id) => id instanceof mongoose.Types.ObjectId)).toBe(true);
    expect(holders.map(String).sort()).toEqual(
      (await formerTokenRead('github')).map(String).sort(),
    );
    await expect(methods.findMCPServerTokenHolderIds('none')).resolves.toEqual([]);
  });

  it('has no tenant criterion of its own: the active tenant scope applies', async () => {
    const [a, b, c] = [oid(), oid(), oid()];
    await mongoose.models.Token.collection.insertMany([
      token(a, 'mcp:github', 'tenant-a'),
      token(b, 'mcp:github', 'tenant-b'),
      token(c, 'mcp:github'),
    ]);

    const inTenant = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.findMCPServerTokenHolderIds('github'),
    );
    const formerInTenant = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      formerTokenRead('github'),
    );
    expect(inTenant.map(String)).toEqual([a.toString()]);
    expect(inTenant.map(String)).toEqual(formerInTenant.map(String));

    const unscoped = await methods.findMCPServerTokenHolderIds('github');
    expect(unscoped.map(String).sort()).toEqual(
      (await formerTokenRead('github')).map(String).sort(),
    );
  });

  it('returns none without the token model', async () => {
    const unregistered = new mongoose.Mongoose();
    await expect(
      createMCPServerMethods(unregistered, deps).findMCPServerTokenHolderIds('github'),
    ).resolves.toEqual([]);
  });
});

describe('findMCPServerViewAclEntries', () => {
  const entry = (resourceId: mongoose.Types.ObjectId, permBits: number, overrides = {}) => ({
    principalType: PrincipalType.USER,
    principalId: oid(),
    principalModel: 'User',
    resourceType: ResourceType.MCPSERVER,
    resourceId,
    permBits,
    grantedAt: new Date(),
    ...overrides,
  });

  it('returns the whole entries on the server with any view bit set', async () => {
    const server = oid();
    const other = oid();
    await mongoose.models.AclEntry.collection.insertMany([
      entry(server, PermissionBits.VIEW),
      entry(server, PermissionBits.VIEW | PermissionBits.EDIT),
      entry(server, PermissionBits.EDIT),
      entry(server, 0),
      entry(server, PermissionBits.VIEW, { resourceType: ResourceType.AGENT }),
      entry(other, PermissionBits.VIEW),
      entry(server, PermissionBits.VIEW, { principalType: PrincipalType.PUBLIC }),
    ]);

    const entries = await methods.findMCPServerViewAclEntries(server.toString());

    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.resourceId.toString() === server.toString())).toBe(true);
    expect(entries.every((e) => (e.permBits & PermissionBits.VIEW) !== 0)).toBe(true);
    expect(entries[0]).toHaveProperty('grantedAt');
    expect(entries[0]).toHaveProperty('_id');
    const byId = (rows: Array<{ _id: unknown }>) =>
      [...rows].sort((x, y) => String(x._id).localeCompare(String(y._id)));
    expect(byId(entries)).toEqual(byId(await formerAclRead(server.toString())));
    await expect(methods.findMCPServerViewAclEntries(server)).resolves.toHaveLength(3);
  });

  it('rejects an id the model cannot cast, as the former read did', async () => {
    await expect(formerAclRead('not-an-id')).rejects.toThrow();
    await expect(methods.findMCPServerViewAclEntries('not-an-id')).rejects.toThrow();
  });

  it('returns none without the ACL entry model', async () => {
    const unregistered = new mongoose.Mongoose();
    await expect(
      createMCPServerMethods(unregistered, deps).findMCPServerViewAclEntries(oid().toString()),
    ).resolves.toEqual([]);
  });
});

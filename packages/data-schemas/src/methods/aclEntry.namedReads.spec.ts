import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
} from 'librechat-data-provider';
import type { PipelineStage } from 'mongoose';
import { createAclEntryMethods, permissionBitSupersets } from './aclEntry';
import { tenantStorage } from '~/config/tenantContext';
import { MAX_PERM_BITS } from '~/common/permissions';
import { createModels } from '~/models';

/**
 * The named ACL reads return exactly what their callers' `aggregateAclEntries` pipelines return
 * for the same inputs: same rows, same order, same fields, same BSON types.
 *
 * The callers build their pipelines inline, so each is duplicated here verbatim (only the
 * `aggregateAclEntries` call around it is dropped):
 * - `controllerPipeline`: `getResourcePermissions` in `api/server/controllers/PermissionsController.js`;
 * - `enricherPipeline`: `enrichRemoteAgentPrincipals` in `packages/api/src/apiKeys/permissions.ts`
 *   (its resource-id cast included).
 */

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const { ObjectId } = mongoose.Types;
const { EJSON } = mongoose.mongo.BSON;

function controllerPipeline(resourceType: string, resourceId: string): PipelineStage[] {
  return [
    {
      $match: {
        resourceType,
        resourceId: mongoose.Types.ObjectId.isValid(resourceId)
          ? mongoose.Types.ObjectId.createFromHexString(resourceId)
          : resourceId,
      },
    },
    {
      $lookup: {
        from: 'accessroles',
        localField: 'roleId',
        foreignField: '_id',
        as: 'role',
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'principalId',
        foreignField: '_id',
        as: 'userInfo',
      },
    },
    {
      $lookup: {
        from: 'groups',
        localField: 'principalId',
        foreignField: '_id',
        as: 'groupInfo',
      },
    },
    {
      $project: {
        principalType: 1,
        principalId: 1,
        accessRoleId: { $arrayElemAt: ['$role.accessRoleId', 0] },
        userInfo: { $arrayElemAt: ['$userInfo', 0] },
        groupInfo: { $arrayElemAt: ['$groupInfo', 0] },
        permBits: 1,
      },
    },
  ];
}

function enricherPipeline(resourceId: string | mongoose.Types.ObjectId): PipelineStage[] {
  const resourceObjectId =
    typeof resourceId === 'string' && /^[a-f\d]{24}$/i.test(resourceId)
      ? mongoose.Types.ObjectId.createFromHexString(resourceId)
      : resourceId;
  return [
    {
      $match: {
        resourceType: ResourceType.AGENT,
        resourceId: resourceObjectId,
        principalType: PrincipalType.USER,
        permBits: { $in: permissionBitSupersets(PermissionBits.SHARE) },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'principalId',
        foreignField: '_id',
        as: 'userInfo',
      },
    },
    {
      $project: {
        principalId: 1,
        userInfo: { $arrayElemAt: ['$userInfo', 0] },
      },
    },
  ];
}

/** Canonical extended JSON: keeps key order and BSON types (ObjectId, Date, Int32, ...). */
function canonical(value: unknown): string {
  return EJSON.stringify(value as Parameters<typeof EJSON.stringify>[0], { relaxed: false });
}

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createAclEntryMethods>;

function collection(modelName: string) {
  return mongoose.models[modelName].collection;
}

/** Seeds raw documents, as stored, so every field and type reaches the reads unchanged. */
async function seed(modelName: string, docs: Record<string, unknown>[]): Promise<void> {
  await collection(modelName).insertMany(docs);
}

async function expectSameAsAggregate(
  named: () => Promise<unknown[]>,
  pipeline: PipelineStage[],
): Promise<unknown[]> {
  const expected = await methods.aggregateAclEntries(pipeline);
  const actual = await named();
  expect(canonical(actual)).toBe(canonical(expected));
  expect(actual).toEqual(expected);
  return actual;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createAclEntryMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all(
    ['AclEntry', 'User', 'Group', 'AccessRole'].map((name) => collection(name).deleteMany({})),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('listResourcePermissionPrincipals', () => {
  const resourceId = new ObjectId();
  const viewerRoleId = new ObjectId();
  const ownerRoleId = new ObjectId();
  const missingRoleId = new ObjectId();
  const userId = new ObjectId();
  const missingUserId = new ObjectId();
  const groupId = new ObjectId();
  const missingGroupId = new ObjectId();
  const grantedAt = new Date('2026-01-02T03:04:05.000Z');

  async function seedMixedResource(): Promise<void> {
    await seed('AccessRole', [
      { _id: viewerRoleId, accessRoleId: 'agent_viewer', name: 'Viewer', permBits: 1 },
      { _id: ownerRoleId, accessRoleId: 'agent_owner', name: 'Owner', permBits: 15 },
    ]);
    await seed('User', [
      {
        _id: userId,
        name: 'Ada',
        username: 'ada',
        email: 'ada@example.com',
        avatar: 'ada.png',
        role: 'ADMIN',
        password: 'hash',
        totpSecret: 'secret',
        tenantId: 'tenant-x',
        createdAt: grantedAt,
      },
    ]);
    await seed('Group', [
      {
        _id: groupId,
        name: 'Engineers',
        email: 'eng@example.com',
        description: 'All engineers',
        source: 'entra',
        idOnTheSource: 'entra-eng',
        memberIds: ['a', 'b'],
      },
    ]);
    await seed('AclEntry', [
      {
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 15,
        roleId: ownerRoleId,
        grantedBy: userId,
        grantedAt,
      },
      {
        principalType: PrincipalType.GROUP,
        principalId: groupId,
        principalModel: PrincipalModel.GROUP,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
        roleId: viewerRoleId,
      },
      {
        principalType: PrincipalType.ROLE,
        principalId: 'USER',
        principalModel: PrincipalModel.ROLE,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
        roleId: viewerRoleId,
      },
      {
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
        roleId: viewerRoleId,
      },
      {
        principalType: PrincipalType.USER,
        principalId: missingUserId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 3,
        roleId: missingRoleId,
      },
      {
        principalType: PrincipalType.GROUP,
        principalId: missingGroupId,
        principalModel: PrincipalModel.GROUP,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
      },
      /* Not on the resource: another type on the same id, and another id. */
      {
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId,
        permBits: 15,
        roleId: ownerRoleId,
      },
      {
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: new ObjectId(),
        permBits: 15,
        roleId: ownerRoleId,
      },
    ]);
  }

  it('runs exactly the controller pipeline', async () => {
    const AclEntry = mongoose.models.AclEntry;
    const aggregate = jest.spyOn(AclEntry, 'aggregate');
    await methods.listResourcePermissionPrincipals(ResourceType.AGENT, resourceId.toString());
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(canonical(aggregate.mock.calls[0][0])).toBe(
      canonical(controllerPipeline(ResourceType.AGENT, resourceId.toString())),
    );
  });

  it('returns no rows for a resource without entries', async () => {
    await seedMixedResource();
    const otherId = new ObjectId().toString();
    const rows = await expectSameAsAggregate(
      () => methods.listResourcePermissionPrincipals(ResourceType.AGENT, otherId),
      controllerPipeline(ResourceType.AGENT, otherId),
    );
    expect(rows).toEqual([]);
  });

  it('returns the aggregate rows for every principal type, joined records missing or not', async () => {
    await seedMixedResource();
    const rows = (await expectSameAsAggregate(
      () => methods.listResourcePermissionPrincipals(ResourceType.AGENT, resourceId.toString()),
      controllerPipeline(ResourceType.AGENT, resourceId.toString()),
    )) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.principalType)).toEqual([
      PrincipalType.USER,
      PrincipalType.GROUP,
      PrincipalType.ROLE,
      PrincipalType.PUBLIC,
      PrincipalType.USER,
      PrincipalType.GROUP,
    ]);
    const [user, group, role, publicRow, missingUser, missingGroup] = rows;

    /* Whole joined records, hidden fields included; only projected entry fields. */
    expect(Object.keys(user).sort()).toEqual(
      ['_id', 'accessRoleId', 'permBits', 'principalId', 'principalType', 'userInfo'].sort(),
    );
    expect(user.accessRoleId).toBe('agent_owner');
    expect(user.userInfo).toMatchObject({
      _id: userId,
      password: 'hash',
      totpSecret: 'secret',
      tenantId: 'tenant-x',
    });
    expect(group.groupInfo).toMatchObject({ _id: groupId, memberIds: ['a', 'b'] });
    expect(group).not.toHaveProperty('userInfo');
    expect(role).toMatchObject({ principalId: 'USER', accessRoleId: 'agent_viewer' });
    expect(role).not.toHaveProperty('userInfo');
    expect(role).not.toHaveProperty('groupInfo');
    expect(publicRow).not.toHaveProperty('principalId');
    expect(publicRow.accessRoleId).toBe('agent_viewer');

    /* Missing joined documents leave the field absent, never null. */
    expect(missingUser).not.toHaveProperty('userInfo');
    expect(missingUser).not.toHaveProperty('accessRoleId');
    expect(missingGroup).not.toHaveProperty('groupInfo');
    expect(missingGroup).not.toHaveProperty('accessRoleId');
  });

  it('matches the resource the same way for an ObjectId, its hex string and a non-id string', async () => {
    await seedMixedResource();
    const fromString = await expectSameAsAggregate(
      () => methods.listResourcePermissionPrincipals(ResourceType.AGENT, resourceId.toString()),
      controllerPipeline(ResourceType.AGENT, resourceId.toString()),
    );
    const fromObjectId = await methods.listResourcePermissionPrincipals(
      ResourceType.AGENT,
      resourceId,
    );
    expect(canonical(fromObjectId)).toBe(canonical(fromString));

    const notAnId = await expectSameAsAggregate(
      () => methods.listResourcePermissionPrincipals(ResourceType.AGENT, 'not-an-object-id'),
      controllerPipeline(ResourceType.AGENT, 'not-an-object-id'),
    );
    expect(notAnId).toEqual([]);
  });

  it('scopes entries, not joined records, to the active tenant', async () => {
    const otherTenantUser = new ObjectId();
    await seed('User', [{ _id: otherTenantUser, name: 'Bob', tenantId: 'tenant-b' }]);
    await seed('AclEntry', [
      {
        principalType: PrincipalType.USER,
        principalId: otherTenantUser,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
        tenantId: 'tenant-a',
      },
      {
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
        tenantId: 'tenant-b',
      },
    ]);

    const rows = (await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      expectSameAsAggregate(
        () => methods.listResourcePermissionPrincipals(ResourceType.AGENT, resourceId.toString()),
        controllerPipeline(ResourceType.AGENT, resourceId.toString()),
      ),
    )) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0].userInfo).toMatchObject({ _id: otherTenantUser, tenantId: 'tenant-b' });
  });
});

describe('listUserPermissionHolders', () => {
  const resourceId = new ObjectId();

  /** One user entry per stored `permBits` value; users exist for the even values only. */
  async function seedEveryPermBits(): Promise<Map<string, number>> {
    const bitsByUser = new Map<string, number>();
    const users: Record<string, unknown>[] = [];
    const entries: Record<string, unknown>[] = [];
    for (let permBits = 0; permBits <= MAX_PERM_BITS; permBits++) {
      const principalId = new ObjectId();
      bitsByUser.set(principalId.toString(), permBits);
      if (permBits % 2 === 0) {
        users.push({ _id: principalId, name: `user-${permBits}`, password: 'hash' });
      }
      entries.push({
        principalType: PrincipalType.USER,
        principalId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits,
      });
    }
    await seed('User', users);
    await seed('AclEntry', [
      ...entries,
      /* Holding every bit, but not users or not on the resource. */
      {
        principalType: PrincipalType.GROUP,
        principalId: new ObjectId(),
        principalModel: PrincipalModel.GROUP,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: MAX_PERM_BITS,
      },
      {
        principalType: PrincipalType.ROLE,
        principalId: 'ADMIN',
        principalModel: PrincipalModel.ROLE,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: MAX_PERM_BITS,
      },
      {
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: MAX_PERM_BITS,
      },
      {
        principalType: PrincipalType.USER,
        principalId: new ObjectId(),
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.REMOTE_AGENT,
        resourceId,
        permBits: MAX_PERM_BITS,
      },
      {
        principalType: PrincipalType.USER,
        principalId: new ObjectId(),
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: new ObjectId(),
        permBits: MAX_PERM_BITS,
      },
    ]);
    return bitsByUser;
  }

  it('runs exactly the enricher pipeline for an agent and SHARE', async () => {
    const AclEntry = mongoose.models.AclEntry;
    const aggregate = jest.spyOn(AclEntry, 'aggregate');
    await methods.listUserPermissionHolders(ResourceType.AGENT, resourceId, PermissionBits.SHARE);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(canonical(aggregate.mock.calls[0][0])).toBe(canonical(enricherPipeline(resourceId)));
  });

  it('returns no rows for a resource without entries', async () => {
    await seedEveryPermBits();
    const otherId = new ObjectId();
    const rows = await expectSameAsAggregate(
      () => methods.listUserPermissionHolders(ResourceType.AGENT, otherId, PermissionBits.SHARE),
      enricherPipeline(otherId),
    );
    expect(rows).toEqual([]);
  });

  it('returns the aggregate rows: user entries holding every SHARE bit, users missing or not', async () => {
    const bitsByUser = await seedEveryPermBits();
    for (const id of [resourceId, resourceId.toString()]) {
      const rows = (await expectSameAsAggregate(
        () => methods.listUserPermissionHolders(ResourceType.AGENT, id, PermissionBits.SHARE),
        enricherPipeline(id),
      )) as Array<Record<string, unknown>>;

      const heldBits = rows.map((row) => bitsByUser.get(String(row.principalId)));
      const expectedBits = [...bitsByUser.values()].filter(
        (bits) => (bits & PermissionBits.SHARE) === PermissionBits.SHARE,
      );
      expect(heldBits).toEqual(expectedBits);
      for (const row of rows) {
        const bits = bitsByUser.get(String(row.principalId)) as number;
        expect(Object.keys(row).sort()).toEqual(
          (bits % 2 === 0 ? ['_id', 'principalId', 'userInfo'] : ['_id', 'principalId']).sort(),
        );
        if (bits % 2 === 0) {
          expect(row.userInfo).toMatchObject({ _id: row.principalId, password: 'hash' });
        }
      }
    }
  });

  it('applies the superset logic to any required bits, and matches nothing for unknown bits', async () => {
    const bitsByUser = await seedEveryPermBits();
    for (const required of [
      0,
      PermissionBits.VIEW,
      PermissionBits.VIEW | PermissionBits.EDIT,
      PermissionBits.DELETE | PermissionBits.SHARE,
      MAX_PERM_BITS,
    ]) {
      const rows = await methods.listUserPermissionHolders(
        ResourceType.AGENT,
        resourceId,
        required,
      );
      const heldBits = rows.map((row) => bitsByUser.get(String(row.principalId)));
      expect(heldBits).toEqual(
        [...bitsByUser.values()].filter((bits) => (bits & required) === required),
      );
    }
    for (const unknown of [MAX_PERM_BITS + 1, -1, 1.5]) {
      await expect(
        methods.listUserPermissionHolders(ResourceType.AGENT, resourceId, unknown),
      ).resolves.toEqual([]);
    }
  });

  it('scopes entries to the active tenant', async () => {
    const userA = new ObjectId();
    const userB = new ObjectId();
    await seed('User', [
      { _id: userA, name: 'A', tenantId: 'tenant-a' },
      { _id: userB, name: 'B', tenantId: 'tenant-b' },
    ]);
    await seed(
      'AclEntry',
      [
        [userA, 'tenant-a'],
        [userB, 'tenant-b'],
      ].map(([principalId, tenantId]) => ({
        principalType: PrincipalType.USER,
        principalId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: MAX_PERM_BITS,
        tenantId,
      })),
    );

    const rows = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      expectSameAsAggregate(
        () =>
          methods.listUserPermissionHolders(
            ResourceType.AGENT,
            resourceId.toString(),
            PermissionBits.SHARE,
          ),
        enricherPipeline(resourceId.toString()),
      ),
    );
    expect(rows.map((row) => String((row as { principalId: unknown }).principalId))).toEqual([
      userA.toString(),
    ]);
  });
});

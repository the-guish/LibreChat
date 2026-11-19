import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ResourceType, PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type * as t from '~/types';
import { createAclEntryMethods } from './aclEntry';
import { createShareMethods } from './share';
import { createModels } from '~/models';

/**
 * The record-level shared link methods and the ACL expiry write, used by the shared-link ACL
 * layer in `packages/api`: each runs the one query that layer ran on the models directly.
 */

let mongoServer: MongoMemoryServer;
let SharedLink: mongoose.Model<t.ISharedLink>;
let AclEntry: mongoose.Model<t.IAclEntry>;
let share: ReturnType<typeof createShareMethods>;
let acl: ReturnType<typeof createAclEntryMethods>;

const user = new mongoose.Types.ObjectId().toString();
const otherUser = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  SharedLink = mongoose.models.SharedLink as mongoose.Model<t.ISharedLink>;
  AclEntry = mongoose.models.AclEntry as mongoose.Model<t.IAclEntry>;
  share = createShareMethods(mongoose);
  acl = createAclEntryMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await SharedLink.deleteMany({});
  await AclEntry.deleteMany({});
});

const createLink = (overrides: Partial<t.ISharedLink> = {}) =>
  SharedLink.create({
    shareId: `share-${new mongoose.Types.ObjectId().toString()}`,
    conversationId: 'convo-a',
    user,
    messages: [],
    ...overrides,
  });

const setLegacyFlag = (id: mongoose.Types.ObjectId, isPublic: boolean) =>
  mongoose.connection.db!.collection('sharedlinks').updateOne({ _id: id }, { $set: { isPublic } });

describe('shared link records', () => {
  it('finds an active link by share id, legacy flag included, and skips an expired one', async () => {
    const active = await createLink({ expiredAt: new Date(Date.now() + 60_000) });
    await setLegacyFlag(active._id!, false);
    const expired = await createLink({ expiredAt: new Date(Date.now() - 60_000) });

    const record = await share.findActiveSharedLinkRecord(active.shareId!);
    expect(record?._id?.toString()).toBe(active._id!.toString());
    expect(record).toMatchObject({ isPublic: false, conversationId: 'convo-a', user });
    expect(await share.findActiveSharedLinkRecord(expired.shareId!)).toBeNull();
    expect(await share.findActiveSharedLinkRecord('missing')).toBeNull();
  });

  it('reads a link by record id, expired or not, as stored', async () => {
    const link = await createLink({ expiredAt: new Date(Date.now() - 60_000) });
    await setLegacyFlag(link._id!, true);

    const byObjectId = await share.getSharedLinkRecord(link._id!);
    const byString = await share.getSharedLinkRecord(link._id!.toString());
    expect(byObjectId).toMatchObject({ isPublic: true, shareId: link.shareId });
    expect(byString?._id?.toString()).toBe(link._id!.toString());
    expect(await share.getSharedLinkRecord(new mongoose.Types.ObjectId())).toBeNull();
  });

  it('reads only the owner of a link and rejects an id that is not one', async () => {
    const link = await createLink();

    const owner = await share.getSharedLinkOwner(link._id!.toString());
    expect(owner?.user).toBe(user);
    expect(owner?._id?.toString()).toBe(link._id!.toString());
    expect(Object.keys(owner ?? {}).sort()).toEqual(['_id', 'user']);
    expect(await share.getSharedLinkOwner(new mongoose.Types.ObjectId())).toBeNull();
    await expect(share.getSharedLinkOwner('not-an-id')).rejects.toThrow(/Cast to ObjectId/);
  });

  it("reads the conversation of the user's own link, expired or not", async () => {
    const link = await createLink({ expiredAt: new Date(Date.now() - 60_000) });

    const found = await share.getOwnSharedLinkConversation(user, link.shareId!);
    expect(found?.conversationId).toBe('convo-a');
    expect(found?._id?.toString()).toBe(link._id!.toString());
    expect(Object.keys(found ?? {}).sort()).toEqual(['_id', 'conversationId']);
    expect(await share.getOwnSharedLinkConversation(otherUser, link.shareId!)).toBeNull();
  });

  it("lists and deletes the owner's links, all or one conversation's", async () => {
    const [a1, a2, b1] = await Promise.all([
      createLink(),
      createLink({ expiredAt: new Date(Date.now() - 60_000) }),
      createLink({ conversationId: 'convo-b' }),
    ]);
    const other = await createLink({ user: otherUser });

    const convoIds = await share.listSharedLinkRecordIds({ user, conversationId: 'convo-a' });
    expect(convoIds.map(String).sort()).toEqual([a1._id, a2._id].map(String).sort());
    expect(convoIds[0]).toBeInstanceOf(mongoose.Types.ObjectId);
    const allIds = await share.listSharedLinkRecordIds({ user });
    expect(allIds.map(String).sort()).toEqual([a1._id, a2._id, b1._id].map(String).sort());

    expect(await share.deleteSharedLinkRecords({ user, conversationId: 'convo-a' })).toMatchObject({
      deletedCount: 2,
    });
    expect(await share.deleteSharedLinkRecords({ user })).toMatchObject({ deletedCount: 1 });
    expect(await SharedLink.countDocuments({ _id: other._id })).toBe(1);
  });

  it('keeps an explicit undefined conversation id in the criteria, as the query did', async () => {
    await createLink();
    const ids = await share.listSharedLinkRecordIds({ user, conversationId: undefined });
    const direct = await SharedLink.find({ user, conversationId: undefined }).select('_id').lean();
    expect(ids.map(String)).toEqual(direct.map((link) => String(link._id)));
  });

  it("takes the user's link by share id and deletes a link by record id", async () => {
    const taken = await createLink();
    const deleted = await createLink();

    expect(await share.takeOwnSharedLinkRecord(otherUser, taken.shareId!)).toBeNull();
    const record = await share.takeOwnSharedLinkRecord(user, taken.shareId!);
    expect(record?._id?.toString()).toBe(taken._id!.toString());
    expect(await SharedLink.countDocuments({ _id: taken._id })).toBe(0);

    expect(await share.deleteSharedLinkRecord(deleted._id!)).toMatchObject({ deletedCount: 1 });
    expect(await SharedLink.countDocuments({ _id: deleted._id })).toBe(0);
  });

  it('clears the legacy flag outside the schema and keeps the other fields', async () => {
    const link = await createLink();
    await setLegacyFlag(link._id!, true);

    await share.clearLegacySharedLinkVisibility(link._id!);
    const raw = await mongoose.connection.db!.collection('sharedlinks').findOne({ _id: link._id });
    expect(raw).not.toHaveProperty('isPublic');
    expect(raw).toMatchObject({ shareId: link.shareId, user });
  });
});

describe('setResourceEntriesExpiration', () => {
  const resourceId = new mongoose.Types.ObjectId();
  const otherResourceId = new mongoose.Types.ObjectId();

  const createEntry = (id: mongoose.Types.ObjectId, principalType: PrincipalType) =>
    AclEntry.create({
      principalType,
      ...(principalType === PrincipalType.USER && {
        principalId: new mongoose.Types.ObjectId(user),
        principalModel: PrincipalModel.USER,
      }),
      resourceType: ResourceType.SHARED_LINK,
      resourceId: id,
      permBits: 1,
      grantedAt: new Date(),
    });

  it("sets and then removes the expiry of every entry on the resource, only that resource's", async () => {
    await Promise.all([
      createEntry(resourceId, PrincipalType.USER),
      createEntry(resourceId, PrincipalType.PUBLIC),
      createEntry(otherResourceId, PrincipalType.PUBLIC),
    ]);
    const expiredAt = new Date(Date.now() + 3_600_000);

    const set = await acl.setResourceEntriesExpiration(
      ResourceType.SHARED_LINK,
      resourceId.toString(),
      expiredAt,
    );
    expect(set).toMatchObject({ matchedCount: 2, modifiedCount: 2 });
    const entries = await AclEntry.find({ resourceId }).lean();
    expect(entries.map((entry) => entry.expiredAt?.getTime())).toEqual([
      expiredAt.getTime(),
      expiredAt.getTime(),
    ]);
    const other = await AclEntry.findOne({ resourceId: otherResourceId }).lean();
    expect(other?.expiredAt).toBeUndefined();

    await acl.setResourceEntriesExpiration(ResourceType.SHARED_LINK, resourceId, null);
    const cleared = await AclEntry.find({ resourceId }).lean();
    expect(cleared.every((entry) => !('expiredAt' in entry))).toBe(true);
  });
});

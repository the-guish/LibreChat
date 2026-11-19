import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ConversationStore } from '~/ports/conversation';
import type { IConversation } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';
import { createMethods } from './index';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let store: ConversationStore;
let Conversation: mongoose.Model<IConversation>;

const user = 'user-a';
const otherUser = 'user-b';
let seq = 0;
const newId = () => `convo-${++seq}`;

/** Inserts a conversation directly, the way any earlier write would have left it. */
async function insert(fields: Partial<IConversation> = {}) {
  const conversationId = fields.conversationId ?? newId();
  await Conversation.create({ endpoint: 'openAI', user, ...fields, conversationId });
  return conversationId;
}

/** A subagent lineage record below `rootConversationId`. */
const lineage = (rootConversationId: string, parentConversationId: string, depth: number) => ({
  rootConversationId,
  parentConversationId,
  parentMessageId: `message-${depth}`,
  parentToolCallId: `call-${depth}`,
  subagentType: 'agent-child',
  subagentKind: 'agent' as const,
  depth,
});

const ids = (targets: Array<{ conversationId: string }>) =>
  targets.map((target) => target.conversationId).sort();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  store = createMethods(mongoose).conversations;
});

afterEach(async () => {
  await Conversation.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('ConversationStore deleteConvos steps (MongoDB)', () => {
  describe('listConvosForDeletion', () => {
    it('lists every conversation of the user, or only the listed ids', async () => {
      const first = await insert();
      const second = await insert();
      await insert({ user: otherUser });

      expect(ids(await store.listConvosForDeletion(user, { all: true }))).toEqual(
        [first, second].sort(),
      );
      expect(ids(await store.listConvosForDeletion(user, { conversationIds: [second] }))).toEqual([
        second,
      ]);
      expect(await store.listConvosForDeletion(user, { conversationIds: [] })).toEqual([]);
    });

    it('returns plain targets with only the fields a deletion needs', async () => {
      const conversationId = await insert({
        tenantId: 'tenant-a',
        chatProjectId: 'project-1',
        tags: ['work'],
        title: 'Not needed',
      });
      const bare = await insert();

      const targets = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        store.listConvosForDeletion(user, { conversationIds: [conversationId] }),
      );
      expect(targets).toEqual([
        { conversationId, tenantId: 'tenant-a', chatProjectId: 'project-1', tags: ['work'] },
      ]);
      const [bareTarget] = await store.listConvosForDeletion(user, { conversationIds: [bare] });
      expect(bareTarget).not.toHaveProperty('_id');
      expect(bareTarget).not.toHaveProperty('title');
      expect(bareTarget.conversationId).toBe(bare);
    });

    it('never lists another user’s conversation by id', async () => {
      const foreign = await insert({ user: otherUser });
      expect(await store.listConvosForDeletion(user, { conversationIds: [foreign] })).toEqual([]);
    });

    it('is scoped to the tenant in context', async () => {
      const conversationId = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        insert({ tenantId: 'tenant-a' }),
      );
      const fromB = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        store.listConvosForDeletion(user, { conversationIds: [conversationId] }),
      );
      expect(fromB).toEqual([]);
    });
  });

  it('listSubagentDescendantsForDeletion finds the owner’s threads at any depth below a root', async () => {
    const root = newId();
    const child = await insert({ subagentThread: lineage(root, root, 1) });
    const grandchild = await insert({ subagentThread: lineage(root, child, 2) });
    await insert({ user: otherUser, subagentThread: lineage(root, root, 1) });
    await insert({ subagentThread: lineage(newId(), newId(), 1) });

    expect(ids(await store.listSubagentDescendantsForDeletion(user, root))).toEqual(
      [child, grandchild].sort(),
    );
  });

  it('listSubagentChildrenForDeletion finds only the owner’s direct children', async () => {
    const root = await insert();
    const otherRoot = await insert();
    const child = await insert({ subagentThread: lineage(root, root, 1) });
    const otherChild = await insert({ subagentThread: lineage(otherRoot, otherRoot, 1) });
    await insert({ subagentThread: lineage(root, child, 2) });
    await insert({ user: otherUser, subagentThread: lineage(root, root, 1) });

    expect(ids(await store.listSubagentChildrenForDeletion(user, [root, otherRoot]))).toEqual(
      [child, otherChild].sort(),
    );
    expect(await store.listSubagentChildrenForDeletion(user, [])).toEqual([]);
  });

  describe('deleteConvoRecords', () => {
    it('deletes only the owner’s listed records and counts them', async () => {
      const first = await insert();
      const second = await insert();
      const kept = await insert();
      const foreign = await insert({ user: otherUser });

      await expect(store.deleteConvoRecords(user, [first, second, foreign])).resolves.toEqual({
        acknowledged: true,
        deletedCount: 2,
      });
      expect(ids(await Conversation.find({}).select('conversationId').lean())).toEqual(
        [kept, foreign].sort(),
      );
      await expect(store.deleteConvoRecords(user, [first])).resolves.toEqual({
        acknowledged: true,
        deletedCount: 0,
      });
    });

    it('is scoped to the tenant in context', async () => {
      const conversationId = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        insert({ tenantId: 'tenant-a' }),
      );
      const fromB = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        store.deleteConvoRecords(user, [conversationId]),
      );
      expect(fromB.deletedCount).toBe(0);
      expect(await Conversation.countDocuments({ conversationId })).toBe(1);
    });
  });
});

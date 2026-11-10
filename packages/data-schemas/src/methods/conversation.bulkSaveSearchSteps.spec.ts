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

/** Reads a stored conversation with every field, hidden ones included. */
const raw = (conversationId: string) =>
  Conversation.collection.findOne({ conversationId }) as Promise<Record<string, unknown> | null>;

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

describe('ConversationStore bulkSaveConvos steps (MongoDB)', () => {
  describe('listConvoProjectAssignments', () => {
    it('lists the stored project of each listed conversation that exists', async () => {
      const assigned = await insert({ chatProjectId: 'project-1' });
      const unassigned = await insert();
      const foreign = await insert({ user: otherUser, chatProjectId: 'project-2' });

      const rows = await store.listConvoProjectAssignments([
        { user, conversationId: assigned },
        { user, conversationId: unassigned },
        { user, conversationId: foreign },
        { user, conversationId: 'missing' },
      ]);

      expect(rows.sort((a, b) => a.conversationId.localeCompare(b.conversationId))).toEqual(
        [
          { user, conversationId: assigned, chatProjectId: 'project-1' },
          { user, conversationId: unassigned, chatProjectId: null },
        ].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
      );
      expect(rows[0]).not.toHaveProperty('_id');
    });

    it('is scoped to the tenant in context', async () => {
      const conversationId = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        insert({ tenantId: 'tenant-a', chatProjectId: 'project-1' }),
      );
      const fromB = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        store.listConvoProjectAssignments([{ user, conversationId }]),
      );
      expect(fromB).toEqual([]);
    });
  });

  describe('bulkUpsertConvos', () => {
    it('creates with the insert-only fields and updates without them, stamping no times', async () => {
      const existing = await insert({ title: 'Before', codeEnvironmentMode: 'without_attached' });
      const before = await raw(existing);
      const created = newId();

      const result = await store.bulkUpsertConvos([
        {
          user,
          conversationId: existing,
          set: { user, conversationId: existing, title: 'After' },
          setOnInsert: { initial_agent_id: null, codeEnvironmentMode: 'attached' },
        },
        {
          user,
          conversationId: created,
          set: { user, conversationId: created, title: 'New', endpoint: 'openAI' },
          setOnInsert: { initial_agent_id: null, codeEnvironmentMode: 'attached' },
        },
      ]);

      expect(result).toMatchObject({ matchedCount: 1, modifiedCount: 1, upsertedCount: 1 });
      const updated = await raw(existing);
      expect(updated).toMatchObject({ title: 'After', codeEnvironmentMode: 'without_attached' });
      expect(updated?.updatedAt).toEqual(before?.updatedAt);
      const inserted = await raw(created);
      expect(inserted).toMatchObject({
        title: 'New',
        initial_agent_id: null,
        codeEnvironmentMode: 'attached',
      });
      expect(inserted).not.toHaveProperty('createdAt');
      expect(inserted).not.toHaveProperty('updatedAt');
    });

    it('keys each row by user, never touching another user’s conversation', async () => {
      const conversationId = await insert({ user: otherUser, title: 'Theirs' });

      await store.bulkUpsertConvos([
        {
          user,
          conversationId,
          set: { user, conversationId, title: 'Mine', endpoint: 'openAI' },
          setOnInsert: {},
        },
      ]);

      const rows = await Conversation.find({ conversationId }).lean();
      expect(rows.map((row) => [row.user, row.title]).sort()).toEqual([
        [user, 'Mine'],
        [otherUser, 'Theirs'],
      ]);
    });

    it('never writes a tenantId from the payload and stamps the tenant in context', async () => {
      const conversationId = newId();
      await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        store.bulkUpsertConvos([
          {
            user,
            conversationId,
            set: { user, conversationId, endpoint: 'openAI', tenantId: 'forged' },
            setOnInsert: { tenantId: 'forged-too' },
          },
        ]),
      );
      expect((await raw(conversationId))?.tenantId).toBe('tenant-a');
    });

    it('writes nothing for an empty list', async () => {
      expect(await store.bulkUpsertConvos([])).toMatchObject({
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
      });
      expect(await Conversation.countDocuments({})).toBe(0);
    });
  });
});

describe('ConversationStore searchConversation steps (MongoDB)', () => {
  const messageId = new mongoose.Types.ObjectId();

  async function insertFull(fields: Partial<IConversation> = {}) {
    return insert({ title: 'Stored', messages: [messageId], laneGitSeq: 7, ...fields });
  }

  it('reads only the ownership fields', async () => {
    const conversationId = await insertFull();
    const found = await store.getConvoByIdAcrossUsers(conversationId, 'ownership');
    expect(found).toMatchObject({ conversationId, user });
    expect(Object.keys(found ?? {}).sort()).toEqual(['_id', 'conversationId', 'user']);
  });

  it('reads every field but the message list, or every field', async () => {
    const conversationId = await insertFull();

    const withoutMessages = await store.getConvoByIdAcrossUsers(conversationId, 'withoutMessages');
    expect(withoutMessages).toMatchObject({ conversationId, user, title: 'Stored' });
    expect(withoutMessages).not.toHaveProperty('messages');

    const full = await store.getConvoByIdAcrossUsers(conversationId, 'full');
    expect(full).toMatchObject({ conversationId, user, title: 'Stored' });
    expect(full?.messages?.map(String)).toEqual([String(messageId)]);
  });

  it('keeps hidden fields hidden under every choice', async () => {
    const conversationId = await insertFull();
    for (const projection of ['ownership', 'withoutMessages', 'full'] as const) {
      expect(await store.getConvoByIdAcrossUsers(conversationId, projection)).not.toHaveProperty(
        'laneGitSeq',
      );
    }
  });

  it('finds a conversation whoever its user is, and null for a missing id', async () => {
    const conversationId = await insertFull({ user: otherUser });
    expect(await store.getConvoByIdAcrossUsers(conversationId, 'ownership')).toMatchObject({
      user: otherUser,
    });
    expect(await store.getConvoByIdAcrossUsers('missing', 'full')).toBeNull();
  });

  it('is scoped to the tenant in context', async () => {
    const conversationId = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      insertFull({ tenantId: 'tenant-a' }),
    );
    const fromB = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      store.getConvoByIdAcrossUsers(conversationId, 'full'),
    );
    expect(fromB).toBeNull();
  });
});

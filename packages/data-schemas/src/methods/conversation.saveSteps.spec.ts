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
let methods: ReturnType<typeof createMethods>;
let Conversation: mongoose.Model<IConversation>;

const user = 'user-a';
const otherUser = 'user-b';
let seq = 0;
const newId = () => `convo-${++seq}`;

/** Writes a conversation the way the steps expect to find one. */
async function insert(fields: Record<string, unknown> = {}) {
  const conversationId = newId();
  const written = await store.writeConvo({
    user,
    conversationId,
    set: { title: 'A chat', endpoint: 'openAI', ...fields },
    upsert: true,
    timestamps: true,
  });
  return { conversationId, conversation: written!.conversation };
}

const read = (conversationId: string) =>
  Conversation.findOne({ conversationId, user }).lean<IConversation>();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  methods = createMethods(mongoose);
  store = methods.conversations;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('ConversationStore saveConvo steps (MongoDB)', () => {
  describe('writeConvo', () => {
    it('creates with upsert and reports the insert, then updates in place', async () => {
      const conversationId = newId();
      const created = await store.writeConvo({
        user,
        conversationId,
        set: { title: 'First' },
        setOnInsert: { initial_agent_id: 'agent-1' },
        upsert: true,
        timestamps: true,
      });
      expect(created?.inserted).toBe(true);
      expect(created?.conversation.createdAt).toBeInstanceOf(Date);

      const updated = await store.writeConvo({
        user,
        conversationId,
        set: { title: 'Second' },
        setOnInsert: { initial_agent_id: 'agent-2' },
        upsert: true,
        timestamps: true,
      });
      expect(updated?.inserted).toBe(false);
      expect(updated?.conversation.title).toBe('Second');
      /* `initial_agent_id` is `select: false`, so it is read back explicitly. */
      const stored = await Conversation.findOne({ conversationId, user })
        .select('+initial_agent_id')
        .lean<IConversation>();
      expect(stored?.initial_agent_id).toBe('agent-1');
      expect(await Conversation.countDocuments({ conversationId })).toBe(1);
    });

    it('returns null without upsert when nothing matches, and never writes another user', async () => {
      const { conversationId } = await insert();
      expect(
        await store.writeConvo({
          user: otherUser,
          conversationId,
          set: { title: 'Hijack' },
          upsert: false,
          timestamps: true,
        }),
      ).toBeNull();
      expect((await read(conversationId))?.title).toBe('A chat');
    });

    it('applies `when.isArchived` as a condition', async () => {
      const { conversationId } = await insert({ isArchived: true });
      const write = (isArchived: boolean) =>
        store.writeConvo({
          user,
          conversationId,
          when: { isArchived },
          set: { title: `archived=${isArchived}` },
          upsert: false,
          timestamps: true,
        });
      expect(await write(false)).toBeNull();
      expect((await write(true))?.conversation.title).toBe('archived=true');
    });

    it('applies the default-title guard', async () => {
      const guard = {
        titleSetByUser: false as const,
        titleIn: [null, '', 'New Chat'],
      };
      const untitled = await insert({ title: 'New Chat' });
      const named = await insert({ title: 'Mine', titleSetByUser: true });
      const write = (conversationId: string) =>
        store.writeConvo({
          user,
          conversationId,
          when: guard,
          set: { title: 'Generated' },
          upsert: false,
          timestamps: true,
        });
      expect((await write(untitled.conversationId))?.conversation.title).toBe('Generated');
      expect(await write(named.conversationId)).toBeNull();
    });

    it('refuses `upsert` combined with `when`', async () => {
      await expect(
        store.writeConvo({
          user,
          conversationId: newId(),
          when: { isArchived: false },
          set: {},
          upsert: true,
          timestamps: true,
        }),
      ).rejects.toThrow('cannot be combined');
    });

    it('unsets, increments, keeps the later stamp and appends message ids without duplicates', async () => {
      const later = new Date('2030-01-02T00:00:00Z');
      const earlier = new Date('2030-01-01T00:00:00Z');
      const { conversationId } = await insert({ promptPrefix: 'drop me', lastResponseAt: later });
      const [m1, m2] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()].map(String);

      await store.writeConvo({
        user,
        conversationId,
        set: {},
        unset: ['promptPrefix'],
        increment: { titleRevision: 1 },
        max: { lastResponseAt: earlier },
        appendMessageIds: [m1, m2],
        upsert: false,
        timestamps: true,
      });
      await store.writeConvo({
        user,
        conversationId,
        set: {},
        increment: { titleRevision: 1 },
        appendMessageIds: [m2],
        upsert: false,
        timestamps: true,
      });

      const stored = await read(conversationId);
      expect(stored?.promptPrefix).toBeUndefined();
      expect(stored?.titleRevision).toBe(2);
      expect(stored?.lastResponseAt).toEqual(later);
      expect((stored?.messages ?? []).map(String)).toEqual([m1, m2]);
    });

    it('leaves updatedAt alone when timestamps are off', async () => {
      const { conversationId, conversation } = await insert();
      await store.writeConvo({
        user,
        conversationId,
        set: { pinned: true },
        upsert: false,
        timestamps: false,
      });
      const stored = await read(conversationId);
      expect(stored?.pinned).toBe(true);
      expect(stored?.updatedAt).toEqual(conversation.updatedAt);
    });

    it('is scoped to the tenant in context', async () => {
      const conversationId = newId();
      await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        store.writeConvo({
          user,
          conversationId,
          set: { title: 'A' },
          upsert: true,
          timestamps: true,
        }),
      );
      const fromB = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        store.writeConvo({
          user,
          conversationId,
          set: { title: 'B' },
          upsert: false,
          timestamps: true,
        }),
      );
      expect(fromB).toBeNull();
      expect(
        await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
          store.convoExists(user, conversationId),
        ),
      ).toBe(false);
    });
  });

  it('convoExists reports only the owner’s conversation', async () => {
    const { conversationId } = await insert();
    expect(await store.convoExists(user, conversationId)).toBe(true);
    expect(await store.convoExists(otherUser, conversationId)).toBe(false);
    expect(await store.convoExists(user, 'missing')).toBe(false);
  });

  it('getConvoMessageIds lists the stored messages oldest first', async () => {
    const { conversationId } = await insert();
    const Message = mongoose.models.Message;
    const first = await Message.create({
      messageId: 'm-1',
      conversationId,
      user,
      text: 'one',
      createdAt: new Date('2030-01-01T00:00:00Z'),
    });
    const second = await Message.create({
      messageId: 'm-2',
      conversationId,
      user,
      text: 'two',
      createdAt: new Date('2030-01-02T00:00:00Z'),
    });
    await Message.create({ messageId: 'm-3', conversationId, user: otherUser, text: 'other' });
    expect(await store.getConvoMessageIds(user, conversationId)).toEqual([
      String(first._id),
      String(second._id),
    ]);
  });

  it('isOwnedChatProject checks ownership and rejects malformed ids', async () => {
    const project = await methods.createChatProject(user, { name: 'Project' });
    const projectId = String(project._id);
    expect(await store.isOwnedChatProject(user, projectId)).toBe(true);
    expect(await store.isOwnedChatProject(otherUser, projectId)).toBe(false);
    expect(await store.isOwnedChatProject(user, 'not-an-id')).toBe(false);
  });

  it('seedConvoCodeEnvironmentDecision writes only while no decision is held', async () => {
    const { conversationId } = await insert();
    const decision = { codeEnvironmentMode: 'without_attached' as const };
    expect(await store.seedConvoCodeEnvironmentDecision({ user, conversationId, decision })).toBe(
      true,
    );
    expect(
      await store.seedConvoCodeEnvironmentDecision({
        user,
        conversationId,
        decision: { codeEnvironmentMode: 'attached' as const },
      }),
    ).toBe(false);
    expect((await read(conversationId))?.codeEnvironmentMode).toBe('without_attached');
  });

  it('setConvoExpiryIfUnset writes only an unset deadline whose chat type matches', async () => {
    const deadline = new Date('2031-01-01T00:00:00Z');
    const { conversationId } = await insert({ isTemporary: false });
    expect(
      await store.setConvoExpiryIfUnset({
        user,
        conversationId,
        isTemporary: true,
        expiredAt: deadline,
      }),
    ).toBe(false);
    expect(
      await store.setConvoExpiryIfUnset({
        user,
        conversationId,
        isTemporary: false,
        expiredAt: deadline,
      }),
    ).toBe(true);
    expect(
      await store.setConvoExpiryIfUnset({
        user,
        conversationId,
        isTemporary: false,
        expiredAt: new Date('2032-01-01T00:00:00Z'),
      }),
    ).toBe(false);
    expect((await read(conversationId))?.expiredAt).toEqual(deadline);
  });

  it('stampConvoReply stamps monotonically and never stamps a temporary chat', async () => {
    const { conversationId } = await insert();
    const first = await store.stampConvoReply({
      user,
      conversationId,
      responseMessageId: 'r-1',
    });
    const second = await store.stampConvoReply({
      user,
      conversationId,
      responseMessageId: 'r-2',
    });
    expect(first?.state.lastResponseMessageId).toBe('r-1');
    expect(first?.state.isMarkedUnread).toBe(false);
    expect(second!.lastResponseAt.getTime()).toBeGreaterThan(first!.lastResponseAt.getTime());
    expect((await read(conversationId))?.lastResponseMessageId).toBe('r-2');

    const temporary = await insert({ isTemporary: true });
    expect(
      await store.stampConvoReply({
        user,
        conversationId: temporary.conversationId,
        responseMessageId: 'r-3',
      }),
    ).toBeNull();
  });

  it('backfillConvoIsTemporary writes only when no chat type is stored', async () => {
    const { conversationId } = await insert();
    await Conversation.updateOne({ conversationId }, { $unset: { isTemporary: '' } });
    const kept = await insert({ isTemporary: true });

    expect(
      await store.backfillConvoIsTemporary({ user, conversationId, touchUpdatedAt: false }),
    ).toBe(true);
    expect(
      await store.backfillConvoIsTemporary({
        user,
        conversationId: kept.conversationId,
        touchUpdatedAt: false,
      }),
    ).toBe(false);
    expect((await read(conversationId))?.isTemporary).toBe(false);
    expect((await read(kept.conversationId))?.isTemporary).toBe(true);
  });

  it('maintains project statistics', async () => {
    const project = await methods.createChatProject(user, { name: 'Stats' });
    const projectId = String(project._id);
    const { conversation } = await insert({ chatProjectId: projectId });

    await store.recordChatProjectLastConversation(user, projectId, conversation);
    expect((await methods.getChatProject(user, projectId))?.lastConversationId).toBe(
      conversation.conversationId,
    );

    await store.refreshChatProjectStats(user, projectId);
    expect((await methods.getChatProject(user, projectId))?.conversationCount).toBe(1);
  });
});

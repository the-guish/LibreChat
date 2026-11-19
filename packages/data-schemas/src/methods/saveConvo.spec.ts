import { Types } from 'mongoose';
import type { ConversationStore } from '~/ports/conversation';
import type { SaveConvo, SaveConvoStore } from './saveConvo';
import type { ConversationMethods } from './conversation';
import type { IConversation, ConvoWrite } from '~/types';
import { createSaveConvo } from './saveConvo';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/*
 * Type-level conformance. These lines fail `npm run typecheck`, not Jest, when the factory's
 * dependencies drift from the port, so any `ConversationStore` adapter can build `saveConvo`.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Every dependency is a port method with exactly the port's signature. */
type DependenciesArePortMethods = Assert<
  Equals<
    { [K in keyof SaveConvoStore]: SaveConvoStore[K] },
    { [K in keyof SaveConvoStore]: Pick<ConversationStore, keyof SaveConvoStore>[K] }
  >
>;
/** The factory's result serves as the declared `ConversationMethods['saveConvo']`. */
type BuildsTheDeclaredMethod = Assert<
  SaveConvo extends ConversationMethods['saveConvo'] ? true : false
>;

/** An in-memory store that records each write and answers it with the written fields. */
function createFakeStore(existing?: Partial<IConversation>) {
  const writes: ConvoWrite[] = [];
  const steps: SaveConvoStore = {
    getConvo: async () => (existing ? ({ ...existing } as IConversation) : null),
    getConvoMessageIds: async () => ['m1', 'm2'],
    isOwnedChatProject: async () => true,
    writeConvo: async (input) => {
      writes.push(input);
      if (!input.upsert && !existing) {
        return null;
      }
      const conversation = {
        ...existing,
        ...input.set,
        isTemporary: existing?.isTemporary ?? false,
      } as IConversation;
      return { conversation, inserted: !existing };
    },
    convoExists: async () => existing != null,
    seedConvoCodeEnvironmentDecision: async () => true,
    setConvoExpiryIfUnset: async () => true,
    stampConvoReply: async () => null,
    backfillConvoIsTemporary: async () => false,
    refreshChatProjectStats: async () => undefined,
    recordChatProjectLastConversation: async () => undefined,
  };
  for (const name of Object.keys(steps) as Array<keyof SaveConvoStore>) {
    jest.spyOn(steps, name);
  }
  const store = steps as jest.Mocked<SaveConvoStore>;
  return { store, writes };
}

describe('createSaveConvo', () => {
  it('conforms to the port at the type level', () => {
    const typeChecks: [DependenciesArePortMethods, BuildsTheDeclaredMethod] = [true, true];
    expect(typeChecks).toEqual([true, true]);
  });

  it('expresses a save as one plain write on the steps', async () => {
    const { store, writes } = createFakeStore({ conversationId: 'c1', user: 'u1' });
    const saveConvo = createSaveConvo(store);
    const messageId = new Types.ObjectId();

    const result = await saveConvo(
      { userId: 'u1' },
      { conversationId: 'c1', title: 'Renamed', lastResponseAt: new Date(), laneGit: {} },
      {
        titleSource: 'manual',
        appendMessageIds: [messageId, 'plain-id'],
        unsetFields: { endpointType: 1, isMarkedUnread: 1, 'laneGit.head': 1, chatProjectId: 1 },
      },
    );

    expect(store.getConvoMessageIds).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write).toMatchObject({
      user: 'u1',
      conversationId: 'c1',
      set: { user: 'u1', title: 'Renamed', titleSetByUser: true },
      unset: ['endpointType'],
      increment: { titleRevision: 1 },
      appendMessageIds: [messageId.toHexString(), 'plain-id'],
      upsert: true,
      timestamps: true,
    });
    expect(write.when).toBeUndefined();
    expect(write.set).not.toHaveProperty('lastResponseAt');
    expect(write.set).not.toHaveProperty('laneGit');
    expect(write.setOnInsert).toEqual({ initial_agent_id: null });
    expect(result).toMatchObject({ conversationId: 'c1', title: 'Renamed' });
  });

  it('guards a generated title with conditions and never upserts it', async () => {
    const { store, writes } = createFakeStore();
    const saveConvo = createSaveConvo(store);

    const result = await saveConvo(
      { userId: 'u1' },
      { conversationId: 'c1', title: 'Generated' },
      { titleSource: 'generated' },
    );

    expect(result).toBeNull();
    expect(store.getConvoMessageIds).toHaveBeenCalledWith('u1', 'c1');
    expect(writes).toEqual([
      expect.objectContaining({
        when: { titleSetByUser: false, titleIn: [null, '', 'New Chat'] },
        set: expect.objectContaining({ messages: ['m1', 'm2'] }),
        upsert: false,
      }),
    ]);
  });

  it('answers a split archive with the stored conversation, never writing an upsert with conditions', async () => {
    const existing = { conversationId: 'c1', user: 'u1', isArchived: false };
    const { store, writes } = createFakeStore(existing);
    store.writeConvo.mockImplementation(async (input) => {
      writes.push(input);
      return null;
    });
    const saveConvo = createSaveConvo(store);

    const result = await saveConvo(
      { userId: 'u1' },
      { conversationId: 'c1', isArchived: true },
      { noUpsert: true, preserveUpdatedAt: true },
    );

    expect(result).toMatchObject(existing);
    expect(writes.map(({ when, upsert }) => ({ when, upsert }))).toEqual([
      { when: { isArchived: false }, upsert: false },
      { when: { isArchived: true }, upsert: false },
      { when: { isArchived: false }, upsert: false },
      { when: { isArchived: true }, upsert: false },
      { when: { isArchived: false }, upsert: false },
      { when: { isArchived: true }, upsert: false },
    ]);
    expect(writes.every((write) => write.timestamps === false)).toBe(true);
    expect(writes[0].set.archivedAt).toBeInstanceOf(Date);
    expect(writes[1].set).not.toHaveProperty('archivedAt');
    expect(store.convoExists).toHaveBeenCalledTimes(2);
  });
});

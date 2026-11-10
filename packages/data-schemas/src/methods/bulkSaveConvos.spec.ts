import type { BulkSaveConvos, BulkSaveConvosDeps, BulkSaveConvosStore } from './bulkSaveConvos';
import type { ConvoBulkUpsert, ConvoProjectAssignment } from '~/types';
import type { ConversationStore } from '~/ports/conversation';
import type { ConversationMethods } from './conversation';
import { createBulkSaveConvos } from './bulkSaveConvos';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/*
 * Type-level conformance. These lines fail `npm run typecheck`, not Jest, when the factory's
 * dependencies drift from the port, so any `ConversationStore` adapter can build `bulkSaveConvos`.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Every store dependency is a port method with exactly the port's signature. */
type StoreIsPortMethods = Assert<
  Equals<
    { [K in keyof BulkSaveConvosStore]: BulkSaveConvosStore[K] },
    { [K in keyof BulkSaveConvosStore]: Pick<ConversationStore, keyof BulkSaveConvosStore>[K] }
  >
>;
/** The factory's result serves as the declared `ConversationMethods['bulkSaveConvos']`. */
type BuildsTheDeclaredMethod = Assert<
  BulkSaveConvos extends ConversationMethods['bulkSaveConvos'] ? true : false
>;
/** It accepts exactly the records the declared method accepts. */
type AcceptsTheDeclaredRecords = Assert<
  Equals<Parameters<BulkSaveConvos>, Parameters<ConversationMethods['bulkSaveConvos']>>
>;

const PROJECT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

/** An in-memory store and ownership dependency recording every call. */
function createFake({
  owned = [],
  stored = [],
}: {
  owned?: Array<{ user: string; chatProjectId: string }>;
  stored?: ConvoProjectAssignment[];
} = {}) {
  const calls: string[] = [];
  const upserts: ConvoBulkUpsert[] = [];
  const store: BulkSaveConvosStore = {
    listConvoProjectAssignments: async (pairs) => {
      calls.push(`assignments:${JSON.stringify(pairs)}`);
      return stored.filter((row) =>
        pairs.some((p) => p.user === row.user && p.conversationId === row.conversationId),
      );
    },
    bulkUpsertConvos: async (rows) => {
      calls.push(`upsert:${rows.length}`);
      upserts.push(...rows);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: rows.length };
    },
    refreshChatProjectStats: async (user, chatProjectId) => {
      calls.push(`stats:${user}:${chatProjectId}`);
    },
  };
  const deps: BulkSaveConvosDeps = {
    listOwnedChatProjectIds: async (pairs) => {
      calls.push(`owned:${JSON.stringify(pairs)}`);
      return owned.filter((row) =>
        pairs.some((p) => p.user === row.user && p.chatProjectId === row.chatProjectId),
      );
    },
  };
  return { store, deps, calls, upserts };
}

describe('createBulkSaveConvos', () => {
  it('conforms to the port at the type level', () => {
    const typeChecks: [StoreIsPortMethods, BuildsTheDeclaredMethod, AcceptsTheDeclaredRecords] = [
      true,
      true,
      true,
    ];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('strips imported state and seeds the code environment only on insert', async () => {
    const { store, deps, upserts } = createFake();
    const bulkSaveConvos = createBulkSaveConvos(store, deps);

    await bulkSaveConvos([
      {
        user: 'u1',
        conversationId: 'c1',
        title: 'Imported',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [{ environmentId: 'e', workspaceId: 'w' }],
        lastResponseAt: new Date(),
        lastResponseMessageId: 'm',
        lastResponseIsManual: true,
        isMarkedUnread: true,
        lastSeenAt: new Date(),
        codeApprovalMode: 'auto',
        initial_agent_id: 'agent',
        toolApprovalAllows: ['tool'],
        laneGit: { branch: 'b' },
        'laneGit.head': 'h',
        laneGitSeq: 3,
        codeAttachmentEpoch: 2,
        codeEnvironmentRevision: 4,
        agentEventActor: {},
        'agentEventActorSuspension.id': 's',
      },
    ]);

    expect(upserts).toEqual([
      {
        user: 'u1',
        conversationId: 'c1',
        set: { user: 'u1', conversationId: 'c1', title: 'Imported' },
        setOnInsert: {
          initial_agent_id: null,
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [{ environmentId: 'e', workspaceId: 'w' }],
        },
      },
    ]);
  });

  it('keeps owned projects, nulls the rest and refreshes joined and left projects', async () => {
    const { store, deps, calls, upserts } = createFake({
      owned: [{ user: 'u1', chatProjectId: PROJECT_A }],
      stored: [{ user: 'u1', conversationId: 'moved', chatProjectId: PROJECT_B }],
    });
    const bulkSaveConvos = createBulkSaveConvos(store, deps);

    const result = await bulkSaveConvos([
      { user: 'u1', conversationId: 'joined', chatProjectId: PROJECT_A },
      { user: 'u1', conversationId: 'moved', chatProjectId: 'not-owned' },
      { user: 'u1', conversationId: 'again', chatProjectId: PROJECT_A },
    ]);

    expect(result).toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 3 });
    expect(upserts.map((row) => row.set.chatProjectId)).toEqual([PROJECT_A, null, PROJECT_A]);
    expect(calls).toEqual([
      `owned:${JSON.stringify([
        { user: 'u1', chatProjectId: PROJECT_A },
        { user: 'u1', chatProjectId: 'not-owned' },
      ])}`,
      `assignments:${JSON.stringify([
        { user: 'u1', conversationId: 'joined' },
        { user: 'u1', conversationId: 'moved' },
        { user: 'u1', conversationId: 'again' },
      ])}`,
      'upsert:3',
      `stats:u1:${PROJECT_A}`,
      `stats:u1:${PROJECT_B}`,
    ]);
  });

  it('skips both reads when no record carries the fields they need, but still writes', async () => {
    const { store, deps, calls } = createFake();
    const bulkSaveConvos = createBulkSaveConvos(store, deps);

    await bulkSaveConvos([]);
    await bulkSaveConvos([{ title: 'no keys' }]);

    expect(calls).toEqual(['upsert:0', 'upsert:1']);
  });

  it('turns any failure into one error', async () => {
    const { store, deps } = createFake();
    const bulkSaveConvos = createBulkSaveConvos(
      {
        ...store,
        bulkUpsertConvos: async () => {
          throw new Error('write failed');
        },
      },
      deps,
    );

    await expect(bulkSaveConvos([{ user: 'u1', conversationId: 'c1' }])).rejects.toThrow(
      'Failed to save conversations in bulk.',
    );
  });
});

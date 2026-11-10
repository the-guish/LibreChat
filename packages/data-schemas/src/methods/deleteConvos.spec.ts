import type { DeleteConvos, DeleteConvosDeps, DeleteConvosStore } from './deleteConvos';
import type { ConversationMethodDeps, ConversationMethods } from './conversation';
import type { ConversationStore } from '~/ports/conversation';
import type { ConvoDeletionTarget } from '~/types';
import { createDeleteConvos } from './deleteConvos';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/*
 * Type-level conformance. These lines fail `npm run typecheck`, not Jest, when the factory's
 * dependencies drift from the port, so any `ConversationStore` adapter can build `deleteConvos`.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Every store dependency is a port method with exactly the port's signature. */
type StoreIsPortMethods = Assert<
  Equals<
    { [K in keyof DeleteConvosStore]: DeleteConvosStore[K] },
    { [K in keyof DeleteConvosStore]: Pick<ConversationStore, keyof DeleteConvosStore>[K] }
  >
>;
/** The queued-turn and trigger dependencies are the ones the methods are already given. */
type SharedDepsMatch = Assert<
  Equals<
    {
      [K in keyof DeleteConvosDeps & keyof ConversationMethodDeps]: DeleteConvosDeps[K];
    },
    {
      [K in keyof DeleteConvosDeps & keyof ConversationMethodDeps]: ConversationMethodDeps[K];
    }
  >
>;
/** The factory's result serves as the declared `ConversationMethods['deleteConvos']`. */
type BuildsTheDeclaredMethod = Assert<
  DeleteConvos extends ConversationMethods['deleteConvos'] ? true : false
>;
/** Every filter the declared method accepts reaches the factory's translation. */
type AcceptsTheDeclaredFilter = Assert<
  Parameters<ConversationMethods['deleteConvos']>[1] extends Parameters<DeleteConvos>[1]
    ? true
    : false
>;

/** An in-memory store of conversation targets keyed by parent, recording every call. */
function createFake(
  rows: Array<ConvoDeletionTarget & { parent?: string; root?: string }>,
  hasMessages = false,
) {
  const calls: string[] = [];
  const live = new Map(rows.map((row) => [row.conversationId, row]));
  const target = ({ conversationId, tenantId, chatProjectId, tags }: ConvoDeletionTarget) => ({
    conversationId,
    ...(tenantId != null && { tenantId }),
    ...(chatProjectId != null && { chatProjectId }),
    ...(tags != null && { tags }),
  });
  const store: DeleteConvosStore = {
    listConvosForDeletion: async (_user, selector) => {
      calls.push(`list:${JSON.stringify(selector)}`);
      const all = [...live.values()];
      return (
        'conversationIds' in selector
          ? all.filter((row) => selector.conversationIds.includes(row.conversationId))
          : all.filter((row) => row.parent == null)
      ).map(target);
    },
    listSubagentDescendantsForDeletion: async (_user, root) => {
      calls.push(`descendants:${root}`);
      return [...live.values()].filter((row) => row.root === root).map(target);
    },
    listSubagentChildrenForDeletion: async (_user, parents) => {
      calls.push(`children:${parents.join(',')}`);
      return [...live.values()]
        .filter((row) => row.parent != null && parents.includes(row.parent))
        .map(target);
    },
    deleteConvoRecords: async (_user, conversationIds) => {
      calls.push(`delete:${conversationIds.join(',')}`);
      let deletedCount = 0;
      for (const id of conversationIds) {
        deletedCount += live.delete(id) ? 1 : 0;
      }
      return { acknowledged: true, deletedCount };
    },
    refreshChatProjectStats: async (_user, projectId) => {
      calls.push(`stats:${projectId}`);
    },
  };
  const deps: DeleteConvosDeps = {
    hasConvoMessages: async () => hasMessages,
    deleteConvoMessages: async (_user, conversationIds) => {
      calls.push(`messages:${conversationIds.join(',')}`);
      return { acknowledged: true, deletedCount: conversationIds.length };
    },
    prepareSubagentContentDeletion: async (_user, conversationIds) => {
      calls.push(`content:${conversationIds.join(',')}`);
    },
    decrementTagCounts: async (_user, tags) => {
      calls.push(`tags:${tags.join(',')}`);
    },
    deleteToolApprovalGrants: async (_user, conversationIds) => {
      calls.push(`grants:${conversationIds.join(',')}`);
    },
    deleteAgentQueuedTurns: async (_user, conversations) => {
      calls.push(`turns:${JSON.stringify(conversations)}`);
    },
  };
  return { store, deps, calls, live };
}

describe('createDeleteConvos', () => {
  it('conforms to the port at the type level', () => {
    const typeChecks: [
      StoreIsPortMethods,
      SharedDepsMatch,
      BuildsTheDeclaredMethod,
      AcceptsTheDeclaredFilter,
    ] = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('translates each supported filter to a selector, ignoring a `user` key', async () => {
    const { store, deps, calls } = createFake([{ conversationId: 'a' }, { conversationId: 'b' }]);
    const deleteConvos = createDeleteConvos(store, () => deps);

    await deleteConvos('u1', { conversationId: 'a' });
    await deleteConvos('u1', { conversationId: { $in: ['b'] } });
    await deleteConvos('u1', { user: 'someone-else' }, { allowEmpty: true });

    expect(calls.filter((call) => call.startsWith('list:'))).toEqual([
      'list:{"conversationIds":["a"]}',
      'list:{"conversationIds":["b"]}',
      'list:{"all":true}',
    ]);
  });

  it('rejects any other filter shape, naming the keys, before touching storage', async () => {
    const { store, deps, calls } = createFake([{ conversationId: 'a' }]);
    const deleteConvos = createDeleteConvos(store, () => deps);

    await expect(deleteConvos('u1', { title: 'x', $or: [] })).rejects.toThrow(
      'deleteConvos does not support the filter key(s) title, $or',
    );
    await expect(
      deleteConvos('u1', { conversationId: { $in: ['a'], $nin: ['b'] } }),
    ).rejects.toThrow('filter key(s) conversationId.$nin;');
    await expect(deleteConvos('u1', { conversationId: { $in: [1] } })).rejects.toThrow(
      'filter key(s) conversationId.$in;',
    );
    await expect(deleteConvos('u1', { conversationId: { $ne: 'a' } })).rejects.toThrow(
      'filter key(s) conversationId.$ne;',
    );
    await expect(deleteConvos('u1', { conversationId: null })).rejects.toThrow(
      'filter key(s) conversationId;',
    );
    expect(calls).toEqual([]);
  });

  it('runs each wave in order and reconciles it before discovering the next', async () => {
    const { store, deps, calls } = createFake([
      { conversationId: 'root', tenantId: 't1', chatProjectId: 'p1', tags: ['work', 'work'] },
      { conversationId: 'child', parent: 'root', root: 'root', tags: ['work'] },
    ]);
    const deleteConvos = createDeleteConvos(store, () => deps);
    const beforeDelete = jest.fn(async (conversationIds: string[]) => {
      calls.push(`before:${conversationIds.join(',')}`);
    });

    const result = await deleteConvos('u1', { conversationId: 'root' }, { beforeDelete });

    expect(result).toEqual({
      acknowledged: true,
      deletedCount: 2,
      messages: { acknowledged: true, deletedCount: 2 },
      conversationIds: ['root', 'child'],
    });
    expect(calls).toEqual([
      'list:{"conversationIds":["root"]}',
      'turns:[{"conversationId":"root","tenantId":"t1"}]',
      'before:root',
      'content:root',
      'delete:root',
      'tags:work',
      'stats:p1',
      'children:root',
      'turns:[{"conversationId":"child"}]',
      'before:child',
      'content:child',
      'delete:child',
      'tags:work',
      'children:child',
      'messages:root,child',
      'grants:root,child',
    ]);
  });

  it('resumes a deleted root from its descendants and keeps the root id', async () => {
    const { store, deps, calls } = createFake([
      { conversationId: 'child', parent: 'gone', root: 'gone' },
    ]);
    const deleteConvos = createDeleteConvos(store, () => deps);

    const result = await deleteConvos('u1', { conversationId: 'gone' });

    expect(result.conversationIds).toEqual(['gone', 'child']);
    expect(calls).toContain('descendants:gone');
    expect(calls).toContain('turns:[{"conversationId":"gone","allTenants":true}]');
    await expect(deleteConvos('u1', { conversationId: { $in: ['gone'] } })).rejects.toThrow(
      'Conversation not found or already deleted.',
    );
  });

  it('fails before any storage call when its dependencies cannot be resolved', async () => {
    const { store, calls } = createFake([{ conversationId: 'a' }]);
    const deleteConvos = createDeleteConvos(store, () => {
      throw new Error('Message methods not injected into conversation methods');
    });

    await expect(deleteConvos('u1', { conversationId: 'a' })).rejects.toThrow(
      'Message methods not injected',
    );
    expect(calls).toEqual([]);
  });
});

import type { SearchConversation, SearchConversationStore } from './searchConversation';
import type { ConvoByIdProjection, IConversation } from '~/types';
import type { ConversationStore } from '~/ports/conversation';
import type { ConversationMethods } from './conversation';
import { createSearchConversation } from './searchConversation';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/*
 * Type-level conformance. These lines fail `npm run typecheck`, not Jest, when the factory's
 * dependency drifts from the port, so any `ConversationStore` adapter can build
 * `searchConversation`.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** The store dependency is a port method with exactly the port's signature. */
type StoreIsPortMethods = Assert<
  Equals<
    { [K in keyof SearchConversationStore]: SearchConversationStore[K] },
    {
      [K in keyof SearchConversationStore]: Pick<
        ConversationStore,
        keyof SearchConversationStore
      >[K];
    }
  >
>;
/** The factory's result has exactly the declared `ConversationMethods['searchConversation']`. */
type BuildsTheDeclaredMethod = Assert<
  Equals<SearchConversation, ConversationMethods['searchConversation']>
>;

function createFake(found: Partial<IConversation> | null = { conversationId: 'c1', user: 'u1' }) {
  const calls: Array<[string, ConvoByIdProjection]> = [];
  const store: SearchConversationStore = {
    getConvoByIdAcrossUsers: async (conversationId, projection) => {
      calls.push([conversationId, projection]);
      return found as IConversation | null;
    },
  };
  return { store, calls };
}

describe('createSearchConversation', () => {
  it('conforms to the port at the type level', () => {
    const typeChecks: [StoreIsPortMethods, BuildsTheDeclaredMethod] = [true, true];
    expect(typeChecks).toEqual([true, true]);
  });

  it('maps each supported projection onto the neutral choice', async () => {
    const { store, calls } = createFake();
    const searchConversation = createSearchConversation(store);

    expect(await searchConversation('c1')).toEqual({ conversationId: 'c1', user: 'u1' });
    await searchConversation('c1', undefined);
    await searchConversation('c1', 'conversationId user');
    await searchConversation('c1', '-messages');
    await searchConversation('c1', null);

    expect(calls).toEqual([
      ['c1', 'ownership'],
      ['c1', 'ownership'],
      ['c1', 'ownership'],
      ['c1', 'withoutMessages'],
      ['c1', 'full'],
    ]);
  });

  it('rejects any other projection before reading', async () => {
    const { store, calls } = createFake();
    const searchConversation = createSearchConversation(store);

    await expect(searchConversation('c1', 'title')).rejects.toThrow(
      'searchConversation does not support the projection "title"',
    );
    await expect(searchConversation('c1', 'user conversationId')).rejects.toThrow(
      'does not support the projection',
    );
    expect(calls).toEqual([]);
  });

  it('passes a missing conversation through and wraps a read failure', async () => {
    const searchConversation = createSearchConversation(createFake(null).store);
    expect(await searchConversation('missing')).toBeNull();

    const failing = createSearchConversation({
      getConvoByIdAcrossUsers: async () => {
        throw new Error('read failed');
      },
    });
    await expect(failing('c1')).rejects.toThrow('Error searching conversation');
  });
});

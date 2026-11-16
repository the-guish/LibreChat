/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ConversationTagStore` contract (`~/ports/conversationTag`), ported from
 * `methods/conversationTag.methods.spec.ts` and the method bodies it covers: a user's tags in
 * position order, created last (or resolved unchanged by name), renamed on the user's
 * conversations in place (the positional `tags.$` update on a string array: the renamed tag keeps
 * its place among the conversation's tags), moved with the tags in between shifted, deleted from
 * every conversation with the gap closed, and the tag counts the conversation writes keep.
 *
 * The `decrementTagCounts` cases of the method spec are not on the port (the helper is called by
 * the conversation methods); they stay there. Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import type { ContractHarness, RawRecord } from './harness';
import { useContractHarness } from './support';

export function describeConversationTagContract(harness: ContractHarness): void {
  describe(`ConversationTagStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().conversationTags;
    const newId = () => harness.ids.generate();
    const user = newId();
    const otherUser = newId();

    const seedTags = (records: RawRecord[]) =>
      harness.seedRaw(
        'conversationtags',
        records.map((record) => ({ _id: newId(), user, count: 0, ...record })),
      );
    const seedConversations = (records: RawRecord[]) =>
      harness.seedRaw(
        'conversations',
        records.map((record) => ({ _id: newId(), user, endpoint: 'openAI', ...record })),
      );
    const tagsOf = async (conversationId: string, owner = user) =>
      (await harness.readRaw('conversations')).find(
        (record) => record.conversationId === conversationId && record.user === owner,
      )?.tags;
    const storedTags = async (owner = user) =>
      (await harness.readRaw('conversationtags'))
        .filter((record) => record.user === owner)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map(({ tag, position, count }) => ({ tag, position, count }));

    describe('getConversationTags', () => {
      it("reads the user's tags in position order, and no other user's", async () => {
        await seedTags([
          { tag: 'third', position: 3 },
          { tag: 'first', position: 1, description: 'One' },
          { tag: 'second', position: 2 },
          { tag: 'theirs', position: 0, user: otherUser },
        ]);
        const tags = await stores().getConversationTags(user);
        expect(tags.map(({ tag }) => tag)).toEqual(['first', 'second', 'third']);
        expect(tags[0]).toMatchObject({ user, tag: 'first', description: 'One', position: 1 });
        expect(await stores().getConversationTags(newId())).toEqual([]);
      });
    });

    describe('createConversationTag', () => {
      it('creates the tag last in position order with no conversations counted', async () => {
        await seedTags([{ tag: 'existing', position: 4 }]);
        const created = await stores().createConversationTag(user, {
          tag: 'work',
          description: 'Work chats',
        });
        expect(created).toMatchObject({ user, tag: 'work', description: 'Work chats' });
        expect(created).toMatchObject({ position: 5, count: 0 });
        expect(created?.createdAt).toBeInstanceOf(Date);
        const first = await stores().createConversationTag(otherUser, { tag: 'work' });
        expect(first).toMatchObject({ position: 1, count: 0 });
      });

      it('resolves an existing tag of that name unchanged', async () => {
        await seedTags([{ tag: 'work', position: 2, count: 7, description: 'Old' }]);
        const existing = await stores().createConversationTag(user, {
          tag: 'work',
          description: 'New',
          addToConversation: true,
          conversationId: 'c1',
        });
        expect(existing).toMatchObject({ tag: 'work', position: 2, count: 7, description: 'Old' });
        expect(await storedTags()).toEqual([{ tag: 'work', position: 2, count: 7 }]);
      });

      it('counts and adds a new tag to the conversation it was created from, once', async () => {
        await seedConversations([{ conversationId: 'c1', tags: ['other'] }]);
        const created = await stores().createConversationTag(user, {
          tag: 'work',
          addToConversation: true,
          conversationId: 'c1',
        });
        expect(created).toMatchObject({ tag: 'work', count: 1, position: 1 });
        expect(await tagsOf('c1')).toEqual(['other', 'work']);
      });
    });

    describe('updateConversationTag', () => {
      it("renames the tag in place on the user's conversations only", async () => {
        await seedTags([
          { tag: 'old', position: 1 },
          { tag: 'old', position: 1, user: otherUser },
        ]);
        await seedConversations([
          { conversationId: 'c1', tags: ['a', 'old', 'b'] },
          { conversationId: 'c2', tags: ['old'] },
          { conversationId: 'c3', tags: ['a'] },
          { conversationId: 'c4', tags: ['old'], user: otherUser },
        ]);
        const updated = await stores().updateConversationTag(user, 'old', { tag: 'new' });
        expect(updated).toMatchObject({ user, tag: 'new', position: 1 });
        expect(await tagsOf('c1')).toEqual(['a', 'new', 'b']);
        expect(await tagsOf('c2')).toEqual(['new']);
        expect(await tagsOf('c3')).toEqual(['a']);
        expect(await tagsOf('c4', otherUser)).toEqual(['old']);
        expect((await stores().getConversationTags(otherUser))[0].tag).toBe('old');
      });

      it('renames only the first occurrence of a tag a conversation carries twice', async () => {
        await seedTags([{ tag: 'dup', position: 1 }]);
        await seedConversations([{ conversationId: 'c1', tags: ['dup', 'x', 'dup'] }]);
        await stores().updateConversationTag(user, 'dup', { tag: 'renamed' });
        // NOTE(contract): the positional `tags.$` update renames the first matching element
        // only, so a conversation that carries the tag twice keeps the old name once (a tag the
        // user no longer has). Pinned as today's behavior.
        expect(await tagsOf('c1')).toEqual(['renamed', 'x', 'dup']);
      });

      it('re-describes the tag, keeps its name without a new one, and resolves null for none', async () => {
        await seedTags([{ tag: 'work', position: 1, description: 'Old' }]);
        expect(
          await stores().updateConversationTag(user, 'work', { description: 'New' }),
        ).toMatchObject({ tag: 'work', description: 'New', position: 1 });
        expect(await stores().updateConversationTag(user, 'missing', { tag: 'x' })).toBeNull();
        expect(
          await stores().updateConversationTag(otherUser, 'work', { description: 'Theirs' }),
        ).toBeNull();
      });

      it('throws when the new name is already one of the user’s tags', async () => {
        await seedTags([
          { tag: 'a', position: 1 },
          { tag: 'b', position: 2 },
        ]);
        await seedConversations([{ conversationId: 'c1', tags: ['a'] }]);
        await expect(stores().updateConversationTag(user, 'a', { tag: 'b' })).rejects.toThrow(
          'Error updating conversation tag',
        );
        expect(await tagsOf('c1')).toEqual(['a']);
        expect((await storedTags()).map(({ tag }) => tag)).toEqual(['a', 'b']);
      });

      it('moves the tag and shifts the tags between its old and new positions', async () => {
        await seedTags([
          { tag: 'a', position: 1 },
          { tag: 'b', position: 2 },
          { tag: 'c', position: 3 },
          { tag: 'd', position: 4 },
          { tag: 'theirs', position: 2, user: otherUser },
        ]);
        await stores().updateConversationTag(user, 'a', { position: 3 });
        expect((await storedTags()).map(({ tag, position }) => [tag, position])).toEqual([
          ['b', 1],
          ['c', 2],
          ['a', 3],
          ['d', 4],
        ]);
        await stores().updateConversationTag(user, 'd', { position: 1 });
        expect((await storedTags()).map(({ tag, position }) => [tag, position])).toEqual([
          ['d', 1],
          ['b', 2],
          ['c', 3],
          ['a', 4],
        ]);
        expect(await storedTags(otherUser)).toEqual([{ tag: 'theirs', position: 2, count: 0 }]);
      });
    });

    describe('deleteConversationTag', () => {
      it('removes every occurrence from the user’s conversations and closes the gap', async () => {
        await seedTags([
          { tag: 'first', position: 1 },
          { tag: 'second', position: 2 },
          { tag: 'third', position: 3 },
          { tag: 'first', position: 1, user: otherUser },
        ]);
        await seedConversations([
          { conversationId: 'c1', tags: ['first', 'important'] },
          { conversationId: 'c2', tags: ['first'] },
          { conversationId: 'c3', tags: ['first', 'other', 'first'] },
          { conversationId: 'c4', tags: ['personal'] },
          { conversationId: 'c5', tags: ['first'], user: otherUser },
        ]);
        const deleted = await stores().deleteConversationTag(user, 'first');
        expect(deleted).toMatchObject({ user, tag: 'first', position: 1 });
        expect(await tagsOf('c1')).toEqual(['important']);
        expect(await tagsOf('c2')).toEqual([]);
        expect(await tagsOf('c3')).toEqual(['other']);
        expect(await tagsOf('c4')).toEqual(['personal']);
        expect(await tagsOf('c5', otherUser)).toEqual(['first']);
        expect(await storedTags()).toEqual([
          { tag: 'second', position: 1, count: 0 },
          { tag: 'third', position: 2, count: 0 },
        ]);
        expect(await storedTags(otherUser)).toHaveLength(1);
      });

      it('resolves null when the user has no such tag', async () => {
        await seedTags([{ tag: 'theirs', position: 1, user: otherUser }]);
        expect(await stores().deleteConversationTag(user, 'theirs')).toBeNull();
        expect(await harness.readRaw('conversationtags')).toHaveLength(1);
      });
    });

    describe('deleteConversationTags', () => {
      it('deletes the matching tags only, leaving the conversations as they are', async () => {
        await seedTags([
          { tag: 'a', position: 1 },
          { tag: 'b', position: 2 },
          { tag: 'a', position: 1, user: otherUser },
        ]);
        await seedConversations([{ conversationId: 'c1', tags: ['a', 'b'] }]);
        expect(await stores().deleteConversationTags({ user })).toBe(2);
        expect(await stores().deleteConversationTags({ user })).toBe(0);
        expect(await tagsOf('c1')).toEqual(['a', 'b']);
        expect(await storedTags(otherUser)).toHaveLength(1);
      });
    });

    describe('bulkIncrementTagCounts', () => {
      it("adds one to each named existing tag once, creating none and touching no other user's", async () => {
        await seedTags([
          { tag: 'a', position: 1, count: 2 },
          { tag: 'b', position: 2, count: 0 },
          { tag: 'a', position: 1, count: 5, user: otherUser },
        ]);
        await harness.seedRaw('conversationtags', [
          { _id: newId(), user, tag: 'legacy', position: 3 },
        ]);
        await stores().bulkIncrementTagCounts(user, ['a', 'a', 'b', '', 'missing', 'legacy']);
        await stores().bulkIncrementTagCounts(user, []);
        expect(await storedTags()).toEqual([
          { tag: 'a', position: 1, count: 3 },
          { tag: 'b', position: 2, count: 1 },
          { tag: 'legacy', position: 3, count: 1 },
        ]);
        expect(await storedTags(otherUser)).toEqual([{ tag: 'a', position: 1, count: 5 }]);
      });
    });

    describe('updateTagsForConversation', () => {
      it('sets the tags, creating missing ones and adjusting the counts of those added and removed', async () => {
        await seedTags([
          { tag: 'keep', position: 1, count: 3 },
          { tag: 'drop', position: 2, count: 1 },
          { tag: 'add', position: 3, count: 4 },
        ]);
        await seedConversations([{ conversationId: 'c1', tags: ['keep', 'drop'] }]);
        const tags = await stores().updateTagsForConversation(user, 'c1', [
          'keep',
          'add',
          'fresh',
          'add',
        ]);
        expect(tags).toEqual(['keep', 'add', 'fresh']);
        expect(await tagsOf('c1')).toEqual(['keep', 'add', 'fresh']);
        const stored = await storedTags();
        expect(stored).toEqual(
          expect.arrayContaining([
            { tag: 'keep', position: 1, count: 3 },
            { tag: 'drop', position: 2, count: 0 },
            { tag: 'add', position: 3, count: 5 },
          ]),
        );
        const fresh = (await stores().getConversationTags(user)).find(({ tag }) => tag === 'fresh');
        expect(fresh).toMatchObject({ user, tag: 'fresh', count: 1 });
        // NOTE(contract): a tag created by tagging a conversation takes the default position 0
        // rather than the next one `createConversationTag` assigns, so it orders before the
        // user's positioned tags (which start at 1). Pinned as today's behavior.
        expect(fresh?.position).toBe(0);
        expect((await stores().getConversationTags(user))[0].tag).toBe('fresh');
      });

      it('clears the tags with an empty list', async () => {
        await seedTags([{ tag: 'only', position: 1, count: 1 }]);
        await seedConversations([{ conversationId: 'c1', tags: ['only'] }]);
        expect(await stores().updateTagsForConversation(user, 'c1', [])).toEqual([]);
        expect(await storedTags()).toEqual([{ tag: 'only', position: 1, count: 0 }]);
      });

      it('throws when the user has no such conversation', async () => {
        await seedConversations([{ conversationId: 'theirs', user: otherUser, tags: [] }]);
        await expect(stores().updateTagsForConversation(user, 'theirs', ['x'])).rejects.toThrow(
          'Error updating tags for conversation',
        );
        expect(await harness.readRaw('conversationtags')).toEqual([]);
      });
    });
  });
}

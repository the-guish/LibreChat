/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ToolFavoriteStore` contract (`~/ports/favorite`), ported from `methods/favorite.spec.ts`:
 * idempotent adds under the cap, removal, per-user reads and account erasure. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness } from './harness';
import { useContractHarness } from './support';

/** `MAX_TOOL_FAVORITES` of `methods/favorite.ts`, which the port names. */
const MAX_TOOL_FAVORITES = 100;

export function describeToolFavoriteContract(harness: ContractHarness): void {
  describe(`ToolFavoriteStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userA = harness.ids.generate();
    const userB = harness.ids.generate();

    describe('addToolFavorite', () => {
      it('stores a favorite, read back as its kind and id', async () => {
        const { toolFavorites } = harness.createStores();
        expect(
          await toolFavorites.addToolFavorite({
            userId: userA,
            itemType: 'mcp',
            itemId: 'everything',
          }),
        ).toEqual({ ok: true, added: true });
        expect(await toolFavorites.getToolFavorites(userA)).toEqual([
          { itemType: 'mcp', itemId: 'everything' },
        ]);
        const [stored] = await harness.readRaw('toolfavorites');
        expect(stored).toMatchObject({ user: userA, itemType: 'mcp', itemId: 'everything' });
      });

      it('is idempotent: a second add keeps one record and reports added: false', async () => {
        const { toolFavorites } = harness.createStores();
        const params = { userId: userA, itemType: 'tool', itemId: 'dalle' } as const;
        await toolFavorites.addToolFavorite(params);
        expect(await toolFavorites.addToolFavorite(params)).toEqual({ ok: true, added: false });
        expect(await harness.readRaw('toolfavorites')).toHaveLength(1);
      });

      it('rejects an item type outside the declared kinds', async () => {
        await expect(
          harness.createStores().toolFavorites.addToolFavorite({
            userId: userA,
            itemType: 'agent' as never,
            itemId: 'x',
          }),
        ).rejects.toThrow();
        expect(await harness.readRaw('toolfavorites')).toEqual([]);
      });

      it('rejects an item id longer than 256 characters', async () => {
        await expect(
          harness.createStores().toolFavorites.addToolFavorite({
            userId: userA,
            itemType: 'tool',
            itemId: 'x'.repeat(257),
          }),
        ).rejects.toThrow();
      });

      it('throws a coded error at the cap, while re-adding an existing favorite succeeds', async () => {
        await harness.seedRaw(
          'toolfavorites',
          Array.from({ length: MAX_TOOL_FAVORITES }, (_, index) => ({
            _id: harness.ids.generate(),
            user: userA,
            itemType: 'tool',
            itemId: `tool-${index}`,
          })),
        );
        const { toolFavorites } = harness.createStores();
        await expect(
          toolFavorites.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'one-more' }),
        ).rejects.toMatchObject({ code: 'MAX_FAVORITES_EXCEEDED', limit: MAX_TOOL_FAVORITES });
        expect(
          await toolFavorites.addToolFavorite({
            userId: userA,
            itemType: 'tool',
            itemId: 'tool-0',
          }),
        ).toEqual({ ok: true, added: false });
        expect(
          await toolFavorites.addToolFavorite({ userId: userB, itemType: 'tool', itemId: 'x' }),
        ).toEqual({ ok: true, added: true });
      });

      it('settles concurrent duplicate adds on one record without throwing', async () => {
        const { toolFavorites } = harness.createStores();
        const params = { userId: userA, itemType: 'skill', itemId: 'abc123' } as const;
        const results = await Promise.all([
          toolFavorites.addToolFavorite(params),
          toolFavorites.addToolFavorite(params),
          toolFavorites.addToolFavorite(params),
        ]);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(await harness.readRaw('toolfavorites')).toHaveLength(1);
      });
    });

    describe('removeToolFavorite', () => {
      it('removes a favorite and is idempotent', async () => {
        const { toolFavorites } = harness.createStores();
        const params = { userId: userA, itemType: 'builtin', itemId: 'web_search' } as const;
        await toolFavorites.addToolFavorite(params);
        expect(await toolFavorites.removeToolFavorite(params)).toEqual({ ok: true, removed: true });
        expect(await toolFavorites.removeToolFavorite(params)).toEqual({
          ok: true,
          removed: false,
        });
        expect(await toolFavorites.getToolFavorites(userA)).toEqual([]);
      });

      it("leaves the same item of another kind and another user's favorite", async () => {
        const { toolFavorites } = harness.createStores();
        await toolFavorites.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'same' });
        await toolFavorites.addToolFavorite({ userId: userA, itemType: 'skill', itemId: 'same' });
        await toolFavorites.addToolFavorite({ userId: userB, itemType: 'tool', itemId: 'same' });
        await toolFavorites.removeToolFavorite({ userId: userA, itemType: 'tool', itemId: 'same' });
        expect(await toolFavorites.getToolFavorites(userA)).toEqual([
          { itemType: 'skill', itemId: 'same' },
        ]);
        expect(await toolFavorites.getToolFavorites(userB)).toHaveLength(1);
      });
    });

    describe('getToolFavorites', () => {
      it('is isolated per user', async () => {
        const { toolFavorites } = harness.createStores();
        await toolFavorites.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'dalle' });
        await toolFavorites.addToolFavorite({ userId: userB, itemType: 'mcp', itemId: 'every' });
        expect(await toolFavorites.getToolFavorites(userA)).toEqual([
          { itemType: 'tool', itemId: 'dalle' },
        ]);
        expect(await toolFavorites.getToolFavorites(userB)).toEqual([
          { itemType: 'mcp', itemId: 'every' },
        ]);
      });

      it('keeps the same item id under different kinds apart, oldest first', async () => {
        await harness.seedRaw('toolfavorites', [
          {
            _id: harness.ids.generate(),
            user: userA,
            itemType: 'skill',
            itemId: 'shared-id',
            createdAt: new Date('2024-01-02T00:00:00.000Z'),
          },
          {
            _id: harness.ids.generate(),
            user: userA,
            itemType: 'tool',
            itemId: 'shared-id',
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
          },
        ]);
        expect(await harness.createStores().toolFavorites.getToolFavorites(userA)).toEqual([
          { itemType: 'tool', itemId: 'shared-id' },
          { itemType: 'skill', itemId: 'shared-id' },
        ]);
      });

      it('returns an empty list for a user without favorites', async () => {
        expect(await harness.createStores().toolFavorites.getToolFavorites(userA)).toEqual([]);
      });
    });

    describe('deleteUserToolFavorites', () => {
      it("removes every favorite of the user, counts them, and keeps other users'", async () => {
        const { toolFavorites } = harness.createStores();
        await toolFavorites.addToolFavorite({ userId: userA, itemType: 'tool', itemId: 'a' });
        await toolFavorites.addToolFavorite({ userId: userA, itemType: 'mcp', itemId: 'b' });
        await toolFavorites.addToolFavorite({ userId: userB, itemType: 'tool', itemId: 'a' });
        expect(await toolFavorites.deleteUserToolFavorites(userA)).toBe(2);
        expect(await toolFavorites.getToolFavorites(userA)).toEqual([]);
        expect(await toolFavorites.getToolFavorites(userB)).toHaveLength(1);
        expect(await toolFavorites.deleteUserToolFavorites(userA)).toBe(0);
      });
    });
  });
}

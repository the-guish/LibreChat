/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `PluginAuthStore` contract (`~/ports/pluginAuth`), ported from `methods/pluginAuth.spec.ts`:
 * a user's plugin credential values (stored as given; callers encrypt them), the atomic upsert,
 * the lookups by field and by plugin keys, and the deletes. Nothing here may import `mongoose` or
 * the MongoDB driver.
 */
import type { ContractHarness } from './harness';
import { idOf, useContractHarness } from './support';

export function describePluginAuthContract(harness: ContractHarness): void {
  describe(`PluginAuthStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const userId = harness.ids.generate();
    const otherUserId = harness.ids.generate();
    const key = { userId, pluginKey: 'web_search', authField: 'API_KEY' };
    const stores = () => harness.createStores().pluginAuths;
    const seed = (entries: Array<[string, string | undefined, string, string]>) =>
      harness.seedRaw(
        'pluginauths',
        entries.map(([owner, pluginKey, authField, value]) => ({
          _id: harness.ids.generate(),
          userId: owner,
          ...(pluginKey ? { pluginKey } : {}),
          authField,
          value,
        })),
      );

    describe('updatePluginAuth', () => {
      it('creates the value when missing and resolves it', async () => {
        const created = await stores().updatePluginAuth({ ...key, value: 'first' });
        expect(created).toMatchObject({ ...key, value: 'first' });
        const [stored] = await harness.readRaw('pluginauths');
        expect(stored).toMatchObject({ ...key, value: 'first' });
        expect(idOf(harness, created._id)).toBe(stored._id);
      });

      it('updates the existing value in place instead of adding one', async () => {
        const created = await stores().updatePluginAuth({ ...key, value: 'first' });
        const updated = await stores().updatePluginAuth({ ...key, value: 'second' });
        expect(idOf(harness, updated._id)).toBe(idOf(harness, created._id));
        expect(updated.value).toBe('second');
        expect(await harness.readRaw('pluginauths')).toHaveLength(1);
      });

      it('keeps values of other plugins, fields and users apart', async () => {
        await stores().updatePluginAuth({ ...key, value: 'a' });
        await stores().updatePluginAuth({ ...key, pluginKey: 'other', value: 'b' });
        await stores().updatePluginAuth({ ...key, authField: 'SECRET', value: 'c' });
        await stores().updatePluginAuth({ ...key, userId: otherUserId, value: 'd' });
        expect(await harness.readRaw('pluginauths')).toHaveLength(4);
      });
    });

    describe('findOnePluginAuth', () => {
      it("finds the user's value for the field, narrowed to the plugin when given", async () => {
        await seed([
          [userId, 'web_search', 'API_KEY', 'search-key'],
          [userId, 'dalle', 'OPENAI_KEY', 'dalle-key'],
          [otherUserId, 'web_search', 'API_KEY', 'other-key'],
        ]);
        expect(
          await stores().findOnePluginAuth({
            userId,
            authField: 'API_KEY',
            pluginKey: 'web_search',
          }),
        ).toMatchObject({ value: 'search-key' });
        expect(await stores().findOnePluginAuth({ userId, authField: 'OPENAI_KEY' })).toMatchObject(
          { value: 'dalle-key' },
        );
        expect(
          await stores().findOnePluginAuth({ userId, authField: 'API_KEY', pluginKey: 'dalle' }),
        ).toBeNull();
        expect(await stores().findOnePluginAuth({ userId, authField: 'MISSING' })).toBeNull();
      });
    });

    describe('findPluginAuthsByKeys', () => {
      it("returns the user's values of any listed plugin, and none for an empty list", async () => {
        await seed([
          [userId, 'web_search', 'API_KEY', 'a'],
          [userId, 'web_search', 'SECRET', 'b'],
          [userId, 'dalle', 'OPENAI_KEY', 'c'],
          [userId, 'other', 'X', 'd'],
          [otherUserId, 'dalle', 'OPENAI_KEY', 'e'],
        ]);
        const found = await stores().findPluginAuthsByKeys({
          userId,
          pluginKeys: ['web_search', 'dalle'],
        });
        expect(found.map((auth) => auth.value).sort()).toEqual(['a', 'b', 'c']);
        expect(await stores().findPluginAuthsByKeys({ userId, pluginKeys: [] })).toEqual([]);
      });
    });

    describe('deletePluginAuth', () => {
      it("deletes the user's value for the field", async () => {
        await seed([
          [userId, 'web_search', 'API_KEY', 'a'],
          [userId, 'web_search', 'SECRET', 'b'],
          [otherUserId, 'web_search', 'API_KEY', 'c'],
        ]);
        expect(await stores().deletePluginAuth({ userId, authField: 'API_KEY' })).toMatchObject({
          deletedCount: 1,
        });
        expect((await harness.readRaw('pluginauths')).map((record) => record.value).sort()).toEqual(
          ['b', 'c'],
        );
      });

      it('deletes one value for the field whichever plugin holds it', async () => {
        // NOTE(contract): without `all`, the delete matches the user and the field only and
        // ignores `pluginKey`, so when two plugins of the user share a field name (such as
        // `API_KEY`) one of the two values goes, not necessarily the named plugin's. Pinned as
        // today's behavior; the only caller passes `pluginKey` through unchanged.
        await seed([
          [userId, 'web_search', 'API_KEY', 'a'],
          [userId, 'dalle', 'API_KEY', 'b'],
        ]);
        expect(
          await stores().deletePluginAuth({ userId, authField: 'API_KEY', pluginKey: 'dalle' }),
        ).toMatchObject({ deletedCount: 1 });
        expect(await harness.readRaw('pluginauths')).toHaveLength(1);
      });

      it('deletes every value of the user with all, narrowed to the plugin when given', async () => {
        await seed([
          [userId, 'web_search', 'API_KEY', 'a'],
          [userId, 'web_search', 'SECRET', 'b'],
          [userId, 'dalle', 'OPENAI_KEY', 'c'],
          [otherUserId, 'web_search', 'API_KEY', 'd'],
        ]);
        expect(
          await stores().deletePluginAuth({ userId, pluginKey: 'web_search', all: true }),
        ).toMatchObject({ deletedCount: 2 });
        expect(await stores().deletePluginAuth({ userId, all: true })).toMatchObject({
          deletedCount: 1,
        });
        expect((await harness.readRaw('pluginauths')).map((record) => record.value)).toEqual(['d']);
      });

      it('throws without a field unless all is given, deleting nothing', async () => {
        await seed([[userId, 'web_search', 'API_KEY', 'a']]);
        await expect(stores().deletePluginAuth({ userId })).rejects.toThrow(
          'authField is required when all is false',
        );
        expect(await harness.readRaw('pluginauths')).toHaveLength(1);
      });
    });

    describe('deleteAllUserPluginAuths', () => {
      it('deletes every value of the user and keeps other users', async () => {
        await seed([
          [userId, 'web_search', 'API_KEY', 'a'],
          [userId, undefined, 'LEGACY', 'b'],
          [otherUserId, 'web_search', 'API_KEY', 'c'],
        ]);
        expect(await stores().deleteAllUserPluginAuths(userId)).toMatchObject({ deletedCount: 2 });
        expect((await harness.readRaw('pluginauths')).map((record) => record.value)).toEqual(['c']);
      });
    });
  });
}

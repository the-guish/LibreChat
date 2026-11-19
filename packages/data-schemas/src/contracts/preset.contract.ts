/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `PresetStore` contract (`~/ports/preset`), with the default handling of
 * `methods/preset.spec.ts`: ordered reads, the upserting save (renames, tool keys, the one
 * default), the deletes, and the `{ message }` results in place of thrown errors. `savePreset`
 * resolves a hydrated document with MongoDB; the cases read it through its fields only. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import type { ContractHarness } from './harness';
import type { PresetRecord } from '~/types/preset';
import { readRawWhere, useContractHarness } from './support';

export function describePresetContract(harness: ContractHarness): void {
  describe(`PresetStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const user = harness.ids.generate();
    const otherUser = harness.ids.generate();
    const preset = (presetId: string, overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      user,
      presetId,
      title: presetId,
      endpoint: 'openAI',
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      ...overrides,
    });
    const asList = (value: PresetRecord[] | { message: string }) => {
      if (!Array.isArray(value)) {
        throw new Error(`Expected presets, got ${JSON.stringify(value)}`);
      }
      return value;
    };
    const defaultsOf = async (owner: string) =>
      (await readRawWhere(harness, 'presets', { user: owner, defaultPreset: true }))
        .map((record) => record.presetId)
        .sort();

    describe('getPresets', () => {
      it("returns the user's presets by order (none last), then most recently updated", async () => {
        await harness.seedRaw('presets', [
          preset('old-unordered', { updatedAt: new Date('2024-01-01T00:00:00.000Z') }),
          preset('new-unordered', { updatedAt: new Date('2024-03-01T00:00:00.000Z') }),
          preset('second', { order: 2 }),
          preset('first', { order: 0 }),
          preset('foreign', { user: otherUser, order: 0 }),
        ]);
        const presets = asList(await harness.createStores().presets.getPresets(user));
        expect(presets.map((item) => item.presetId)).toEqual([
          'first',
          'second',
          'new-unordered',
          'old-unordered',
        ]);
      });

      it("narrows by the filter, still within the user's presets", async () => {
        await harness.seedRaw('presets', [
          preset('a', { endpoint: 'anthropic' }),
          preset('b'),
          preset('c', { endpoint: 'anthropic', user: otherUser }),
        ]);
        const presets = asList(
          await harness.createStores().presets.getPresets(user, { endpoint: 'anthropic' }),
        );
        expect(presets.map((item) => item.presetId)).toEqual(['a']);
      });

      it('cannot read another user through the filter', async () => {
        await harness.seedRaw('presets', [preset('foreign', { user: otherUser })]);
        expect(await harness.createStores().presets.getPresets(user, { user: otherUser })).toEqual(
          [],
        );
      });
    });

    describe('savePreset', () => {
      it('creates the preset with tools stored by plugin key', async () => {
        const saved = await harness.createStores().presets.savePreset(user, {
          presetId: 'p1',
          title: 'Preset',
          endpoint: 'gptPlugins',
          tools: [{ pluginKey: 'dalle' }, 'calculator', { name: 'no key' }, 3],
        });
        expect(saved).toMatchObject({ presetId: 'p1', title: 'Preset', user });
        const [stored] = await harness.readRaw('presets');
        expect(stored).toMatchObject({
          presetId: 'p1',
          user,
          title: 'Preset',
          tools: ['dalle', 'calculator'],
        });
      });

      it("ignores a user field in the preset and keeps the caller's", async () => {
        await harness.createStores().presets.savePreset(user, {
          presetId: 'p1',
          title: 'Preset',
          user: otherUser,
        });
        const [stored] = await harness.readRaw('presets');
        expect(stored.user).toBe(user);
      });

      it('replaces the fields of the existing preset, renaming it with newPresetId', async () => {
        const seeded = preset('p1', { title: 'Old', model: 'gpt-4' });
        await harness.seedRaw('presets', [seeded]);
        const saved = await harness.createStores().presets.savePreset(user, {
          presetId: 'p1',
          newPresetId: 'p2',
          title: 'New',
        });
        expect(saved).toMatchObject({ presetId: 'p2', title: 'New', model: 'gpt-4' });
        const records = await harness.readRaw('presets');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ _id: seeded._id, presetId: 'p2', title: 'New' });
      });

      it('demotes every other default of the same user, leaving other users untouched', async () => {
        await harness.seedRaw('presets', [
          preset('a', { defaultPreset: true, order: 0 }),
          preset('b', { defaultPreset: true, order: 0 }),
          preset('x', { user: otherUser, defaultPreset: true, order: 0 }),
        ]);
        const saved = await harness.createStores().presets.savePreset(user, {
          presetId: 'c',
          title: 'c',
          endpoint: 'openAI',
          defaultPreset: true,
        });
        expect(saved).toMatchObject({ presetId: 'c', defaultPreset: true, order: 0 });
        expect(await defaultsOf(user)).toEqual(['c']);
        expect(await defaultsOf(otherUser)).toEqual(['x']);
        const demoted = (await readRawWhere(harness, 'presets', { presetId: 'a' }))[0];
        expect(demoted).not.toHaveProperty('order');
        expect(demoted).not.toHaveProperty('defaultPreset');
      });

      it('keeps the default flag when re-saving the current default', async () => {
        const { presets } = harness.createStores();
        await presets.savePreset(user, { presetId: 'a', title: 'a', defaultPreset: true });
        await presets.savePreset(user, { presetId: 'a', title: 'renamed', defaultPreset: true });
        expect(await defaultsOf(user)).toEqual(['a']);
      });

      it('clears the default flag and its order with defaultPreset: false', async () => {
        await harness.seedRaw('presets', [preset('a', { defaultPreset: true, order: 0 })]);
        await harness
          .createStores()
          .presets.savePreset(user, { presetId: 'a', title: 'a', defaultPreset: false });
        const [stored] = await harness.readRaw('presets');
        expect(stored).not.toHaveProperty('defaultPreset');
        expect(stored).not.toHaveProperty('order');
      });

      it('cannot take over a presetId another user holds (presetIds are unique per tenant)', async () => {
        await harness.seedRaw('presets', [preset('shared', { user: otherUser, title: 'Theirs' })]);
        const result = await harness
          .createStores()
          .presets.savePreset(user, { presetId: 'shared', title: 'Mine' });
        expect(result).toEqual({ message: 'Error saving preset' });
        const records = await harness.readRaw('presets');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ user: otherUser, title: 'Theirs' });
      });

      it('resolves { message } instead of throwing when the write fails', async () => {
        const result = await harness.createStores().presets.savePreset(user, {
          presetId: 'p1',
          title: 'Preset',
          temperature: 'not a number',
        });
        expect(result).toEqual({ message: 'Error saving preset' });
        expect(await harness.readRaw('presets')).toEqual([]);
      });
    });

    describe('deletePresets', () => {
      it("deletes one preset by presetId, only the user's", async () => {
        await harness.seedRaw('presets', [
          preset('a'),
          preset('b'),
          preset('x', { user: otherUser }),
        ]);
        const { presets } = harness.createStores();
        expect((await presets.deletePresets(user, { presetId: 'x' })).deletedCount).toBe(0);
        const result = await presets.deletePresets(user, { presetId: 'a' });
        expect(result.deletedCount).toBe(1);
        const remaining = await harness.readRaw('presets');
        expect(remaining.map((record) => record.presetId).sort()).toEqual(['b', 'x']);
      });

      it('deletes every preset of the user without a filter', async () => {
        await harness.seedRaw('presets', [
          preset('a'),
          preset('b'),
          preset('c', { user: otherUser }),
        ]);
        const result = await harness.createStores().presets.deletePresets(user);
        expect(result.deletedCount).toBe(2);
        expect(await harness.readRaw('presets')).toHaveLength(1);
      });
    });
  });
}

/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `AssistantStore` contract (`~/ports/assistant`): criteria reads with projections, the
 * upserting update, the guarded avatar write (ported from `methods/assistant.avatar.spec.ts`),
 * the deletes and the index preparation. Nothing here may import `mongoose` or the MongoDB
 * driver.
 */
import type { ContractHarness } from './harness';
import type { AssistantQuery } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, readRawWhere, useContractHarness } from './support';

export function describeAssistantContract(harness: ContractHarness): void {
  describe(`AssistantStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const ownerId = harness.ids.generate();
    const otherId = harness.ids.generate();
    const originalAvatar = { filepath: '/images/original.png', source: 'local' };
    const avatar = { filepath: '/images/replacement.png', source: 'local' };
    const assistant = (overrides: Record<string, unknown> = {}) => ({
      _id: harness.ids.generate(),
      assistant_id: 'asst-1',
      user: ownerId,
      endpoint: 'openAI',
      avatar: originalAvatar,
      conversation_starters: [],
      ...overrides,
    });
    const stored = async (assistantId: string) =>
      (await readRawWhere(harness, 'assistants', { assistant_id: assistantId }))[0];

    describe('getAssistant', () => {
      it('returns the first assistant matching the criteria, or null', async () => {
        const seeded = assistant();
        await harness.seedRaw('assistants', [seeded, assistant({ assistant_id: 'asst-2' })]);
        const { assistants } = harness.createStores();
        const found = await assistants.getAssistant({ assistantId: 'asst-1', user: ownerId });
        expect(found).toMatchObject({ assistant_id: 'asst-1', endpoint: 'openAI' });
        expect(idOf(harness, found?._id)).toBe(seeded._id);
        expect(idOf(harness, found?.user)).toBe(ownerId);
        expect(await assistants.getAssistant({ assistantId: 'asst-1', user: otherId })).toBeNull();
      });

      it('matches the stored avatar path', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        const found = await harness
          .createStores()
          .assistants.getAssistant({ avatarFilepath: originalAvatar.filepath });
        expect(found).toMatchObject({ assistant_id: 'asst-1' });
      });

      it('selects the fields of an inclusion projection', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        const found = await harness
          .createStores()
          .assistants.getAssistant({ assistantId: 'asst-1' }, { endpoint: 1 });
        expect(found).toMatchObject({ endpoint: 'openAI' });
        expect(found).not.toHaveProperty('assistant_id');
        expect(found).not.toHaveProperty('avatar');
      });

      it('rejects an unrecognized criterion', async () => {
        await expect(
          harness
            .createStores()
            .assistants.getAssistant({ assistant_id: 'asst-1' } as unknown as AssistantQuery),
        ).rejects.toThrow("Unknown query criterion: 'assistant_id'");
      });
    });

    describe('getAssistants', () => {
      it('returns every assistant matching the criteria', async () => {
        await harness.seedRaw('assistants', [
          assistant({ assistant_id: 'asst-1' }),
          assistant({ assistant_id: 'asst-2' }),
          assistant({ assistant_id: 'asst-3', user: otherId }),
        ]);
        const { assistants } = harness.createStores();
        const mine = await assistants.getAssistants({ user: ownerId });
        expect(mine.map((item) => item.assistant_id).sort()).toEqual(['asst-1', 'asst-2']);
        const some = await assistants.getAssistants({ assistantId: ['asst-1', 'asst-3'] });
        expect(some.map((item) => item.assistant_id).sort()).toEqual(['asst-1', 'asst-3']);
      });

      it('selects the fields of a projection string or record', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        const { assistants } = harness.createStores();
        const [byString] = await assistants.getAssistants({ assistantId: 'asst-1' }, 'avatar');
        expect(byString).toMatchObject({ avatar: originalAvatar });
        expect(byString).not.toHaveProperty('endpoint');
        const [byRecord] = await assistants.getAssistants(
          { assistantId: 'asst-1' },
          { assistant_id: 1 },
        );
        expect(byRecord).toMatchObject({ assistant_id: 'asst-1' });
        expect(byRecord).not.toHaveProperty('avatar');
      });
    });

    describe('updateAssistantDoc', () => {
      it('sets the given fields, keeping the others', async () => {
        const seeded = assistant({ conversation_starters: ['hi'] });
        await harness.seedRaw('assistants', [seeded]);
        const updated = await harness
          .createStores()
          .assistants.updateAssistantDoc(
            { assistantId: 'asst-1', user: ownerId },
            { endpoint: 'azureOpenAI', append_current_datetime: true },
          );
        expect(idOf(harness, updated?._id)).toBe(seeded._id);
        expect(updated).toMatchObject({
          endpoint: 'azureOpenAI',
          append_current_datetime: true,
          conversation_starters: ['hi'],
          avatar: originalAvatar,
        });
        expect(await harness.readRaw('assistants')).toHaveLength(1);
      });

      it('creates the assistant from the criteria and the fields when none matches', async () => {
        const created = await harness
          .createStores()
          .assistants.updateAssistantDoc(
            { assistantId: 'asst-new', user: ownerId },
            { conversation_starters: ['a', 'b'] },
          );
        expect(created).toMatchObject({
          assistant_id: 'asst-new',
          conversation_starters: ['a', 'b'],
        });
        expect(idOf(harness, created?.user)).toBe(ownerId);
        const record = await stored('asst-new');
        expect(record).toMatchObject({ user: ownerId, conversation_starters: ['a', 'b'] });
      });
    });

    describe('updateAssistantAvatar', () => {
      it("updates the owner's avatar, keeping owner and endpoint, with the previous avatar", async () => {
        const seeded = assistant();
        await harness.seedRaw('assistants', [seeded, assistant({ assistant_id: 'other' })]);
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'asst-1', user: ownerId }, avatar);
        expect(result).toMatchObject({ assistant_id: 'asst-1', endpoint: 'openAI', avatar });
        expect(idOf(harness, result?._id)).toBe(seeded._id);
        expect(idOf(harness, result?.user)).toBe(ownerId);
        expect(result?.previousAvatar).toEqual(originalAvatar);
        const record = await stored('asst-1');
        expect(record).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
        expect(record).not.toHaveProperty('previousAvatar');
        expect(await stored('other')).toMatchObject({ avatar: originalAvatar });
      });

      it("cannot update another user's assistant or claim it", async () => {
        await harness.seedRaw('assistants', [assistant()]);
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'asst-1', user: otherId }, avatar);
        expect(result).toBeNull();
        expect(await stored('asst-1')).toMatchObject({ user: ownerId, avatar: originalAvatar });
      });

      it('allows a selector without a user, keeping owner and endpoint', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'asst-1' }, avatar);
        expect(result).toMatchObject({ endpoint: 'openAI', avatar });
        expect(await stored('asst-1')).toMatchObject({ user: ownerId, avatar });
      });

      it('resolves null for an unknown assistant without insert data, inserting nothing', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        expect(
          await harness
            .createStores()
            .assistants.updateAssistantAvatar({ assistantId: 'missing', user: ownerId }, avatar),
        ).toBeNull();
        expect(await harness.readRaw('assistants')).toHaveLength(1);
      });

      it('creates the reference from the insert data when there is none', async () => {
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'provider-only' }, avatar, {
            user: otherId,
            endpoint: 'assistants',
          });
        expect(result).toMatchObject({
          assistant_id: 'provider-only',
          endpoint: 'assistants',
          avatar,
        });
        expect(idOf(harness, result?.user)).toBe(otherId);
        expect(result).not.toHaveProperty('previousAvatar');
        expect(await stored('provider-only')).toMatchObject({ user: otherId, avatar });
      });

      it('converges concurrent initializations on one reference', async () => {
        const stores = [harness.createStores(), harness.createStores(), harness.createStores()];
        const results = await Promise.all(
          stores.map(({ assistants }) =>
            assistants.updateAssistantAvatar({ assistantId: 'raced' }, avatar, {
              user: ownerId,
              endpoint: 'assistants',
            }),
          ),
        );
        const records = await readRawWhere(harness, 'assistants', { assistant_id: 'raced' });
        expect(records).toHaveLength(1);
        for (const result of results) {
          expect(idOf(harness, result?._id)).toBe(records[0]._id);
        }
      });

      it('never applies insert-only identity to an existing assistant', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'asst-1' }, avatar, {
            user: otherId,
            endpoint: 'assistants',
          });
        expect(result).toMatchObject({ endpoint: 'openAI', avatar });
        expect(idOf(harness, result?.user)).toBe(ownerId);
        expect(await harness.readRaw('assistants')).toHaveLength(1);
      });

      it('fills a missing owner and endpoint from the insert data', async () => {
        await harness.seedRaw('assistants', [
          { _id: harness.ids.generate(), assistant_id: 'incomplete', avatar: originalAvatar },
        ]);
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'incomplete' }, avatar, {
            user: ownerId,
            endpoint: 'assistants',
          });
        expect(result).toMatchObject({ endpoint: 'assistants', avatar });
        expect(result?.previousAvatar).toEqual(originalAvatar);
        expect(await stored('incomplete')).toMatchObject({
          user: ownerId,
          endpoint: 'assistants',
          avatar,
        });
      });

      it('refuses an owner-scoped insertion over an assistant someone else owns', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        await expect(
          harness
            .createStores()
            .assistants.updateAssistantAvatar({ assistantId: 'asst-1', user: otherId }, avatar, {
              user: otherId,
              endpoint: 'assistants',
            }),
        ).rejects.toThrow('Assistant ownership changed');
        expect(await stored('asst-1')).toMatchObject({ user: ownerId, avatar: originalAvatar });
      });

      it('keeps an ownerless reference for an owner-scoped request without insert data', async () => {
        await harness.seedRaw('assistants', [
          {
            _id: harness.ids.generate(),
            assistant_id: 'ownerless',
            endpoint: 'openAI',
            avatar: originalAvatar,
          },
        ]);
        expect(
          await harness
            .createStores()
            .assistants.updateAssistantAvatar({ assistantId: 'ownerless', user: ownerId }, avatar),
        ).toBeNull();
        const record = await stored('ownerless');
        expect(record).not.toHaveProperty('user');
        expect(record).toMatchObject({ avatar: originalAvatar });
      });

      it('updates an incomplete reference without claiming identity when insert data is omitted', async () => {
        await harness.seedRaw('assistants', [
          { _id: harness.ids.generate(), assistant_id: 'incomplete', avatar: originalAvatar },
        ]);
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'incomplete' }, avatar);
        expect(result).toMatchObject({ avatar, previousAvatar: originalAvatar });
        expect(result?.user).toBeUndefined();
        expect(result?.endpoint).toBeUndefined();
      });

      it('returns the record without a previous avatar when the avatar already matches', async () => {
        await harness.seedRaw('assistants', [assistant({ avatar })]);
        const result = await harness
          .createStores()
          .assistants.updateAssistantAvatar({ assistantId: 'asst-1' }, avatar);
        expect(result).toMatchObject({ avatar });
        expect(result).not.toHaveProperty('previousAvatar');
      });

      it.each([
        [{}, 'assistantId must be a nonempty string'],
        [{ assistantId: ' ' }, 'assistantId must be a nonempty string'],
        [{ assistantId: { $ne: null } }, 'assistantId must be a nonempty string'],
        [{ assistantId: 'asst-1', user: '' }, 'user must be a nonempty string'],
        [{ assistantId: 'asst-1', user: { $ne: null } }, 'user must be a nonempty string'],
      ])('rejects the malformed selector %p with a TypeError', async (query, message) => {
        await harness.seedRaw('assistants', [assistant()]);
        const failure = harness
          .createStores()
          .assistants.updateAssistantAvatar(
            query as unknown as { assistantId: string; user?: string },
            avatar,
          );
        await expect(failure).rejects.toThrow(TypeError);
        await expect(failure).rejects.toThrow(message);
        expect(await stored('asst-1')).toMatchObject({ avatar: originalAvatar });
      });

      it('rejects insert data that disagrees with the owner scope', async () => {
        await expect(
          harness
            .createStores()
            .assistants.updateAssistantAvatar({ assistantId: 'new', user: ownerId }, avatar, {
              user: otherId,
              endpoint: 'assistants',
            }),
        ).rejects.toThrow('Avatar insert data must identify');
        expect(await harness.readRaw('assistants')).toEqual([]);
      });

      it("cannot update another tenant's assistant", async () => {
        await harness.seedRaw('assistants', [assistant({ tenantId: 'tenant-b' })]);
        const result = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          harness
            .createStores()
            .assistants.updateAssistantAvatar({ assistantId: 'asst-1' }, avatar),
        );
        expect(result).toBeNull();
        expect(await stored('asst-1')).toMatchObject({
          tenantId: 'tenant-b',
          avatar: originalAvatar,
        });
      });
    });

    describe('deleteAssistant', () => {
      it('deletes the first matching assistant and resolves to it', async () => {
        const seeded = assistant();
        await harness.seedRaw('assistants', [seeded, assistant({ assistant_id: 'asst-2' })]);
        const deleted = await harness
          .createStores()
          .assistants.deleteAssistant({ assistantId: 'asst-1', user: ownerId });
        expect(deleted).toMatchObject({ assistant_id: 'asst-1', endpoint: 'openAI' });
        expect(idOf(harness, deleted?._id)).toBe(seeded._id);
        expect((await harness.readRaw('assistants')).map((record) => record.assistant_id)).toEqual([
          'asst-2',
        ]);
      });

      it('resolves null when nothing matches', async () => {
        expect(
          await harness.createStores().assistants.deleteAssistant({ assistantId: 'none' }),
        ).toBeNull();
      });
    });

    describe('deleteAssistants', () => {
      it('deletes every matching assistant and counts them', async () => {
        await harness.seedRaw('assistants', [
          assistant({ assistant_id: 'asst-1' }),
          assistant({ assistant_id: 'asst-2' }),
          assistant({ assistant_id: 'asst-3', user: otherId }),
        ]);
        expect(await harness.createStores().assistants.deleteAssistants({ user: ownerId })).toBe(2);
        expect((await harness.readRaw('assistants')).map((record) => record.assistant_id)).toEqual([
          'asst-3',
        ]);
      });

      it('fails closed on an unrecognized criterion', async () => {
        await harness.seedRaw('assistants', [assistant()]);
        await expect(
          harness
            .createStores()
            .assistants.deleteAssistants({ owner: ownerId } as unknown as AssistantQuery),
        ).rejects.toThrow("Unknown query criterion: 'owner'");
        expect(await harness.readRaw('assistants')).toHaveLength(1);
      });
    });

    describe('ensureAssistantIndexes', () => {
      it('resolves, and resolves again on a later call', async () => {
        const { assistants } = harness.createStores();
        await expect(assistants.ensureAssistantIndexes()).resolves.toBeUndefined();
        await expect(assistants.ensureAssistantIndexes()).resolves.toBeUndefined();
      });
    });
  });
}

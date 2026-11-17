/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `PromptLibraryStore` contract (`~/ports/promptLibrary`), ported from `methods/prompt.spec.ts`,
 * `methods/prompt.getPromptGroup.spec.ts` and `methods/prompt.accessContext.spec.ts`: prompt
 * groups with their production prompt (created, reused while unfinished, joined on reads, moved
 * on deletes and promotions), the filtered, sorted and paged listings (the system categories, the
 * escaped name search, the keyset cursor over use count, update time and id), the revisions, the
 * deletes that take their permissions with them, the account wipe (sole-owned and legacy groups),
 * the Langfuse mirrors (source identity, duplicate key, tenant buckets), the per-user access sets
 * with their tenant-generation cache, and tenant scoping. Cases that spy on the driver (a failing
 * query, the `groupId_1_version_1` index repair, query plans) or on mongoose validation of
 * documents built by hand stay in the method specs. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import {
  ResourceType,
  PrincipalType,
  PermissionBits,
  SystemCategories,
} from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import type { CacheStore } from '~/types';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, readRawWhere, timeOf, useContractHarness } from './support';

type Row = Record<string, unknown>;

/** An in-memory `CacheStore` whose generation-marker writes and deletes can be made to fail. */
function createCache() {
  const entries = new Map<string, unknown>();
  const failures = { markerWrites: false, markerDeletes: false };
  const isMarker = (key: string) => key.includes('access:generation');
  const store: CacheStore = {
    get: async (key) => entries.get(key),
    set: async (key, value) => {
      if (failures.markerWrites && isMarker(key)) {
        return false;
      }
      entries.set(key, value);
      return true;
    },
    delete: async (key) => {
      if (failures.markerDeletes && isMarker(key)) {
        return false;
      }
      return entries.delete(key);
    },
  };
  return { store, entries, failures };
}

export function describePromptContract(harness: ContractHarness): void {
  describe(`PromptLibraryStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const authorId = harness.ids.generate();
    const otherAuthorId = harness.ids.generate();
    const prompts = () => harness.createStores().prompts;
    const inTenant = <T>(tenantId: string, run: () => Promise<T>): Promise<T> =>
      tenantStorage.run({ tenantId }, run);
    const ids = (rows: Row[]) => rows.map((row) => idOf(harness, row._id));
    const idStrings = (values: unknown[]) => values.map((value) => idOf(harness, value));
    const groupRaw = (id: string) =>
      harness.readRaw('promptgroups').then((rows) => rows.find((row) => row._id === id));

    /** A native group created through the store, with its first revision. */
    const createGroup = async (
      name: string,
      options: { category?: string; author?: string; text?: string } = {},
    ) => {
      const { prompt, group } = await prompts().createPromptGroup({
        prompt: { prompt: options.text ?? `${name} text`, type: 'text' },
        group: { name, category: options.category ?? '' },
        author: options.author ?? authorId,
        authorName: 'Prompt Author',
      });
      return { groupId: idOf(harness, group._id), promptId: idOf(harness, prompt?._id) };
    };

    /** A raw prompt group record (no defaults applied), with the fields listings read. */
    const rawGroup = (overrides: RawRecord = {}): RawRecord & { _id: string } => ({
      _id: harness.ids.generate(),
      name: 'Raw group',
      numberOfGenerations: 0,
      oneliner: '',
      category: '',
      author: authorId,
      authorName: 'Prompt Author',
      source: 'native',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    });
    const rawPrompt = (
      groupId: string,
      overrides: RawRecord = {},
    ): RawRecord & { _id: string } => ({
      _id: harness.ids.generate(),
      groupId,
      author: authorId,
      prompt: 'raw prompt',
      type: 'text',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    });
    /** Grants `bits` on the group to the user (or to everyone, for a `null` user). */
    const grant = (userId: string | null, groupId: string, bits: number) =>
      harness
        .createStores()
        .aclEntries.grantPermission(
          userId ? PrincipalType.USER : PrincipalType.PUBLIC,
          userId ? harness.ids.toStoreId(userId) : null,
          ResourceType.PROMPTGROUP,
          groupId,
          bits,
        );
    const OWNER_BITS =
      PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;
    const aclOf = (groupId: string) => readRawWhere(harness, 'aclentries', { resourceId: groupId });

    describe('createPromptGroup', () => {
      it('creates a native group whose first revision is its production prompt', async () => {
        const { prompt, group } = await prompts().createPromptGroup({
          prompt: { prompt: 'Hello {{name}}', type: 'text' },
          group: { name: 'Greeting', category: 'writing', oneliner: 'Says hello' },
          author: authorId,
          authorName: 'Prompt Author',
        });
        expect(prompt).toMatchObject({ prompt: 'Hello {{name}}', type: 'text' });
        expect(idOf(harness, prompt?.groupId)).toBe(idOf(harness, group._id));
        expect(idOf(harness, prompt?.author)).toBe(authorId);
        expect(group).toMatchObject({
          name: 'Greeting',
          category: 'writing',
          oneliner: 'Says hello',
          authorName: 'Prompt Author',
          source: 'native',
          numberOfGenerations: 0,
          productionPrompt: { prompt: 'Hello {{name}}' },
        });
        expect(idOf(harness, group.productionId)).toBe(idOf(harness, prompt?._id));
        expect(group).not.toHaveProperty('__v');

        const [stored] = await harness.readRaw('promptgroups');
        expect(stored).toMatchObject({
          name: 'Greeting',
          author: authorId,
          productionId: idOf(harness, prompt?._id),
        });
        expect(stored.createdAt).toBeInstanceOf(Date);
        const storedPrompts = await harness.readRaw('prompts');
        expect(storedPrompts).toHaveLength(1);
        expect(storedPrompts[0]).toMatchObject({ groupId: stored._id, author: authorId });
      });

      it.each([
        ['missing', {}],
        ['null', { source: null }],
        ['native', { source: 'native' }],
      ])(
        'reuses an unfinished group (no production prompt) with a %s source',
        async (_label, source) => {
          const unfinished = {
            _id: harness.ids.generate(),
            name: 'Unfinished',
            category: '',
            author: authorId,
            authorName: 'Prompt Author',
            productionId: null,
            ...source,
          };
          await harness.seedRaw('promptgroups', [unfinished]);
          const { groupId, promptId } = await createGroup('Unfinished');
          expect(groupId).toBe(unfinished._id);
          expect((await harness.readRaw('promptgroups')).length).toBe(1);
          expect((await groupRaw(groupId))?.productionId).toBe(promptId);
        },
      );

      it('creates a new native group rather than reusing a mirrored group of the same name', async () => {
        const mirrored = rawGroup({
          name: 'Shared Name',
          source: 'langfuse',
          sourcePromptName: 'shared-name',
          sourceProjectId: 'project-1',
          sourceDestination: 'eu',
        });
        await harness.seedRaw('promptgroups', [mirrored]);
        const { groupId } = await createGroup('Shared Name');
        expect(groupId).not.toBe(mirrored._id);
        expect((await groupRaw(mirrored._id as string))?.productionId).toBeUndefined();
        expect((await groupRaw(groupId))?.source).toBe('native');
      });

      it('does not attach a native prompt to a group of an unknown source', async () => {
        const external = rawGroup({ name: 'External', source: 'external-catalog' });
        delete external.productionId;
        await harness.seedRaw('promptgroups', [external]);
        const { groupId } = await createGroup('External');
        expect(groupId).not.toBe(external._id);
        expect(await harness.readRaw('promptgroups')).toHaveLength(2);
      });

      it('creates a second group for a name whose group is finished', async () => {
        const first = await createGroup('Same Name');
        const second = await createGroup('Same Name');
        expect(second.groupId).not.toBe(first.groupId);
        expect(await harness.readRaw('promptgroups')).toHaveLength(2);
      });

      it('stamps the active tenant on the group and its prompt', async () => {
        const { groupId } = await inTenant('tenant-a', () => createGroup('Tenant Group'));
        expect((await groupRaw(groupId))?.tenantId).toBe('tenant-a');
        expect((await harness.readRaw('prompts'))[0].tenantId).toBe('tenant-a');
      });
    });

    describe('savePrompt', () => {
      it('stores a revision of the group by the author, as a plain record', async () => {
        const { groupId } = await createGroup('Revisions');
        const { prompt } = await prompts().savePrompt({
          prompt: { prompt: 'second revision', type: 'chat', groupId },
          author: harness.ids.toStoreId(otherAuthorId),
        });
        expect(prompt).toMatchObject({ prompt: 'second revision', type: 'chat' });
        expect(idOf(harness, prompt.groupId)).toBe(groupId);
        expect(idOf(harness, prompt.author)).toBe(otherAuthorId);
        expect(prompt.createdAt).toBeInstanceOf(Date);
        expect(typeof (prompt as { save?: unknown }).save).toBe('undefined');
        const stored = await readRawWhere(harness, 'prompts', { groupId });
        expect(stored.map((row) => row.prompt).sort()).toEqual([
          'Revisions text',
          'second revision',
        ]);
      });

      it('rejects a revision missing a required field', async () => {
        const { groupId } = await createGroup('Invalid revision');
        await expect(
          prompts().savePrompt({ prompt: { prompt: 'no type', groupId }, author: authorId }),
        ).rejects.toThrow();
        expect(await readRawWhere(harness, 'prompts', { groupId })).toHaveLength(1);
      });
    });

    describe('getPrompts', () => {
      it('reads the prompts of the group, newest first', async () => {
        const groupId = harness.ids.generate();
        const otherGroupId = harness.ids.generate();
        const oldest = rawPrompt(groupId, { createdAt: new Date('2026-01-01T00:00:00Z') });
        const newest = rawPrompt(groupId, { createdAt: new Date('2026-03-01T00:00:00Z') });
        const middle = rawPrompt(groupId, { createdAt: new Date('2026-02-01T00:00:00Z') });
        await harness.seedRaw('prompts', [oldest, newest, middle, rawPrompt(otherGroupId)]);
        const rows = await prompts().getPrompts({ groupId });
        expect(ids(rows)).toEqual([newest._id, middle._id, oldest._id]);
        expect(idOf(harness, rows[0].groupId)).toBe(groupId);
      });

      it('reads nothing for a group without prompts', async () => {
        expect(await prompts().getPrompts({ groupId: harness.ids.generate() })).toEqual([]);
      });
    });

    describe('getPrompt', () => {
      it('reads the prompt by id, or null', async () => {
        const groupId = harness.ids.generate();
        const prompt = rawPrompt(groupId, { prompt: 'by id' });
        await harness.seedRaw('prompts', [prompt]);
        const row = await prompts().getPrompt({ _id: prompt._id });
        expect(row).toMatchObject({ prompt: 'by id', type: 'text' });
        expect(idOf(harness, row?._id)).toBe(prompt._id);
        expect(await prompts().getPrompt({ _id: harness.ids.generate() })).toBeNull();
      });

      it('matches a groupId condition given as a string id', async () => {
        const groupId = harness.ids.generate();
        const prompt = rawPrompt(groupId);
        await harness.seedRaw('prompts', [prompt]);
        const row = await prompts().getPrompt({ _id: prompt._id, groupId });
        expect(idOf(harness, row?._id)).toBe(prompt._id);
        expect(
          await prompts().getPrompt({ _id: prompt._id, groupId: harness.ids.generate() }),
        ).toBeNull();
      });
    });

    describe('getPromptGroup', () => {
      it('reads the group with its production prompt joined and its author as a string', async () => {
        const { groupId, promptId } = await createGroup('Joined', { text: 'production text' });
        const group = await prompts().getPromptGroup({ _id: groupId });
        expect(group).toMatchObject({ name: 'Joined', author: authorId });
        expect(typeof group?.author).toBe('string');
        const production = group?.productionPrompt as Row;
        expect(production).toMatchObject({ prompt: 'production text', type: 'text' });
        expect(idOf(harness, production._id)).toBe(promptId);
        expect(idOf(harness, production.groupId)).toBe(groupId);
      });

      it('reads null for an unknown group', async () => {
        expect(await prompts().getPromptGroup({ _id: harness.ids.generate() })).toBeNull();
      });

      it('leaves productionPrompt out when the production prompt is missing', async () => {
        const group = rawGroup({ name: 'Dangling', productionId: harness.ids.generate() });
        await harness.seedRaw('promptgroups', [group]);
        const read = await prompts().getPromptGroup({ _id: group._id });
        expect(read?.name).toBe('Dangling');
        expect(read?.productionPrompt).toBeUndefined();
      });

      it("hides the production prompt of another tenant, but not the tenant's own", async () => {
        const ownPrompt = rawPrompt(harness.ids.generate(), { tenantId: 'tenant-a' });
        const foreignPrompt = rawPrompt(harness.ids.generate(), { tenantId: 'tenant-b' });
        const own = rawGroup({ name: 'Own', tenantId: 'tenant-a', productionId: ownPrompt._id });
        const crossed = rawGroup({
          name: 'Crossed',
          tenantId: 'tenant-a',
          productionId: foreignPrompt._id,
        });
        await harness.seedRaw('prompts', [ownPrompt, foreignPrompt]);
        await harness.seedRaw('promptgroups', [own, crossed]);
        await inTenant('tenant-a', async () => {
          const ownRead = await prompts().getPromptGroup({ _id: own._id });
          expect(idOf(harness, (ownRead?.productionPrompt as Row)._id)).toBe(ownPrompt._id);
          const crossedRead = await prompts().getPromptGroup({ _id: crossed._id });
          expect(crossedRead?.name).toBe('Crossed');
          expect(crossedRead?.productionPrompt).toBeNull();
        });
        await inTenant('tenant-b', async () => {
          expect(await prompts().getPromptGroup({ _id: own._id })).toBeNull();
        });
      });

      it('joins the production prompt with no tenant context', async () => {
        const prompt = rawPrompt(harness.ids.generate(), { tenantId: 'tenant-b' });
        const group = rawGroup({ tenantId: 'tenant-a', productionId: prompt._id });
        await harness.seedRaw('prompts', [prompt]);
        await harness.seedRaw('promptgroups', [group]);
        const read = await prompts().getPromptGroup({ _id: group._id });
        expect(idOf(harness, (read?.productionPrompt as Row)._id)).toBe(prompt._id);
      });
    });

    describe('updatePromptGroup', () => {
      it('sets the given fields and resolves to the updated group', async () => {
        const { groupId } = await createGroup('Before', { category: 'old' });
        const updated = await prompts().updatePromptGroup(
          { _id: groupId },
          { name: 'After', category: 'new', oneliner: 'one line', command: 'after-cmd' },
        );
        expect(updated).toMatchObject({
          name: 'After',
          category: 'new',
          oneliner: 'one line',
          command: 'after-cmd',
        });
        expect(idOf(harness, (updated as unknown as Row)._id)).toBe(groupId);
        expect(await groupRaw(groupId)).toMatchObject({ name: 'After', command: 'after-cmd' });
      });

      it('throws when no group matches', async () => {
        await expect(
          prompts().updatePromptGroup({ _id: harness.ids.generate() }, { name: 'Missing' }),
        ).rejects.toThrow('Prompt group not found');
        expect(await harness.readRaw('promptgroups')).toEqual([]);
      });

      it('writes the fields without the schema validators', async () => {
        // NOTE(contract): `updatePromptGroup` writes without update validators, so a `command`
        // the schema's validator refuses on create is stored. Pinned as today's behavior; the
        // prompt service validates updates before they reach the store.
        const { groupId } = await createGroup('Command');
        const updated = await prompts().updatePromptGroup(
          { _id: groupId },
          { command: 'Not Valid!' },
        );
        expect(updated.command).toBe('Not Valid!');
        expect((await groupRaw(groupId))?.command).toBe('Not Valid!');
      });
    });

    describe('getAllPromptGroups', () => {
      it('lists the matching groups most used first, then most recently updated, then by id', async () => {
        const [first, second, third, fourth] = [0, 1, 2, 3]
          .map(() => harness.ids.generate())
          .sort();
        await harness.seedRaw('promptgroups', [
          rawGroup({ _id: fourth, name: 'Four', numberOfGenerations: 1 }),
          rawGroup({
            _id: third,
            name: 'Three',
            numberOfGenerations: 1,
            updatedAt: new Date('2026-02-01T00:00:00Z'),
          }),
          rawGroup({ _id: second, name: 'Two', numberOfGenerations: 5 }),
          rawGroup({ _id: first, name: 'One', numberOfGenerations: 1 }),
        ]);
        const rows = await prompts().getAllPromptGroups({});
        expect(Array.isArray(rows)).toBe(true);
        expect(ids(rows as Row[])).toEqual([second, third, first, fourth]);
      });

      it('matches a case-insensitive name substring with special characters taken literally', async () => {
        await harness.seedRaw('promptgroups', [
          rawGroup({ name: 'Alpha (v1) prompt' }),
          rawGroup({ name: 'alpha v1' }),
          rawGroup({ name: 'Beta' }),
        ]);
        const rows = (await prompts().getAllPromptGroups({ name: 'ALPHA (V1' })) as Row[];
        expect(rows.map((row) => row.name)).toEqual(['Alpha (v1) prompt']);
      });

      it('reads the system categories as every category, and no-category as the empty one', async () => {
        await harness.seedRaw('promptgroups', [
          rawGroup({ name: 'Writing', category: 'writing' }),
          rawGroup({ name: 'Uncategorized', category: '' }),
        ]);
        const names = async (category?: string) =>
          ((await prompts().getAllPromptGroups({ category })) as Row[])
            .map((row) => row.name)
            .sort();
        expect(await names(undefined)).toEqual(['Uncategorized', 'Writing']);
        expect(await names(SystemCategories.MY_PROMPTS)).toEqual(['Uncategorized', 'Writing']);
        expect(await names(SystemCategories.SHARED_PROMPTS)).toEqual(['Uncategorized', 'Writing']);
        expect(await names(SystemCategories.NO_CATEGORY)).toEqual(['Uncategorized']);
        expect(await names('writing')).toEqual(['Writing']);
      });

      it('applies other filter fields, such as the author', async () => {
        await harness.seedRaw('promptgroups', [
          rawGroup({ name: 'Mine' }),
          rawGroup({ name: 'Theirs', author: otherAuthorId }),
        ]);
        const rows = (await prompts().getAllPromptGroups({ author: authorId })) as Row[];
        expect(rows.map((row) => row.name)).toEqual(['Mine']);
      });

      it('attaches each production prompt text and projects the listing fields', async () => {
        const { groupId, promptId } = await createGroup('Listed', { text: 'listed text' });
        const mirrored = rawGroup({
          name: 'Mirrored',
          source: 'langfuse',
          sourcePromptName: 'mirrored',
          sourceProjectId: 'project-1',
          sourceDestination: 'eu',
          command: 'mirror-cmd',
          tenantId: undefined,
        });
        await harness.seedRaw('promptgroups', [mirrored]);
        const rows = (await prompts().getAllPromptGroups({})) as Row[];
        const listed = rows.find((row) => idOf(harness, row._id) === groupId) as Row;
        expect(idOf(harness, (listed.productionPrompt as Row)._id)).toBe(promptId);
        expect((listed.productionPrompt as Row).prompt).toBe('listed text');
        expect(Object.keys(listed.productionPrompt as Row).sort()).toEqual(['_id', 'prompt']);
        expect(listed).not.toHaveProperty('__v');
        expect(listed).not.toHaveProperty('tenantId');
        const mirror = rows.find((row) => row.name === 'Mirrored') as Row;
        expect(mirror).toMatchObject({
          source: 'langfuse',
          sourcePromptName: 'mirrored',
          sourceProjectId: 'project-1',
          sourceDestination: 'eu',
          command: 'mirror-cmd',
          productionPrompt: null,
        });
      });

      it('resolves a message instead of throwing when the read fails', async () => {
        expect(await prompts().getAllPromptGroups({ _id: 'not-an-id' })).toEqual({
          message: 'Error getting all prompt groups',
        });
      });
    });

    describe('getPromptGroups', () => {
      it('pages the matching groups, reporting the page, page size and page count as strings', async () => {
        await harness.seedRaw(
          'promptgroups',
          [5, 4, 3, 2, 1].map((uses) =>
            rawGroup({ name: `Paged ${uses}`, numberOfGenerations: uses }),
          ),
        );
        const page = await prompts().getPromptGroups({ pageNumber: '2', pageSize: 2 });
        expect(page).toMatchObject({ pageNumber: '2', pageSize: '2', pages: '3' });
        const { promptGroups } = page as { promptGroups: Row[] };
        expect(promptGroups.map((row) => row.name)).toEqual(['Paged 3', 'Paged 2']);
      });

      it('defaults to the first page of ten, and clamps pages below one', async () => {
        await harness.seedRaw(
          'promptgroups',
          Array.from({ length: 12 }, (_, index) => rawGroup({ name: `Group ${index}` })),
        );
        const page = await prompts().getPromptGroups({});
        expect(page).toMatchObject({ pageNumber: '1', pageSize: '10', pages: '2' });
        expect((page as { promptGroups: Row[] }).promptGroups).toHaveLength(10);
        expect(await prompts().getPromptGroups({ pageNumber: 0, pageSize: 0 })).toMatchObject({
          pageNumber: '1',
          pageSize: '1',
          pages: '12',
        });
      });

      it('filters by name and category, with the production prompt and command projected', async () => {
        const { groupId } = await createGroup('Command Projection', { category: 'tools' });
        await prompts().updatePromptGroup({ _id: groupId }, { command: 'mytest-cmd' });
        await harness.seedRaw('promptgroups', [rawGroup({ name: 'Other', category: 'tools' })]);
        const page = await prompts().getPromptGroups({
          name: 'command projection',
          category: 'tools',
        });
        const { promptGroups } = page as { promptGroups: Row[] };
        expect(promptGroups).toHaveLength(1);
        expect(promptGroups[0]).toMatchObject({
          command: 'mytest-cmd',
          productionPrompt: { prompt: 'Command Projection text' },
        });
        expect((page as { pages: string }).pages).toBe('1');
      });

      it('resolves a message instead of throwing when the read fails', async () => {
        expect(await prompts().getPromptGroups({ _id: 'not-an-id' })).toEqual({
          message: 'Error getting prompt groups',
        });
      });
    });

    describe('getListPromptGroupsByAccess', () => {
      it('lists only the accessible groups, all of them without a limit', async () => {
        const first = await createGroup('Accessible One');
        const second = await createGroup('Accessible Two');
        await createGroup('Hidden');
        const result = await prompts().getListPromptGroupsByAccess({
          accessibleIds: [first.groupId, harness.ids.toStoreId(second.groupId)],
        });
        expect(result.object).toBe('list');
        expect(ids(result.data).sort()).toEqual([first.groupId, second.groupId].sort());
        expect(result).toMatchObject({ has_more: false, after: null });
        expect(result.first_id).toBe(idOf(harness, result.data[0]._id));
        expect(result.last_id).toBe(idOf(harness, result.data[1]._id));
        expect(typeof result.first_id).toBe('string');
        expect(result.data[0].author).toBe(authorId);
        expect(typeof result.data[0].author).toBe('string');
        expect(result.data[0].productionPrompt).toMatchObject({ prompt: expect.any(String) });
      });

      it('lists nothing (null first and last ids) for no accessible ids', async () => {
        await createGroup('Hidden');
        expect(await prompts().getListPromptGroupsByAccess({})).toEqual({
          object: 'list',
          data: [],
          first_id: null,
          last_id: null,
          has_more: false,
          after: null,
        });
      });

      it('filters by a literal name substring and by category (the empty one included)', async () => {
        const alpha = await createGroup('Listing Alpha (v1)', { category: 'writing' });
        const beta = await createGroup('Listing Beta');
        const accessibleIds = [alpha.groupId, beta.groupId];
        const list = (params: { name?: string; category?: string }) =>
          prompts()
            .getListPromptGroupsByAccess({ accessibleIds, ...params })
            .then((result) => ids(result.data));
        expect(await list({ name: 'alpha (v1' })).toEqual([alpha.groupId]);
        expect(await list({ category: '' })).toEqual([beta.groupId]);
        expect(await list({ category: 'writing' })).toEqual([alpha.groupId]);
        expect((await list({})).sort()).toEqual(accessibleIds.sort());
      });

      it('pages by cursor over use count, update time and id, ties included', async () => {
        const groupIds = Array.from({ length: 5 }, () => harness.ids.generate()).sort();
        const tied = new Date('2026-02-01T00:00:00Z');
        await harness.seedRaw('promptgroups', [
          rawGroup({ _id: groupIds[4], name: 'Most used', numberOfGenerations: 9 }),
          rawGroup({ _id: groupIds[3], name: 'Tie A', numberOfGenerations: 2, updatedAt: tied }),
          rawGroup({ _id: groupIds[1], name: 'Tie B', numberOfGenerations: 2, updatedAt: tied }),
          rawGroup({ _id: groupIds[2], name: 'Tie C', numberOfGenerations: 2, updatedAt: tied }),
          rawGroup({ _id: groupIds[0], name: 'Older', numberOfGenerations: 2 }),
        ]);
        const pages: string[][] = [];
        let after: string | null = null;
        do {
          const page: Awaited<
            ReturnType<ReturnType<typeof prompts>['getListPromptGroupsByAccess']>
          > = await prompts().getListPromptGroupsByAccess({
            accessibleIds: groupIds,
            limit: 2,
            after,
          });
          pages.push(ids(page.data));
          expect(page.has_more).toBe(page.after !== null);
          after = page.after;
        } while (after);
        expect(pages).toEqual([
          [groupIds[4], groupIds[1]],
          [groupIds[2], groupIds[3]],
          [groupIds[0]],
        ]);
      });

      it('clamps the limit to 1..100 and reads an unparsable one as 20', async () => {
        const groupIds = Array.from({ length: 101 }, () => harness.ids.generate());
        await harness.seedRaw(
          'promptgroups',
          groupIds.map((_id, index) => rawGroup({ _id, name: `Clamp ${index}` })),
        );
        const sizeOf = async (limit: number | string) => {
          const page = await prompts().getListPromptGroupsByAccess({
            accessibleIds: groupIds,
            limit,
          });
          return { size: page.data.length, has_more: page.has_more };
        };
        expect(await sizeOf(500)).toEqual({ size: 100, has_more: true });
        expect(await sizeOf(-3)).toEqual({ size: 1, has_more: true });
        expect(await sizeOf('abc')).toEqual({ size: 20, has_more: true });
        expect(await sizeOf('3')).toEqual({ size: 3, has_more: true });
      });

      it('ignores a malformed or legacy cursor and reads the first page', async () => {
        const one = await createGroup('Cursor One');
        const two = await createGroup('Cursor Two');
        const accessibleIds = [one.groupId, two.groupId];
        const firstPage = ids(
          (await prompts().getListPromptGroupsByAccess({ accessibleIds, limit: 1 })).data,
        );
        for (const after of [
          'not-base64-json',
          Buffer.from(JSON.stringify({ updatedAt: 'nope', _id: one.groupId })).toString('base64'),
          'undefined',
          'null',
        ]) {
          const page = await prompts().getListPromptGroupsByAccess({
            accessibleIds,
            limit: 1,
            after,
          });
          expect(ids(page.data)).toEqual(firstPage);
        }
      });
    });

    describe('incrementPromptGroupUsage', () => {
      it('adds one to the use count and resolves to it', async () => {
        const { groupId } = await createGroup('Used');
        expect(await prompts().incrementPromptGroupUsage(groupId)).toEqual({
          numberOfGenerations: 1,
        });
        expect(await prompts().incrementPromptGroupUsage(groupId)).toEqual({
          numberOfGenerations: 2,
        });
        expect((await groupRaw(groupId))?.numberOfGenerations).toBe(2);
      });

      it('throws for a malformed id and for an unknown group', async () => {
        await expect(prompts().incrementPromptGroupUsage('not-an-id')).rejects.toThrow(
          'Invalid groupId',
        );
        await expect(prompts().incrementPromptGroupUsage(harness.ids.generate())).rejects.toThrow(
          'Prompt group not found',
        );
      });
    });

    describe('deletePromptGroup', () => {
      it('deletes the group, its prompts and its permissions, leaving other groups intact', async () => {
        const doomed = await createGroup('Doomed');
        const kept = await createGroup('Kept');
        await prompts().savePrompt({
          prompt: { prompt: 'second', type: 'text', groupId: doomed.groupId },
          author: authorId,
        });
        await grant(authorId, doomed.groupId, OWNER_BITS);
        await grant(authorId, kept.groupId, OWNER_BITS);
        expect(await prompts().deletePromptGroup({ _id: doomed.groupId })).toEqual({
          message: 'Prompt group deleted successfully',
        });
        expect(ids(await harness.readRaw('promptgroups'))).toEqual([kept.groupId]);
        expect((await harness.readRaw('prompts')).map((row) => row.groupId)).toEqual([
          kept.groupId,
        ]);
        expect(await aclOf(doomed.groupId)).toEqual([]);
        expect(await aclOf(kept.groupId)).toHaveLength(1);
      });

      it('throws for an unknown group', async () => {
        await expect(prompts().deletePromptGroup({ _id: harness.ids.generate() })).rejects.toThrow(
          'Prompt group not found',
        );
      });
    });

    describe('deletePrompt', () => {
      const addRevision = async (groupId: string, text: string) => {
        const { prompt } = await prompts().savePrompt({
          prompt: { prompt: text, type: 'text', groupId },
          author: authorId,
        });
        return idOf(harness, prompt._id);
      };

      it('deletes a revision that is not the production prompt, keeping the production one', async () => {
        const { groupId, promptId } = await createGroup('Keep production');
        const revision = await addRevision(groupId, 'revision');
        expect(await prompts().deletePrompt({ promptId: revision, groupId })).toEqual({
          prompt: 'Prompt deleted successfully',
        });
        expect(ids(await harness.readRaw('prompts'))).toEqual([promptId]);
        expect((await groupRaw(groupId))?.productionId).toBe(promptId);
      });

      it('makes the newest remaining prompt the production one when the production prompt goes', async () => {
        const { groupId, promptId } = await createGroup('Move production');
        const older = await addRevision(groupId, 'older');
        const newer = await addRevision(groupId, 'newer');
        expect(older).not.toBe(newer);
        await prompts().deletePrompt({ promptId: harness.ids.toStoreId(promptId), groupId });
        expect((await groupRaw(groupId))?.productionId).toBe(newer);
      });

      it('takes the group and its permissions with its last prompt', async () => {
        const { groupId, promptId } = await createGroup('Last prompt');
        await grant(authorId, groupId, OWNER_BITS);
        const result = await prompts().deletePrompt({ promptId, groupId });
        expect(result).toMatchObject({
          prompt: 'Prompt deleted successfully',
          promptGroup: { message: 'Prompt group deleted successfully' },
        });
        expect(idOf(harness, result.promptGroup?.id)).toBe(groupId);
        expect(await harness.readRaw('promptgroups')).toEqual([]);
        expect(await harness.readRaw('prompts')).toEqual([]);
        expect(await aclOf(groupId)).toEqual([]);
      });

      it('throws when the prompt is not in the group', async () => {
        const { groupId, promptId } = await createGroup('Wrong group');
        await expect(
          prompts().deletePrompt({ promptId, groupId: harness.ids.generate() }),
        ).rejects.toThrow('Failed to delete the prompt');
        await expect(
          prompts().deletePrompt({ promptId: harness.ids.generate(), groupId }),
        ).rejects.toThrow('Failed to delete the prompt');
        expect(await harness.readRaw('prompts')).toHaveLength(1);
      });
    });

    describe('deleteUserPrompts', () => {
      it('deletes the groups the user owns alone and their legacy groups, keeping shared ones', async () => {
        const soleOwned = await createGroup('Sole owned');
        const shared = await createGroup('Shared');
        const legacy = await createGroup('Legacy, no permissions');
        const migratedToOther = await createGroup('Authored, owned by another');
        const foreign = await createGroup('Foreign', { author: otherAuthorId });
        await grant(authorId, soleOwned.groupId, OWNER_BITS);
        await grant(authorId, shared.groupId, OWNER_BITS);
        await grant(otherAuthorId, shared.groupId, OWNER_BITS);
        await grant(otherAuthorId, migratedToOther.groupId, OWNER_BITS);
        await grant(otherAuthorId, foreign.groupId, OWNER_BITS);

        await prompts().deleteUserPrompts(authorId);

        expect(ids(await harness.readRaw('promptgroups')).sort()).toEqual(
          [shared.groupId, migratedToOther.groupId, foreign.groupId].sort(),
        );
        expect(
          (await harness.readRaw('prompts')).map((row) => row.groupId as string).sort(),
        ).toEqual([shared.groupId, migratedToOther.groupId, foreign.groupId].sort());
        expect(await aclOf(soleOwned.groupId)).toEqual([]);
        expect(await readRawWhere(harness, 'prompts', { groupId: legacy.groupId })).toEqual([]);
        expect(await aclOf(shared.groupId)).toHaveLength(2);
      });

      it('resolves without changes when the user owns nothing', async () => {
        const { groupId } = await createGroup('Foreign', { author: otherAuthorId });
        await grant(otherAuthorId, groupId, OWNER_BITS);
        await prompts().deleteUserPrompts(authorId);
        expect(ids(await harness.readRaw('promptgroups'))).toEqual([groupId]);
      });
    });

    describe('makePromptProduction', () => {
      it("makes the prompt its group's production prompt", async () => {
        const { groupId } = await createGroup('Promote');
        const { prompt } = await prompts().savePrompt({
          prompt: { prompt: 'next', type: 'text', groupId },
          author: authorId,
        });
        const promptId = idOf(harness, prompt._id);
        expect(await prompts().makePromptProduction(promptId)).toEqual({
          message: 'Prompt production made successfully',
        });
        expect((await groupRaw(groupId))?.productionId).toBe(promptId);
        const group = await prompts().getPromptGroup({ _id: groupId });
        expect((group?.productionPrompt as Row).prompt).toBe('next');
      });

      it('throws for an unknown prompt', async () => {
        await expect(prompts().makePromptProduction(harness.ids.generate())).rejects.toThrow(
          'Prompt not found',
        );
      });
    });

    describe('updatePromptLabels', () => {
      it('acknowledges an existing prompt without storing the labels', async () => {
        // NOTE(contract): the prompt schema declares no `labels` path, so the strict model drops
        // the `$set` and nothing is stored, yet the method reports success. Pinned as today's
        // behavior; no caller reads labels back from the store.
        const { promptId } = await createGroup('Labels');
        expect(await prompts().updatePromptLabels(promptId, ['production', 'v2'])).toEqual({
          message: 'Prompt labels updated successfully',
        });
        expect((await harness.readRaw('prompts'))[0]).not.toHaveProperty('labels');
      });

      it('reports an unknown prompt, and a failed write, as messages', async () => {
        expect(await prompts().updatePromptLabels(harness.ids.generate(), ['x'])).toEqual({
          message: 'Prompt not found',
        });
        expect(await prompts().updatePromptLabels('not-an-id', ['x'])).toEqual({
          message: 'Error updating prompt labels',
        });
      });
    });

    describe('getOwnedPromptGroupIds', () => {
      it("reads the ids of the user's groups, also from the primary", async () => {
        const mine = await createGroup('Mine');
        await createGroup('Theirs', { author: otherAuthorId });
        expect(idStrings(await prompts().getOwnedPromptGroupIds(authorId))).toEqual([mine.groupId]);
        expect(idStrings(await prompts().getOwnedPromptGroupIds(authorId, true))).toEqual([
          mine.groupId,
        ]);
      });

      it('reads nothing for an author that is not a store id', async () => {
        await createGroup('Mine');
        expect(await prompts().getOwnedPromptGroupIds('not-an-id')).toEqual([]);
        expect(await prompts().getOwnedPromptGroupIds('')).toEqual([]);
      });
    });

    describe('getPromptGroupAccessContext and invalidatePromptGroupAccessContext', () => {
      const userId = harness.ids.generate();
      const contextOf = async (store: ReturnType<typeof prompts>) => {
        const context = await store.getPromptGroupAccessContext({ userId, role: 'USER' });
        return {
          accessibleIds: idStrings(context.accessibleIds).sort(),
          publiclyAccessibleIds: idStrings(context.publiclyAccessibleIds).sort(),
          ownedPromptGroupIds: idStrings(context.ownedPromptGroupIds).sort(),
        };
      };

      it('resolves the groups the user may view, the public ones and the owned ones', async () => {
        const own = await createGroup('Own', { author: userId });
        const shared = await createGroup('Shared with user', { author: otherAuthorId });
        const everyone = await createGroup('Public', { author: otherAuthorId });
        await createGroup('Hidden', { author: otherAuthorId });
        await grant(userId, own.groupId, OWNER_BITS);
        await grant(userId, shared.groupId, PermissionBits.VIEW);
        await grant(null, everyone.groupId, PermissionBits.VIEW);
        expect(await contextOf(prompts())).toEqual({
          accessibleIds: [own.groupId, shared.groupId, everyone.groupId].sort(),
          publiclyAccessibleIds: [everyone.groupId],
          ownedPromptGroupIds: [own.groupId],
        });
      });

      it('rebuilds on every read without a cache', async () => {
        const store = prompts();
        expect((await contextOf(store)).accessibleIds).toEqual([]);
        const { groupId } = await createGroup('Granted later', { author: otherAuthorId });
        await grant(userId, groupId, PermissionBits.VIEW);
        expect((await contextOf(store)).accessibleIds).toEqual([groupId]);
        await expect(store.invalidatePromptGroupAccessContext()).resolves.toBeUndefined();
      });

      it('serves the cached sets until they are invalidated', async () => {
        const cache = createCache();
        const store = harness.createStores({ getCache: () => cache.store }).prompts;
        await inTenant('tenant-cache', async () => {
          await store.invalidatePromptGroupAccessContext();
          expect((await contextOf(store)).accessibleIds).toEqual([]);
          const { groupId } = await createGroup('Granted later', { author: otherAuthorId });
          await grant(userId, groupId, PermissionBits.VIEW);
          expect((await contextOf(store)).accessibleIds).toEqual([]);
          await store.invalidatePromptGroupAccessContext();
          expect((await contextOf(store)).accessibleIds).toEqual([groupId]);
        });
      });

      it('drops the cached sets when a group is created or deleted through the store', async () => {
        const cache = createCache();
        const store = harness.createStores({ getCache: () => cache.store }).prompts;
        await inTenant('tenant-writes', async () => {
          await store.invalidatePromptGroupAccessContext();
          expect((await contextOf(store)).ownedPromptGroupIds).toEqual([]);
          const { groupId } = await store
            .createPromptGroup({
              prompt: { prompt: 'created', type: 'text' },
              group: { name: 'Created' },
              author: userId,
              authorName: 'User',
            })
            .then(({ group }) => ({ groupId: idOf(harness, group._id) }));
          await grant(null, groupId, PermissionBits.VIEW);
          expect(await contextOf(store)).toMatchObject({ ownedPromptGroupIds: [groupId] });
          await store.invalidatePromptGroupAccessContext();
          expect((await contextOf(store)).publiclyAccessibleIds).toEqual([groupId]);
          await store.deletePromptGroup({ _id: groupId });
          expect(await contextOf(store)).toEqual({
            accessibleIds: [],
            publiclyAccessibleIds: [],
            ownedPromptGroupIds: [],
          });
        });
      });

      it('keeps the cache of other tenants', async () => {
        const cache = createCache();
        const store = harness.createStores({ getCache: () => cache.store }).prompts;
        await inTenant('tenant-x', () => store.invalidatePromptGroupAccessContext());
        await inTenant('tenant-y', () => store.invalidatePromptGroupAccessContext());
        const group = rawGroup({ tenantId: 'tenant-x', author: userId });
        await inTenant('tenant-x', async () => {
          expect((await contextOf(store)).ownedPromptGroupIds).toEqual([]);
        });
        await harness.seedRaw('promptgroups', [group]);
        await inTenant('tenant-y', () => store.invalidatePromptGroupAccessContext());
        await inTenant('tenant-x', async () => {
          expect((await contextOf(store)).ownedPromptGroupIds).toEqual([]);
          await store.invalidatePromptGroupAccessContext();
          expect((await contextOf(store)).ownedPromptGroupIds).toEqual([group._id]);
        });
      });

      it('throws when the marker can be neither removed nor replaced, and then bypasses the cache', async () => {
        const cache = createCache();
        const store = harness.createStores({ getCache: () => cache.store }).prompts;
        await inTenant('tenant-failing', async () => {
          await store.invalidatePromptGroupAccessContext();
          expect((await contextOf(store)).accessibleIds).toEqual([]);
          cache.failures.markerWrites = true;
          cache.failures.markerDeletes = true;
          await expect(store.invalidatePromptGroupAccessContext()).rejects.toThrow(
            'Prompt group access generation write failed',
          );
          const { groupId } = await createGroup('Granted while bypassed', {
            author: otherAuthorId,
          });
          await grant(userId, groupId, PermissionBits.VIEW);
          expect((await contextOf(store)).accessibleIds).toEqual([groupId]);
          cache.failures.markerWrites = false;
          cache.failures.markerDeletes = false;
          await store.invalidatePromptGroupAccessContext();
          expect((await contextOf(store)).accessibleIds).toEqual([groupId]);
        });
      });

      it('resolves when the marker was removed though its replacement failed', async () => {
        const cache = createCache();
        const store = harness.createStores({ getCache: () => cache.store }).prompts;
        await inTenant('tenant-removed', async () => {
          await store.invalidatePromptGroupAccessContext();
          cache.failures.markerWrites = true;
          await expect(store.invalidatePromptGroupAccessContext()).resolves.toBeUndefined();
          cache.failures.markerWrites = false;
          await store.invalidatePromptGroupAccessContext();
        });
      });
    });

    describe('findLangfusePromptGroup and createLangfusePromptGroup', () => {
      const identity = {
        sourceDestination: 'eu',
        sourceProjectId: 'project-1',
        sourcePromptName: 'welcome-prompt',
      };
      const createMirror = (name = 'Welcome') =>
        prompts().createLangfusePromptGroup({
          ...identity,
          name,
          author: authorId,
          authorName: 'Sync Admin',
        });

      it('finds nothing before the mirror is created, and its id after', async () => {
        expect(await prompts().findLangfusePromptGroup(identity)).toBeNull();
        const created = await createMirror();
        expect(typeof created._id).toBe('string');
        expect(await prompts().findLangfusePromptGroup(identity)).toEqual({ _id: created._id });
        expect(
          await prompts().findLangfusePromptGroup({ ...identity, sourcePromptName: 'other' }),
        ).toBeNull();
      });

      it('stores the source identity and no production prompt or content', async () => {
        const created = await createMirror();
        const stored = await groupRaw(created._id);
        expect(stored).toMatchObject({
          source: 'langfuse',
          ...identity,
          name: 'Welcome',
          author: authorId,
          authorName: 'Sync Admin',
          category: '',
          oneliner: '',
          numberOfGenerations: 0,
        });
        expect(stored).not.toHaveProperty('productionId');
        expect(await harness.readRaw('prompts')).toEqual([]);
      });

      it('rejects a second mirror of the identity with a duplicate-key error', async () => {
        await createMirror();
        const failure = await createMirror('Welcome again').catch((error: unknown) => error);
        expect(harness.errors.isDuplicateKey(failure)).toBe(true);
        expect(await harness.readRaw('promptgroups')).toHaveLength(1);
      });

      it('stamps the tenant and keeps lookups and identities per tenant', async () => {
        const inA = await inTenant('tenant-a', () => createMirror());
        expect((await groupRaw(inA._id))?.tenantId).toBe('tenant-a');
        await inTenant('tenant-b', async () => {
          expect(await prompts().findLangfusePromptGroup(identity)).toBeNull();
          const inB = await createMirror();
          expect(inB._id).not.toBe(inA._id);
        });
        await inTenant('tenant-a', async () => {
          expect(await prompts().findLangfusePromptGroup(identity)).toEqual({ _id: inA._id });
        });
      });

      it('lists the mirror with its source fields and no production prompt', async () => {
        const created = await createMirror();
        const listed = await prompts().getListPromptGroupsByAccess({
          accessibleIds: [created._id],
        });
        expect(listed.data[0]).toMatchObject({
          source: 'langfuse',
          ...identity,
          productionPrompt: null,
        });
      });
    });

    describe('tenant scoping', () => {
      it("reads, lists and updates only the active tenant's groups and prompts", async () => {
        const inA = await inTenant('tenant-a', () => createGroup('Tenant A group'));
        const inB = await inTenant('tenant-b', () => createGroup('Tenant B group'));
        await inTenant('tenant-a', async () => {
          expect(
            ((await prompts().getAllPromptGroups({})) as Row[]).map((row) => row.name),
          ).toEqual(['Tenant A group']);
          const listed = await prompts().getListPromptGroupsByAccess({
            accessibleIds: [inA.groupId, inB.groupId],
          });
          expect(ids(listed.data)).toEqual([inA.groupId]);
          expect(await prompts().getPrompt({ _id: inB.promptId })).toBeNull();
          expect(await prompts().getPrompts({ groupId: inB.groupId })).toEqual([]);
          await expect(
            prompts().updatePromptGroup({ _id: inB.groupId }, { name: 'Hijacked' }),
          ).rejects.toThrow('Prompt group not found');
          await expect(prompts().incrementPromptGroupUsage(inB.groupId)).rejects.toThrow(
            'Prompt group not found',
          );
        });
        expect((await groupRaw(inB.groupId))?.name).toBe('Tenant B group');
      });
    });

    it('keeps timestamps on created groups and prompts', async () => {
      const { groupId } = await createGroup('Timestamps');
      const stored = await groupRaw(groupId);
      expect(timeOf(stored?.createdAt)).toBeGreaterThan(0);
      expect(timeOf(stored?.updatedAt)).toBeGreaterThanOrEqual(timeOf(stored?.createdAt));
    });
  });
}

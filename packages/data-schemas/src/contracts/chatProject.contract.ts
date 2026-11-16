/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The `ChatProjectStore` contract (`~/ports/chatProject`), ported from `methods/chatProject.spec.ts`:
 * private projects per user (and tenant), the keyset-paged list with its search and the projects
 * without conversations (a `null` latest activity) paging after the dated ones, the instructions
 * and file attachments that advance `contextRevision` only when they change, the revision
 * compare-and-set, the eligibility of an attached file (the owner's indexed, unexpired message
 * attachment) and the release of its temporary hold, and the conversation assignment that
 * refreshes the stats of both projects, counting only conversations the workspace shows.
 *
 * Cases that interleave writes through spies (the stats compare-and-set losing races, the
 * metadata fallback after a lost conditional update, the concurrent attachments at the file
 * limit, the release or attach failing midway) stay in the method spec, and so do the internal
 * stats helpers (`refreshChatProjectStatsForUser`, `updateChatProjectLastConversationForUser`),
 * which are not on the port, and the hand-built cursor of the invalid-cursor case (cursors are
 * opaque). Nothing here may import `mongoose` or the MongoDB driver.
 */
import { FileContext } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from './harness';
import { tenantStorage } from '~/config/tenantContext';
import { idOf, timeOf, useContractHarness } from './support';

export function describeChatProjectContract(harness: ContractHarness): void {
  describe(`ChatProjectStore contract: ${harness.name}`, () => {
    useContractHarness(harness);

    const stores = () => harness.createStores().chatProjects;
    const newId = () => harness.ids.generate();
    /** Owners are ids: attached files are owned by a user id. */
    const owner = newId();
    const otherOwner = newId();

    const create = async (name: string, extra: RawRecord = {}, user = owner) =>
      idOf(harness, (await stores().createChatProject(user, { name, ...extra }))._id);
    const seedConversations = (records: RawRecord[]) =>
      harness.seedRaw(
        'conversations',
        records.map((record) => ({ _id: newId(), user: owner, endpoint: 'openAI', ...record })),
      );
    const seedFile = (fileId: string, record: RawRecord = {}) =>
      harness.seedRaw('files', [
        {
          _id: newId(),
          user: owner,
          file_id: fileId,
          filename: `${fileId}.pdf`,
          filepath: `/uploads/${fileId}.pdf`,
          type: 'application/pdf',
          bytes: 100,
          embedded: true,
          context: FileContext.message_attachment,
          ...record,
        },
      ]);
    const rawFile = async (fileId: string) =>
      (await harness.readRaw('files')).find((record) => record.file_id === fileId);
    const conversationOf = async (conversationId: string) =>
      (await harness.readRaw('conversations')).find(
        (record) => record.conversationId === conversationId,
      );

    describe('createChatProject and getChatProject', () => {
      it('creates a private project with no conversations and reads it back', async () => {
        const project = await stores().createChatProject(owner, {
          name: '  Customer Alpha  ',
          description: 'Support work',
          instructions: '  Use concise English.  ',
        });
        expect(project).toMatchObject({
          name: 'Customer Alpha',
          description: 'Support work',
          instructions: 'Use concise English.',
          user: owner,
          conversationCount: 0,
        });
        expect(project.lastConversationAt == null).toBe(true);
        expect(project.lastConversationId == null).toBe(true);
        const id = idOf(harness, project._id);
        const read = await stores().getChatProject(owner, id);
        expect(read).toMatchObject({ name: 'Customer Alpha', file_ids: [] });
        expect(idOf(harness, read?._id)).toBe(id);
        expect(read?.contextRevision).toBe(project.contextRevision);
      });

      it('reads another user’s project, an unknown id and a malformed id as absent', async () => {
        const id = await create('Mine');
        expect(await stores().getChatProject(otherOwner, id)).toBeNull();
        expect(await stores().getChatProject(owner, newId())).toBeNull();
        expect(await stores().getChatProject(owner, 'not-an-id')).toBeNull();
      });

      it('rejects an empty name and instructions over the limit', async () => {
        await expect(stores().createChatProject(owner, { name: '   ' })).rejects.toThrow(
          'Project name is required',
        );
        await expect(
          stores().createChatProject(
            owner,
            { name: 'Too long', instructions: 'x'.repeat(11) },
            { maxInstructionsLength: 10 },
          ),
        ).rejects.toThrow('Invalid project instructions');
        expect(await harness.readRaw('chatprojects')).toEqual([]);
      });
    });

    describe('listChatProjects', () => {
      it('lists the user’s projects with instruction and file summaries instead of their content', async () => {
        const id = await create('Beta', { instructions: 'Guidance' });
        await create('Alpha');
        await create('Theirs', {}, otherOwner);
        await seedFile('ref');
        await stores().addChatProjectFile(owner, id, 'ref');

        const { projects, nextCursor } = await stores().listChatProjects(owner, {
          sortBy: 'name',
          sortDirection: 'asc',
        });
        expect(nextCursor).toBeNull();
        expect(projects.map((project) => project.name)).toEqual(['Alpha', 'Beta']);
        expect(projects[1]).toMatchObject({ hasInstructions: true, fileCount: 1, user: owner });
        expect(projects[0]).toMatchObject({ hasInstructions: false, fileCount: 0 });
        expect(projects[1]).not.toHaveProperty('instructions');
        expect(projects[1]).not.toHaveProperty('file_ids');
        expect(idOf(harness, projects[1]._id)).toBe(id);
      });

      it('keeps the projects whose name or description contains the search, ignoring case', async () => {
        await create('Customer Alpha', { description: 'Support work' });
        await create('Internal Tools', { description: 'Overflow menu test' });
        await create('a.b');
        const names = async (search: string) =>
          (await stores().listChatProjects(owner, { search })).projects.map(({ name }) => name);
        expect(await names('alpha')).toEqual(['Customer Alpha']);
        expect(await names('OVERFLOW')).toEqual(['Internal Tools']);
        expect(await names('a.b')).toEqual(['a.b']);
        expect(await names('a.')).toEqual(['a.b']);
        expect(await names('zzzz')).toEqual([]);
      });

      it.each([3, 2])(
        'pages the projects without conversations after the dated ones (limit %i)',
        async (limit) => {
          const seed = (name: string, lastConversationAt: Date | null): RawRecord => ({
            _id: newId(),
            name,
            user: owner,
            conversationCount: 0,
            lastConversationAt,
            lastConversationId: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          });
          await harness.seedRaw('chatprojects', [
            seed('Stale', new Date('2026-01-01T00:00:00.000Z')),
            seed('Quiet A', null),
            seed('Quiet B', null),
            seed('Recent', new Date('2026-02-01T00:00:00.000Z')),
          ]);
          const options = { sortBy: 'lastConversationAt' as const, sortDirection: 'desc' as const };
          const first = await stores().listChatProjects(owner, { ...options, limit });
          const second = await stores().listChatProjects(owner, {
            ...options,
            limit,
            cursor: first.nextCursor,
          });
          expect(first.projects.map(({ name }) => name).slice(0, 2)).toEqual(['Recent', 'Stale']);
          expect(first.nextCursor).toEqual(expect.any(String));
          expect(second.nextCursor).toBeNull();
          expect(second.projects.every((project) => project.lastConversationAt == null)).toBe(true);
          const names = [...first.projects, ...second.projects].map(({ name }) => name);
          expect(names.sort()).toEqual(['Quiet A', 'Quiet B', 'Recent', 'Stale']);
        },
      );

      it('pages by name in both directions without skipping or repeating a project', async () => {
        for (const name of ['d', 'b', 'a', 'c', 'e']) {
          await create(name);
        }
        for (const sortDirection of ['asc', 'desc'] as const) {
          const seen: string[] = [];
          let cursor: string | null = null;
          for (let page = 0; page < 5; page++) {
            const result = await stores().listChatProjects(owner, {
              sortBy: 'name',
              sortDirection,
              limit: 2,
              cursor,
            });
            seen.push(...result.projects.map(({ name }) => name));
            cursor = result.nextCursor;
            if (cursor == null) {
              break;
            }
          }
          const expected = ['a', 'b', 'c', 'd', 'e'];
          expect(seen).toEqual(sortDirection === 'asc' ? expected : expected.reverse());
        }
      });
    });

    describe('updateChatProject', () => {
      it('advances the context revision only when the instructions change', async () => {
        const project = await stores().createChatProject(owner, {
          name: 'Documentation',
          description: 'Human-facing summary',
          instructions: 'Use concise technical English.',
        });
        const id = idOf(harness, project._id);
        const base = project.contextRevision ?? 0;
        const described = await stores().updateChatProject(owner, id, {
          description: 'Renamed summary',
        });
        expect(described).toMatchObject({
          description: 'Renamed summary',
          instructions: 'Use concise technical English.',
          contextRevision: base,
        });
        const changed = await stores().updateChatProject(owner, id, {
          instructions: 'Do not describe experimental features as stable.',
        });
        expect(changed?.contextRevision).toBe(base + 1);
        const unchanged = await stores().updateChatProject(owner, id, {
          name: 'Documentation workspace',
          instructions: changed?.instructions,
        });
        expect(unchanged).toMatchObject({
          name: 'Documentation workspace',
          contextRevision: base + 1,
        });
        const cleared = await stores().updateChatProject(owner, id, { instructions: '' });
        expect(cleared).toMatchObject({ instructions: '', contextRevision: base + 2 });
        expect((await stores().listChatProjects(owner)).projects[0].hasInstructions).toBe(false);
      });

      it('rejects a stale expected revision and accepts the current one', async () => {
        const project = await stores().createChatProject(owner, {
          name: 'Shared',
          instructions: 'v1',
        });
        const id = idOf(harness, project._id);
        const revision = project.contextRevision;
        const first = await stores().updateChatProject(owner, id, {
          instructions: 'v2',
          contextRevision: revision,
        });
        expect(first).toMatchObject({ instructions: 'v2', contextRevision: (revision ?? 0) + 1 });
        await expect(
          stores().updateChatProject(owner, id, { instructions: 'v3', contextRevision: revision }),
        ).rejects.toThrow('Project revision conflict');
        await expect(
          stores().updateChatProject(owner, id, { name: 'Renamed', contextRevision: revision }),
        ).rejects.toThrow('Project revision conflict');
        expect(await stores().getChatProject(owner, id)).toMatchObject({
          name: 'Shared',
          instructions: 'v2',
        });
        expect(
          await stores().updateChatProject(owner, newId(), { name: 'x', contextRevision: 0 }),
        ).toBeNull();
      });

      it('rejects too-long instructions and an empty name, keeping the saved project', async () => {
        const id = await create('At limit', { instructions: 'x'.repeat(10) });
        await expect(
          stores().updateChatProject(
            owner,
            id,
            { instructions: 'x'.repeat(11) },
            { maxInstructionsLength: 10 },
          ),
        ).rejects.toThrow('Invalid project instructions');
        await expect(stores().updateChatProject(owner, id, { name: ' ' })).rejects.toThrow(
          'Project name is required',
        );
        expect(await stores().getChatProject(owner, id)).toMatchObject({
          name: 'At limit',
          instructions: 'x'.repeat(10),
        });
      });

      it('initializes a legacy project’s context fields only when their content changes', async () => {
        const id = newId();
        await harness.seedRaw('chatprojects', [
          { _id: id, name: 'Legacy', user: owner, conversationCount: 0 },
        ]);
        expect((await stores().listChatProjects(owner)).projects[0]).toMatchObject({
          hasInstructions: false,
          fileCount: 0,
        });
        await stores().updateChatProject(owner, id, { instructions: '' });
        expect((await stores().getChatProject(owner, id))?.contextRevision ?? 0).toBe(0);
        expect(
          await stores().updateChatProject(owner, id, { instructions: 'New context' }),
        ).toMatchObject({ instructions: 'New context', contextRevision: 1 });
        await seedFile('legacy-ref');
        expect(await stores().addChatProjectFile(owner, id, 'legacy-ref')).toMatchObject({
          file_ids: ['legacy-ref'],
          contextRevision: 2,
        });
      });

      it('reads another user’s project as absent', async () => {
        const id = await create('Private');
        expect(
          await stores().updateChatProject(otherOwner, id, { instructions: 'Injected' }),
        ).toBeNull();
        expect(await stores().updateChatProject(owner, 'not-an-id', { name: 'x' })).toBeNull();
        expect((await stores().getChatProject(owner, id))?.instructions).toBe('');
      });
    });

    describe('addChatProjectFile and removeChatProjectFile', () => {
      it('attaches a file once, releasing its temporary hold, and detaches it', async () => {
        const id = await create('Files');
        const deadline = new Date(Date.now() + 86_400_000);
        await seedFile('shared-reference', {
          expiresAt: new Date(Date.now() + 3_600_000),
          temp_file_id: 'temporary',
          expiredAt: deadline,
        });
        const attached = await stores().addChatProjectFile(owner, id, 'shared-reference');
        expect(attached?.file_ids).toEqual(['shared-reference']);
        const file = await rawFile('shared-reference');
        expect(file?.expiresAt == null).toBe(true);
        expect(file?.temp_file_id == null).toBe(true);
        expect(timeOf(file?.expiredAt)).toBe(deadline.getTime());

        const again = await stores().addChatProjectFile(owner, id, 'shared-reference');
        expect(again?.file_ids).toEqual(['shared-reference']);
        expect(again?.contextRevision).toBe(attached?.contextRevision);

        const detached = await stores().removeChatProjectFile(owner, id, 'shared-reference');
        expect(detached?.file_ids).toEqual([]);
        expect(detached?.contextRevision).toBe((attached?.contextRevision ?? 0) + 1);
        const repeated = await stores().removeChatProjectFile(owner, id, 'shared-reference');
        expect(repeated?.contextRevision).toBe(detached?.contextRevision);
        expect(await harness.readRaw('files')).toHaveLength(1);
      });

      it('accepts a retained search destination that is not embedded', async () => {
        const id = await create('Repairable');
        await seedFile('repairable', { embedded: false, metadata: { searchDestination: true } });
        expect((await stores().addChatProjectFile(owner, id, 'repairable'))?.file_ids).toEqual([
          'repairable',
        ]);
        expect((await rawFile('repairable'))?.embedded).toBe(false);
      });

      it('rejects a foreign, agent-scoped, unindexed, expired or missing file', async () => {
        const id = await create('Private');
        await seedFile('foreign', { user: otherOwner });
        await seedFile('foreign-repair', {
          user: otherOwner,
          embedded: false,
          metadata: { searchDestination: true },
        });
        await seedFile('agent-index', { context: FileContext.agents });
        await seedFile('unindexed', { embedded: false });
        await seedFile('expired', { expiredAt: new Date(0) });
        for (const fileId of [
          'foreign',
          'foreign-repair',
          'agent-index',
          'unindexed',
          'expired',
          'missing',
          '',
          'x'.repeat(129),
        ]) {
          await expect(stores().addChatProjectFile(owner, id, fileId)).rejects.toThrow(
            'Project file unavailable',
          );
        }
        expect((await stores().getChatProject(owner, id))?.file_ids).toEqual([]);
      });

      it('resolves null for a missing or foreign project and keeps the file’s hold', async () => {
        const id = await create('Mine');
        const hold = new Date('2026-12-15T00:00:00.000Z');
        await seedFile('orphan', { expiresAt: hold, temp_file_id: 'orphan-temp' });
        expect(await stores().addChatProjectFile(owner, newId(), 'orphan')).toBeNull();
        expect(await stores().addChatProjectFile(otherOwner, id, 'orphan')).toBeNull();
        expect(await stores().removeChatProjectFile(otherOwner, id, 'orphan')).toBeNull();
        expect(await stores().removeChatProjectFile(owner, 'not-an-id', 'orphan')).toBeNull();
        const file = await rawFile('orphan');
        expect(timeOf(file?.expiresAt)).toBe(hold.getTime());
        expect(file?.temp_file_id).toBe('orphan-temp');
      });

      it('stops at the file limit', async () => {
        const id = await create('Small');
        await seedFile('first');
        await seedFile('second', { expiresAt: new Date('2026-12-15T00:00:00.000Z') });
        await stores().addChatProjectFile(owner, id, 'first', { maxFiles: 1 });
        await expect(
          stores().addChatProjectFile(owner, id, 'second', { maxFiles: 1 }),
        ).rejects.toThrow('Project file limit reached');
        expect(
          (await stores().addChatProjectFile(owner, id, 'first', { maxFiles: 1 }))?.file_ids,
        ).toEqual(['first']);
        expect((await stores().getChatProject(owner, id))?.file_ids).toEqual(['first']);
        expect((await rawFile('second'))?.expiresAt).toBeInstanceOf(Date);
      });
    });

    describe('assignConversationToProject', () => {
      it('assigns conversations, moves them between projects and refreshes both stats', async () => {
        const first = await create('First');
        const second = await create('Second');
        await seedConversations([
          {
            conversationId: 'convo-1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            conversationId: 'convo-2',
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        ]);
        const assigned = await stores().assignConversationToProject(owner, 'convo-1', first);
        expect(assigned).toMatchObject({ previousProjectId: null, projectId: first });
        expect(assigned?.conversation).toMatchObject({
          conversationId: 'convo-1',
          chatProjectId: first,
        });
        await stores().assignConversationToProject(owner, 'convo-2', first);
        expect(await stores().getChatProject(owner, first)).toMatchObject({
          conversationCount: 2,
          lastConversationId: 'convo-2',
        });
        /** The assignment is a write to the conversation, so its latest activity is now. */
        expect(timeOf((await stores().getChatProject(owner, first))?.lastConversationAt)).toBe(
          timeOf((await conversationOf('convo-2'))?.updatedAt),
        );

        const moved = await stores().assignConversationToProject(owner, 'convo-2', second);
        expect(moved).toMatchObject({ previousProjectId: first, projectId: second });
        expect(await stores().getChatProject(owner, first)).toMatchObject({
          conversationCount: 1,
          lastConversationId: 'convo-1',
        });
        expect(await stores().getChatProject(owner, second)).toMatchObject({
          conversationCount: 1,
          lastConversationId: 'convo-2',
        });

        const removed = await stores().assignConversationToProject(owner, 'convo-1', null);
        expect(removed).toMatchObject({ previousProjectId: first, projectId: null });
        expect((await conversationOf('convo-1'))?.chatProjectId == null).toBe(true);
        const emptied = await stores().getChatProject(owner, first);
        expect(emptied?.conversationCount).toBe(0);
        expect(emptied?.lastConversationId == null).toBe(true);
        expect(emptied?.lastConversationAt == null).toBe(true);
      });

      it('counts only the conversations the workspace shows', async () => {
        const id = await create('Visible Stats');
        const visible = new Date('2026-01-01T00:00:00.000Z');
        const hidden = new Date('2099-02-01T00:00:00.000Z');
        await seedConversations([
          {
            conversationId: 'visible-convo',
            chatProjectId: id,
            isTemporary: false,
            expiredAt: null,
            createdAt: visible,
            updatedAt: visible,
          },
          {
            conversationId: 'temporary-convo',
            chatProjectId: id,
            isTemporary: true,
            expiredAt: new Date('2099-03-01T00:00:00.000Z'),
            createdAt: hidden,
            updatedAt: hidden,
          },
          {
            conversationId: 'expired-convo',
            chatProjectId: id,
            isTemporary: false,
            expiredAt: new Date('2025-12-01T00:00:00.000Z'),
            createdAt: hidden,
            updatedAt: hidden,
          },
          {
            conversationId: 'archived-convo',
            chatProjectId: id,
            isArchived: true,
            createdAt: hidden,
            updatedAt: hidden,
          },
        ]);
        await stores().assignConversationToProject(owner, 'visible-convo', id);
        const project = await stores().getChatProject(owner, id);
        expect(project).toMatchObject({
          conversationCount: 1,
          lastConversationId: 'visible-convo',
        });
        expect(timeOf(project?.lastConversationAt)).toBe(
          timeOf((await conversationOf('visible-convo'))?.updatedAt),
        );
      });

      it('resolves null for a missing conversation and throws for a foreign project', async () => {
        const mine = await create('Mine');
        const theirs = await create('Theirs', {}, otherOwner);
        await seedConversations([{ conversationId: 'convo-1' }]);
        expect(await stores().assignConversationToProject(owner, 'missing', mine)).toBeNull();
        expect(
          await stores().assignConversationToProject(otherOwner, 'convo-1', theirs),
        ).toBeNull();
        for (const projectId of [theirs, newId(), 'not-an-id']) {
          await expect(
            stores().assignConversationToProject(owner, 'convo-1', projectId),
          ).rejects.toThrow('Project not found');
        }
        expect((await conversationOf('convo-1'))?.chatProjectId == null).toBe(true);
      });
    });

    describe('deleteChatProject and deleteUserChatProjects', () => {
      it('deletes the project and detaches its conversations without deleting them', async () => {
        const id = await create('Delete me');
        await seedFile('kept');
        await stores().addChatProjectFile(owner, id, 'kept');
        await seedConversations([{ conversationId: 'convo-1' }, { conversationId: 'convo-2' }]);
        await stores().assignConversationToProject(owner, 'convo-1', id);
        await stores().assignConversationToProject(owner, 'convo-2', id);

        expect(await stores().deleteChatProject(otherOwner, id)).toEqual({
          deletedCount: 0,
          modifiedCount: 0,
        });
        expect(await stores().deleteChatProject(owner, 'not-an-id')).toEqual({
          deletedCount: 0,
          modifiedCount: 0,
        });
        expect(await stores().deleteChatProject(owner, id)).toEqual({
          deletedCount: 1,
          modifiedCount: 2,
        });
        expect(await stores().getChatProject(owner, id)).toBeNull();
        const conversations = await harness.readRaw('conversations');
        expect(conversations).toHaveLength(2);
        expect(conversations.every((record) => record.chatProjectId == null)).toBe(true);
        expect(await harness.readRaw('files')).toHaveLength(1);
      });

      it("deletes every project of the user and no other user's", async () => {
        await create('One');
        await create('Two');
        await create('Theirs', {}, otherOwner);
        expect(await stores().deleteUserChatProjects(owner)).toBe(2);
        expect(await stores().deleteUserChatProjects(owner)).toBe(0);
        expect((await harness.readRaw('chatprojects')).map((record) => record.user)).toEqual([
          otherOwner,
        ]);
      });
    });

    describe('tenant isolation', () => {
      it('scopes every read and write to the tenant, even for the same owner id', async () => {
        const inTenant = <T>(tenantId: string, run: () => Promise<T>) =>
          tenantStorage.run({ tenantId }, run);
        const id = await inTenant('project-tenant-a', async () => {
          const project = await create('Tenant A', { instructions: 'A' });
          await seedFile('tenant-a-ref', { tenantId: 'project-tenant-a' });
          await stores().addChatProjectFile(owner, project, 'tenant-a-ref');
          return project;
        });
        await seedFile('tenant-b-ref', { tenantId: 'project-tenant-b' });
        await inTenant('project-tenant-b', async () => {
          expect(await stores().getChatProject(owner, id)).toBeNull();
          expect((await stores().listChatProjects(owner)).projects).toEqual([]);
          expect(await stores().updateChatProject(owner, id, { instructions: 'B' })).toBeNull();
          expect(await stores().addChatProjectFile(owner, id, 'tenant-b-ref')).toBeNull();
          expect(await stores().removeChatProjectFile(owner, id, 'tenant-a-ref')).toBeNull();
          expect((await stores().deleteChatProject(owner, id)).deletedCount).toBe(0);
        });
        await inTenant('project-tenant-a', async () => {
          await expect(stores().addChatProjectFile(owner, id, 'tenant-b-ref')).rejects.toThrow(
            'Project file unavailable',
          );
          expect(await stores().getChatProject(owner, id)).toMatchObject({
            instructions: 'A',
            file_ids: ['tenant-a-ref'],
          });
        });
      });
    });
  });
}

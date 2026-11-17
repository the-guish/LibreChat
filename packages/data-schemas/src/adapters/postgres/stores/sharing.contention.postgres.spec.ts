import { FileContext } from 'librechat-data-provider';
import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { DataStore } from '~/ports';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from '../contractHarness';
import { createPostgresDataStoreBackend } from '../backend';

/**
 * Contention specs of the PostgreSQL sharing and project stores (docs/postgres-port/PHASE4.md
 * §3.5): racing creates of one shared link leave exactly one, racing retaggings count every
 * conversation once on one tag record, a project never holds more files than its limit when
 * attaches race (and the losers' temporary holds come back), and racing assignments leave the
 * project's statistics equal to its conversations. Each case runs with the shadow check off (the
 * production path: one statement per guarded write, rechecked on the locked row) and on (the
 * lock-then-write path the contract suites take).
 */
describePostgres('PostgreSQL sharing and project stores under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  describe.each([
    ['shadow check off', false],
    ['shadow check on', true],
  ])('%s', (_title, shadowCheck) => {
    const harness: ContractHarness = createPostgresContractHarness(
      { connect: async () => database.uri, release: async () => undefined },
      { backend: createPostgresDataStoreBackend({ shadowCheck }) },
    );
    let stores: DataStore;

    beforeAll(async () => {
      await harness.setup();
      stores = harness.createStores();
    }, 120_000);
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const newId = () => harness.ids.generate();
    const seedConversations = (user: string, records: RawRecord[]) =>
      harness.seedRaw(
        'conversations',
        records.map((record) => ({ _id: newId(), user, endpoint: 'openAI', ...record })),
      );

    it('keeps exactly one of 8 racing creates of a link, rejecting the others as existing', async () => {
      const user = newId();
      await seedConversations(user, [{ conversationId: 'c1', title: 'Racing' }]);
      await harness.seedRaw('messages', [
        {
          _id: newId(),
          messageId: 'm1',
          conversationId: 'c1',
          user,
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          isCreatedByUser: true,
          text: 'Hello',
        },
      ]);
      for (let round = 0; round < 3; round++) {
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () => stores.sharedLinks.createSharedLink(user, 'c1')),
        );
        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const codes = results.flatMap((result) =>
          result.status === 'rejected' ? [(result.reason as { code?: string }).code] : [],
        );
        const stored = await harness.readRaw('sharedlinks');
        expect(stored).toHaveLength(1);
        expect(fulfilled).toHaveLength(round === 0 ? 1 : 0);
        expect(codes).toEqual(Array(round === 0 ? 7 : 8).fill('SHARE_EXISTS'));
      }
    });

    it('counts 12 racing retaggings once each on one tag record', async () => {
      const user = newId();
      const conversationIds = Array.from({ length: 12 }, (_, index) => `c${index}`);
      await seedConversations(
        user,
        conversationIds.map((conversationId) => ({ conversationId, tags: [] })),
      );
      await Promise.all(
        conversationIds.map((conversationId) =>
          stores.conversationTags.updateTagsForConversation(user, conversationId, ['shared']),
        ),
      );
      const tags = (await harness.readRaw('conversationtags')).filter(
        (record) => record.user === user,
      );
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({ tag: 'shared', count: 12 });

      await Promise.all([
        ...conversationIds
          .slice(0, 6)
          .map((conversationId) =>
            stores.conversationTags.updateTagsForConversation(user, conversationId, []),
          ),
        stores.conversationTags.bulkIncrementTagCounts(user, ['shared']),
        stores.conversationTags.bulkIncrementTagCounts(user, ['shared']),
      ]);
      const [after] = (await harness.readRaw('conversationtags')).filter(
        (record) => record.user === user,
      );
      expect(after.count).toBe(8);
    });

    it('never attaches more files than the limit when 6 attaches race', async () => {
      const user = newId();
      const expiresAt = new Date(Date.now() + 3_600_000);
      const fileIds = Array.from({ length: 6 }, (_, index) => `file-${index}`);
      await harness.seedRaw(
        'files',
        fileIds.map((fileId) => ({
          _id: newId(),
          user,
          file_id: fileId,
          filename: `${fileId}.pdf`,
          filepath: `/uploads/${fileId}.pdf`,
          type: 'application/pdf',
          bytes: 100,
          embedded: true,
          context: FileContext.message_attachment,
          expiresAt,
        })),
      );
      const project = await stores.chatProjects.createChatProject(user, { name: 'Limited' });
      const projectId = String(project._id);
      const results = await Promise.allSettled(
        fileIds.map((fileId) =>
          stores.chatProjects.addChatProjectFile(user, projectId, fileId, { maxFiles: 3 }),
        ),
      );
      const rejected = results.flatMap((result) =>
        result.status === 'rejected' ? [(result.reason as Error).message] : [],
      );
      expect(rejected).toEqual(Array(3).fill('Project file limit reached'));
      const stored = await stores.chatProjects.getChatProject(user, projectId);
      expect(stored?.file_ids).toHaveLength(3);
      expect(stored?.contextRevision).toBe(3);
      const files = await harness.readRaw('files');
      for (const fileId of fileIds) {
        const file = files.find((record) => record.file_id === fileId);
        const attached = stored?.file_ids?.includes(fileId) === true;
        /** An attached file loses its temporary hold; a rejected one keeps it. */
        expect(file?.expiresAt == null).toBe(attached);
      }
    });

    it('leaves the project statistics equal to its conversations after 6 racing assignments', async () => {
      const user = newId();
      const conversationIds = Array.from({ length: 6 }, (_, index) => `c${index}`);
      await seedConversations(
        user,
        conversationIds.map((conversationId, index) => ({
          conversationId,
          isArchived: false,
          isTemporary: false,
          updatedAt: new Date(Date.UTC(2026, 0, 1 + index)),
        })),
      );
      const project = await stores.chatProjects.createChatProject(user, { name: 'Busy' });
      const projectId = String(project._id);
      await Promise.all(
        conversationIds.map((conversationId) =>
          stores.chatProjects.assignConversationToProject(user, conversationId, projectId),
        ),
      );
      /** Each assignment stamps its conversation's `updatedAt`, so the latest is the last written. */
      const [latest] = (await harness.readRaw('conversations')).sort(
        (a, b) =>
          (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime() ||
          String(b._id).localeCompare(String(a._id)),
      );
      const stored = await stores.chatProjects.getChatProject(user, projectId);
      expect(stored).toMatchObject({
        conversationCount: 6,
        lastConversationId: latest.conversationId,
      });
      expect(stored?.lastConversationAt?.getTime()).toBe((latest.updatedAt as Date).getTime());
    });
  });
});

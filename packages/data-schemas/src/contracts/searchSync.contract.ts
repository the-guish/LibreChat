/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the suite factory that each backend's own spec imports. The rule
   guards against accidental exports from spec files. */
/**
 * The search sync contract (docs/postgres-port/PHASE4.md §8 I3; D4 keeps MeiliSearch): how a
 * backend keeps the MeiliSearch indexes `messages` and `convos` in step with the messages and
 * conversations it stores, on a fake MeiliSearch (`./meiliFake`, which the runner puts in place
 * of the `meilisearch` package, with the configuration of `./searchSyncEnv` loaded first):
 * - the write hooks: a saved or updated message or conversation reaches the index once its
 *   write is durable and is marked indexed (`_meiliIndex`, `_meiliIndexSchemaVersion`,
 *   `_meiliCleanupVersion`, a fresh `_meiliIndexVersion`); a temporary one is kept out and marked
 *   cleaned; deleted ones leave the index;
 * - the search index sync (`SearchIndexSync`, which a backend serves outside `DataStore`): its
 *   progress counts, the batch sync (stale entries and excluded records removed first, pending
 *   records indexed in batches without touching `updatedAt`), the excluded-record cleanup and
 *   the flag reset, each over several batches (`MEILI_SYNC_BATCH_SIZE=2`);
 * - the reads on the index: the user's message search (hydrated on request), the title and
 *   message search of the conversation list, and the conversation search of the shared links.
 *
 * Index writes are detached from the store write that causes them on every backend, so the
 * cases wait for their effect. Left in `models/plugins/mongoMeili.spec.ts` and the method specs:
 * the driver calls, retries and failures injected at the search engine, the race of two writers
 * of one record, and the cross-user hydration of the MongoDB message search (it hydrates by
 * `messageId` alone; PHASE4.md §4). Nothing here may import `mongoose` or the MongoDB driver.
 */
import { randomUUID } from 'node:crypto';
import type { SearchIndexName, SearchIndexSync } from '~/ports/searchIndexSync';
import type { ContractHarness, RawRecord } from './harness';
import type { MessageStore } from '~/ports/message';
import { readRawWhere, timeOf, useContractHarness } from './support';
import { fakeMeili } from './meiliFake';

const USER = 'search-user';
const OTHER = 'search-other';
const hour = 60 * 60 * 1000;

type Params = Parameters<MessageStore['saveMessage']>[1];

/** Waits until `check` stops throwing, up to `timeoutMs`; rethrows its last failure. */
async function eventually(check: () => unknown, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** One searchable kind: its collection, its MeiliSearch index, its key and its excluded path. */
interface SearchKind {
  name: SearchIndexName;
  collection: string;
  meiliIndex: string;
  key: string;
  /** A record of this kind, as stored, with `key` as its primary key value. */
  record(key: string, fields?: RawRecord): RawRecord;
  /** The fields that keep a record out of search. */
  excluded: RawRecord;
  /** The indexed form of a stored record. */
  indexed(record: RawRecord): RawRecord;
}

/**
 * The search sync contract. `searchIndexSync` is the backend's search index sync on the
 * harness's database (built once the harness is set up).
 */
export function describeSearchSyncContract(
  harness: ContractHarness,
  searchIndexSync: () => SearchIndexSync,
): void {
  describe(`search sync contract: ${harness.name}`, () => {
    useContractHarness(harness);
    beforeEach(() => fakeMeili.reset());

    const stores = () => harness.createStores();
    const domain = () => harness.createConversationDomain();
    const newId = () => harness.ids.generate();
    const uuid = () => randomUUID();
    const created = new Date('2026-03-01T10:00:00.000Z');

    const saveMessage = (params: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
      stores().messages.saveMessage({ userId: USER, ...ctx }, params as Params);
    const saveConvo = (
      data: Record<string, unknown> & { conversationId: string },
      ctx: Record<string, unknown> = {},
    ) =>
      domain().saveConvo(
        { userId: USER, ...ctx },
        { endpoint: 'openAI', ...data },
        {
          context: 'search sync contract',
        },
      );
    const rawMessage = async (messageId: string) =>
      (await readRawWhere(harness, 'messages', { messageId }))[0];
    const rawConvo = async (conversationId: string) =>
      (await readRawWhere(harness, 'conversations', { conversationId }))[0];

    /** Waits until the stored record is marked indexed, and returns it. */
    const indexedRecord = async (read: () => Promise<RawRecord | undefined>) => {
      let record: RawRecord | undefined;
      await eventually(async () => {
        record = await read();
        expect(record).toMatchObject({
          _meiliIndex: true,
          _meiliIndexSchemaVersion: 1,
          _meiliCleanupVersion: 1,
        });
        expect(typeof record?._meiliIndexVersion).toBe('string');
      });
      return record as RawRecord;
    };

    /** Waits until the stored record is marked cleaned (kept out of the index). */
    const cleanedRecord = async (read: () => Promise<RawRecord | undefined>) =>
      eventually(async () => {
        const record = await read();
        expect(record).toBeDefined();
        expect(record?._meiliIndex ?? null).toBeNull();
        expect(record?._meiliIndexAttempted ?? null).toBeNull();
        expect(record?._meiliCleanupVersion).toBe(1);
      });

    /* ------------------------------------------------------------------ write hooks */

    describe('write hooks', () => {
      it('indexes a saved message once its write is durable, and marks it indexed', async () => {
        const conversationId = uuid();
        await saveMessage({
          messageId: 'hook-m1',
          conversationId,
          text: 'The quick brown fox',
          sender: 'User',
          isCreatedByUser: true,
        });
        const stored = await indexedRecord(() => rawMessage('hook-m1'));
        const document = fakeMeili.document('messages', 'hook-m1');
        expect(document).toMatchObject({
          messageId: 'hook-m1',
          conversationId,
          user: USER,
          sender: 'User',
          text: 'The quick brown fox',
        });
        expect(document).not.toHaveProperty('isCreatedByUser');
        expect(document).not.toHaveProperty('_id');
        expect(stored._meiliIndexAttempted).toBe(true);
      });

      it("indexes the text of a message's content parts in place of its content", async () => {
        await saveMessage({
          messageId: 'hook-parts',
          conversationId: uuid(),
          content: [
            { type: 'text', text: 'alpha section' },
            { type: 'text', text: 'beta section' },
          ],
        });
        await indexedRecord(() => rawMessage('hook-parts'));
        const document = fakeMeili.document('messages', 'hook-parts');
        expect(document).not.toHaveProperty('content');
        expect(document?.text).toEqual(expect.stringContaining('alpha section'));
        expect(document?.text).toEqual(expect.stringContaining('beta section'));
      });

      it('reindexes an updated message with its new text under a new version', async () => {
        const conversationId = uuid();
        await saveMessage({ messageId: 'hook-edit', conversationId, text: 'First draft' });
        const first = await indexedRecord(() => rawMessage('hook-edit'));
        await stores().messages.updateMessage(USER, {
          messageId: 'hook-edit',
          text: 'Final words',
        });
        await eventually(async () => {
          expect(fakeMeili.document('messages', 'hook-edit')?.text).toBe('Final words');
          const stored = await indexedRecord(() => rawMessage('hook-edit'));
          expect(stored._meiliIndexVersion).not.toBe(first._meiliIndexVersion);
        });
      });

      it('keeps a temporary message out of the index and marks it cleaned', async () => {
        await saveMessage(
          { messageId: 'hook-temp', conversationId: uuid(), text: 'Secret thought' },
          { isTemporary: true },
        );
        await cleanedRecord(() => rawMessage('hook-temp'));
        expect(fakeMeili.document('messages', 'hook-temp')).toBeUndefined();
      });

      it('indexes a saved conversation with its title and user', async () => {
        const conversationId = uuid();
        await saveConvo({ conversationId, title: 'Quarterly planning' });
        await indexedRecord(() => rawConvo(conversationId));
        expect(fakeMeili.document('convos', conversationId)).toMatchObject({
          conversationId,
          title: 'Quarterly planning',
          user: USER,
        });
      });

      it('reindexes a renamed conversation', async () => {
        const conversationId = uuid();
        await saveConvo({ conversationId, title: 'Draft title' });
        await indexedRecord(() => rawConvo(conversationId));
        await saveConvo({ conversationId, title: 'Renamed title' });
        await eventually(() =>
          expect(fakeMeili.document('convos', conversationId)?.title).toBe('Renamed title'),
        );
        await indexedRecord(() => rawConvo(conversationId));
      });

      it('keeps a temporary conversation out of the index and marks it cleaned', async () => {
        const conversationId = uuid();
        await saveConvo({ conversationId, title: 'Temporary chat' }, { isTemporary: true });
        await cleanedRecord(() => rawConvo(conversationId));
        expect(fakeMeili.document('convos', conversationId)).toBeUndefined();
      });

      it('removes deleted messages from the index', async () => {
        const conversationId = uuid();
        await saveMessage({ messageId: 'hook-del-1', conversationId, text: 'one' });
        await saveMessage({ messageId: 'hook-del-2', conversationId, text: 'two' });
        await saveMessage({ messageId: 'hook-keep', conversationId: uuid(), text: 'three' });
        await indexedRecord(() => rawMessage('hook-del-1'));
        await indexedRecord(() => rawMessage('hook-del-2'));
        await indexedRecord(() => rawMessage('hook-keep'));
        await stores().messages.deleteMessages({ conversationId });
        await eventually(() => {
          expect(fakeMeili.document('messages', 'hook-del-1')).toBeUndefined();
          expect(fakeMeili.document('messages', 'hook-del-2')).toBeUndefined();
        });
        expect(fakeMeili.document('messages', 'hook-keep')).toBeDefined();
      });

      it('removes deleted conversations from the index', async () => {
        const deleted = uuid();
        const kept = uuid();
        await saveConvo({ conversationId: deleted, title: 'Going away' });
        await saveConvo({ conversationId: kept, title: 'Staying' });
        await indexedRecord(() => rawConvo(deleted));
        await indexedRecord(() => rawConvo(kept));
        await stores().conversations.deleteConvoRecords(USER, [deleted]);
        await eventually(() => expect(fakeMeili.document('convos', deleted)).toBeUndefined());
        expect(fakeMeili.document('convos', kept)).toBeDefined();
      });
    });

    /* ------------------------------------------------------------- the index sync */

    const kinds: SearchKind[] = [
      {
        name: 'messages',
        collection: 'messages',
        meiliIndex: 'messages',
        key: 'messageId',
        record: (key, fields = {}) => ({
          _id: newId(),
          messageId: key,
          conversationId: `convo-${key}`,
          user: USER,
          text: `text of ${key}`,
          isCreatedByUser: false,
          createdAt: created,
          updatedAt: created,
          ...fields,
        }),
        excluded: { subagentTask: { attemptKey: 'attempt-1', status: 'running' } },
        indexed: (record) => ({
          messageId: record.messageId,
          conversationId: record.conversationId,
          user: record.user,
          text: record.text,
        }),
      },
      {
        name: 'conversations',
        collection: 'conversations',
        meiliIndex: 'convos',
        key: 'conversationId',
        record: (key, fields = {}) => ({
          _id: newId(),
          conversationId: key,
          user: USER,
          title: `title of ${key}`,
          endpoint: 'openAI',
          createdAt: created,
          updatedAt: created,
          ...fields,
        }),
        excluded: {
          subagentThread: {
            rootConversationId: 'root',
            parentConversationId: 'root',
            parentMessageId: 'parent-message',
            parentToolCallId: 'call-1',
            subagentType: 'researcher',
            subagentKind: 'agent',
            depth: 1,
          },
        },
        indexed: (record) => ({
          conversationId: record.conversationId,
          title: record.title,
          user: record.user,
        }),
      },
    ];

    const indexedFlags = {
      _meiliIndex: true,
      _meiliIndexSchemaVersion: 1,
      _meiliCleanupVersion: 1,
    };

    describe.each(kinds)('SearchIndexSync: $name', (kind) => {
      const seed = (records: RawRecord[]) => harness.seedRaw(kind.collection, records);
      const raw = async (key: string) =>
        (await readRawWhere(harness, kind.collection, { [kind.key]: key }))[0];
      const indexedKeys = () =>
        fakeMeili
          .documents(kind.meiliIndex)
          .map((document) => String(document[kind.key]))
          .sort();
      const future = () => new Date(Date.now() + 24 * hour);
      const past = () => new Date(Date.now() - 24 * hour);

      it('getSyncProgress counts indexed, pending and excluded records', async () => {
        await seed([
          kind.record('current-1', { ...indexedFlags, isTemporary: false }),
          kind.record('current-2', { ...indexedFlags, isTemporary: false }),
          kind.record('unindexed'),
          kind.record('failed', {
            _meiliIndex: false,
            _meiliIndexAttempted: true,
            isTemporary: false,
          }),
          kind.record('stale', {
            _meiliIndex: true,
            _meiliIndexSchemaVersion: 0,
            isTemporary: false,
          }),
          kind.record('temporary', { isTemporary: true, expiredAt: future(), _meiliIndex: false }),
          kind.record('expired', { isTemporary: false, expiredAt: past(), _meiliIndex: false }),
          kind.record('excluded-indexed', {
            ...kind.excluded,
            _meiliIndex: true,
            isTemporary: false,
          }),
          kind.record('excluded-clean', {
            ...kind.excluded,
            _meiliIndex: false,
            _meiliCleanupVersion: 1,
            isTemporary: false,
          }),
        ]);
        expect(await searchIndexSync().getSyncProgress(kind.name)).toEqual({
          totalProcessed: 2,
          totalDocuments: 5,
          pendingIndexing: 2,
          pendingCleanup: 1,
          isComplete: false,
        });
      });

      it('reports a complete index when every visible record is indexed', async () => {
        await seed([
          kind.record('current', { ...indexedFlags, isTemporary: false }),
          kind.record('temporary', { isTemporary: true, expiredAt: future() }),
        ]);
        expect(await searchIndexSync().getSyncProgress(kind.name)).toEqual({
          totalProcessed: 1,
          totalDocuments: 1,
          pendingIndexing: 0,
          pendingCleanup: 0,
          isComplete: true,
        });
      });

      it('syncIndex indexes pending records in batches after removing stale entries', async () => {
        const current = kind.record('current', { ...indexedFlags, isTemporary: false });
        const pending = ['pending-1', 'pending-2', 'pending-3'].map((key) => kind.record(key));
        const stale = kind.record('stale', {
          _meiliIndex: true,
          _meiliIndexSchemaVersion: 0,
          isTemporary: false,
        });
        const temporary = kind.record('temporary', {
          isTemporary: true,
          expiredAt: future(),
          _meiliIndex: true,
        });
        const excluded = kind.record('excluded', {
          ...kind.excluded,
          _meiliIndex: true,
          isTemporary: false,
        });
        await seed([current, ...pending, stale, temporary, excluded]);
        fakeMeili.seed(kind.meiliIndex, kind.key, [
          kind.indexed(current),
          kind.indexed(temporary),
          kind.indexed(excluded),
          { [kind.key]: 'orphan', user: USER },
        ]);

        await searchIndexSync().syncIndex(kind.name);

        expect(indexedKeys()).toEqual(
          ['current', 'pending-1', 'pending-2', 'pending-3', 'stale'].sort(),
        );
        expect(fakeMeili.document(kind.meiliIndex, 'pending-2')).toMatchObject(
          kind.indexed(pending[1]),
        );
        for (const key of ['pending-1', 'pending-2', 'pending-3', 'stale']) {
          const record = await raw(key);
          expect(record).toMatchObject({ ...indexedFlags, _meiliIndexAttempted: true });
          expect(timeOf(record.updatedAt)).toBe(created.getTime());
        }
        const cleaned = await raw('excluded');
        expect(cleaned._meiliIndex ?? null).toBeNull();
        expect(cleaned._meiliCleanupVersion).toBe(1);
        expect(await searchIndexSync().getSyncProgress(kind.name)).toEqual({
          totalProcessed: 5,
          totalDocuments: 5,
          pendingIndexing: 0,
          pendingCleanup: 0,
          isComplete: true,
        });
      });

      it('cleanupExcluded removes excluded records from the index and marks them cleaned', async () => {
        const indexed = kind.record('excluded-indexed', {
          ...kind.excluded,
          _meiliIndex: true,
          _meiliCleanupVersion: 1,
          isTemporary: false,
        });
        const attempted = kind.record('excluded-attempted', {
          ...kind.excluded,
          _meiliIndex: false,
          _meiliIndexAttempted: true,
          _meiliCleanupVersion: 1,
          isTemporary: false,
        });
        const legacy = kind.record('excluded-legacy', {
          ...kind.excluded,
          _meiliIndex: false,
          isTemporary: false,
        });
        const clean = kind.record('excluded-clean', {
          ...kind.excluded,
          _meiliIndex: false,
          _meiliCleanupVersion: 1,
          isTemporary: false,
        });
        const visible = kind.record('visible', { ...indexedFlags, isTemporary: false });
        await seed([indexed, attempted, legacy, clean, visible]);
        fakeMeili.seed(
          kind.meiliIndex,
          kind.key,
          [indexed, attempted, legacy, clean, visible].map(kind.indexed),
        );

        await searchIndexSync().cleanupExcluded(kind.name);

        expect(indexedKeys()).toEqual(['excluded-clean', 'visible']);
        for (const key of ['excluded-indexed', 'excluded-attempted', 'excluded-legacy']) {
          const record = await raw(key);
          expect(record._meiliIndex ?? null).toBeNull();
          expect(record._meiliIndexAttempted ?? null).toBeNull();
          expect(record._meiliCleanupVersion).toBe(1);
          expect(timeOf(record.updatedAt)).toBe(created.getTime());
        }
        expect(await raw('visible')).toMatchObject(indexedFlags);
        expect((await searchIndexSync().getSyncProgress(kind.name)).pendingCleanup).toBe(0);
      });

      it('resetSyncFlags marks every visible record unindexed and counts them', async () => {
        await seed([
          kind.record('indexed-1', { ...indexedFlags, isTemporary: false }),
          kind.record('indexed-2', { ...indexedFlags, isTemporary: false }),
          kind.record('unflagged'),
          kind.record('unindexed', { _meiliIndex: false, isTemporary: false }),
          kind.record('temporary', { _meiliIndex: true, isTemporary: true, expiredAt: future() }),
          kind.record('expired', { _meiliIndex: true, isTemporary: false, expiredAt: past() }),
        ]);

        expect(await searchIndexSync().resetSyncFlags(kind.name)).toBe(3);

        for (const key of ['indexed-1', 'indexed-2', 'unflagged', 'unindexed']) {
          expect((await raw(key))._meiliIndex).toBe(false);
        }
        expect((await raw('temporary'))._meiliIndex).toBe(true);
        expect((await raw('expired'))._meiliIndex).toBe(true);
        expect(timeOf((await raw('indexed-1')).updatedAt)).toBe(created.getTime());
        const progress = await searchIndexSync().getSyncProgress(kind.name);
        expect(progress).toMatchObject({ totalProcessed: 0, totalDocuments: 4 });
      });
    });

    /* ---------------------------------------------------------------- the searches */

    describe('searches', () => {
      it("searchUserMessages finds only the user's messages, hydrated on request", async () => {
        const conversationId = uuid();
        await saveMessage({
          messageId: 'search-m1',
          conversationId,
          text: 'An apple pie recipe',
          sender: 'User',
          isCreatedByUser: true,
        });
        await saveMessage({ messageId: 'search-m2', conversationId, text: 'Banana bread' });
        await saveMessage(
          { messageId: 'search-m3', conversationId: uuid(), text: 'Apple tart' },
          { userId: OTHER },
        );
        for (const messageId of ['search-m1', 'search-m2', 'search-m3']) {
          await indexedRecord(() => rawMessage(messageId));
        }

        const plain = await stores().messages.searchUserMessages({
          user: USER,
          text: 'apple',
          limit: 10,
        });
        expect(plain.hits.map((hit) => hit.messageId)).toEqual(['search-m1']);
        expect(plain.hits[0]).toMatchObject({ conversationId, text: 'An apple pie recipe' });
        expect(plain.hits[0]).not.toHaveProperty('isCreatedByUser');

        const hydrated = await stores().messages.searchUserMessages({
          user: USER,
          text: 'apple',
          limit: 10,
          hydrate: true,
        });
        expect(hydrated.hits).toHaveLength(1);
        expect(hydrated.hits[0]).toMatchObject({
          messageId: 'search-m1',
          conversationId,
          user: USER,
          text: 'An apple pie recipe',
          isCreatedByUser: true,
        });
        expect(hydrated.hits[0]).not.toHaveProperty('_meiliIndex');

        const limited = await stores().messages.searchUserMessages({
          user: USER,
          text: '',
          limit: 1,
        });
        expect(limited.hits).toHaveLength(1);
      });

      it('getConvosByCursor search matches conversation titles and message text', async () => {
        const [byTitle, byMessage, unrelated, othersMatch] = [uuid(), uuid(), uuid(), uuid()];
        await saveConvo({ conversationId: byTitle, title: 'Garden ideas' });
        await saveConvo({ conversationId: byMessage, title: 'Weekend errands' });
        await saveConvo({ conversationId: unrelated, title: 'Taxes' });
        await saveConvo({ conversationId: othersMatch, title: 'Garden party' }, { userId: OTHER });
        await saveMessage({
          messageId: 'convo-search-m1',
          conversationId: byMessage,
          text: 'buy a garden hose',
        });
        for (const conversationId of [byTitle, byMessage, unrelated, othersMatch]) {
          await indexedRecord(() => rawConvo(conversationId));
        }
        await indexedRecord(() => rawMessage('convo-search-m1'));

        const { conversations } = await stores().conversations.getConvosByCursor(USER, {
          search: 'garden',
        });
        expect(conversations.map((convo) => convo.conversationId).sort()).toEqual(
          [byTitle, byMessage].sort(),
        );
        expect(
          (await stores().conversations.getConvosByCursor(USER, { search: 'nothing here' }))
            .conversations,
        ).toEqual([]);
      });

      it('getSharedLinks search keeps the links of matching conversations', async () => {
        const user = newId();
        const [matching, other] = [uuid(), uuid()];
        await saveConvo({ conversationId: matching, title: 'Recipe book' }, { userId: user });
        await saveConvo({ conversationId: other, title: 'Travel plans' }, { userId: user });
        await indexedRecord(() => rawConvo(matching));
        await indexedRecord(() => rawConvo(other));
        await harness.seedRaw(
          'sharedlinks',
          [matching, other].map((conversationId) => ({
            _id: newId(),
            shareId: `share-${conversationId}`,
            conversationId,
            user,
            title: 'Shared',
            createdAt: created,
            updatedAt: created,
          })),
        );

        const { links } = await stores().sharedLinks.getSharedLinks(
          user,
          undefined,
          10,
          'createdAt',
          'desc',
          'recipe',
        );
        expect(links.map((link) => link.conversationId)).toEqual([matching]);
      });
    });
  });
}

/** Search on, with a MeiliSearch host and key, before the backend reads them (side-effect import: keep it first). */
import '~/contracts/searchSyncEnv';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresContractHarness } from './contractHarness';
import { createPostgresDataStoreBackend } from './backend';
import { useContractHarness } from '~/contracts/support';
import { SearchNotConfiguredError } from './search';
import { fakeMeili } from '~/contracts/meiliFake';

/** The backend's MeiliSearch client is the in-memory fake. */
jest.mock('meilisearch', () => jest.requireActual('~/contracts/meiliFake').meilisearchModule);

const CONVERSATION = '6f9619ff-8b86-4d11-b42d-00c04fc964ff';

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

/**
 * What the search sync contract (`contracts/searchSync.contract.ts`) leaves out because MongoDB
 * differs or has no equivalent: the hydrated message search reads by user and `messageId`
 * (MongoDB's reads by `messageId` alone), the bookkeeping writes that opt out of the search write
 * hook, and the backend without MeiliSearch configured.
 */
describePostgres('PostgreSQL search', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const engine = { connect: async () => database.uri, release: async () => undefined };
  const backend = createPostgresDataStoreBackend({ shadowCheck: true });
  const harness = createPostgresContractHarness(engine, { backend });
  useContractHarness(harness);
  beforeEach(() => fakeMeili.reset());

  const stores = () => harness.createStores();
  const rawMessage = async (user: string, messageId: string) =>
    (await harness.readRaw('messages')).find(
      (record) => record.user === user && record.messageId === messageId,
    );

  it('hydrates a message hit with the searching user’s message, never another user’s', async () => {
    await stores().messages.saveMessage(
      { userId: 'user-a' },
      { messageId: 'shared-id', conversationId: CONVERSATION, text: 'needle of a', sender: 'A' },
    );
    await eventually(async () =>
      expect((await rawMessage('user-a', 'shared-id'))?._meiliIndex).toBe(true),
    );
    /** Another user's message under the same `messageId`, stored but not indexed. */
    await harness.seedRaw('messages', [
      {
        _id: harness.ids.generate(),
        messageId: 'shared-id',
        conversationId: CONVERSATION,
        user: 'user-b',
        text: 'needle of b',
        sender: 'B',
        isCreatedByUser: true,
      },
    ]);

    const { hits } = await stores().messages.searchUserMessages({
      user: 'user-a',
      text: 'needle',
      limit: 5,
      hydrate: true,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ messageId: 'shared-id', user: 'user-a', sender: 'A' });
    expect(hits[0].isCreatedByUser).not.toBe(true);
  });

  it('leaves the search flags alone on the bookkeeping writes that opt out', async () => {
    await harness
      .createConversationDomain()
      .saveConvo(
        { userId: 'user-a' },
        { conversationId: CONVERSATION, title: 'Lane', endpoint: 'openAI' },
        { context: 'search spec' },
      );
    let version: unknown;
    await eventually(async () => {
      const record = (await harness.readRaw('conversations'))[0];
      expect(record._meiliIndex).toBe(true);
      version = record._meiliIndexVersion;
    });
    expect(await stores().conversations.reserveConvoLaneGitSeq('user-a', CONVERSATION)).toBe(1);
    const record = (await harness.readRaw('conversations'))[0];
    expect(record).toMatchObject({ _meiliIndex: true, _meiliIndexVersion: version });
  });

  describe('without MeiliSearch configured', () => {
    const unconfigured = createPostgresDataStoreBackend({ shadowCheck: true, search: null });
    const plain = createPostgresContractHarness(engine, { backend: unconfigured });
    beforeAll(() => plain.setup(), 120_000);
    afterAll(() => plain.teardown());

    it('writes without search flags and refuses the searches and the index sync', async () => {
      await plain
        .createStores()
        .messages.saveMessage(
          { userId: 'user-a' },
          { messageId: 'plain-1', conversationId: CONVERSATION, text: 'no index' },
        );
      const record = await rawMessage('user-a', 'plain-1');
      expect(record?._meiliIndex).toBe(false);
      expect(record?._meiliIndexVersion).toBeUndefined();
      expect(fakeMeili.documents('messages')).toEqual([]);

      await expect(
        plain.createStores().messages.searchUserMessages({ user: 'user-a', text: 'x', limit: 1 }),
      ).rejects.toThrow();
      await expect(
        plain.createStores().conversations.getConvosByCursor('user-a', { search: 'x' }),
      ).rejects.toThrow('Error during meiliSearch');
      const sync = unconfigured.getSearchIndexSync();
      await expect(sync?.syncIndex('messages')).rejects.toBeInstanceOf(SearchNotConfiguredError);
      await expect(sync?.getSyncProgress('messages')).resolves.toMatchObject({
        totalDocuments: 1,
        totalProcessed: 0,
      });
    });
  });
});

import mongoose, { Mongoose } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import type { CheckpointStore } from '~/ports/checkpointStore';
import {
  checkpointStorageKey,
  CHECKPOINT_STORE_METHODS,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
} from '~/ports/checkpointStore';
import { CHECKPOINT_DELETION_COLLECTION, createMongoCheckpointStore } from './checkpointStore';
import { CHECKPOINT_STORAGE_COLLECTION, LazyMongoSaver } from './checkpointSaver';
import { createMongoDataStoreBackend } from './backend';

const STORAGE = {
  checkpointCollectionName: 'cp',
  checkpointWritesCollectionName: 'cp_writes',
};
const SETTINGS = { type: 'mongo' as const, ttlSeconds: 60, ...STORAGE };
const OWNER = `lcg:v2:${'a'.repeat(64)}:`;
const OTHER = `lcg:v2:${'b'.repeat(64)}:`;

let server: MongoMemoryServer;
let store: CheckpointStore;

const collection = (name: string) => mongoose.connection.db!.collection(name);

async function insertBoth(rows: Record<string, unknown>[]) {
  for (const name of [STORAGE.checkpointCollectionName, STORAGE.checkpointWritesCollectionName]) {
    await collection(name).insertMany(rows.map((row) => ({ ...row })));
  }
}

async function checkpointIds(name = STORAGE.checkpointCollectionName) {
  const rows = await collection(name).find().toArray();
  return rows.map((row) => row.checkpoint_id as string).sort();
}

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(server.getUri(), { dbName: 'checkpoint_store_spec' });
  store = createMongoCheckpointStore(mongoose)!;
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('MongoDB checkpoint store', () => {
  it('has every port method and is served by the backend; null without a database', () => {
    const served = createMongoDataStoreBackend(mongoose).getCheckpointStore();
    expect(served).not.toBeNull();
    expect(Object.keys(served!).sort()).toEqual([...CHECKPOINT_STORE_METHODS].sort());
    expect(served!.isConnected()).toBe(true);
    expect(createMongoCheckpointStore(new Mongoose())).toBeNull();
  });

  it('builds the lazy saver on the selected database with every index', async () => {
    const saver = await store.createSaver(SETTINGS);
    expect(saver).toBeInstanceOf(LazyMongoSaver);
    const checkpointIndexes = await collection('cp').indexes();
    expect(checkpointIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'thread_ns_checkpoint_idx',
        'upserted_at_1',
        'checkpoint_ns_1',
        'lc_owner_1_thread_id_1',
      ]),
    );
    expect(checkpointIndexes.find((index) => index.name === 'upserted_at_1')).toMatchObject({
      expireAfterSeconds: 60,
    });
    const writeIndexes = await collection('cp_writes').indexes();
    expect(writeIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['thread_ns_checkpoint_task_idx', 'checkpoint_ns_1']),
    );
  });

  it('records the storage descriptor of an owned write and lists and deletes it', async () => {
    const saver = await store.createSaver(SETTINGS);
    const checkpoint = emptyCheckpoint();
    const config = {
      configurable: {
        thread_id: 'thread',
        checkpoint_ns: 'event-actor/x',
        checkpoint_id: checkpoint.id,
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER,
      },
    };
    await saver.putWrites(config, [[INTERRUPT, 'approve?']], 'task');
    const key = checkpointStorageKey({ type: 'mongo', ...STORAGE });
    expect(await collection(CHECKPOINT_STORAGE_COLLECTION).findOne()).toEqual({
      _id: `${OWNER}${key}`,
      owner: OWNER,
      storage: { type: 'mongo', ...STORAGE },
    });
    expect(await store.listStorageDescriptors([OWNER])).toEqual([{ type: 'mongo', ...STORAGE }]);
    expect(await store.listStorageDescriptors([OTHER])).toEqual([]);
    await store.deleteStorageDescriptors([`${OWNER}${key}`]);
    expect(await store.listStorageDescriptors([OWNER])).toEqual([]);
  });

  it('lists and deletes a generation by namespace prefix, or the legacy rows', async () => {
    await insertBoth([
      { thread_id: 't', checkpoint_ns: 'gen', checkpoint_id: 'root' },
      { thread_id: 't', checkpoint_ns: 'gen|child', checkpoint_id: 'nested' },
      { thread_id: 't', checkpoint_ns: 'generation', checkpoint_id: 'sibling' },
      { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'legacy' },
      { thread_id: 't', checkpoint_ns: `${OWNER}x`, checkpoint_id: 'owned-ns' },
      { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'owned', lc_owner: OWNER },
      { thread_id: 'u', checkpoint_ns: 'gen', checkpoint_id: 'other-thread' },
    ]);
    const scope = { threadId: 't', namespace: 'gen' };
    expect((await store.listGenerationCheckpointIds(STORAGE, scope)).sort()).toEqual([
      'nested',
      'root',
    ]);
    expect((await store.listGenerationCheckpointIds(STORAGE, { threadId: 't' })).sort()).toEqual([
      'legacy',
      'nested',
      'root',
      'sibling',
    ]);

    await store.deleteGenerationCheckpoints(STORAGE, scope, ['nested']);
    expect(await checkpointIds()).not.toContain('nested');
    expect(await checkpointIds()).toContain('root');
    await store.deleteGenerationCheckpoints(STORAGE, { threadId: 't' });
    expect(await checkpointIds()).toEqual(['other-thread', 'owned', 'owned-ns']);
    expect(await checkpointIds('cp_writes')).toEqual(['other-thread', 'owned', 'owned-ns']);
  });

  it('deletes owned rows by namespace, by owner, and exact references', async () => {
    await insertBoth([
      { thread_id: `${OWNER}t`, checkpoint_ns: `${OWNER}ns`, checkpoint_id: 'a', lc_owner: OWNER },
      {
        thread_id: `${OWNER}t`,
        checkpoint_ns: `${OWNER}ns|x`,
        checkpoint_id: 'b',
        lc_owner: OWNER,
      },
      {
        thread_id: `${OWNER}t`,
        checkpoint_ns: `${OWNER}other`,
        checkpoint_id: 'c',
        lc_owner: OWNER,
      },
      { thread_id: 't', checkpoint_ns: `${OWNER}legacy`, checkpoint_id: 'd' },
      { thread_id: 't', checkpoint_ns: 'plain', checkpoint_id: 'e' },
      { thread_id: 't', checkpoint_ns: 'plain', checkpoint_id: 'f', lc_owner: OTHER },
    ]);
    await store.deleteOwnedNamespace(STORAGE, OWNER, 't', 'ns');
    expect(await checkpointIds()).toEqual(['c', 'd', 'e', 'f']);

    await store.deleteCheckpointReference(STORAGE, {
      threadId: 't',
      checkpointNs: 'plain',
      checkpointId: 'f',
    });
    expect(await checkpointIds()).toContain('f');
    await store.deleteCheckpointReference(
      STORAGE,
      { threadId: 't', checkpointNs: 'plain', checkpointId: 'e' },
      OWNER,
    );
    expect(await checkpointIds()).toEqual(['c', 'd', 'f']);

    await store.deleteOwnerCheckpoints(STORAGE, OWNER, ['t']);
    expect(await checkpointIds()).toEqual(['f']);
    expect(await checkpointIds('cp_writes')).toEqual(['f']);

    await store.deleteCheckpointReferences(
      STORAGE,
      [{ threadId: 't', checkpointNs: 'plain', checkpointId: 'f' }],
      OTHER,
    );
    expect(await checkpointIds()).toEqual([]);
  });

  it('lists owned references by conversation and finds remaining payload', async () => {
    await insertBoth([
      { thread_id: `${OWNER}t`, checkpoint_ns: `${OWNER}ns`, checkpoint_id: 'a', lc_owner: OWNER },
      { thread_id: 't', checkpoint_ns: `${OWNER}ns`, checkpoint_id: 'b' },
      { thread_id: 'u', checkpoint_ns: 'plain', checkpoint_id: 'c', lc_owner: OTHER },
    ]);
    const references = [];
    for await (const reference of store.listOwnedCheckpointReferences(STORAGE, [OWNER], ['t'])) {
      references.push(reference);
    }
    expect(references).toHaveLength(4);
    expect(new Set(references.map((reference) => reference.conversationId))).toEqual(
      new Set(['t']),
    );
    expect(references).toContainEqual({
      conversationId: 't',
      checkpoint: { threadId: `${OWNER}t`, checkpointNs: `${OWNER}ns`, checkpointId: 'a' },
    });

    expect(await store.hasCheckpointPayload(STORAGE, [OWNER], 't')).toBe(true);
    expect(await store.hasCheckpointPayload(STORAGE, [OWNER], 'u')).toBe(false);
    expect(
      await store.hasCheckpointPayload(STORAGE, [OTHER], 'none', {
        threadId: 'u',
        checkpointNs: 'plain',
        checkpointId: 'c',
      }),
    ).toBe(true);
  });

  it('records, finds and removes deletion intents by version', async () => {
    const intent = { id: `${OWNER}k:1`, threadId: 't', storage: SETTINGS };
    const reference = { threadId: 't', checkpointNs: 'ns', checkpointId: 'c' };
    await store.saveDeletionIntents('v1', 'user', undefined, [
      intent,
      { ...intent, id: `${OWNER}k:2`, checkpoint: reference },
      { ...intent, id: `${OTHER}k:3` },
    ]);
    const byId = (intents: Array<{ id: string }>) =>
      [...intents].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(await store.findDeletionIntents([`${OWNER}[0-9a-z]:`]))).toEqual([
      expect.objectContaining({ id: `${OWNER}k:1`, version: 'v1', userId: 'user' }),
      expect.objectContaining({ id: `${OWNER}k:2`, checkpoint: reference }),
    ]);
    expect(await store.hasDeletionIntent([OTHER])).toBe(true);

    await store.saveDeletionIntents('v2', 'user', undefined, [{ ...intent, id: `${OWNER}k:2` }]);
    const second = (await store.findDeletionIntents([OWNER])).find(
      ({ id }) => id === `${OWNER}k:2`,
    );
    expect(second).toMatchObject({ version: 'v2', checkpoint: reference });

    await store.deleteDeletionIntents([
      { id: `${OWNER}k:1`, version: 'v1' },
      { id: `${OWNER}k:2`, version: 'v1' },
    ]);
    expect((await store.findDeletionIntents([OWNER])).map(({ id }) => id)).toEqual([`${OWNER}k:2`]);

    const page = await store.listDeletionIntents(undefined, 1);
    expect(page.map(({ id }) => id)).toEqual([`${OWNER}k:2`]);
    expect((await store.listDeletionIntents(page[0].id, 5)).map(({ id }) => id)).toEqual([
      `${OTHER}k:3`,
    ]);
    expect(await store.deleteDeletionIntent(`${OTHER}k:3`, 'v2')).toBe(0);
    expect(await store.deleteDeletionIntent(`${OTHER}k:3`, 'v1')).toBe(1);
    expect(await collection(CHECKPOINT_DELETION_COLLECTION).countDocuments()).toBe(1);
  });

  it('reads conversation evidence and the actor cleanup list', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    expect(await store.hasConversationRecords(userId, 'c')).toBe(false);
    await collection('toolcalls').insertOne({
      user: new mongoose.Types.ObjectId(userId),
      conversationId: 'c',
    });
    expect(await store.hasConversationRecords(userId, 'c')).toBe(true);
    expect(await store.hasConversation(userId, 'c')).toBe(false);

    const reference = { threadId: 'c', checkpointNs: 'event-actor/a', checkpointId: '1' };
    await collection('conversations').insertOne({
      user: userId,
      tenantId: null,
      conversationId: 'c',
      subagentThread: { parentConversationId: 'p' },
      agentEventActor: { checkpoint: reference },
      agentEventActorCleanup: [reference],
    });
    expect(await store.hasConversation(userId, 'c')).toBe(true);
    expect(await store.getActorCleanup(userId, undefined, 'c')).toEqual([reference]);
    expect(await store.getActorCleanup(userId, 'tenant', 'c')).toEqual([]);

    const history = [];
    for await (const conversation of store.findActorHistory(userId, 'tenant', ['c'])) {
      history.push(conversation);
    }
    expect(history).toEqual([
      expect.objectContaining({
        conversationId: 'c',
        agentEventActor: { checkpoint: reference },
        agentEventActorCleanup: [reference],
      }),
    ]);

    await store.pullActorCleanup(userId, undefined, 'c', reference);
    expect(await store.getActorCleanup(userId, undefined, 'c')).toEqual([]);
  });
});

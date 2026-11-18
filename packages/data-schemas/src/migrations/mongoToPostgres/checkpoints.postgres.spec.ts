import { Mongoose } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver, CheckpointTuple } from '@langchain/langgraph-checkpoint';
import type { MongoClient } from 'mongodb';
import type { CheckpointStore, CheckpointStorageNames } from '~/ports/checkpointStore';
import type { PostgresDataStoreConnection } from '~/adapters/postgres/connection';
import {
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
} from '~/ports/checkpointStore';
import { postgresCheckpointSchemaName } from '~/adapters/postgres/checkpointSaver';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { createPostgresDataStoreBackend } from '~/adapters/postgres/backend';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { copyMongoToPostgres, formatMongoToPostgresReport } from './index';
import { createMongoDataStoreBackend } from '~/adapters/mongo/backend';
import { OwnedMongoSaver } from '~/adapters/mongo/checkpointSaver';
import { versionedCheckpoint } from './checkpoints';

/**
 * The checkpoint half of the copy tool (docs/postgres-port/PHASE4.md D5, §8 X1): LangGraph runs
 * checkpointed on MongoDB (interrupted human-in-the-loop runs on the lazy saver, owned and
 * unowned; fully persisted runs with parents and writes on the owned saver, in a second storage)
 * are copied into PostgreSQL. Then `getTuple` and `list` answer the same on both savers, the
 * interrupted runs resume on PostgreSQL with `Command({ resume })`, the storage descriptors and
 * deletion intents read the same, and a repeated copy changes nothing.
 */
/**
 * The backend reading the copy back: `POSTGRES_ALLOW_INCOMPLETE_STORES` lets it connect while a
 * backend member is still missing (until B1); a backend without the escape hatch ignores it.
 */
const BACKEND_ENV = { POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' };
const mongoose = new Mongoose();
let server: MongoMemoryServer;
const harness = createMongoContractHarness(
  {
    async connect() {
      server = await MongoMemoryServer.create();
      return server.getUri();
    },
    async release() {
      await server.stop();
    },
  },
  mongoose,
);

const DEFAULT: CheckpointStorageNames = {
  checkpointCollectionName: 'agent_checkpoints',
  checkpointWritesCollectionName: 'agent_checkpoint_writes',
};
const CUSTOM: CheckpointStorageNames = {
  checkpointCollectionName: 'custom_checkpoints',
  checkpointWritesCollectionName: 'custom_checkpoint_writes',
};
const OWNER = `lcg:v2:${'d'.repeat(64)}:`;
const TTL = 3600;

const State = Annotation.Root({
  messages: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

/** A graph that asks, then finishes: interrupts at `ask`. */
function askGraph(saver: BaseCheckpointSaver) {
  return new StateGraph(State)
    .addNode('ask', () => {
      const answer = interrupt({ question: 'Deploy where?' }) as string;
      return { messages: [`answer:${answer}`] };
    })
    .addNode('finish', () => ({ messages: ['done'] }))
    .addEdge(START, 'ask')
    .addEdge('ask', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer: saver });
}

/** A graph of three steps, the middle one writing from two parallel tasks. */
function stepsGraph(saver: BaseCheckpointSaver) {
  return new StateGraph(State)
    .addNode('one', () => ({ messages: ['one'] }))
    .addNode('left', () => ({ messages: ['left'] }))
    .addNode('right', () => ({ messages: ['right'] }))
    .addNode('last', () => ({ messages: ['last'] }))
    .addEdge(START, 'one')
    .addEdge('one', 'left')
    .addEdge('one', 'right')
    .addEdge('left', 'last')
    .addEdge('right', 'last')
    .addEdge('last', END)
    .compile({ checkpointer: saver });
}

const askConfig = (thread: string, owned: boolean) => ({
  configurable: {
    thread_id: thread,
    [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'generation-1',
    ...(owned ? { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER } : {}),
  },
});

const stepsConfig = (thread: string, owned: boolean) => ({
  configurable: {
    thread_id: thread,
    checkpoint_ns: '',
    ...(owned ? { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER } : {}),
  },
});

/**
 * A tuple as both savers can answer it: `PostgresSaver` stores channel values per channel
 * version, so the values a MongoDB checkpoint document keeps for channels its `channel_versions`
 * do not name (LangGraph's empty `__pregel_tasks` topic) read back as the empty channels they
 * are (`versionedCheckpoint`). Everything else is compared as it is.
 */
function answer(tuple: CheckpointTuple | undefined): unknown {
  return tuple && { ...tuple, checkpoint: versionedCheckpoint(tuple.checkpoint) };
}

async function listAll(saver: BaseCheckpointSaver, config: object): Promise<unknown[]> {
  const tuples: unknown[] = [];
  for await (const tuple of saver.list(config)) tuples.push(answer(tuple));
  return tuples;
}

describePostgres('MongoDB → PostgreSQL copy of the agent checkpoints', () => {
  const database = usePostgresTestDatabase({ template: 'empty' });
  let mongoStore: CheckpointStore;
  let postgresStore: CheckpointStore;
  let connection: PostgresDataStoreConnection;
  const env = () => database.env();
  const copy = () =>
    copyMongoToPostgres({
      mongo: {
        client: mongoose.connection.getClient() as unknown as MongoClient,
        dbName: mongoose.connection.db!.databaseName,
      },
      env: env(),
      batchSize: 3,
    });

  beforeAll(async () => {
    await harness.setup();
    mongoStore = createMongoDataStoreBackend(mongoose).getCheckpointStore()!;
    const client = mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof OwnedMongoSaver
    >[0]['client'];
    const dbName = mongoose.connection.db!.databaseName;

    const lazy = await mongoStore.createSaver({ ...DEFAULT, ttlSeconds: TTL });
    for (const [thread, owned] of [
      ['conversation-1', false],
      ['conversation-2', true],
    ] as const) {
      const paused = await askGraph(lazy).invoke(
        { messages: ['hi'] },
        { ...askConfig(thread, owned), durability: 'exit' },
      );
      if ((paused as { __interrupt__?: unknown }).__interrupt__ === undefined) {
        throw new Error(`The run of ${thread} did not interrupt`);
      }
    }
    const custom = new OwnedMongoSaver({ client, dbName, ...CUSTOM });
    await stepsGraph(custom).invoke({ messages: ['go'] }, stepsConfig('conversation-3', true));
    const unownedDefault = new OwnedMongoSaver({ client, dbName, ...DEFAULT });
    await stepsGraph(unownedDefault).invoke(
      { messages: ['go'] },
      stepsConfig('conversation-4', false),
    );
    await mongoStore.saveDeletionIntents('v1', 'user-1', undefined, [
      {
        id: `${OWNER}conversation-9`,
        threadId: `${OWNER}conversation-9`,
        storage: { type: 'mongo', ...DEFAULT, ttlSeconds: TTL },
      },
    ]);

    const report = await copy();
    if (!report.ok) {
      throw new Error(formatMongoToPostgresReport(report));
    }

    const backend = createPostgresDataStoreBackend();
    connection = backend.createConnection({
      env: database.env(BACKEND_ENV),
      cache: { handle: null, promise: null },
    });
    await connection.connect();
    postgresStore = backend.getCheckpointStore()!;
  }, 180_000);

  afterAll(async () => {
    await connection?.close();
    await harness.teardown();
  });

  it('reports every storage, checkpoint and write as copied and verified', async () => {
    const report = await copy();
    expect(report.ok).toBe(true);
    const storages = report.checkpoints.map((storage) => ({
      checkpointCollection: storage.checkpointCollection,
      schema: storage.schema,
      threads: storage.threads,
      verified: storage.verified === storage.checkpoints,
      orphanWrites: storage.orphanWrites,
    }));
    expect(storages).toEqual(
      expect.arrayContaining([
        {
          checkpointCollection: 'agent_checkpoints',
          schema: postgresCheckpointSchemaName('public', DEFAULT),
          threads: 3,
          verified: true,
          orphanWrites: 0,
        },
        {
          checkpointCollection: 'custom_checkpoints',
          schema: postgresCheckpointSchemaName('public', CUSTOM),
          threads: 1,
          verified: true,
          orphanWrites: 0,
        },
      ]),
    );
    const sources = mongoose.connection.db!;
    for (const storage of report.checkpoints) {
      expect(storage.checkpoints).toBe(
        await sources.collection(storage.checkpointCollection).countDocuments(),
      );
      expect(storage.writes).toBe(
        await sources.collection(storage.writesCollection).countDocuments(),
      );
    }
  });

  it('resumes an interrupted copy of the checkpoints', async () => {
    const pool = database.pool();
    const schema = postgresCheckpointSchemaName('public', DEFAULT);
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}".checkpoint_writes WHERE thread_id = 'conversation-4'`,
    );
    /** A copy stopped after the first checkpoints of a thread, or between a put and its writes. */
    await pool.query(
      `DELETE FROM "${schema}".checkpoint_writes WHERE thread_id = 'conversation-4'`,
    );
    await pool.query(
      `DELETE FROM "${schema}".checkpoints WHERE thread_id = 'conversation-4'
        AND checkpoint_id > (SELECT min(checkpoint_id) FROM "${schema}".checkpoints
          WHERE thread_id = 'conversation-4')`,
    );
    const report = await copy();
    expect(report.ok).toBe(true);
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}".checkpoint_writes WHERE thread_id = 'conversation-4'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it.each([
    ['an unowned interrupted run', DEFAULT, askConfig('conversation-1', false)],
    ['an owned interrupted run', DEFAULT, askConfig('conversation-2', true)],
    ['an owned run with parents and writes', CUSTOM, stepsConfig('conversation-3', true)],
    ['an unowned run with parents and writes', DEFAULT, stepsConfig('conversation-4', false)],
  ])('answers getTuple and list for %s as MongoDB does', async (_name, storage, config) => {
    const fromMongo = await mongoStore.createSaver({ ...storage, ttlSeconds: TTL });
    const fromPostgres = await postgresStore.createSaver({ ...storage, ttlSeconds: TTL });
    const mongoTuple = await fromMongo.getTuple(config);
    expect(mongoTuple).toBeDefined();
    expect(answer(await fromPostgres.getTuple(config))).toEqual(answer(mongoTuple));
    const mongoList = await listAll(fromMongo, config);
    expect(mongoList.length).toBeGreaterThan(0);
    expect(await listAll(fromPostgres, config)).toEqual(mongoList);
    for await (const tuple of fromMongo.list(config)) {
      const byId = { configurable: { ...config.configurable, ...tuple.config.configurable } };
      expect(answer(await fromPostgres.getTuple(byId))).toEqual(answer(tuple));
    }
  });

  it.each([
    ['unowned', 'conversation-1', false],
    ['owned', 'conversation-2', true],
  ])('resumes the %s interrupted run on PostgreSQL', async (_name, thread, owned) => {
    const saver = await postgresStore.createSaver({ ...DEFAULT, ttlSeconds: TTL });
    const finished = await askGraph(saver).invoke(new Command({ resume: 'prod' }), {
      ...askConfig(thread, owned),
      durability: 'exit',
    });
    expect(finished.messages).toEqual(['hi', 'answer:prod', 'done']);
  });

  it('copies the storage descriptors and deletion intents', async () => {
    const sort = (list: Array<{ checkpointCollectionName: string }>) =>
      [...list].sort((a, b) =>
        a.checkpointCollectionName.localeCompare(b.checkpointCollectionName),
      );
    const mongoDescriptors = await mongoStore.listStorageDescriptors([OWNER]);
    expect(mongoDescriptors.length).toBe(2);
    expect(sort(await postgresStore.listStorageDescriptors([OWNER]))).toEqual(
      sort(mongoDescriptors),
    );
    const pattern = [`^${OWNER}`];
    expect(await postgresStore.findDeletionIntents(pattern)).toEqual(
      await mongoStore.findDeletionIntents(pattern),
    );
  });

  it('keeps owner-prefixed ids and lc_owner', async () => {
    const pool = database.pool();
    const schema = postgresCheckpointSchemaName('public', CUSTOM);
    const { rows } = await pool.query(
      `SELECT DISTINCT thread_id, lc_owner FROM "${schema}".checkpoints
       UNION SELECT DISTINCT thread_id, lc_owner FROM "${schema}".checkpoint_writes`,
    );
    expect(rows).toEqual([{ thread_id: `${OWNER}conversation-3`, lc_owner: OWNER }]);
  });
});

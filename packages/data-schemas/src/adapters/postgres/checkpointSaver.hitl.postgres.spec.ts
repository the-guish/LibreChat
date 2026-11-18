import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { Pool } from 'pg';
import type { PostgresDataStoreConnection } from './connection';
import type { CheckpointSaver } from '~/ports/checkpointStore';
import type { PostgresDataStoreBackend } from './backend';
import {
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
} from '~/ports/checkpointStore';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { postgresCheckpointSchemaName } from './checkpointSaver';
import { createPostgresDataStoreBackend } from './backend';

/**
 * A LangGraph human-in-the-loop run on the PostgreSQL saver (PHASE4.md §8 I2): a graph interrupts,
 * its pause is persisted by one backend's saver, and the run resumes with `Command({ resume })` on
 * a saver another backend (another replica) builds on the same database, reading the interrupted
 * checkpoint, its channel values and its pending writes back. The clean exit of the resumed run
 * is not persisted (lazy persistence), and deleting the generation leaves no rows behind.
 */
describePostgres('LangGraph HITL resume on the PostgreSQL checkpoint saver', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const STORAGE = {
    checkpointCollectionName: 'agent_checkpoints',
    checkpointWritesCollectionName: 'agent_checkpoint_writes',
  };
  const OWNER = `lcg:v2:${'c'.repeat(64)}:`;
  const schema = postgresCheckpointSchemaName('public', STORAGE);
  const replicas: Array<{
    backend: PostgresDataStoreBackend;
    connection: PostgresDataStoreConnection;
  }> = [];

  async function replica(): Promise<CheckpointSaver> {
    const backend = createPostgresDataStoreBackend();
    const connection = backend.createConnection({
      env: database.env({ POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' }),
      cache: { handle: null, promise: null },
    });
    await connection.connect();
    replicas.push({ backend, connection });
    return backend.getCheckpointStore()!.createSaver({ ...STORAGE, ttlSeconds: 3600 });
  }

  let pool: Pool;
  beforeAll(() => {
    pool = database.pool();
  });

  afterEach(async () => {
    for (const { connection } of replicas.splice(0)) {
      await connection.close();
    }
    await database.truncateAll();
  });

  const State = Annotation.Root({
    messages: Annotation<string[]>({
      reducer: (left, right) => left.concat(right),
      default: () => [],
    }),
  });

  function graph(saver: CheckpointSaver) {
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

  const count = async (table: string) =>
    Number(
      (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${schema}".${table}`)).rows[0].n,
    );

  it.each([['unowned'], ['owned']])(
    'resumes an %s interrupted run on another replica',
    async (kind) => {
      const isOwned = kind === 'owned';
      const owner: Record<string, string> = isOwned
        ? { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER }
        : {};
      const prefix = isOwned ? OWNER : '';
      const config = {
        configurable: {
          thread_id: 'conversation-1',
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: 'generation-1',
          ...owner,
        },
        durability: 'exit' as const,
      };
      const paused = await graph(await replica()).invoke({ messages: ['hi'] }, config);
      expect((paused as { __interrupt__?: unknown }).__interrupt__).toEqual([
        expect.objectContaining({ value: { question: 'Deploy where?' } }),
      ]);
      expect(await count('checkpoints')).toBe(1);
      expect(await count('checkpoint_writes')).toBeGreaterThan(0);

      const resumer = await replica();
      const state = await resumer.getTuple({ configurable: config.configurable });
      expect(state?.checkpoint.channel_values).toMatchObject({ messages: ['hi'] });
      expect(state?.pendingWrites?.some(([, channel]) => channel === '__interrupt__')).toBe(true);

      const finished = await graph(resumer).invoke(new Command({ resume: 'prod' }), config);
      expect(finished.messages).toEqual(['hi', 'answer:prod', 'done']);
      /** The resumed run ended cleanly: its exit checkpoint was not persisted. */
      expect(await count('checkpoints')).toBe(1);

      const store = replicas[1].backend.getCheckpointStore()!;
      const ids = await store.listGenerationCheckpointIds(STORAGE, {
        threadId: `${prefix}conversation-1`,
        namespace: `${prefix}generation-1`,
      });
      expect(ids).toHaveLength(1);
      if (isOwned) {
        await store.deleteOwnedNamespace(STORAGE, OWNER, 'conversation-1', 'generation-1');
      } else {
        await store.deleteGenerationCheckpoints(STORAGE, {
          threadId: 'conversation-1',
          namespace: 'generation-1',
        });
      }
      expect(await count('checkpoints')).toBe(0);
      expect(await count('checkpoint_writes')).toBe(0);
      expect(await count('checkpoint_blobs')).toBe(0);
    },
  );
});

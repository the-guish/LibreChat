import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';
import type { Pool } from 'pg';
import type { CheckpointSaver, CheckpointStore } from '~/ports/checkpointStore';
import type { PostgresDataStoreConnection } from './connection';
import {
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
} from '~/ports/checkpointStore';
import { postgresCheckpointSchemaName, postgresCheckpointTables } from './checkpointSaver';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresDataStoreBackend } from './backend';

/**
 * The races of the PostgreSQL checkpoint store (PHASE4.md §8 I2), each on several backends (each
 * its own pool, as replicas): concurrent setups of one storage schema, deletions racing writes of
 * the same thread and namespace (the channel values a checkpoint references must survive the
 * blob cleanup of a deletion running beside its `put`), and overlapping deletions (whose blob
 * cleanups lock the same threads and namespaces).
 */
describePostgres('PostgreSQL checkpoint store under contention', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const STORAGE = {
    checkpointCollectionName: 'agent_checkpoints',
    checkpointWritesCollectionName: 'agent_checkpoint_writes',
  };
  const schema = postgresCheckpointSchemaName('public', STORAGE);
  const tables = postgresCheckpointTables(schema);
  const connections: PostgresDataStoreConnection[] = [];
  let pool: Pool;

  async function replica(): Promise<CheckpointStore> {
    const backend = createPostgresDataStoreBackend();
    const connection = backend.createConnection({
      env: database.env({ POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' }),
      cache: { handle: null, promise: null },
    });
    await connection.connect();
    connections.push(connection);
    return backend.getCheckpointStore()!;
  }

  beforeAll(() => {
    pool = database.pool();
  });
  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      await connection.close();
    }
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await database.truncateAll();
  });

  const actor = (namespace: string, checkpointId?: string) => ({
    configurable: {
      thread_id: 't',
      checkpoint_ns: '',
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
      [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'invocation',
      ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
    },
  });
  const checkpointOf = (id: string, values: Record<string, unknown>): Checkpoint => ({
    ...emptyCheckpoint(),
    id,
    channel_values: values,
    channel_versions: Object.fromEntries(Object.keys(values).map((key) => [key, 1])),
  });
  const metadata = { source: 'loop' as const, step: 1, parents: {} };

  it('sets one storage schema up once when six replicas build its saver at the same time', async () => {
    const stores = await Promise.all(Array.from({ length: 6 }, () => replica()));
    const savers = await Promise.all(
      stores.map((store) => store.createSaver({ ...STORAGE, ttlSeconds: 3600 })),
    );
    expect(savers).toHaveLength(6);
    const versions = await pool.query<{ v: number }>(
      `SELECT v FROM "${schema}".lc_checkpoint_migrations ORDER BY v`,
    );
    expect(versions.rows.map((row) => row.v)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const saverVersions = await pool.query<{ v: number }>(
      `SELECT v FROM "${schema}".checkpoint_migrations ORDER BY v`,
    );
    expect(saverVersions.rows.map((row) => row.v)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps the channel values of a checkpoint written while a deletion removes its predecessor', async () => {
    const [writer, deleter] = await Promise.all([replica(), replica()]);
    const saver: CheckpointSaver = await writer.createSaver({ ...STORAGE, ttlSeconds: 3600 });
    await deleter.createSaver({ ...STORAGE, ttlSeconds: 3600 });
    const values = { messages: ['shared'], config: { model: 'x' } };
    for (let round = 0; round < 25; round += 1) {
      const namespace = `gen-${round}`;
      await saver.put(actor(namespace), checkpointOf(`a-${round}`, values), metadata);
      /** The successor keeps every channel at the predecessor's version (the same blobs). */
      await Promise.all([
        deleter.deleteGenerationCheckpoints(STORAGE, { threadId: 't', namespace }, [`a-${round}`]),
        saver.put(actor(namespace, `a-${round}`), checkpointOf(`b-${round}`, values), metadata, {}),
      ]);
      const tuple = await saver.getTuple(actor(namespace));
      expect(tuple?.checkpoint.id).toBe(`b-${round}`);
      expect(tuple?.checkpoint.channel_values).toEqual(values);
    }
    const orphans = await pool.query(
      `SELECT 1 FROM ${tables.blobs} b WHERE NOT EXISTS (
        SELECT 1 FROM ${tables.checkpoints} c
        WHERE c.thread_id = b.thread_id AND c.checkpoint_ns = b.checkpoint_ns)`,
    );
    expect(orphans.rowCount).toBe(0);
  });

  it('runs overlapping deletions of the same threads and namespaces without deadlocks', async () => {
    const stores = await Promise.all(Array.from({ length: 4 }, () => replica()));
    const saver = await stores[0].createSaver({ ...STORAGE, ttlSeconds: 3600 });
    await Promise.all(
      stores.slice(1).map((store) => store.createSaver({ ...STORAGE, ttlSeconds: 3600 })),
    );
    for (let index = 0; index < 40; index += 1) {
      await saver.put(
        actor(`gen-${index % 8}`),
        checkpointOf(`c-${index}`, { value: index }),
        metadata,
      );
    }
    await Promise.all([
      stores[1].deleteGenerationCheckpoints(STORAGE, { threadId: 't' }),
      stores[2].deleteOwnerCheckpoints(STORAGE, 'lcg:v2:none:'),
      stores[3].deleteCheckpointReferences(
        STORAGE,
        Array.from({ length: 40 }, (_, index) => ({
          threadId: 't',
          checkpointNs: `gen-${index % 8}`,
          checkpointId: `c-${index}`,
        })).reverse(),
        'lcg:v2:none:',
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        stores[index % 4].deleteGenerationCheckpoints(STORAGE, {
          threadId: 't',
          namespace: `gen-${7 - index}`,
        }),
      ),
    ]);
    expect(
      Number((await pool.query(`SELECT count(*) AS n FROM ${tables.checkpoints}`)).rows[0].n),
    ).toBe(0);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM ${tables.blobs}`)).rows[0].n)).toBe(
      0,
    );
  });
});

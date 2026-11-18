import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';
import type { Pool } from 'pg';
import type { PostgresDataStoreConnection } from './connection';
import type { PostgresDataStoreBackend } from './backend';
import {
  CheckpointTooLargeError,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
} from '~/ports/checkpointStore';
import {
  LazyPostgresSaver,
  postgresCheckpointTables,
  postgresCheckpointSchemaName,
  POSTGRES_CHECKPOINT_STORAGE_TABLE,
} from './checkpointSaver';
import { POSTGRES_CHECKPOINT_DELETION_TABLE, sweepExpiredCheckpoints } from './checkpointStore';
import { POSTGRES_UNIMPLEMENTED_MEMBERS, createPostgresDataStoreBackend } from './backend';
import { CHECKPOINT_DELETION_COLLECTION } from '~/adapters/mongo/checkpointStore';
import { CHECKPOINT_STORAGE_COLLECTION } from '~/adapters/mongo/checkpointSaver';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';

/**
 * What the PostgreSQL checkpoint store keeps in its storage schemas (the backend-neutral behavior
 * is in `contracts/checkpointStore.contract.ts` and `contracts/checkpointStore.saver.contract.ts`):
 * the schema and its migrations, the channel values in `checkpoint_blobs` and their cleanup, the
 * expiry, and the size guard.
 */
const STORAGE = {
  checkpointCollectionName: 'agent_checkpoints',
  checkpointWritesCollectionName: 'agent_checkpoint_writes',
};
const OWNER = `lcg:v2:${'d'.repeat(64)}:`;

describe('PostgreSQL checkpoint store, without a database', () => {
  it('is served by the backend, null while not connected, and no longer listed as missing', () => {
    expect(POSTGRES_UNIMPLEMENTED_MEMBERS).not.toContain('checkpointStore');
    const backend = createPostgresDataStoreBackend();
    expect(backend.unimplemented).not.toContain('checkpointStore');
    expect(backend.getCheckpointStore()).toBeNull();
  });

  it('keeps the MongoDB names of the descriptor and intent tables, so the copy tool maps them', () => {
    expect(POSTGRES_CHECKPOINT_STORAGE_TABLE).toBe(CHECKPOINT_STORAGE_COLLECTION);
    expect(POSTGRES_CHECKPOINT_DELETION_TABLE).toBe(CHECKPOINT_DELETION_COLLECTION);
  });

  it('names one schema per backend schema and pair of collections', () => {
    const name = postgresCheckpointSchemaName('public', STORAGE);
    expect(name).toMatch(/^lc_checkpoints_[0-9a-f]{24}$/);
    expect(postgresCheckpointSchemaName('public', { ...STORAGE })).toBe(name);
    expect(postgresCheckpointSchemaName('tenant_a', STORAGE)).not.toBe(name);
    expect(
      postgresCheckpointSchemaName('public', { ...STORAGE, checkpointWritesCollectionName: 'w' }),
    ).not.toBe(name);
    expect(postgresCheckpointTables(name)).toEqual({
      schema: name,
      checkpoints: `"${name}".checkpoints`,
      blobs: `"${name}".checkpoint_blobs`,
      writes: `"${name}".checkpoint_writes`,
    });
  });
});

describePostgres('PostgreSQL checkpoint store', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  const schema = postgresCheckpointSchemaName('public', STORAGE);
  const tables = postgresCheckpointTables(schema);
  let pool: Pool;
  let backend: PostgresDataStoreBackend;
  let connection: PostgresDataStoreConnection;

  beforeAll(async () => {
    pool = database.pool();
    backend = createPostgresDataStoreBackend();
    connection = backend.createConnection({
      env: database.env({ POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' }),
      cache: { handle: null, promise: null },
    });
    await connection.connect();
  });
  afterAll(async () => {
    await connection?.close();
  });
  beforeEach(() => database.truncateAll());

  const store = () => backend.getCheckpointStore()!;
  const saver = () => store().createSaver({ ...STORAGE, ttlSeconds: 3600 });
  const count = async (table: string, where = 'true') =>
    Number((await pool.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n);
  const actor = (namespace: string, extra: Record<string, unknown> = {}) => ({
    configurable: {
      thread_id: 't',
      checkpoint_ns: '',
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
      [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: 'invocation',
      ...extra,
    },
  });
  const checkpointOf = (
    id: string,
    values: Record<string, unknown>,
    versions: Record<string, number>,
  ): Checkpoint => ({
    ...emptyCheckpoint(),
    id,
    channel_values: values,
    channel_versions: versions,
  });
  const metadata = { source: 'loop' as const, step: 1, parents: {} };

  it('sets the storage schema up once: the saver tables, its migrations and LibreChat columns', async () => {
    await Promise.all([saver(), saver(), saver()]);
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1 AND column_name IN ('lc_owner', 'upserted_at', 'task_path')
        ORDER BY table_name, column_name`,
      [schema],
    );
    expect(columns.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      'checkpoint_writes.lc_owner',
      'checkpoint_writes.task_path',
      'checkpoint_writes.upserted_at',
      'checkpoints.lc_owner',
      'checkpoints.upserted_at',
    ]);
    expect(await count(`"${schema}".checkpoint_migrations`)).toBe(6);
    expect(await count(`"${schema}".lc_checkpoint_migrations`)).toBe(9);
    const indexes = await pool.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname',
      [schema],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'checkpoints_upserted_at',
        'checkpoint_writes_upserted_at',
        'checkpoints_checkpoint_ns',
        'checkpoint_writes_checkpoint_ns',
        'checkpoints_lc_owner_thread',
        'checkpoint_writes_lc_owner_thread',
      ]),
    );
    const comment = await pool.query<{ comment: string }>(
      `SELECT obj_description($1::regnamespace, 'pg_namespace') AS comment`,
      [schema],
    );
    expect(comment.rows[0].comment).toContain('agent_checkpoint_writes');
  });

  it('keeps channel values in blobs under the stored thread, and removes those nothing references', async () => {
    const target = await saver();
    const owned = { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER };
    await target.put(
      actor('gen', owned),
      checkpointOf('a', { messages: ['a'], kept: 'same' }, { messages: 1, kept: 1 }),
      metadata,
    );
    await target.put(
      actor('gen', { ...owned, checkpoint_id: 'a' }),
      checkpointOf('b', { messages: ['a', 'b'], kept: 'same' }, { messages: 2, kept: 1 }),
      metadata,
    );
    const blobs = await pool.query<{ thread_id: string; channel: string; version: string }>(
      `SELECT thread_id, channel, version FROM ${tables.blobs} ORDER BY channel, version`,
    );
    expect(blobs.rows.map((row) => [row.thread_id, row.channel, row.version])).toEqual([
      [`${OWNER}t`, 'kept', '1'],
      [`${OWNER}t`, 'messages', '1'],
      [`${OWNER}t`, 'messages', '2'],
    ]);
    const stamped = await pool.query<{ lc_owner: string; upserted_at: Date }>(
      `SELECT lc_owner, upserted_at FROM ${tables.checkpoints}`,
    );
    expect(stamped.rows.every((row) => row.lc_owner === OWNER && row.upserted_at != null)).toBe(
      true,
    );

    await store().deleteGenerationCheckpoints(
      STORAGE,
      { threadId: `${OWNER}t`, namespace: `${OWNER}gen` },
      ['a'],
    );
    const left = await pool.query<{ channel: string; version: string }>(
      `SELECT channel, version FROM ${tables.blobs} ORDER BY channel`,
    );
    expect(left.rows.map((row) => `${row.channel}@${row.version}`)).toEqual([
      'kept@1',
      'messages@2',
    ]);
    const tuple = await target.getTuple(actor('gen', owned));
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ['a', 'b'], kept: 'same' });

    await store().deleteOwnerCheckpoints(STORAGE, OWNER);
    expect(await count(tables.blobs)).toBe(0);
  });

  it('removes expired checkpoints and writes with their blobs, and keeps fresh ones', async () => {
    const target = await saver();
    await target.put(actor('old'), checkpointOf('old', { v: 1 }, { v: 1 }), metadata);
    await target.putWrites(actor('old', { checkpoint_id: 'old' }), [['v', 2]], 'task');
    await target.put(actor('new'), checkpointOf('new', { v: 1 }, { v: 1 }), metadata);
    await pool.query(
      `UPDATE ${tables.checkpoints} SET upserted_at = now() - interval '2 hours' WHERE checkpoint_id = 'old'`,
    );
    await pool.query(
      `UPDATE ${tables.writes} SET upserted_at = now() - interval '2 hours' WHERE checkpoint_id = 'old'`,
    );
    expect(await sweepExpiredCheckpoints(pool, schema, 3600)).toEqual({
      checkpoints: 1,
      writes: 1,
      blobs: 1,
    });
    expect(await count(tables.checkpoints)).toBe(1);
    expect(await count(tables.blobs, `checkpoint_ns = 'new'`)).toBe(1);
    expect(await count(tables.blobs)).toBe(1);
    expect(await sweepExpiredCheckpoints(pool, 'lc_checkpoints_missing', 1)).toEqual({
      checkpoints: 0,
      writes: 0,
      blobs: 0,
    });

    /** A later write of a checkpoint moves its expiry. */
    await pool.query(`UPDATE ${tables.checkpoints} SET upserted_at = now() - interval '2 hours'`);
    await target.put(actor('new'), checkpointOf('new', { v: 1 }, { v: 1 }), metadata);
    expect((await sweepExpiredCheckpoints(pool, schema, 3600)).checkpoints).toBe(0);
  });

  it('sweeps the storages of its savers every POSTGRES_TTL_INTERVAL_MS while connected', async () => {
    const sweeping = createPostgresDataStoreBackend();
    const sweepingConnection = sweeping.createConnection({
      env: database.env({
        POSTGRES_ALLOW_INCOMPLETE_STORES: 'true',
        POSTGRES_TTL_INTERVAL_MS: '100',
      }),
      cache: { handle: null, promise: null },
    });
    await sweepingConnection.connect();
    try {
      const target = await sweeping
        .getCheckpointStore()!
        .createSaver({ ...STORAGE, ttlSeconds: 1 });
      await target.put(actor('gen'), checkpointOf('c', { v: 1 }, { v: 1 }), metadata);
      await pool.query(
        `UPDATE ${tables.checkpoints} SET upserted_at = now() - interval '1 minute'`,
      );
      const deadline = Date.now() + 10_000;
      while ((await count(tables.checkpoints)) > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await count(tables.checkpoints)).toBe(0);
      expect(await count(tables.blobs)).toBe(0);
    } finally {
      await sweepingConnection.close();
    }
  });

  it('refuses a checkpoint over the size limit before writing anything', async () => {
    await saver();
    const guarded = new LazyPostgresSaver({
      pool,
      schema,
      storage: { type: 'mongo', ...STORAGE },
      recordDescriptor: async () => undefined,
      hardLimitBytes: 1024,
    });
    await expect(
      guarded.put(actor('big'), checkpointOf('big', { v: 'x'.repeat(4096) }, { v: 1 }), metadata),
    ).rejects.toBeInstanceOf(CheckpointTooLargeError);
    expect(await count(tables.checkpoints)).toBe(0);
    expect(await count(tables.blobs)).toBe(0);
  });

  it('records a storage descriptor once however many writes race', async () => {
    const target = await saver();
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        target.put(
          actor('gen', { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: OWNER }),
          checkpointOf(`c${index}`, { v: index }, { v: index + 1 }),
          metadata,
        ),
      ),
    );
    expect(await count(POSTGRES_CHECKPOINT_STORAGE_TABLE)).toBe(1);
    expect(await count(tables.checkpoints)).toBe(5);
  });
});

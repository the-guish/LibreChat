/**
 * The PostgreSQL LangGraph checkpoint saver (`CheckpointStore.createSaver` in
 * `~/ports/checkpointStore`; docs/postgres-port/PHASE4.md §4, D5, §8 I2): `PostgresSaver` from
 * `@langchain/langgraph-checkpoint-postgres` on the backend's `pg` pool, wrapped as the MongoDB
 * saver wraps `MongoDBSaver` (`adapters/mongo/checkpointSaver.ts`), with the same storage rules
 * (`~/methods/checkpointRules`):
 * - {@link OwnedPostgresSaver}: owner-isolated rows (`lc_owner`, owner-prefixed thread and
 *   namespace), the one named legacy read, and the storage descriptors (the
 *   `agent_checkpoint_stores` table, written by the store);
 * - {@link LazyPostgresSaver}: the generation namespace mapping, the lazy persistence of anchored
 *   checkpoints only, and the size guard (MongoDB's limit, kept for parity);
 * - {@link setupPostgresCheckpointStorage}: the saver's own migrations (`PostgresSaver.setup()`)
 *   and LibreChat's (`lc_owner`, `upserted_at`, the cleanup indexes), per storage schema, under an
 *   advisory lock.
 *
 * **Storage.** One storage (a pair of MongoDB collections, `CheckpointStorageNames`) is one
 * PostgreSQL schema holding the `PostgresSaver` tables (`checkpoints`, `checkpoint_blobs`,
 * `checkpoint_writes`, `checkpoint_migrations`) plus `lc_checkpoint_migrations`; its name
 * ({@link postgresCheckpointSchemaName}) is derived from the backend's schema and the two
 * collection names. LibreChat adds two columns to `checkpoints` and `checkpoint_writes`:
 * `lc_owner` (MongoDB's field: `NULL` on unowned rows) and `upserted_at` (stamped on every write,
 * the TTL's clock, as MongoDB's TTL index reads `upserted_at`).
 *
 * **Writes.** `put` and `putWrites` are LibreChat's own SQL (the owned and the unowned paths), so
 * that both stamp `upserted_at` and record the owner, and so that `put` takes the shared
 * advisory lock of its thread and namespace ({@link checkpointBlobLockKey}): channel values live
 * in `checkpoint_blobs`, shared by every checkpoint of a thread and namespace that kept a channel
 * at the same version, and the store removes the blobs no remaining checkpoint references under
 * the exclusive lock (`./checkpointStore`), which a `put` in flight cannot race. Unlike
 * `PostgresSaver`, which stores only the channels `newVersions` names, `put` stores (or keeps) the
 * blob of every channel of the checkpoint's `channel_versions` (plus `newVersions`), so a
 * persisted checkpoint never depends on the blobs of a checkpoint it did not persist (the lazy
 * saver discards most of them) or of one deleted meanwhile, as a MongoDB checkpoint document
 * holds all its channel values; `newVersions` may be omitted (the agents runtime's event actor
 * forks, `CheckpointSaver.put`). Blobs already stored at a version are kept (`DO NOTHING`).
 * Unowned reads are `PostgresSaver`'s; owned reads are LibreChat's SQL on the same tables.
 * `getDeltaChannelHistory` is the base class's walk over `getTuple`, so it applies the rules too.
 *
 * Must not import `mongoose`, `mongodb` or `bson`.
 */
import { createHash } from 'crypto';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  WRITES_IDX_MAP,
  writesSortKey,
  BaseCheckpointSaver,
  compareWritesSortKeys,
} from '@langchain/langgraph-checkpoint';
import type {
  Checkpoint,
  PendingWrite,
  ChannelVersions,
  CheckpointTuple,
  CheckpointMetadata,
  CheckpointListOptions,
  CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { Pool, PoolClient } from 'pg';
import type {
  CheckpointSaver,
  CheckpointStorageNames,
  CheckpointStorageDescriptor,
} from '~/ports/checkpointStore';
import type { CheckpointRunnableConfig as RunnableConfig } from '~/methods/checkpointRules';
import {
  sweepStale,
  checkpointOwnerOf,
  hasResumableWrite,
  CHECKPOINT_WARN_BYTES,
  isEventActorInvocation,
  ownedCheckpointIdentity,
  checkpointStorageOwnerOf,
  toStorageCheckpointConfig,
  fromStorageCheckpointTuple,
  fromStorageCheckpointConfig,
  CHECKPOINT_HARD_LIMIT_BYTES,
} from '~/methods/checkpointRules';
import {
  checkpointStorageKey,
  CheckpointTooLargeError,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
} from '~/ports/checkpointStore';
import logger from '~/config/winston';

/** The table of the storage descriptors (MongoDB's `agent_checkpoint_stores` collection). */
export const POSTGRES_CHECKPOINT_STORAGE_TABLE = 'agent_checkpoint_stores';

/** A storage descriptor as recorded: where an owner wrote checkpoints. */
export interface PostgresCheckpointStorageRecord {
  _id: string;
  owner: string;
  storage: CheckpointStorageDescriptor;
}

/**
 * The PostgreSQL schema of a storage: `lc_checkpoints_` and 24 hex digits of the SHA-256 of the
 * backend's schema and the two collection names, so two storages (or two LibreChat schemas in one
 * database) never share one, and the name stays a short lowercase identifier whatever the names.
 * The schema's comment names the storage it holds.
 */
export function postgresCheckpointSchemaName(
  mainSchema: string,
  names: CheckpointStorageNames,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        mainSchema,
        names.checkpointCollectionName,
        names.checkpointWritesCollectionName,
      ]),
    )
    .digest('hex');
  return `lc_checkpoints_${digest.slice(0, 24)}`;
}

/** The qualified (quoted) tables of a storage schema. */
export interface PostgresCheckpointTables {
  schema: string;
  checkpoints: string;
  blobs: string;
  writes: string;
}

export function postgresCheckpointTables(schema: string): PostgresCheckpointTables {
  const quoted = `"${schema}"`;
  return {
    schema,
    checkpoints: `${quoted}.checkpoints`,
    blobs: `${quoted}.checkpoint_blobs`,
    writes: `${quoted}.checkpoint_writes`,
  };
}

/**
 * The text of the advisory lock (`hashtextextended(text, 0)`) of a thread and namespace's channel
 * values in a storage: `put` holds it shared while it writes blobs and the checkpoint referencing
 * them; removing unreferenced blobs holds it exclusively.
 */
export function checkpointBlobLockKey(schema: string, threadId: string, namespace: string): string {
  return JSON.stringify(['lc_checkpoint_blobs', schema, threadId, namespace]);
}

/**
 * LibreChat's migrations of a storage schema, after `PostgresSaver`'s own; each index is a
 * version recorded in `lc_checkpoint_migrations`.
 */
function librechatCheckpointMigrations(schema: string, names: CheckpointStorageNames): string[] {
  const { checkpoints, writes } = postgresCheckpointTables(schema);
  const comment = `LibreChat agent checkpoints: ${JSON.stringify([
    names.checkpointCollectionName,
    names.checkpointWritesCollectionName,
  ])}`.replace(/'/g, "''");
  return [
    `ALTER TABLE ${checkpoints}
      ADD COLUMN IF NOT EXISTS lc_owner TEXT,
      ADD COLUMN IF NOT EXISTS upserted_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `ALTER TABLE ${writes}
      ADD COLUMN IF NOT EXISTS lc_owner TEXT,
      ADD COLUMN IF NOT EXISTS upserted_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `CREATE INDEX IF NOT EXISTS checkpoints_upserted_at ON ${checkpoints} (upserted_at)`,
    `CREATE INDEX IF NOT EXISTS checkpoint_writes_upserted_at ON ${writes} (upserted_at)`,
    `CREATE INDEX IF NOT EXISTS checkpoints_checkpoint_ns ON ${checkpoints} (checkpoint_ns text_pattern_ops)`,
    `CREATE INDEX IF NOT EXISTS checkpoint_writes_checkpoint_ns ON ${writes} (checkpoint_ns text_pattern_ops)`,
    `CREATE INDEX IF NOT EXISTS checkpoints_lc_owner_thread ON ${checkpoints} (lc_owner, thread_id)`,
    `CREATE INDEX IF NOT EXISTS checkpoint_writes_lc_owner_thread ON ${writes} (lc_owner, thread_id)`,
    `COMMENT ON SCHEMA "${schema}" IS '${comment}'`,
  ];
}

/** A `pg` pool that hands out `client` (never released by its users), for `PostgresSaver.setup()`. */
function singleClientPool(client: PoolClient): Pool {
  return {
    connect: async () => ({ query: client.query.bind(client), release: () => undefined }),
  } as unknown as Pool;
}

/**
 * Creates or migrates a storage schema: `PostgresSaver.setup()` (its schema, tables and
 * versioned migrations), then LibreChat's migrations. Runs on one pooled connection holding a
 * session advisory lock on the schema, so concurrent boots (replicas, or several savers of one
 * process) migrate it once.
 */
export async function setupPostgresCheckpointStorage(
  pool: Pool,
  schema: string,
  names: CheckpointStorageNames,
): Promise<void> {
  const client = await pool.connect();
  const lock = `lc_checkpoint_setup:${schema}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
    try {
      await new PostgresSaver(singleClientPool(client), undefined, { schema }).setup();
      const table = `"${schema}".lc_checkpoint_migrations`;
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (v INTEGER PRIMARY KEY)`);
      const { rows } = await client.query<{ v: number | null }>(`SELECT max(v) AS v FROM ${table}`);
      const migrations = librechatCheckpointMigrations(schema, names);
      for (let version = (rows[0]?.v ?? -1) + 1; version < migrations.length; version += 1) {
        await client.query('BEGIN');
        try {
          await client.query(migrations[version]);
          await client.query(`INSERT INTO ${table} (v) VALUES ($1)`, [version]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
    }
  } finally {
    client.release();
  }
}

/** A checkpoint row as the reads select it. */
interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint: Omit<Checkpoint, 'channel_values'>;
  metadata: Record<string, unknown>;
  channel_values: [Uint8Array, Uint8Array, Uint8Array][] | null;
}

/** A write row as the owned reads select it. */
interface WriteRow {
  task_id: string;
  task_path: string;
  idx: number;
  channel: string;
  type: string | null;
  blob: Uint8Array;
  checkpoint_ns: string;
}

/** What an {@link OwnedPostgresSaver} is built with. */
export interface OwnedPostgresSaverOptions {
  /** The backend's pool (shared with the stores). */
  pool: Pool;
  /** The storage's schema ({@link postgresCheckpointSchemaName}). */
  schema: string;
  /** The storage, as its descriptors record it. */
  storage: CheckpointStorageDescriptor;
  /** Records a storage descriptor unless one with its id exists. */
  recordDescriptor(record: PostgresCheckpointStorageRecord): Promise<void>;
}

/**
 * A `jsonb` value as read: the backend's pool reads `json` and `jsonb` as text (`./connection`),
 * `PostgresSaver`'s own reads parse them.
 */
function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function primitiveFilter(filter: Record<string, unknown> | undefined): Record<string, unknown> {
  for (const value of Object.values(filter ?? {})) {
    if (value !== null && typeof value === 'object') {
      throw new Error('Checkpoint metadata filters must be primitive');
    }
  }
  return filter ?? {};
}

/** Isolate physical storage by owner while preserving logical SDK references. */
export class OwnedPostgresSaver extends PostgresSaver {
  protected readonly checkpointPool: Pool;
  protected readonly tables: PostgresCheckpointTables;
  private readonly storage: CheckpointStorageDescriptor;
  private readonly recordDescriptor: OwnedPostgresSaverOptions['recordDescriptor'];
  private readonly selectSql: string;

  constructor(options: OwnedPostgresSaverOptions) {
    super(options.pool, undefined, { schema: options.schema });
    this.checkpointPool = options.pool;
    this.tables = postgresCheckpointTables(options.schema);
    this.storage = options.storage;
    this.recordDescriptor = options.recordDescriptor;
    this.selectSql = `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        checkpoint, metadata,
        (SELECT array_agg(array[bl.channel::bytea, bl.type::bytea, bl.blob])
          FROM jsonb_each_text(cp.checkpoint -> 'channel_versions')
          INNER JOIN ${this.tables.blobs} bl
            ON bl.thread_id = cp.thread_id
            AND bl.checkpoint_ns = cp.checkpoint_ns
            AND bl.channel = jsonb_each_text.key
            AND bl.version = jsonb_each_text.value
        ) AS channel_values
      FROM ${this.tables.checkpoints} cp`;
  }

  private async recordStorage(config: RunnableConfig): Promise<void> {
    const owner = checkpointStorageOwnerOf(config);
    if (owner == null) return;
    await this.recordDescriptor({
      _id: `${owner}${checkpointStorageKey(this.storage)}`,
      owner,
      storage: this.storage,
    });
  }

  private async tuple(row: CheckpointRow, owner: string, legacy = false): Promise<CheckpointTuple> {
    const namespace = row.checkpoint_ns.startsWith(owner)
      ? row.checkpoint_ns.slice(owner.length)
      : row.checkpoint_ns;
    const key = {
      thread_id: row.thread_id.startsWith(owner)
        ? row.thread_id.slice(owner.length)
        : row.thread_id,
      checkpoint_ns: namespace,
      checkpoint_id: row.checkpoint_id,
    };
    const { rows } = await this.checkpointPool.query<WriteRow>(
      `SELECT task_id, task_path, idx, channel, type, blob, checkpoint_ns
        FROM ${this.tables.writes}
        WHERE checkpoint_id = $1
          AND ((thread_id = $2 AND checkpoint_ns = $3 AND lc_owner = $4)
            OR ($5 AND thread_id = $6 AND checkpoint_ns = $7 AND lc_owner IS NULL))`,
      [
        key.checkpoint_id,
        `${owner}${key.thread_id}`,
        `${owner}${namespace}`,
        owner,
        legacy,
        key.thread_id,
        namespace,
      ],
    );
    const slots = new Map<string, WriteRow>();
    for (const write of rows) {
      const slot = JSON.stringify([write.task_id, write.idx]);
      if (!slots.has(slot) || write.checkpoint_ns === `${owner}${namespace}`) {
        slots.set(slot, write);
      }
    }
    const ordered = [...slots.values()].sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.task_path, a.task_id, a.idx),
        writesSortKey(b.task_path, b.task_id, b.idx),
      ),
    );
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      ordered.map(
        async (write) =>
          [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(write.type ?? '', write.blob),
          ] as CheckpointPendingWrite,
      ),
    );
    return {
      config: {
        configurable: {
          ...key,
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
          ...(legacy ? { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: row.checkpoint_id } : {}),
        },
      },
      checkpoint: await this._loadCheckpoint(parseJson(row.checkpoint), row.channel_values ?? []),
      metadata: (await this._loadMetadata(parseJson(row.metadata))) as CheckpointMetadata,
      pendingWrites,
      ...(row.parent_checkpoint_id == null
        ? {}
        : {
            parentConfig: {
              configurable: {
                ...key,
                checkpoint_id: row.parent_checkpoint_id,
                [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
                [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: row.parent_checkpoint_id,
              },
            },
          }),
    };
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const owner = checkpointOwnerOf(config);
    if (owner == null) return super.getTuple(config);
    const key = ownedCheckpointIdentity(config);
    const params: unknown[] = [`${owner}${key.thread_id}`, `${owner}${key.checkpoint_ns}`, owner];
    const byId =
      key.checkpoint_id == null ? '' : ` AND checkpoint_id = $${params.push(key.checkpoint_id)}`;
    let [row] = (
      await this.checkpointPool.query<CheckpointRow>(
        `${this.selectSql}
          WHERE thread_id = $1 AND checkpoint_ns = $2 AND lc_owner = $3${byId}
          ORDER BY checkpoint_id DESC LIMIT 1`,
        params,
      )
    ).rows;
    const legacy =
      key.checkpoint_id != null &&
      key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
    if (row == null && legacy) {
      [row] = (
        await this.checkpointPool.query<CheckpointRow>(
          `${this.selectSql}
            WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3 AND lc_owner IS NULL
            LIMIT 1`,
          [key.thread_id, key.checkpoint_ns, key.checkpoint_id],
        )
      ).rows;
    }
    return row == null ? undefined : this.tuple(row, owner, legacy);
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const owner = checkpointOwnerOf(config);
    const filter = primitiveFilter(options?.filter);
    if (owner == null) {
      yield* super.list(config, options);
      return;
    }
    const key = ownedCheckpointIdentity(config);
    const params: unknown[] = [`${owner}${key.thread_id}`, `${owner}${key.checkpoint_ns}`, owner];
    const conditions = ['thread_id = $1', 'checkpoint_ns = $2', 'lc_owner = $3'];
    if (Object.keys(filter).length > 0) {
      conditions.push(`metadata @> $${params.push(JSON.stringify(filter))}::jsonb`);
    }
    const before = options?.before?.configurable?.checkpoint_id;
    if (before != null) {
      if (typeof before !== 'string') throw new Error('Invalid checkpoint list boundary');
      conditions.push(`checkpoint_id < $${params.push(before)}`);
    }
    const limit =
      options?.limit == null ? '' : ` LIMIT ${Number.parseInt(String(options.limit), 10)}`;
    const { rows } = await this.checkpointPool.query<CheckpointRow>(
      `${this.selectSql} WHERE ${conditions.join(' AND ')} ORDER BY checkpoint_id DESC${limit}`,
      params,
    );
    for (const row of rows) yield await this.tuple(row, owner);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    await this.recordStorage(config);
    const owner = checkpointOwnerOf(config);
    const key = ownedCheckpointIdentity(config);
    const stored = {
      thread_id: owner == null ? key.thread_id : `${owner}${key.thread_id}`,
      checkpoint_ns: owner == null ? key.checkpoint_ns : `${owner}${key.checkpoint_ns}`,
    };
    const [blobs, serializedMetadata] = await Promise.all([
      this._dumpBlobs(stored.thread_id, stored.checkpoint_ns, checkpoint.channel_values, {
        ...checkpoint.channel_versions,
        ...newVersions,
      }),
      this._dumpMetadata(metadata),
    ]);
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
        checkpointBlobLockKey(this.tables.schema, stored.thread_id, stored.checkpoint_ns),
      ]);
      for (const blob of blobs) {
        await client.query(
          `INSERT INTO ${this.tables.blobs} (thread_id, checkpoint_ns, channel, version, type, blob)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (thread_id, checkpoint_ns, channel, version) DO NOTHING`,
          blob,
        );
      }
      await client.query(
        `INSERT INTO ${this.tables.checkpoints}
            (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata,
              lc_owner)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
            parent_checkpoint_id = EXCLUDED.parent_checkpoint_id,
            checkpoint = EXCLUDED.checkpoint,
            metadata = EXCLUDED.metadata,
            upserted_at = now()${owner == null ? '' : ',\n            lc_owner = EXCLUDED.lc_owner'}`,
        [
          stored.thread_id,
          stored.checkpoint_ns,
          checkpoint.id,
          key.checkpoint_id ?? null,
          this._dumpCheckpoint(checkpoint),
          serializedMetadata,
          owner ?? null,
        ],
      );
    });
    const reference = {
      thread_id: key.thread_id,
      checkpoint_ns: key.checkpoint_ns,
      checkpoint_id: checkpoint.id,
    };
    return {
      configurable:
        owner == null ? reference : { ...reference, [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner },
    };
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    await this.recordStorage(config);
    const owner = checkpointOwnerOf(config);
    const key = ownedCheckpointIdentity(config);
    if (key.checkpoint_id == null) {
      throw new Error(
        owner == null
          ? 'Invalid configurable.checkpoint_id: expected a string'
          : 'Owned writes require a checkpoint id',
      );
    }
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const legacy =
      owner != null && key.checkpoint_id === config.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
    const legacySlots = new Set<number>();
    if (!allSpecial && legacy) {
      const { rows } = await this.checkpointPool.query<{ idx: number }>(
        `SELECT idx FROM ${this.tables.writes}
          WHERE thread_id = $1 AND checkpoint_ns = $2 AND checkpoint_id = $3 AND task_id = $4
            AND lc_owner IS NULL`,
        [key.thread_id, key.checkpoint_ns, key.checkpoint_id, taskId],
      );
      for (const row of rows) legacySlots.add(row.idx);
    }
    const dumped = await this._dumpWrites(
      owner == null ? key.thread_id : `${owner}${key.thread_id}`,
      owner == null ? key.checkpoint_ns : `${owner}${key.checkpoint_ns}`,
      key.checkpoint_id,
      taskId,
      writes.map(([channel, value]) => [channel, value]),
      taskPath ?? '',
    );
    const rows = dumped.filter(
      (_row, idx) => !legacySlots.has(WRITES_IDX_MAP[writes[idx][0]] ?? idx),
    );
    if (rows.length === 0) return;
    const update = allSpecial
      ? `DO UPDATE SET channel = EXCLUDED.channel, type = EXCLUDED.type, blob = EXCLUDED.blob,
          upserted_at = now()${owner == null ? '' : ', lc_owner = EXCLUDED.lc_owner'}`
      : 'DO NOTHING';
    await this.transaction(async (client) => {
      for (const row of rows) {
        await client.query(
          `INSERT INTO ${this.tables.writes}
              (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type,
                blob, lc_owner)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) ${update}`,
          [...row, owner ?? null],
        );
      }
    });
  }

  /** The base class's walk over `getTuple`, so the delta history follows the storage rules. */
  override getDeltaChannelHistory(
    options: Parameters<BaseCheckpointSaver['getDeltaChannelHistory']>[0],
  ): ReturnType<BaseCheckpointSaver['getDeltaChannelHistory']> {
    return BaseCheckpointSaver.prototype.getDeltaChannelHistory.call(this, options);
  }

  private async transaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.checkpointPool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** A bookkeeping-only pending-write batch held until its checkpoint's fate is decided. */
interface BufferedWriteBatch {
  at: number;
  batches: Array<{
    config: RunnableConfig;
    writes: PendingWrite[];
    taskId: string;
    taskPath?: string;
  }>;
}

/** What a {@link LazyPostgresSaver} is built with: the owned saver's options and the size guard. */
export interface LazyPostgresSaverOptions extends OwnedPostgresSaverOptions {
  /** Soft warn threshold in bytes. Defaults to {@link CHECKPOINT_WARN_BYTES}. */
  warnBytes?: number;
  /** Hard reject limit in bytes. Defaults to {@link CHECKPOINT_HARD_LIMIT_BYTES}. */
  hardLimitBytes?: number;
}

/**
 * The PostgreSQL saver the store builds: `LazyMongoSaver`'s rules over {@link OwnedPostgresSaver}
 * (see its comment in `adapters/mongo/checkpointSaver.ts` for why and how): only checkpoints a
 * resumable write anchors, or event actor checkpoints, are persisted; bookkeeping batches follow
 * their checkpoint's fate; the generation namespace is mapped into storage and back; a checkpoint
 * over the size limit is refused with `CheckpointTooLargeError` before anything is written. The
 * size is measured as MongoDB measures it (serialized checkpoint, serialized metadata, and the
 * metadata a second time, as MongoDB stores it twice), so both backends refuse the same
 * checkpoints. `putWrites` passes LangGraph's `taskPath` on.
 */
export class LazyPostgresSaver extends OwnedPostgresSaver {
  /** checkpoint id → time the resumable `putWrites` anchoring it arrived; consumed by `put`. */
  private readonly writeAnchorIds = new Map<string, number>();
  /** checkpoint id → time its anchored `put` persisted it. */
  private readonly persistedIds = new Map<string, number>();
  /** checkpoint id → bookkeeping batches parked until the checkpoint persists or is discarded. */
  private readonly bufferedBookkeeping = new Map<string, BufferedWriteBatch>();
  private readonly warnBytes: number;
  private readonly hardLimitBytes: number;

  constructor(options: LazyPostgresSaverOptions) {
    const { warnBytes, hardLimitBytes, ...ownedOptions } = options;
    super(ownedOptions);
    this.warnBytes = warnBytes ?? CHECKPOINT_WARN_BYTES;
    this.hardLimitBytes = hardLimitBytes ?? CHECKPOINT_HARD_LIMIT_BYTES;
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(toStorageCheckpointConfig(config));
    return tuple ? fromStorageCheckpointTuple(tuple, config) : undefined;
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const storageConfig = toStorageCheckpointConfig(config);
    const storageOptions = options?.before
      ? { ...options, before: toStorageCheckpointConfig(options.before) }
      : options;
    for await (const tuple of super.list(storageConfig, storageOptions)) {
      yield fromStorageCheckpointTuple(tuple, config);
    }
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const storageConfig = toStorageCheckpointConfig(config);
    if (isEventActorInvocation(config)) {
      return super.putWrites(storageConfig, writes, taskId, taskPath);
    }
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!checkpointId) {
      return super.putWrites(storageConfig, writes, taskId, taskPath);
    }
    if (!hasResumableWrite(writes)) {
      if (this.writeAnchorIds.has(checkpointId) || this.persistedIds.has(checkpointId)) {
        return super.putWrites(storageConfig, writes, taskId, taskPath);
      }
      const batch = { config: storageConfig, writes, taskId, taskPath };
      const buffered = this.bufferedBookkeeping.get(checkpointId);
      if (buffered) {
        buffered.batches.push(batch);
      } else {
        sweepStale(this.bufferedBookkeeping, (b) => b.at);
        this.bufferedBookkeeping.set(checkpointId, { at: Date.now(), batches: [batch] });
      }
      return;
    }
    this.recordWriteAnchor(checkpointId);
    try {
      await this.flushBufferedBookkeeping(checkpointId);
      return await super.putWrites(storageConfig, writes, taskId, taskPath);
    } catch (err) {
      this.writeAnchorIds.delete(checkpointId);
      throw err;
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    if (isEventActorInvocation(config)) {
      await this.assertCheckpointFitsRecord(config, checkpoint, metadata);
      const persisted = await super.put(
        toStorageCheckpointConfig(config),
        checkpoint,
        metadata,
        newVersions,
      );
      logger.debug(
        `[checkpointer] Persisted durable checkpoint for thread ${config.configurable?.thread_id ?? 'unknown'} (${checkpoint.id})`,
      );
      return fromStorageCheckpointConfig(persisted, config);
    }
    if (this.writeAnchorIds.delete(checkpoint.id)) {
      await this.assertCheckpointFitsRecord(config, checkpoint, metadata);
      sweepStale(this.persistedIds, (t) => t);
      this.persistedIds.set(checkpoint.id, Date.now());
      const persisted = await super.put(
        toStorageCheckpointConfig(config),
        checkpoint,
        metadata,
        newVersions,
      );
      logger.debug(
        `[checkpointer] Persisted durable checkpoint for thread ${config.configurable?.thread_id ?? 'unknown'} (${checkpoint.id})`,
      );
      await this.flushBufferedBookkeeping(checkpoint.id);
      return fromStorageCheckpointConfig(persisted, config);
    }
    this.bufferedBookkeeping.delete(checkpoint.id);
    return {
      ...config,
      configurable: {
        ...config.configurable,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  private recordWriteAnchor(checkpointId: string): void {
    sweepStale(this.writeAnchorIds, (t) => t);
    this.writeAnchorIds.set(checkpointId, Date.now());
  }

  private async flushBufferedBookkeeping(checkpointId: string): Promise<void> {
    const buffered = this.bufferedBookkeeping.get(checkpointId);
    if (!buffered) {
      return;
    }
    this.bufferedBookkeeping.delete(checkpointId);
    await Promise.all(
      buffered.batches.map((b) => super.putWrites(b.config, b.writes, b.taskId, b.taskPath)),
    );
  }

  private async assertCheckpointFitsRecord(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<void> {
    const [, serializedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);
    const bytes = serializedCheckpoint.byteLength + 2 * serializedMetadata.byteLength;
    const threadId = config.configurable?.thread_id as string | undefined;
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
    if (bytes > this.hardLimitBytes) {
      this.bufferedBookkeeping.delete(checkpoint.id);
      logger.error(
        `[checkpointer] Durable checkpoint for thread ${threadId ?? 'unknown'} is ${mb(bytes)} MB, over the ${mb(this.hardLimitBytes)} MB limit; refusing the write.`,
      );
      throw new CheckpointTooLargeError(bytes, this.hardLimitBytes, threadId);
    }
    if (bytes >= this.warnBytes) {
      logger.warn(
        `[checkpointer] Durable checkpoint for thread ${threadId ?? 'unknown'} is ${mb(bytes)} MB, past the ${mb(this.warnBytes)} MB soft threshold (hard limit ${mb(this.hardLimitBytes)} MB).`,
      );
      return;
    }
    logger.debug(
      `[checkpointer] Prepared durable checkpoint for thread ${threadId ?? 'unknown'}: ${bytes} bytes`,
    );
  }
}

/**
 * Builds the durable saver of a storage: migrates its schema
 * ({@link setupPostgresCheckpointStorage}), then returns a {@link LazyPostgresSaver} on the pool.
 * Rejects when the schema cannot be set up.
 */
export async function createPostgresCheckpointSaver(
  options: LazyPostgresSaverOptions,
): Promise<CheckpointSaver> {
  await setupPostgresCheckpointStorage(options.pool, options.schema, options.storage);
  const saver = new LazyPostgresSaver(options);
  logger.info('[checkpointer] Durable PostgreSQL checkpointer ready for agent continuation');
  return saver;
}

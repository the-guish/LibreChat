/**
 * The PostgreSQL checkpoint store (`~/ports/checkpointStore`; docs/postgres-port/PHASE4.md §4, D5,
 * §8 I2), as `adapters/mongo/checkpointStore.ts` is MongoDB's. Must not import `mongoose`,
 * `mongodb` or `bson`.
 * - Checkpoints and writes live in the `PostgresSaver` tables of each storage's schema
 *   (`./checkpointSaver`: one schema per pair of collection names); owned rows carry `lc_owner`
 *   and an owner-prefixed `thread_id` and `checkpoint_ns`, as on MongoDB. The operations query
 *   them with hand-written SQL on the backend's pool. A storage whose schema does not exist yet
 *   (no saver was ever built on it) holds nothing: reads find nothing and deletes do nothing, as
 *   on a MongoDB collection never written.
 * - Owner and namespace matches keep MongoDB's patterns: an owner matches stored namespaces by the
 *   unescaped regular expression `^<owner>` (`~`, the syntax both engines share for these
 *   prefixes), a generation by its exact namespace or the namespace followed by `|` (a literal
 *   `LIKE` prefix, as MongoDB's escaped regex), the legacy rows by `checkpoint_ns !~ '^lcg:v2:'`
 *   and no owner.
 * - Deletions remove the matching write rows and checkpoint rows in MongoDB's order, then the
 *   channel values (`checkpoint_blobs`) of the threads and namespaces they touched that no
 *   remaining checkpoint references, each thread and namespace under the exclusive advisory lock
 *   a `put` holds shared while it writes ({@link removeUnreferencedCheckpointBlobs}).
 * - Expiry: MongoDB's TTL index on `upserted_at` removes checkpoints and writes the approval
 *   window after their last write. Here each storage a saver was built on is swept
 *   ({@link sweepExpiredCheckpoints}) every `POSTGRES_TTL_INTERVAL_MS` (the TTL sweeper's period,
 *   I4) while the connection is open, with the saver's `ttlSeconds`.
 * - Storage descriptors (`agent_checkpoint_stores`) and deletion intents
 *   (`agent_checkpoint_deletions`) are the raw tables of the initial migration, read and written
 *   through the collection primitive's raw mode (as MongoDB writes them through the driver); the
 *   conversation evidence reads the `conversations`, `messages`, `toolcalls` and `sharedlinks`
 *   tables the same way (no tenant policy, as MongoDB's raw collection reads).
 */
import type { Pool } from 'pg';
import type {
  CheckpointStore,
  CheckpointReference,
  CheckpointStorageNames,
  CheckpointDeletionIntent,
  CheckpointGenerationScope,
  OwnedCheckpointReference,
  ActorCheckpointHistory,
  CheckpointStorageDescriptor,
} from '~/ports/checkpointStore';
import type { PostgresCheckpointTables, PostgresCheckpointStorageRecord } from './checkpointSaver';
import type { PgCollections, PgFilter, PgRecord } from './collection';
import type { PostgresHandle } from './types';
import {
  checkpointBlobLockKey,
  postgresCheckpointTables,
  postgresCheckpointSchemaName,
  createPostgresCheckpointSaver,
  POSTGRES_CHECKPOINT_STORAGE_TABLE,
} from './checkpointSaver';
import { CHECKPOINT_NAMESPACE_SEPARATOR } from '~/methods/checkpointRules';
import { DEFAULT_TTL_INTERVAL_MS } from './ttlSweeper';
import { postgresStoreIds } from './storeIds';
import logger from '~/config/winston';

/** The table of the deletion intents (MongoDB's `agent_checkpoint_deletions` collection). */
export const POSTGRES_CHECKPOINT_DELETION_TABLE = 'agent_checkpoint_deletions';

/** Rows a TTL delete statement removes at most, as the TTL sweeper's batches. */
export const CHECKPOINT_TTL_BATCH_SIZE = 1_000;
/** Rows a listing page reads at most. */
const PAGE_SIZE = 200;
/** Threads and namespaces whose channel values one blob cleanup transaction locks at most. */
const BLOB_CLEANUP_BATCH = 200;

/** A deletion intent as stored: the intent with its id as `_id`. */
type DeletionRecord = Omit<CheckpointDeletionIntent, 'id'> & { _id: string } & PgRecord;
type DescriptorRecord = PostgresCheckpointStorageRecord & PgRecord;

/** A thread and namespace of a storage whose rows were removed. */
interface ThreadNamespace {
  thread_id: string;
  checkpoint_ns: string;
}

/** Positional parameters of a hand-written statement: `add` returns the placeholder. */
function parameters() {
  const values: unknown[] = [];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/** `value` as a literal `LIKE` pattern (escape `\`). */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The condition on a storage's rows of a thread's generation (`scope`). */
function generationCondition(
  scope: CheckpointGenerationScope,
  add: (value: unknown) => string,
): string {
  const thread = `thread_id = ${add(scope.threadId)}`;
  if (scope.namespace === undefined) {
    return `${thread} AND checkpoint_ns !~ '^lcg:v2:' AND lc_owner IS NULL`;
  }
  if (scope.namespace === '') {
    return `${thread} AND checkpoint_ns = ''`;
  }
  return `${thread} AND (checkpoint_ns = ${add(scope.namespace)} OR checkpoint_ns LIKE ${add(
    `${likeLiteral(`${scope.namespace}${CHECKPOINT_NAMESPACE_SEPARATOR}`)}%`,
  )} ESCAPE '\\')`;
}

/** The pairs of `rows`, each once. */
function distinctPairs(rows: readonly ThreadNamespace[]): ThreadNamespace[] {
  const pairs = new Map<string, ThreadNamespace>();
  for (const row of rows) {
    pairs.set(JSON.stringify([row.thread_id, row.checkpoint_ns]), {
      thread_id: row.thread_id,
      checkpoint_ns: row.checkpoint_ns,
    });
  }
  return [...pairs.values()];
}

/**
 * Removes the channel values of `pairs` (threads and namespaces of the storage `tables`) that no
 * remaining checkpoint of the same thread and namespace references at their version. Each batch
 * is one transaction that first takes the exclusive advisory lock of every pair it covers, in a
 * fixed order (so two cleanups never deadlock), and so waits for the `put`s in flight on those
 * pairs, which hold it shared from their first blob to their checkpoint.
 */
export async function removeUnreferencedCheckpointBlobs(
  pool: Pool,
  tables: PostgresCheckpointTables,
  pairs: readonly ThreadNamespace[],
): Promise<number> {
  const keyed = distinctPairs(pairs)
    .map((pair) => ({
      ...pair,
      lock: checkpointBlobLockKey(tables.schema, pair.thread_id, pair.checkpoint_ns),
    }))
    .sort((a, b) => Number(a.lock > b.lock) - Number(a.lock < b.lock));
  let removed = 0;
  for (let offset = 0; offset < keyed.length; offset += BLOB_CLEANUP_BATCH) {
    const batch = keyed.slice(offset, offset + BLOB_CLEANUP_BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended(lock, 0)) FROM unnest($1::text[]) WITH ORDINALITY AS l(lock, n) ORDER BY n',
        [batch.map((pair) => pair.lock)],
      );
      const result = await client.query(
        `DELETE FROM ${tables.blobs} b
          USING unnest($1::text[], $2::text[]) AS p(thread_id, checkpoint_ns)
          WHERE b.thread_id = p.thread_id AND b.checkpoint_ns = p.checkpoint_ns
            AND NOT EXISTS (
              SELECT 1 FROM ${tables.checkpoints} c
              WHERE c.thread_id = b.thread_id AND c.checkpoint_ns = b.checkpoint_ns
                AND c.checkpoint -> 'channel_versions' ->> b.channel = b.version
            )`,
        [batch.map((pair) => pair.thread_id), batch.map((pair) => pair.checkpoint_ns)],
      );
      await client.query('COMMIT');
      removed += result.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return removed;
}

/** What a TTL pass over one storage removed. */
export interface CheckpointSweepResult {
  checkpoints: number;
  writes: number;
  blobs: number;
}

/**
 * Removes the checkpoints and writes of the storage schema `schema` whose `upserted_at` is at or
 * before `now` minus `ttlSeconds` (as MongoDB's TTL monitor removes documents whose indexed date
 * is), in batches of {@link CHECKPOINT_TTL_BATCH_SIZE} rows (rows another transaction has locked
 * are left for the next pass), then the channel values no remaining checkpoint references. A
 * schema that does not exist yet has nothing to remove.
 */
export async function sweepExpiredCheckpoints(
  pool: Pool,
  schema: string,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<CheckpointSweepResult> {
  const tables = postgresCheckpointTables(schema);
  const result: CheckpointSweepResult = { checkpoints: 0, writes: 0, blobs: 0 };
  const { rows } = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [tables.writes],
  );
  if (!rows[0]?.exists) {
    return result;
  }
  const cutoff = new Date(now.getTime() - ttlSeconds * 1000);
  const touched: ThreadNamespace[] = [];
  for (const kind of ['writes', 'checkpoints'] as const) {
    const table = tables[kind];
    for (;;) {
      const deleted = await pool.query<ThreadNamespace>(
        `DELETE FROM ${table}
          WHERE ctid = ANY (ARRAY (
            SELECT ctid FROM ${table} WHERE upserted_at <= $1 LIMIT $2 FOR UPDATE SKIP LOCKED
          ))
          AND upserted_at <= $1
          RETURNING thread_id, checkpoint_ns`,
        [cutoff, CHECKPOINT_TTL_BATCH_SIZE],
      );
      result[kind] += deleted.rowCount ?? 0;
      if (kind === 'checkpoints') {
        touched.push(...deleted.rows);
      }
      if ((deleted.rowCount ?? 0) < CHECKPOINT_TTL_BATCH_SIZE) {
        break;
      }
    }
  }
  result.blobs = await removeUnreferencedCheckpointBlobs(pool, tables, touched);
  return result;
}

/** The storages a connection's savers were built on, swept while the connection is open. */
interface CheckpointExpiry {
  storages: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
}

const expiries = new WeakMap<Pool, CheckpointExpiry>();

/** Registers `schema` (with its TTL) for the periodic sweep of `pool`, starting it once. */
function scheduleExpiry(
  pool: Pool,
  schema: string,
  ttlSeconds: number,
  intervalMs: number,
  isConnected: () => boolean,
): void {
  let expiry = expiries.get(pool);
  if (!expiry) {
    expiry = { storages: new Map() };
    expiries.set(pool, expiry);
  }
  expiry.storages.set(schema, ttlSeconds);
  if (expiry.timer) {
    return;
  }
  const state = expiry;
  const tick = async () => {
    state.timer = undefined;
    if (!isConnected()) {
      expiries.delete(pool);
      return;
    }
    for (const [storage, ttl] of state.storages) {
      try {
        await sweepExpiredCheckpoints(pool, storage, ttl);
      } catch (error) {
        if (!isConnected()) {
          expiries.delete(pool);
          return;
        }
        logger.error(`[checkpointer] Removing expired checkpoints of ${storage} failed:`, error);
      }
    }
    state.timer = setTimeout(tick, intervalMs);
    state.timer.unref?.();
  };
  state.timer = setTimeout(tick, intervalMs);
  state.timer.unref?.();
}

/** What {@link createPostgresCheckpointStore} is built with. */
export interface PostgresCheckpointStoreOptions {
  /** The connected handle: its pool runs the checkpoint SQL, its schema names the storages. */
  handle: PostgresHandle;
  /** The backend's collections, for the raw tables (descriptors, intents, conversations). */
  collections(): PgCollections;
  /** Whether the backend's connection still has `handle` open. */
  isConnected(): boolean;
  /** The period of the expiry sweep (default: the TTL sweeper's, 60 s). */
  ttlIntervalMs?: number;
}

/** Records `record` unless a descriptor with its id exists (racing writers converge on one row). */
async function recordDescriptor(
  collections: () => PgCollections,
  record: PostgresCheckpointStorageRecord,
): Promise<void> {
  await collections()
    .raw<DescriptorRecord>(POSTGRES_CHECKPOINT_STORAGE_TABLE)
    .updateOne(
      { _id: record._id },
      { $setOnInsert: { owner: record.owner, storage: record.storage } },
      { upsert: true },
    );
}

function toDeletionIntent({ _id, ...intent }: DeletionRecord): CheckpointDeletionIntent {
  return { id: _id, ...intent } as CheckpointDeletionIntent;
}

/** A projection as a tree of paths: `true` keeps the whole value at that path. */
type ProjectionTree = { [key: string]: ProjectionTree | true };

/**
 * `value` projected on `tree` as MongoDB projects a document: an object keeps the projected keys it
 * has (an intermediate object stays, even when none of its projected keys exist), an array is
 * projected element by element (elements that are not objects are dropped), and anything else
 * below a projected path is left out.
 */
function projectValue(value: unknown, tree: ProjectionTree): unknown {
  if (Array.isArray(value)) {
    return value
      .map((element) => projectValue(element, tree))
      .filter((element) => element !== undefined);
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, branch] of Object.entries(tree)) {
    const inner = (value as Record<string, unknown>)[key];
    if (inner === undefined) {
      continue;
    }
    const projected = branch === true ? inner : projectValue(inner, branch);
    if (projected !== undefined) {
      result[key] = projected;
    }
  }
  return result;
}

/**
 * The paths of the event actor evidence `findActorHistory` reads below what the primitive
 * projects (the suspension is `Mixed`, the reconciliations a child table), as MongoDB's projection
 * names them.
 */
const ACTOR_HISTORY_PROJECTION: ProjectionTree = {
  agentEventActorSuspension: {
    suspension: { checkpoint: true, invocation: { fork: true, base: { checkpoint: true } } },
  },
  agentEventActorReconciliations: { checkpoint: true },
};

function toActorHistory(record: PgRecord): ActorCheckpointHistory {
  const history: Record<string, unknown> = { ...record };
  for (const [key, tree] of Object.entries(ACTOR_HISTORY_PROJECTION)) {
    if (history[key] === undefined || tree === true) {
      continue;
    }
    const projected = projectValue(history[key], tree);
    if (projected === undefined) {
      delete history[key];
    } else {
      history[key] = projected;
    }
  }
  return history as unknown as ActorCheckpointHistory;
}

/** The checkpoint store on the connected `handle` (see the module header). */
export function createPostgresCheckpointStore(
  options: PostgresCheckpointStoreOptions,
): CheckpointStore {
  const { pool } = options.handle;
  const raw = <T extends PgRecord>(table: string) => options.collections().raw<T>(table);
  const deletions = () => raw<DeletionRecord>(POSTGRES_CHECKPOINT_DELETION_TABLE);
  const descriptors = () => raw<DescriptorRecord>(POSTGRES_CHECKPOINT_STORAGE_TABLE);
  const conversations = () => raw<PgRecord>('conversations');

  /** Schemas known to exist (a schema is never dropped by the store). */
  const existing = new Set<string>();
  const storageTables = async (
    storage: CheckpointStorageNames,
  ): Promise<PostgresCheckpointTables | null> => {
    const schema = postgresCheckpointSchemaName(options.handle.schema, storage);
    const tables = postgresCheckpointTables(schema);
    if (existing.has(schema)) {
      return tables;
    }
    const { rows } = await pool.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS exists',
      [tables.writes, `"${schema}".lc_checkpoint_migrations`],
    );
    if (!rows[0]?.exists) {
      return null;
    }
    existing.add(schema);
    return tables;
  };

  /**
   * Removes the rows of both tables matching `condition` (built on its own parameters), writes
   * first unless `checkpointsFirst`, then the channel values nothing references any more.
   */
  const removeRows = async (
    tables: PostgresCheckpointTables,
    condition: string,
    values: unknown[],
    checkpointsFirst = false,
  ): Promise<void> => {
    const deleteWrites = () =>
      pool.query(`DELETE FROM ${tables.writes} WHERE ${condition}`, values);
    const deleteCheckpoints = () =>
      pool.query<ThreadNamespace>(
        `DELETE FROM ${tables.checkpoints} WHERE ${condition} RETURNING thread_id, checkpoint_ns`,
        values,
      );
    let touched: ThreadNamespace[];
    if (checkpointsFirst) {
      touched = (await deleteCheckpoints()).rows;
      await deleteWrites();
    } else {
      await deleteWrites();
      touched = (await deleteCheckpoints()).rows;
    }
    await removeUnreferencedCheckpointBlobs(pool, tables, touched);
  };

  /** The condition of rows owned by one of `owners`: by owned namespace or recorded owner. */
  const ownership = (owners: readonly string[], add: (value: unknown) => string) =>
    `(checkpoint_ns ~ ANY (${add(owners.map((owner) => `^${owner}`))}::text[]) OR lc_owner = ANY (${add(
      owners,
    )}::text[]))`;

  const store: CheckpointStore = {
    isConnected: () => options.isConnected(),

    async createSaver(saverOptions) {
      const names = {
        checkpointCollectionName: saverOptions.checkpointCollectionName,
        checkpointWritesCollectionName: saverOptions.checkpointWritesCollectionName,
      };
      const schema = postgresCheckpointSchemaName(options.handle.schema, names);
      const saver = await createPostgresCheckpointSaver({
        pool,
        schema,
        storage: { type: 'mongo', ...names },
        recordDescriptor: (record) => recordDescriptor(options.collections, record),
      });
      existing.add(schema);
      scheduleExpiry(
        pool,
        schema,
        saverOptions.ttlSeconds,
        options.ttlIntervalMs ?? DEFAULT_TTL_INTERVAL_MS,
        options.isConnected,
      );
      return saver;
    },

    async listGenerationCheckpointIds(storage, scope) {
      const tables = await storageTables(storage);
      if (!tables) {
        return [];
      }
      const { values, add } = parameters();
      const { rows } = await pool.query<{ checkpoint_id: string }>(
        `SELECT checkpoint_id FROM ${tables.checkpoints} WHERE ${generationCondition(scope, add)}`,
        values,
      );
      return rows.map((row) => row.checkpoint_id);
    },

    async deleteGenerationCheckpoints(storage, scope, checkpointIds) {
      const tables = await storageTables(storage);
      if (!tables) {
        return;
      }
      const { values, add } = parameters();
      const condition = `${generationCondition(scope, add)}${
        checkpointIds ? ` AND checkpoint_id = ANY (${add([...checkpointIds])}::text[])` : ''
      }`;
      await removeRows(tables, condition, values);
    },

    async deleteOwnedNamespace(storage, owner, threadId, namespace) {
      const tables = await storageTables(storage);
      if (!tables) {
        return;
      }
      const { values, add } = parameters();
      const condition = `lc_owner = ${add(owner)} AND ${generationCondition(
        { threadId: `${owner}${threadId}`, namespace: `${owner}${namespace}` },
        add,
      )}`;
      await removeRows(tables, condition, values);
    },

    async deleteOwnerCheckpoints(storage, owner, conversationIds) {
      const tables = await storageTables(storage);
      if (!tables) {
        return;
      }
      const ids = conversationIds == null ? undefined : [...new Set(conversationIds)];
      const batchSize = 128;
      for (let offset = 0; offset < (ids?.length ?? 1); offset += batchSize) {
        const { values, add } = parameters();
        const threads = ids
          ?.slice(offset, offset + batchSize)
          .flatMap((id) => [id, `${owner}${id}`]);
        const condition = `${ownership([owner], add)}${
          threads ? ` AND thread_id = ANY (${add(threads)}::text[])` : ''
        }`;
        await removeRows(tables, condition, values, true);
      }
    },

    async deleteCheckpointReference(storage, reference, owner) {
      const tables = await storageTables(storage);
      if (!tables) {
        return;
      }
      const { values, add } = parameters();
      const condition = `thread_id = ${add(reference.threadId)} AND checkpoint_ns = ${add(
        reference.checkpointNs,
      )} AND checkpoint_id = ${add(reference.checkpointId)} AND ${
        owner == null ? 'lc_owner IS NULL' : `(lc_owner = ${add(owner)} OR lc_owner IS NULL)`
      }`;
      await removeRows(tables, condition, values);
    },

    async deleteCheckpointReferences(storage, references, owner) {
      if (references.length === 0) {
        return;
      }
      const tables = await storageTables(storage);
      if (!tables) {
        return;
      }
      for (let offset = 0; offset < references.length; offset += 256) {
        const batch = references.slice(offset, offset + 256);
        const { values, add } = parameters();
        const condition = `(lc_owner = ${add(owner)} OR lc_owner IS NULL)
          AND (thread_id, checkpoint_ns, checkpoint_id) IN (
            SELECT * FROM unnest(${add(batch.map((r) => r.threadId))}::text[], ${add(
              batch.map((r) => r.checkpointNs),
            )}::text[], ${add(batch.map((r) => r.checkpointId))}::text[]))`;
        await removeRows(tables, condition, values);
      }
    },

    async *listOwnedCheckpointReferences(
      storage: CheckpointStorageNames,
      owners: readonly string[],
      conversationIds?: readonly string[],
    ): AsyncGenerator<OwnedCheckpointReference> {
      const tables = await storageTables(storage);
      if (!tables) {
        return;
      }
      for (let offset = 0; offset < (conversationIds?.length ?? 1); offset += 64) {
        const logicalIds = new Map<string, string>();
        for (const id of conversationIds?.slice(offset, offset + 64) ?? []) {
          logicalIds.set(id, id);
          for (const owner of owners) logicalIds.set(`${owner}${id}`, id);
        }
        for (const [table, keys] of [
          [tables.checkpoints, ['thread_id', 'checkpoint_ns', 'checkpoint_id']],
          [tables.writes, ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx']],
        ] as const) {
          let after: unknown[] | undefined;
          for (;;) {
            const { values, add } = parameters();
            const conditions = [ownership(owners, add)];
            if (conversationIds != null) {
              conditions.push(`thread_id = ANY (${add([...logicalIds.keys()])}::text[])`);
            }
            if (after) {
              conditions.push(
                `(${keys.join(', ')}) > (${after.map((value) => add(value)).join(', ')})`,
              );
            }
            const { rows } = await pool.query<
              Record<string, unknown> & {
                thread_id: string;
                checkpoint_ns: string;
                checkpoint_id: string;
                lc_owner: string | null;
              }
            >(
              `SELECT ${[...new Set([...keys, 'lc_owner'])].join(', ')} FROM ${table}
                WHERE ${conditions.join(' AND ')}
                ORDER BY ${keys.join(', ')} LIMIT ${PAGE_SIZE}`,
              values,
            );
            for (const row of rows) {
              const logicalThread =
                row.lc_owner != null &&
                owners.includes(row.lc_owner) &&
                row.thread_id.startsWith(row.lc_owner)
                  ? row.thread_id.slice(row.lc_owner.length)
                  : row.thread_id;
              yield {
                conversationId: logicalIds.get(row.thread_id) ?? logicalThread,
                checkpoint: {
                  threadId: row.thread_id,
                  checkpointNs: row.checkpoint_ns,
                  checkpointId: row.checkpoint_id,
                },
              };
            }
            if (rows.length < PAGE_SIZE) {
              break;
            }
            const last = rows[rows.length - 1];
            after = keys.map((key) => last[key]);
          }
        }
      }
    },

    async hasCheckpointPayload(storage, owners, threadId, reference) {
      const tables = await storageTables(storage);
      if (!tables) {
        return false;
      }
      const { values, add } = parameters();
      const branches = owners.map(
        (owner) =>
          `(thread_id = ANY (${add([threadId, `${owner}${threadId}`])}::text[]) AND ${ownership(
            [owner],
            add,
          )})`,
      );
      if (reference != null) {
        branches.push(
          `(thread_id = ${add(reference.threadId)} AND checkpoint_ns = ${add(
            reference.checkpointNs,
          )} AND checkpoint_id = ${add(reference.checkpointId)} AND (lc_owner = ANY (${add(
            owners,
          )}::text[]) OR lc_owner IS NULL))`,
        );
      }
      if (branches.length === 0) {
        return false;
      }
      const condition = branches.join(' OR ');
      const { rows } = await pool.query<{ found: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${tables.checkpoints} WHERE ${condition})
          OR EXISTS (SELECT 1 FROM ${tables.writes} WHERE ${condition}) AS found`,
        values,
      );
      return rows[0]?.found === true;
    },

    async listStorageDescriptors(owners) {
      const records = await descriptors().find({
        $or: owners.map((owner) => ({ _id: { $regex: `^${owner}` } })),
      });
      return records.map(({ storage }) => storage as CheckpointStorageDescriptor);
    },

    async deleteStorageDescriptors(ids) {
      await descriptors().deleteMany({ _id: { $in: [...ids] } });
    },

    async findDeletionIntents(idPatterns) {
      const intents = await deletions().find({
        $or: idPatterns.map((prefix) => ({ _id: { $regex: `^${prefix}` } })),
      });
      return intents.map(toDeletionIntent);
    },

    async hasDeletionIntent(idPatterns) {
      const pending = await deletions().exists({
        $or: idPatterns.map((prefix) => ({ _id: { $regex: `^${prefix}` } })),
      });
      return pending != null;
    },

    async saveDeletionIntents(version, userId, tenantId, intents) {
      for (const target of intents) {
        await deletions().updateOne(
          { _id: target.id },
          {
            $set: {
              version,
              threadId: target.threadId,
              userId,
              tenantId: tenantId ?? null,
              storage: target.storage,
              ...(target.checkpoint && { checkpoint: target.checkpoint }),
            },
          },
          { upsert: true },
        );
      }
    },

    async deleteDeletionIntents(intents) {
      await deletions().deleteMany({
        $or: intents.map(({ id, version }) => ({ _id: id, version })),
      });
    },

    async listDeletionIntents(after, limit) {
      const intents = await deletions().find(after == null ? {} : { _id: { $gt: after } }, {
        sort: { _id: 1 },
        limit,
      });
      return intents.map(toDeletionIntent);
    },

    async deleteDeletionIntent(id, version) {
      return (await deletions().deleteOne({ _id: id, version })).deletedCount;
    },

    async hasConversationRecords(userId, conversationId) {
      const filter = { user: userId, conversationId };
      const rows = await Promise.all([
        conversations().exists(filter),
        raw<PgRecord>('messages').exists(filter),
        postgresStoreIds.isValid(userId)
          ? raw<PgRecord>('toolcalls').exists(filter)
          : Promise.resolve(null),
        raw<PgRecord>('sharedlinks').exists(filter),
      ]);
      return rows.some((row) => row != null);
    },

    async hasConversation(userId, conversationId) {
      return (await conversations().exists({ user: userId, conversationId })) != null;
    },

    async getActorCleanup(user, tenantId, conversationId) {
      const conversation = await conversations().findOne(
        { user, tenantId: tenantId ?? null, conversationId },
        { projection: { agentEventActorCleanup: 1 } },
      );
      return (conversation?.agentEventActorCleanup as CheckpointReference[] | undefined) ?? [];
    },

    async pullActorCleanup(user, tenantId, conversationId, reference: CheckpointReference) {
      await conversations().updateOne(
        { user, tenantId: tenantId ?? null, conversationId },
        { $pull: { agentEventActorCleanup: { ...reference } } },
      );
    },

    async *findActorHistory(
      user: string,
      tenantId: string | undefined,
      conversationIds?: readonly string[],
    ): AsyncGenerator<ActorCheckpointHistory> {
      const filter: PgFilter = {
        user,
        tenantId: tenantId ? { $in: [tenantId, null] } : null,
        subagentThread: { $exists: true },
        ...(conversationIds && { conversationId: { $in: [...conversationIds] } }),
      };
      let after: string | undefined;
      for (;;) {
        const page = await conversations().find(
          after == null ? filter : { $and: [filter, { _id: { $gt: after } }] },
          {
            projection: {
              conversationId: 1,
              'agentEventActor.checkpoint': 1,
              'agentEventActor.previousCheckpoint': 1,
              'agentEventActorSuspension.suspension': 1,
              agentEventActorReconciliations: 1,
              agentEventActorCleanup: 1,
            },
            sort: { _id: 1 },
            limit: PAGE_SIZE,
          },
        );
        for (const conversation of page) {
          yield toActorHistory(conversation);
        }
        if (page.length < PAGE_SIZE) {
          break;
        }
        after = String(page[page.length - 1]._id);
      }
    },
  };
  return store;
}

/**
 * The TTL sweeper (docs/postgres-port/PHASE4.md §1.7, §8 I4): PostgreSQL's stand-in for
 * MongoDB's TTL monitor. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Driven by the TTL rules of the schema descriptor (`TableDescriptor.ttl`, generated from the
 * schemas' TTL indexes and the raw collections', `browser_setup_sessions.deleteAfter` and the
 * key-value store's `expires_at` included): a row expires once its rule's column plus
 * `expireAfterSeconds` is at or before now, as MongoDB's monitor removes documents whose indexed
 * date is at or before now minus the offset. A row whose column is `NULL` never expires (MongoDB
 * ignores documents without a date there), and a partial rule (`schedules`: `erased = true`) also
 * needs its predicate. Child and element rows go with their parent row (`ON DELETE CASCADE`).
 *
 * A pass ({@link sweepExpiredPostgresRows}) runs on one pooled connection: it takes a
 * session-level advisory lock with `pg_try_advisory_lock` and returns at once when another
 * replica holds it (that replica is sweeping), then deletes each rule's expired rows in batches
 * of {@link TTL_SWEEP_BATCH_SIZE}, each batch its own statement (short row locks; rows another
 * transaction has locked are skipped until the next pass), until a batch comes back short. A
 * failing table is logged and reported, and the pass goes on with the next. Tables the database
 * lacks (a schema migrated by other migrations, in specs) are skipped.
 *
 * The connection (`./connection`) starts a sweeper ({@link createPostgresTtlSweeper}) once it is
 * connected and stops it before closing the pool, so it runs only with `DATABASE_BACKEND=postgres`;
 * passes run every `POSTGRES_TTL_INTERVAL_MS` (default 60 s, MongoDB's monitor period), the first
 * one interval after connecting. Like MongoDB's, removal lags expiry by up to one interval (R7).
 */
import { sql } from 'kysely';
import type { SchemaDescriptor } from './schema/descriptor';
import type { PostgresKysely } from './types';
import { SCHEMA_DESCRIPTOR } from './schema/descriptor.generated';
import logger from '~/config/winston';

/** The period of the sweeper when `POSTGRES_TTL_INTERVAL_MS` is not set. */
export const DEFAULT_TTL_INTERVAL_MS = 60_000;
/** The rows one delete statement removes at most. */
export const TTL_SWEEP_BATCH_SIZE = 1_000;
/**
 * The advisory lock key of the sweeper (the migrator's post-migration step uses
 * 7451062315930470731, Kysely's migration lock another).
 */
export const TTL_SWEEP_LOCK_KEY = '7451062315930470732';
const LOCK_KEY = sql.raw(TTL_SWEEP_LOCK_KEY);

/** One TTL rule, with the table it applies to. */
export interface TtlSweepTarget {
  table: string;
  /** The `timestamptz` column the rule reads. */
  column: string;
  expireAfterSeconds: number;
  /** The partial predicate rows must also match (generated SQL on the table's columns). */
  where?: string;
  /** The MongoDB index the rule comes from. */
  mongoName: string;
}

/** Every TTL rule of `descriptor`, in table order. */
export function collectTtlSweepTargets(
  descriptor: SchemaDescriptor = SCHEMA_DESCRIPTOR,
): TtlSweepTarget[] {
  return descriptor.tables.flatMap((table) =>
    table.ttl.map((rule) => ({
      table: table.name,
      column: rule.column,
      expireAfterSeconds: rule.expireAfterSeconds,
      ...(rule.where ? { where: rule.where } : {}),
      mongoName: rule.mongoName,
    })),
  );
}

/**
 * The sweeper's period from `POSTGRES_TTL_INTERVAL_MS`: a positive number of milliseconds, or
 * {@link DEFAULT_TTL_INTERVAL_MS} when it is unset or not one.
 */
export function readTtlIntervalMs(env: Readonly<Record<string, string | undefined>>): number {
  const value = Number(env.POSTGRES_TTL_INTERVAL_MS?.trim() || NaN);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) || 1 : DEFAULT_TTL_INTERVAL_MS;
}

/** Options of a pass. */
export interface TtlSweepOptions {
  /** The clock (the current time by default); read once per pass. */
  now?: () => Date;
  /** The rules (the generated descriptor's by default). */
  targets?: readonly TtlSweepTarget[];
  /** Rows per delete statement ({@link TTL_SWEEP_BATCH_SIZE} by default). */
  batchSize?: number;
  /** Checked between batches: once it answers `true` the pass ends early (the sweeper stopping). */
  shouldStop?: () => boolean;
}

/** What a pass did. */
export interface TtlSweepResult {
  /** Whether it held the lock; `false` when another session was sweeping (nothing was done). */
  locked: boolean;
  /** Rows deleted per table (tables with none left out); child rows are not counted. */
  deleted: Record<string, number>;
  /** The error message per table whose deletes failed. */
  failed: Record<string, string>;
  /** Tables of the rules that the database does not have. */
  missing: string[];
  /** Whether the pass ended early because `shouldStop` answered `true`. */
  stopped: boolean;
}

/** The single pooled connection a pass runs on (`db.connection()`). */
type Connection = PostgresKysely;

/** The tables of `names` that exist in the connection's current schema. */
async function existingTables(connection: Connection, names: string[]): Promise<Set<string>> {
  const { rows } = await sql<{ name: string }>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = current_schema()::regnamespace
      AND relkind IN ('r', 'p')
      AND relname = ANY (${names}::text[])
  `.execute(connection);
  return new Set(rows.map((row) => row.name));
}

/** Deletes up to `limit` rows of `target` expired at `cutoff`; resolves to how many. */
async function deleteBatch(
  connection: Connection,
  target: TtlSweepTarget,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const table = sql.id(target.table);
  const predicate = target.where ? sql.raw(` AND (${target.where})`) : sql.raw('');
  const expired = sql`${sql.id(target.column)} <= ${cutoff}::timestamptz${predicate}`;
  /** `ctid` names the rows the subquery picked; the outer condition is checked again on the row
   *  version the delete finds, so a row updated meanwhile (its expiry pushed back) stays. */
  const result = await sql`
    DELETE FROM ${table}
    WHERE ctid = ANY (ARRAY (
      SELECT ctid FROM ${table} WHERE ${expired} LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ))
    AND ${expired}
  `.execute(connection);
  return Number(result.numAffectedRows ?? 0);
}

/**
 * One pass of the sweeper on a connection of `db`'s pool (see the module header). Rejects only
 * when the lock cannot be queried; a table's failure is logged and reported in the result.
 */
export async function sweepExpiredPostgresRows(
  db: PostgresKysely,
  options: TtlSweepOptions = {},
): Promise<TtlSweepResult> {
  const targets = options.targets ?? collectTtlSweepTargets();
  const batchSize = options.batchSize ?? TTL_SWEEP_BATCH_SIZE;
  const result: TtlSweepResult = {
    locked: false,
    deleted: {},
    failed: {},
    missing: [],
    stopped: false,
  };
  return db.connection().execute(async (connection) => {
    const { rows } = await sql<{
      locked: boolean;
    }>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`.execute(connection);
    if (!rows[0].locked) {
      return result;
    }
    result.locked = true;
    try {
      const tables = [...new Set(targets.map((target) => target.table))];
      const existing = await existingTables(connection, tables);
      result.missing = tables.filter((table) => !existing.has(table));
      const now = (options.now ?? (() => new Date()))().getTime();
      for (const target of targets) {
        if (!existing.has(target.table)) {
          continue;
        }
        const cutoff = new Date(now - target.expireAfterSeconds * 1000);
        let deleted = 0;
        try {
          for (;;) {
            if (options.shouldStop?.()) {
              result.stopped = true;
              break;
            }
            const count = await deleteBatch(connection, target, cutoff, batchSize);
            deleted += count;
            if (count < batchSize) {
              break;
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.failed[target.table] = message;
          logger.error(
            `[ttlSweeper] Removing expired rows of ${target.table} (${target.mongoName}) failed: ${message}`,
          );
        }
        if (deleted > 0) {
          result.deleted[target.table] = (result.deleted[target.table] ?? 0) + deleted;
        }
        if (result.stopped) {
          break;
        }
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`.execute(connection);
    }
    return result;
  });
}

/** Options of {@link createPostgresTtlSweeper}. */
export interface PostgresTtlSweeperOptions extends Omit<TtlSweepOptions, 'shouldStop'> {
  /** The period ({@link DEFAULT_TTL_INTERVAL_MS} by default). */
  intervalMs?: number;
  /** Told about every scheduled pass that completed (specs, metrics); must not throw. */
  onSweep?: (result: TtlSweepResult) => void;
}

/** A sweeper running passes on a timer. */
export interface PostgresTtlSweeper {
  readonly intervalMs: number;
  /** Schedules a pass every `intervalMs` (the first one interval from now); idempotent. */
  start(): void;
  /**
   * Cancels the next pass and waits for the one in progress, which ends after its current batch.
   * The sweeper may be started again.
   */
  stop(): Promise<void>;
  /** Whether passes are scheduled. */
  isStarted(): boolean;
  /** Runs one pass now (outside the schedule). */
  sweep(): Promise<TtlSweepResult>;
}

/**
 * A sweeper on `db` (see the module header). Its timer does not keep the process alive, and a
 * pass never overlaps the next: the next one is scheduled when the current one ends.
 */
export function createPostgresTtlSweeper(
  db: PostgresKysely,
  options: PostgresTtlSweeperOptions = {},
): PostgresTtlSweeper {
  const intervalMs = options.intervalMs ?? DEFAULT_TTL_INTERVAL_MS;
  let started = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inProgress: Promise<void> | undefined;

  const sweep = () =>
    sweepExpiredPostgresRows(db, {
      now: options.now,
      targets: options.targets,
      batchSize: options.batchSize,
      shouldStop: () => stopping,
    });

  function schedule(): void {
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  }

  function tick(): void {
    timer = undefined;
    inProgress = sweep()
      .then(
        (result) => {
          options.onSweep?.(result);
        },
        (error: unknown) => {
          logger.error('[ttlSweeper] A pass failed:', error);
        },
      )
      .finally(() => {
        inProgress = undefined;
        if (started) {
          schedule();
        }
      });
  }

  return {
    intervalMs,
    start() {
      if (started) {
        return;
      }
      started = true;
      stopping = false;
      schedule();
    },
    async stop() {
      started = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      stopping = true;
      try {
        await inProgress;
      } finally {
        stopping = false;
      }
    },
    isStarted: () => started,
    sweep,
  };
}

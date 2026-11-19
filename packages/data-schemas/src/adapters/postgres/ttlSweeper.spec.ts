import { sql, Kysely, PostgresDialect } from 'kysely';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TtlSweepResult, TtlSweepTarget } from './ttlSweeper';
import type { PostgresKysely, PostgresTables } from './types';
import type { TableDescriptor } from './schema/descriptor';
import {
  TTL_SWEEP_LOCK_KEY,
  TTL_SWEEP_BATCH_SIZE,
  DEFAULT_TTL_INTERVAL_MS,
  readTtlIntervalMs,
  collectTtlSweepTargets,
  createPostgresTtlSweeper,
  sweepExpiredPostgresRows,
} from './ttlSweeper';
import { createPostgresDataStoreConnection, getPostgresTtlSweeper } from './connection';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { SCHEMA_DESCRIPTOR } from './schema/descriptor.generated';
import { generatePostgresStoreId } from './storeIds';

const TABLES = new Map(SCHEMA_DESCRIPTOR.tables.map((table) => [table.name, table]));
const TARGETS = collectTtlSweepTargets();

/**
 * Rows matching and missing each partial TTL predicate of the descriptor. A new partial TTL rule
 * fails the fake-clock spec until its predicate is listed here.
 */
const PARTIAL_FIXTURES: Record<
  string,
  { match: Record<string, unknown>; miss: Record<string, unknown> }
> = {
  '"erased" = TRUE': { match: { erased: true }, miss: { erased: false } },
};

describe('TTL rules and settings', () => {
  it('collects every TTL rule of the descriptor, the key-value store and browser setup included', () => {
    const rules = SCHEMA_DESCRIPTOR.tables.flatMap((table) =>
      table.ttl.map((rule) => [table.name, rule.column, rule.expireAfterSeconds, rule.where]),
    );
    expect(TARGETS.map((t) => [t.table, t.column, t.expireAfterSeconds, t.where])).toEqual(rules);
    expect(TARGETS).toHaveLength(21);
    expect(TARGETS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'key_value_entries', column: 'expires_at' }),
        expect.objectContaining({ table: 'browser_setup_sessions', column: 'deleteAfter' }),
        expect.objectContaining({ table: 'schedules', where: '"erased" = TRUE' }),
        expect.objectContaining({ table: 'users', expireAfterSeconds: 604800 }),
      ]),
    );
  });

  it('reads POSTGRES_TTL_INTERVAL_MS, defaulting to 60 s', () => {
    expect(DEFAULT_TTL_INTERVAL_MS).toBe(60_000);
    expect(readTtlIntervalMs({})).toBe(60_000);
    expect(readTtlIntervalMs({ POSTGRES_TTL_INTERVAL_MS: '' })).toBe(60_000);
    expect(readTtlIntervalMs({ POSTGRES_TTL_INTERVAL_MS: ' 5000 ' })).toBe(5000);
    for (const value of ['0', '-1', 'soon', 'Infinity']) {
      expect(readTtlIntervalMs({ POSTGRES_TTL_INTERVAL_MS: value })).toBe(60_000);
    }
  });
});

/** A value of a column of type `sqlType` that differs for each `n`. */
function distinctValue(sqlType: string, n: number): unknown {
  if (sqlType.startsWith('lc_object_id')) {
    return generatePostgresStoreId();
  }
  if (sqlType.startsWith('text')) {
    return `u${n}`;
  }
  if (sqlType === 'double precision' || sqlType === 'integer') {
    return n;
  }
  if (sqlType === 'timestamptz') {
    return new Date(n * 1000);
  }
  throw new Error(`No distinct value for a ${sqlType} column`);
}

/**
 * A row of `table` with key `n` and `values`, as column → value. The first key column of each
 * unique index gets a value of its own, so the rows (mostly `NULL` elsewhere) never collide
 * under `NULLS NOT DISTINCT`.
 */
function rowOf(table: TableDescriptor, n: number, values: Record<string, unknown>) {
  const row: Record<string, unknown> =
    table.name === 'key_value_entries'
      ? { store: 'ttl', key: `k${n}` }
      : { _id: table.idType === 'objectId' ? generatePostgresStoreId() : `id-${n}` };
  for (const index of table.indexes) {
    const column = index.unique ? index.keys[0].column : undefined;
    if (column && !(column in row)) {
      const sqlType = table.columns.find((candidate) => candidate.name === column)!.sqlType;
      row[column] = distinctValue(sqlType, n);
    }
  }
  return { ...row, ...values };
}

async function insert(db: PostgresKysely, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await sql`INSERT INTO ${sql.id(table)} (${sql.join(columns.map((c) => sql.id(c)))})
    VALUES (${sql.join(columns.map((c) => row[c]))})`.execute(db);
}

/** The key of a row as the spec names it (`_id`, or `key` on the key-value table). */
const keyOf = (row: Record<string, unknown>) => String(row._id ?? row.key);

async function remainingKeys(db: PostgresKysely, table: TableDescriptor): Promise<string[]> {
  const key = table.name === 'key_value_entries' ? 'key' : '_id';
  const { rows } = await sql<{ k: string }>`SELECT ${sql.id(key)}::text AS k FROM ${sql.id(
    table.name,
  )}`.execute(db);
  return rows.map((row) => row.k).sort();
}

describePostgres('TTL sweeper on PostgreSQL', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let db: PostgresKysely;

  beforeAll(() => {
    db = database.kysely();
  });
  beforeEach(() => database.truncateAll());

  describe('on a fake clock, every TTL table of the descriptor', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it.each(TARGETS.map((target) => [target.table, target] as const))(
      '%s: removes rows once their date plus expireAfterSeconds has passed, children by cascade',
      async (_name, target: TtlSweepTarget) => {
        const table = TABLES.get(target.table)!;
        const partial = target.where ? PARTIAL_FIXTURES[target.where] : undefined;
        if (target.where && !partial) {
          throw new Error(`Add fixtures for the partial TTL predicate ${target.where}`);
        }
        const children = SCHEMA_DESCRIPTOR.tables.filter((child) => child.parent === table.name);
        expect(
          SCHEMA_DESCRIPTOR.tables.filter((t) => children.some((c) => t.parent === c.name)),
        ).toEqual([]);

        const start = Date.parse('2030-01-01T00:00:00.000Z');
        jest.useFakeTimers({
          now: start,
          doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
        });
        const offset = target.expireAfterSeconds * 1000;
        const firstPass = start + DEFAULT_TTL_INTERVAL_MS;
        const at = (ms: number) => new Date(ms);
        const match = partial?.match ?? {};
        const rows = {
          expired: rowOf(table, 1, { [target.column]: at(firstPass - offset - 1000), ...match }),
          boundary: rowOf(table, 2, { [target.column]: at(firstPass - offset), ...match }),
          later: rowOf(table, 3, { [target.column]: at(firstPass - offset + 30_000), ...match }),
          future: rowOf(table, 4, { [target.column]: at(firstPass + 365 * 86_400_000), ...match }),
          undated: rowOf(table, 5, { [target.column]: null, ...match }),
          ...(partial
            ? { excluded: rowOf(table, 6, { [target.column]: at(0), ...partial.miss }) }
            : {}),
        };
        for (const row of Object.values(rows)) {
          await insert(db, table.name, row);
        }
        for (const child of children) {
          for (const parent of [rows.expired, rows.future]) {
            await insert(db, child.name, { _parent: parent._id, _ord: 0 });
          }
        }

        const passes: TtlSweepResult[] = [];
        let notify: () => void = () => undefined;
        const sweeper = createPostgresTtlSweeper(db, {
          onSweep: (result) => {
            passes.push(result);
            notify();
          },
        });
        const nextPass = () =>
          new Promise<void>((resolve) => {
            notify = resolve;
          });
        sweeper.start();
        try {
          let done = nextPass();
          await jest.advanceTimersByTimeAsync(DEFAULT_TTL_INTERVAL_MS - 1);
          expect(passes).toHaveLength(0);
          await jest.advanceTimersByTimeAsync(1);
          await done;
          expect(passes[0]).toMatchObject({ locked: true, failed: {}, missing: [] });
          expect(passes[0].deleted[table.name]).toBe(2);
          const kept = [rows.later, rows.future, rows.undated, rows.excluded].filter(Boolean);
          expect(await remainingKeys(db, table)).toEqual(
            kept.map((row) => keyOf(row as Record<string, unknown>)).sort(),
          );
          for (const child of children) {
            const { rows: left } = await sql<{
              parent: string;
            }>`SELECT "_parent"::text AS parent FROM ${sql.id(child.name)}`.execute(db);
            expect(left).toEqual([{ parent: rows.future._id }]);
          }

          done = nextPass();
          await jest.advanceTimersByTimeAsync(DEFAULT_TTL_INTERVAL_MS);
          await done;
          expect(passes[1].deleted[table.name]).toBe(1);
          expect(await remainingKeys(db, table)).toEqual(
            [rows.future, rows.undated, rows.excluded]
              .filter(Boolean)
              .map((row) => keyOf(row as Record<string, unknown>))
              .sort(),
          );
        } finally {
          await sweeper.stop();
        }
        expect(sweeper.isStarted()).toBe(false);
      },
    );
  });

  describe('a pass', () => {
    const kvTarget = TARGETS.find((target) => target.table === 'key_value_entries')!;
    const seedExpired = (count: number) =>
      sql`INSERT INTO key_value_entries (store, key, value, expires_at)
        SELECT 'bulk', 'k' || n, 'v', now() - interval '1 hour' FROM generate_series(1, ${count}) AS n`.execute(
        db,
      );
    const remaining = async () =>
      Number(
        (await sql<{ n: string }>`SELECT count(*) AS n FROM key_value_entries`.execute(db)).rows[0]
          .n,
      );

    it('deletes in batches of 1,000 rows per table', async () => {
      await seedExpired(2_500);
      const deletes: string[] = [];
      const observed = new Kysely<PostgresTables>({
        dialect: new PostgresDialect({ pool: database.pool() }),
        log: (event) => {
          if (/^\s*DELETE FROM "key_value_entries"/.test(event.query.sql)) {
            deletes.push(event.query.sql);
          }
        },
      });
      try {
        const result = await sweepExpiredPostgresRows(observed, { targets: [kvTarget] });
        expect(TTL_SWEEP_BATCH_SIZE).toBe(1_000);
        expect(result).toEqual({
          locked: true,
          deleted: { key_value_entries: 2_500 },
          failed: {},
          missing: [],
          stopped: false,
        });
        expect(deletes).toHaveLength(3);
        expect(deletes[0]).toContain('LIMIT $');
        expect(await remaining()).toBe(0);
      } finally {
        await observed.destroy();
      }
    });

    it('ends after the current batch once asked to stop', async () => {
      await seedExpired(30);
      let batches = 0;
      const result = await sweepExpiredPostgresRows(db, {
        targets: [kvTarget],
        batchSize: 10,
        shouldStop: () => batches++ >= 1,
      });
      expect(result).toMatchObject({ stopped: true, deleted: { key_value_entries: 10 } });
      expect(await remaining()).toBe(20);
    });

    it('skips tables the database lacks and reports a failing table, going on with the next', async () => {
      await seedExpired(3);
      const result = await sweepExpiredPostgresRows(db, {
        targets: [
          { table: 'no_such_table', column: 'expiresAt', expireAfterSeconds: 0, mongoName: 'x' },
          {
            table: 'users',
            column: 'expiresAt',
            expireAfterSeconds: 0,
            where: 'no_such_column',
            mongoName: 'y',
          },
          kvTarget,
        ],
      });
      expect(result.missing).toEqual(['no_such_table']);
      expect(result.failed.users).toMatch(/no_such_column/);
      expect(result.deleted).toEqual({ key_value_entries: 3 });
    });

    it('leaves rows another transaction has locked for the next pass', async () => {
      await seedExpired(5);
      const other = database.pool();
      const client = await other.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM key_value_entries WHERE key = 'k1' FOR UPDATE`);
        const result = await sweepExpiredPostgresRows(db, { targets: [kvTarget] });
        expect(result.deleted).toEqual({ key_value_entries: 4 });
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const result = await sweepExpiredPostgresRows(db, { targets: [kvTarget] });
      expect(result.deleted).toEqual({ key_value_entries: 1 });
    });
  });

  describe('across two connections', () => {
    it('sweeps on one session at a time: a pass returns at once while another holds the lock', async () => {
      await sql`INSERT INTO key_value_entries (store, key, value, expires_at)
        VALUES ('s', 'k', 'v', now() - interval '1 minute')`.execute(db);
      const first = database.pool({ max: 1 });
      const second = database.kysely({ max: 1 });
      const holder = await first.connect();
      try {
        const { rows } = await holder.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(${TTL_SWEEP_LOCK_KEY}) AS locked`,
        );
        expect(rows[0].locked).toBe(true);
        const blocked = await sweepExpiredPostgresRows(second);
        expect(blocked).toEqual({
          locked: false,
          deleted: {},
          failed: {},
          missing: [],
          stopped: false,
        });
        expect(
          (await sql<{ n: string }>`SELECT count(*) AS n FROM key_value_entries`.execute(db))
            .rows[0].n,
        ).toBe('1');
        await holder.query(`SELECT pg_advisory_unlock(${TTL_SWEEP_LOCK_KEY})`);
      } finally {
        holder.release();
      }
      const swept = await sweepExpiredPostgresRows(second);
      expect(swept).toMatchObject({ locked: true, deleted: { key_value_entries: 1 } });
      const { rows: locks } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
        WHERE l.locktype = 'advisory' AND d.datname = current_database()`.execute(db);
      expect(locks[0].n).toBe('0');
    });

    it('never runs two passes at once: concurrent sweepers delete each row once', async () => {
      await sql`INSERT INTO key_value_entries (store, key, value, expires_at)
        SELECT 'bulk', 'k' || n, 'v', now() - interval '1 hour' FROM generate_series(1, 5000) AS n`.execute(
        db,
      );
      const sessions = [database.kysely({ max: 1 }), database.kysely({ max: 1 })];
      const results = await Promise.all(
        sessions.map((session) => sweepExpiredPostgresRows(session, { batchSize: 100 })),
      );
      const locked = results.filter((result) => result.locked);
      expect(locked.length).toBeGreaterThanOrEqual(1);
      const total = results.reduce(
        (sum, result) => sum + (result.deleted.key_value_entries ?? 0),
        0,
      );
      expect(total).toBe(5000);
      if (locked.length === 1) {
        expect(results.find((result) => !result.locked)).toMatchObject({ deleted: {} });
      }
    });
  });

  describe('with the connection lifecycle', () => {
    it('starts on connect with POSTGRES_TTL_INTERVAL_MS, sweeps, and stops on close', async () => {
      await sql`INSERT INTO key_value_entries (store, key, value, expires_at)
        VALUES ('s', 'old', 'v', now() - interval '1 minute'),
               ('s', 'new', 'v', now() + interval '1 hour')`.execute(db);
      const connection = createPostgresDataStoreConnection({
        env: database.env({ POSTGRES_TTL_INTERVAL_MS: '100' }),
        cache: { handle: null, promise: null },
      });
      const handle = await connection.connect();
      const sweeper = getPostgresTtlSweeper(handle)!;
      try {
        expect(sweeper.isStarted()).toBe(true);
        expect(sweeper.intervalMs).toBe(100);
        const deadline = Date.now() + 10_000;
        let keys: string[] = [];
        while (Date.now() < deadline) {
          keys = (
            await sql<{ key: string }>`SELECT key FROM key_value_entries`.execute(db)
          ).rows.map((row) => row.key);
          if (keys.length === 1) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(keys).toEqual(['new']);
      } finally {
        await connection.close();
      }
      expect(sweeper.isStarted()).toBe(false);
      expect(getPostgresTtlSweeper(handle)).toBeUndefined();
    });

    it('uses 60 s when POSTGRES_TTL_INTERVAL_MS is unset', async () => {
      const connection = createPostgresDataStoreConnection({
        env: database.env(),
        cache: { handle: null, promise: null },
      });
      const handle = await connection.connect();
      try {
        expect(getPostgresTtlSweeper(handle)?.intervalMs).toBe(60_000);
      } finally {
        await connection.close();
      }
    });
  });
});

describe('TTL sweeper with DATABASE_BACKEND=mongo', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('is never created: the MongoDB connection keeps its TTL indexes', async () => {
    const previous = process.env.DATABASE_BACKEND;
    const created = jest.fn();
    let backend:
      | {
          name: string;
          createConnection: (options: { env: Record<string, string> }) => {
            connect(): Promise<unknown>;
            close(): Promise<void>;
          };
        }
      | undefined;
    try {
      process.env.DATABASE_BACKEND = 'mongo';
      jest.isolateModules(() => {
        jest.doMock('~/adapters/postgres/ttlSweeper', () => ({
          ...jest.requireActual('~/adapters/postgres/ttlSweeper'),
          createPostgresTtlSweeper: created,
        }));
        const { getDataStoreBackend } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry
          require('~/adapters/backend') as typeof import('~/adapters/backend');
        backend = getDataStoreBackend() as unknown as typeof backend;
      });
    } finally {
      if (previous === undefined) {
        delete process.env.DATABASE_BACKEND;
      } else {
        process.env.DATABASE_BACKEND = previous;
      }
    }
    expect(backend!.name).toBe('mongo');
    const connection = backend!.createConnection({ env: { MONGO_URI: server.getUri() } });
    await connection.connect();
    await connection.close();
    expect(created).not.toHaveBeenCalled();
  });
});

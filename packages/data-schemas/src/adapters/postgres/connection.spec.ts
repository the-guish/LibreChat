import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';
import type { DataStoreQueryObservation } from '~/ports/connection';
import type { PostgresConnectionCache } from './connection';
import {
  assertPostgresServerFacts,
  readPostgresServerFacts,
  readPostgresConnectionSettings,
  createPostgresDataStoreConnection,
} from './connection';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { DATA_STORE_CONNECTION_METHODS } from '~/ports/connection';

const newCache = (): PostgresConnectionCache => ({ handle: null, promise: null });

describe('readPostgresConnectionSettings', () => {
  it('requires POSTGRES_URI', () => {
    expect(() => readPostgresConnectionSettings({})).toThrow(
      'Please define the POSTGRES_URI environment variable',
    );
  });

  it('defaults to the public schema, the pool default and migrations on boot', () => {
    expect(readPostgresConnectionSettings({ POSTGRES_URI: 'postgresql://h/db' })).toEqual({
      uri: 'postgresql://h/db',
      schema: 'public',
      autoMigrate: true,
    });
  });

  it('reads the schema, the pool size and the migration switch', () => {
    expect(
      readPostgresConnectionSettings({
        POSTGRES_URI: 'postgresql://h/db',
        POSTGRES_SCHEMA: ' librechat ',
        POSTGRES_POOL_MAX: '25',
        POSTGRES_AUTO_MIGRATE: 'false',
      }),
    ).toEqual({ uri: 'postgresql://h/db', schema: 'librechat', poolMax: 25, autoMigrate: false });
  });

  it('ignores a pool size that is not a positive number', () => {
    for (const POSTGRES_POOL_MAX of ['0', '-3', 'many', '']) {
      expect(
        readPostgresConnectionSettings({ POSTGRES_URI: 'postgresql://h/db', POSTGRES_POOL_MAX }),
      ).not.toHaveProperty('poolMax');
    }
  });

  it('refuses a schema that is not a lowercase identifier', () => {
    for (const POSTGRES_SCHEMA of ['Public', 'a-b', '1abc', 'x;drop']) {
      expect(() =>
        readPostgresConnectionSettings({ POSTGRES_URI: 'postgresql://h/db', POSTGRES_SCHEMA }),
      ).toThrow('POSTGRES_SCHEMA');
    }
  });

  it('throws from createPostgresDataStoreConnection when the URI is missing', () => {
    expect(() => createPostgresDataStoreConnection({ env: {} })).toThrow('POSTGRES_URI');
  });
});

describe('assertPostgresServerFacts (boot checks)', () => {
  const good = {
    versionNum: 150000,
    version: '15.0',
    standardConformingStrings: 'on',
    hasIcu: true,
  };

  it('accepts PostgreSQL 15 and later with ICU and standard strings', () => {
    expect(() => assertPostgresServerFacts(good)).not.toThrow();
    expect(() =>
      assertPostgresServerFacts({ ...good, versionNum: 170002, version: '17.2' }),
    ).not.toThrow();
  });

  it('refuses PostgreSQL 14 and older', () => {
    expect(() =>
      assertPostgresServerFacts({ ...good, versionNum: 140011, version: '14.11' }),
    ).toThrow('PostgreSQL 15 or later is required; the server is 14.11');
  });

  it('refuses a server built without ICU', () => {
    expect(() => assertPostgresServerFacts({ ...good, hasIcu: false })).toThrow('und-x-icu');
  });

  it('refuses standard_conforming_strings off', () => {
    expect(() => assertPostgresServerFacts({ ...good, standardConformingStrings: 'off' })).toThrow(
      'standard_conforming_strings',
    );
  });
});

describePostgres('PostgreSQL connection', () => {
  const database = usePostgresTestDatabase();

  it('passes the boot checks on the test server', async () => {
    const facts = await readPostgresServerFacts(database.kysely());
    expect(facts.versionNum).toBeGreaterThanOrEqual(150000);
    expect(() => assertPostgresServerFacts(facts)).not.toThrow();
  });

  it('has every DataStoreConnection method', () => {
    const connection = createPostgresDataStoreConnection({
      env: database.env(),
      cache: newCache(),
    });
    for (const method of DATA_STORE_CONNECTION_METHODS) {
      expect(typeof connection[method]).toBe('function');
    }
  });

  it('connects, shares one handle, reports health and closes', async () => {
    const connection = createPostgresDataStoreConnection({
      env: database.env(),
      cache: newCache(),
    });
    expect(connection.getState()).toBe('disconnected');
    expect(connection.isConnected()).toBe(false);
    expect(await connection.health()).toEqual({ ok: false, state: 'disconnected' });

    const connecting = [connection.connect(), connection.connect()];
    expect(connection.getState()).toBe('connecting');
    const [first, second] = await Promise.all(connecting);
    expect(first).toBe(second);
    expect(await connection.connect()).toBe(first);
    expect(connection.getHandle()).toBe(first);
    expect(first.schema).toBe('public');
    expect(connection.getState()).toBe('connected');
    expect(connection.isConnected()).toBe(true);

    const health = await connection.health();
    expect(health.ok).toBe(true);
    expect(health.state).toBe('connected');
    expect(typeof health.latencyMs).toBe('number');

    const { rows } = await sql<{ one: number }>`SELECT 1 AS one`.execute(first.db);
    expect(rows).toEqual([{ one: 1 }]);

    await connection.close();
    expect(connection.getState()).toBe('disconnected');
    expect(connection.getHandle()).toBeNull();
    expect((await connection.health()).ok).toBe(false);
    expect(first.pool.ended).toBe(true);

    const reopened = await connection.connect();
    expect(reopened).not.toBe(first);
    expect((await connection.health()).ok).toBe(true);
    await connection.close();
  });

  it('shares the connection between connections created with one cache', async () => {
    const cache = newCache();
    const a = createPostgresDataStoreConnection({ env: database.env(), cache });
    const b = createPostgresDataStoreConnection({ env: database.env(), cache });
    const handle = await a.connect();
    expect(b.isConnected()).toBe(true);
    expect(await b.connect()).toBe(handle);
    await b.close();
    expect(a.isConnected()).toBe(false);
  });

  it('applies the migrations on connect, and creates a schema other than public', async () => {
    const migrations: Record<string, Migration> = {
      '202601010000_widgets': {
        up: async (db: Kysely<unknown>) => {
          await sql`CREATE TABLE widgets (id integer PRIMARY KEY)`.execute(db);
        },
      },
    };
    const connection = createPostgresDataStoreConnection({
      env: database.env({ POSTGRES_SCHEMA: 'lc_connection_spec' }),
      cache: newCache(),
      migrations,
    });
    const { db, schema } = await connection.connect();
    expect(schema).toBe('lc_connection_spec');
    const { rows } = await sql<{
      schema: string;
      table: string | null;
    }>`SELECT current_schema() AS schema, to_regclass('widgets')::text AS table`.execute(db);
    expect(rows).toEqual([{ schema: 'lc_connection_spec', table: 'widgets' }]);
    const applied = await sql<{
      name: string;
    }>`SELECT name FROM lc_connection_spec.kysely_migration`.execute(db);
    expect(applied.rows).toEqual([{ name: '202601010000_widgets' }]);
    await connection.close();
  });

  it('with POSTGRES_AUTO_MIGRATE=false, refuses a database behind the code', async () => {
    const migrations: Record<string, Migration> = {
      '202601010000_gadgets': {
        up: async (db: Kysely<unknown>) => {
          await sql`CREATE TABLE gadgets (id integer PRIMARY KEY)`.execute(db);
        },
      },
    };
    const env = database.env({ POSTGRES_SCHEMA: 'lc_no_auto', POSTGRES_AUTO_MIGRATE: 'false' });
    const refused = createPostgresDataStoreConnection({ env, cache: newCache(), migrations });
    await expect(refused.connect()).rejects.toThrow(
      /behind this version \(1 migrations pending: 202601010000_gadgets\).*db:migrate/,
    );
    expect(refused.getState()).toBe('disconnected');

    const migrating = createPostgresDataStoreConnection({
      env: { ...env, POSTGRES_AUTO_MIGRATE: 'true' },
      cache: newCache(),
      migrations,
    });
    await migrating.connect();
    await migrating.close();

    const current = createPostgresDataStoreConnection({ env, cache: newCache(), migrations });
    await expect(current.connect()).resolves.toBeDefined();
    await current.close();
  });

  it('rejects connect when the server cannot be reached, and can retry', async () => {
    const connection = createPostgresDataStoreConnection({
      env: { POSTGRES_URI: 'postgresql://postgres@127.0.0.1:1/nowhere' },
      cache: newCache(),
    });
    await expect(connection.connect()).rejects.toThrow();
    expect(connection.getState()).toBe('disconnected');
    await expect(connection.connect()).rejects.toThrow();
  });

  it('reports each query to the observer: table, operation, outcome, duration', async () => {
    const observations: DataStoreQueryObservation[] = [];
    const connection = createPostgresDataStoreConnection({
      env: database.env(),
      cache: newCache(),
      observeQueries: (observation) => observations.push(observation),
    });
    const { db } = await connection.connect();
    observations.length = 0;

    await sql`CREATE TABLE observed (id integer PRIMARY KEY, name text)`.execute(db);
    await db.insertInto('observed').values({ id: 1, name: 'a' }).execute();
    await db.selectFrom('observed').selectAll().execute();
    await db.updateTable('observed').set({ name: 'b' }).where('id', '=', 1).execute();
    await db.deleteFrom('observed').where('id', '=', 1).execute();
    await expect(sql`SELECT * FROM missing_table`.execute(db)).rejects.toThrow();

    expect(observations.map(({ model, operation, status }) => [model, operation, status])).toEqual([
      [undefined, 'create', 'success'],
      ['observed', 'insert', 'success'],
      ['observed', 'select', 'success'],
      ['observed', 'update', 'success'],
      ['observed', 'delete', 'success'],
      [undefined, 'select', 'error'],
    ]);
    for (const observation of observations) {
      expect(observation.durationSeconds).toBeGreaterThanOrEqual(0);
    }
    await connection.close();
  });

  it('reads json and jsonb as text, so the tagged codec keeps key order', async () => {
    const connection = createPostgresDataStoreConnection({
      env: database.env(),
      cache: newCache(),
    });
    const { db } = await connection.connect();
    const { rows } = await sql<{
      j: unknown;
      b: unknown;
    }>`SELECT '{"z":1,"a":2}'::json AS j, '{"z":1}'::jsonb AS b`.execute(db);
    expect(rows).toEqual([{ j: '{"z":1,"a":2}', b: '{"z": 1}' }]);
    await connection.close();
  });
});

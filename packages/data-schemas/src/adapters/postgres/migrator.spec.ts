import { sql } from 'kysely';
import type { Kysely, Migration } from 'kysely';
import type { PostgresKysely } from './types';
import {
  PostgresMigrationError,
  migratePostgresToLatest,
  getPendingPostgresMigrations,
} from './migrator';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { POSTGRES_MIGRATIONS } from './migrations';

/** A migration creating `table`. */
const createTable = (table: string): Migration => ({
  up: async (db: Kysely<unknown>) => {
    await sql`CREATE TABLE ${sql.table(table)} (id integer PRIMARY KEY)`.execute(db);
  },
});

const tableExists = async (db: PostgresKysely, table: string, schema = 'public') => {
  const { rows } = await sql<{
    found: string | null;
  }>`SELECT to_regclass(${`${schema}.${table}`})::text AS found`.execute(db);
  return rows[0].found !== null;
};

describePostgres('PostgreSQL migrator', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let db: PostgresKysely;

  beforeAll(() => {
    db = database.kysely();
  });

  it("ships the package's migrations, starting with 0001_initial", async () => {
    expect(Object.keys(POSTGRES_MIGRATIONS)).toEqual(['0001_initial']);
    /** The template every suite database comes from was migrated with it. */
    expect(await tableExists(db, 'kysely_migration')).toBe(true);
    expect(await tableExists(db, 'kysely_migration_lock')).toBe(true);
    expect(await migratePostgresToLatest(db)).toEqual([]);
    expect(await getPendingPostgresMigrations(db)).toEqual([]);
  });

  it('applies pending migrations in name order, once', async () => {
    const schema = 'lc_migrator_order';
    const log: string[] = [];
    const tracked = (name: string): Migration => ({
      up: async (trx: Kysely<unknown>) => {
        log.push(name);
        await createTable(name).up(trx);
      },
    });
    const migrations = {
      '202602010000_b': tracked('202602010000_b'),
      '202601010000_a': tracked('202601010000_a'),
    };
    expect(await getPendingPostgresMigrations(db, { schema, migrations })).toEqual([
      '202601010000_a',
      '202602010000_b',
    ]);
    expect(await migratePostgresToLatest(db, { schema, migrations })).toEqual([
      '202601010000_a',
      '202602010000_b',
    ]);
    expect(log).toEqual(['202601010000_a', '202602010000_b']);
    expect(await migratePostgresToLatest(db, { schema, migrations })).toEqual([]);
    expect(await getPendingPostgresMigrations(db, { schema, migrations })).toEqual([]);
    /** The migration tables live in the schema. */
    expect(await tableExists(db, 'kysely_migration', schema)).toBe(true);
  });

  it('applies a migration named before the latest applied one (unordered merges)', async () => {
    const schema = 'lc_migrator_unordered';
    await migratePostgresToLatest(db, {
      schema,
      migrations: { '202603010000_late': createTable('lc_late') },
    });
    const applied = await migratePostgresToLatest(db, {
      schema,
      migrations: {
        '202603010000_late': createTable('lc_late'),
        '202601010000_merged': createTable('lc_merged'),
      },
    });
    expect(applied).toEqual(['202601010000_merged']);
    expect(await tableExists(db, 'lc_merged')).toBe(true);
  });

  it('rejects with the failing migration, rolling back the whole pending batch', async () => {
    const schema = 'lc_migrator_failure';
    const migrations: Record<string, Migration> = {
      '202601010000_ok': createTable('lc_ok'),
      '202601020000_bad': {
        up: async (trx: Kysely<unknown>) => {
          await createTable('lc_half').up(trx);
          await sql`SELECT * FROM lc_missing_table`.execute(trx);
        },
      },
    };
    const failure = await migratePostgresToLatest(db, { schema, migrations }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PostgresMigrationError);
    expect((failure as PostgresMigrationError).migrationName).toBe('202601020000_bad');
    expect((failure as Error).message).toContain('lc_missing_table');
    /** Kysely applies the pending migrations in one transaction: none of them stays applied. */
    expect(await tableExists(db, 'lc_half')).toBe(false);
    expect(await tableExists(db, 'lc_ok')).toBe(false);
    expect(await getPendingPostgresMigrations(db, { schema, migrations })).toEqual([
      '202601010000_ok',
      '202601020000_bad',
    ]);
  });

  it('serializes concurrent migrators with its lock: each migration runs once', async () => {
    const schema = 'lc_migrator_lock';
    await sql`CREATE TABLE lc_lock_log (migration text, started timestamptz, ended timestamptz)`.execute(
      db,
    );
    const slow = (name: string): Migration => ({
      up: async (trx: Kysely<unknown>) => {
        await sql`INSERT INTO lc_lock_log (migration, started) VALUES (${name}, clock_timestamp())`.execute(
          trx,
        );
        await sql`SELECT pg_sleep(0.3)`.execute(trx);
        await sql`UPDATE lc_lock_log SET ended = clock_timestamp() WHERE migration = ${name}`.execute(
          trx,
        );
      },
    });
    const migrations = { '202601010000_one': slow('one'), '202601020000_two': slow('two') };
    /** Two replicas booting at once: separate pools, so separate sessions. */
    const replicaA = database.kysely({ max: 2 });
    const replicaB = database.kysely({ max: 2 });

    const [appliedA, appliedB] = await Promise.all([
      migratePostgresToLatest(replicaA, { schema, migrations }),
      migratePostgresToLatest(replicaB, { schema, migrations }),
    ]);

    expect([...appliedA, ...appliedB].sort()).toEqual(['202601010000_one', '202601020000_two']);
    const { rows } = await sql<{
      migration: string;
      started: Date;
      ended: Date;
    }>`SELECT migration, started, ended FROM lc_lock_log ORDER BY started`.execute(db);
    expect(rows.map((row) => row.migration)).toEqual(['one', 'two']);
    /** Never overlapping: the second starts after the first ended. */
    expect(rows[1].started.getTime()).toBeGreaterThanOrEqual(rows[0].ended.getTime());
    expect(await getPendingPostgresMigrations(db, { schema, migrations })).toEqual([]);
  });

  it('makes a migrator wait for the lock held by another session', async () => {
    const schema = 'lc_migrator_wait';
    const holder = database.pool({ max: 1 });
    const client = await holder.connect();
    try {
      /** Kysely's migration lock: the advisory lock its PostgreSQL adapter takes. */
      await client.query('SELECT pg_advisory_lock(3853314791062309107)');
      let finished = false;
      const migrating = migratePostgresToLatest(database.kysely(), {
        schema,
        migrations: { '202601010000_waits': createTable('lc_waits') },
      }).then((applied) => {
        finished = true;
        return applied;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      await client.query('SELECT pg_advisory_unlock(3853314791062309107)');
      expect(await migrating).toEqual(['202601010000_waits']);
    } finally {
      client.release();
    }
  });
});

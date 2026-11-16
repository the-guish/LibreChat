/**
 * The post-migration step of the migrator (`migrator.ts`, docs/postgres-port/PHASE4.md §5): the
 * indexes of the large tables are built `CONCURRENTLY`, outside the migration transaction, when
 * the database lacks them; and `runPostgresMigrations` (`npm run db:migrate`).
 */
import { sql, Kysely, PostgresDialect } from 'kysely';
import type { PostgresKysely, PostgresTables } from './types';
import type { IndexDescriptor } from './schema/descriptor';
import {
  PostgresMigrationError,
  migratePostgresSchema,
  deferredPostgresIndexes,
  buildDeferredPostgresIndexes,
} from './migrator';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresPool, runPostgresMigrations } from './connection';
import { SCHEMA_OVERRIDES } from './schema/overrides';
import { POSTGRES_MIGRATIONS } from './migrations';
import { emitIndexDdl } from './schema/emitDdl';

describePostgres('PostgreSQL post-migration index step', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let db: PostgresKysely;

  beforeAll(() => {
    db = database.kysely();
  });

  /** Whether the index `name` exists in `public`, and is valid. */
  const indexState = async (name: string): Promise<'valid' | 'invalid' | 'missing'> => {
    const { rows } = await sql<{ valid: boolean }>`
      SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ${name} AND c.relnamespace = 'public'::regnamespace`.execute(db);
    if (rows.length === 0) {
      return 'missing';
    }
    return rows[0].valid ? 'valid' : 'invalid';
  };

  /** A Kysely instance logging every statement it runs into `log`. */
  const loggingKysely = (log: string[]): PostgresKysely => {
    const pool = database.pool();
    return new Kysely<PostgresTables>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        log.push(event.query.sql);
      },
    });
  };

  it('keeps every index of the large tables, and finds nothing to build after the migrations', async () => {
    const deferred = deferredPostgresIndexes();
    const largeTables = new Set(deferred.map((index) => index.table));
    for (const collection of SCHEMA_OVERRIDES.largeTables.collections) {
      expect(largeTables.has(collection)).toBe(true);
    }
    expect(largeTables.has('users')).toBe(false);
    expect(await migratePostgresSchema(db)).toEqual({ applied: [], builtIndexes: [] });
  });

  it('builds a missing large-table index CONCURRENTLY, outside any transaction', async () => {
    const index = deferredPostgresIndexes().find((entry) => entry.table === 'messages')!;
    await sql.raw(`DROP INDEX "${index.name}"`).execute(db);
    expect(await indexState(index.name)).toBe('missing');
    const log: string[] = [];
    const logging = loggingKysely(log);
    try {
      expect(await migratePostgresSchema(logging)).toEqual({
        applied: [],
        builtIndexes: [index.name],
      });
    } finally {
      await logging.destroy();
    }
    expect(log).toContain(emitIndexDdl(index, { concurrently: true }));
    expect(await indexState(index.name)).toBe('valid');
  });

  it('replaces an invalid leftover, and reports a failed build without leaving one', async () => {
    await sql`CREATE TABLE widgets (id integer PRIMARY KEY, v text)`.execute(db);
    await sql`INSERT INTO widgets VALUES (1, 'a'), (2, 'a')`.execute(db);
    const index: IndexDescriptor = {
      name: 'widgets__v',
      table: 'widgets',
      method: 'btree',
      keys: [{ path: 'v', direction: 1, column: 'v' }],
      unique: true,
      sources: [],
    };
    /** An interrupted or failed concurrent build leaves an invalid index behind. */
    await expect(sql.raw(emitIndexDdl(index, { concurrently: true })).execute(db)).rejects.toThrow(
      /could not create unique index/,
    );
    expect(await indexState('widgets__v')).toBe('invalid');

    const failure = buildDeferredPostgresIndexes(db, [index]);
    await expect(failure).rejects.toBeInstanceOf(PostgresMigrationError);
    await expect(failure).rejects.toThrow(/widgets__v on widgets CONCURRENTLY failed/);
    expect(await indexState('widgets__v')).toBe('missing');

    await expect(
      sql.raw(emitIndexDdl(index, { concurrently: true })).execute(db),
    ).rejects.toThrow();
    await sql`DELETE FROM widgets WHERE id = 2`.execute(db);
    expect(await indexState('widgets__v')).toBe('invalid');
    expect(await buildDeferredPostgresIndexes(db, [index])).toEqual(['widgets__v']);
    expect(await indexState('widgets__v')).toBe('valid');
    expect(await buildDeferredPostgresIndexes(db, [index])).toEqual([]);
  });

  it('serializes concurrent runs with its advisory lock: each index is built once', async () => {
    const indexes = deferredPostgresIndexes()
      .filter((entry) => entry.table === 'conversations')
      .slice(0, 2);
    for (const index of indexes) {
      await sql.raw(`DROP INDEX "${index.name}"`).execute(db);
    }
    const other = new Kysely<PostgresTables>({
      dialect: new PostgresDialect({ pool: database.pool() }),
    });
    try {
      const [first, second] = await Promise.all([
        buildDeferredPostgresIndexes(db, indexes),
        buildDeferredPostgresIndexes(other, indexes),
      ]);
      expect([...first, ...second].sort()).toEqual(indexes.map((index) => index.name).sort());
    } finally {
      await other.destroy();
    }
    for (const index of indexes) {
      expect(await indexState(index.name)).toBe('valid');
    }
  });

  it('builds nothing after migrations a caller passes, unless told which indexes', async () => {
    const index = deferredPostgresIndexes().find((entry) => entry.table === 'files')!;
    await sql.raw(`DROP INDEX "${index.name}"`).execute(db);
    const pool = createPostgresPool({ uri: database.uri, schema: 'public', autoMigrate: true });
    const custom = new Kysely<PostgresTables>({ dialect: new PostgresDialect({ pool }) });
    try {
      const migrations = { ...POSTGRES_MIGRATIONS };
      expect(await migratePostgresSchema(custom, { migrations })).toEqual({
        applied: [],
        builtIndexes: [],
      });
      expect(await migratePostgresSchema(custom, { migrations, deferredIndexes: [index] })).toEqual(
        { applied: [], builtIndexes: [index.name] },
      );
    } finally {
      await custom.destroy();
    }
  });

  it('migrates the database of the environment (npm run db:migrate)', async () => {
    const env = database.env({ POSTGRES_SCHEMA: 'lc_db_migrate', POSTGRES_AUTO_MIGRATE: 'false' });
    expect(await runPostgresMigrations({ env })).toEqual({
      applied: Object.keys(POSTGRES_MIGRATIONS),
      builtIndexes: [],
    });
    expect(await runPostgresMigrations({ env })).toEqual({ applied: [], builtIndexes: [] });
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'lc_db_migrate'`.execute(db);
    expect(rows[0].n).toBeGreaterThan(90);
    await expect(runPostgresMigrations({ env: {} })).rejects.toThrow(/POSTGRES_URI/);
  });
});

/**
 * The PostgreSQL schema migrator (docs/postgres-port/PHASE4.md §5, D6): Kysely's `Migrator`
 * with an in-code provider (`./migrations`, imported statically because tsdown bundles the
 * package). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - The pending migrations are applied in name order, all in one transaction (PostgreSQL has
 *   transactional DDL; that is how Kysely runs them): when one fails, none of the batch stays
 *   applied. `allowUnorderedMigrations` is on: parallel units and upstream merges interleave
 *   timestamps, so a migration older than the latest applied one still runs.
 * - `CREATE INDEX CONCURRENTLY` cannot run in that transaction, so a migration never builds an
 *   index on an existing large table (`largeTables` in `schema/overrides.ts`: messages,
 *   conversations, files, transactions, trigger deliveries, and their child tables). A
 *   post-migration step does, after every run of the migrator ({@link buildDeferredPostgresIndexes}):
 *   each index the generated descriptor declares on a large table that the database lacks (or
 *   holds invalid, after an interrupted build) is built `CONCURRENTLY`, outside any transaction,
 *   so writes to the table go on meanwhile. It converges on the descriptor whatever the order of
 *   the migrations, finds nothing to do on a database the migrations created (the first migration
 *   builds every index of its new, empty tables) and builds nothing for migrations a caller passes
 *   (specs) unless told which indexes. Replicas booting at once are serialized by a session-level
 *   advisory lock, taken by polling `pg_try_advisory_lock` (a session blocked in
 *   `pg_advisory_lock` would hold a snapshot the concurrent build waits for).
 * - Concurrent migrators (several replicas booting at once) are serialized by Kysely's lock: a
 *   session-level advisory lock (`pg_advisory_lock`) taken before the state is read, so the
 *   second migrator waits, then finds nothing left to apply.
 * - The migration tables (`kysely_migration`, `kysely_migration_lock`) live in the configured
 *   schema (`POSTGRES_SCHEMA`); a schema other than `public` is created when missing.
 */
import { sql, Migrator } from 'kysely';
import type { Migration, MigrationResultSet } from 'kysely';
import type { IndexDescriptor, SchemaDescriptor } from './schema/descriptor';
import type { PostgresKysely } from './types';
import { SCHEMA_DESCRIPTOR } from './schema/descriptor.generated';
import { POSTGRES_MIGRATIONS } from './migrations';
import { quoteIdentifier } from './schema/naming';
import { emitIndexDdl } from './schema/emitDdl';

/** What the migrator works on: the schema, and the migrations (the package's by default). */
export interface PostgresMigratorOptions {
  /** The schema holding the tables and the migration tables; `public` when not given. */
  schema?: string;
  /** The migrations by name; {@link POSTGRES_MIGRATIONS} when not given (specs pass their own). */
  migrations?: Readonly<Record<string, Migration>>;
  /**
   * The indexes the post-migration step builds `CONCURRENTLY` when missing: by default every index
   * of a large table of the generated descriptor ({@link deferredPostgresIndexes}) with the
   * package's migrations, and none with `migrations` given.
   */
  deferredIndexes?: readonly IndexDescriptor[];
}

/** What a run of the migrator did. */
export interface PostgresMigrationResult {
  /** The migrations applied, in order (none when another migrator applied them first). */
  applied: string[];
  /** The indexes the post-migration step built `CONCURRENTLY`. */
  builtIndexes: string[];
}

/** The Kysely migrator over the in-code migrations. */
export function createPostgresMigrator(
  db: PostgresKysely,
  options: PostgresMigratorOptions = {},
): Migrator {
  const migrations = options.migrations ?? POSTGRES_MIGRATIONS;
  const schema = options.schema && options.schema !== 'public' ? options.schema : undefined;
  return new Migrator({
    db,
    provider: { getMigrations: async () => ({ ...migrations }) },
    allowUnorderedMigrations: true,
    ...(schema ? { migrationTableSchema: schema } : {}),
  });
}

/** Thrown when a migration fails; names the migration, with the database's error as `cause`. */
export class PostgresMigrationError extends Error {
  readonly migrationName?: string;
  readonly cause?: unknown;
  constructor(message: string, options: { migrationName?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'PostgresMigrationError';
    this.migrationName = options.migrationName;
    this.cause = options.cause;
  }
}

/** The names of the migrations a result set applied; throws when one failed. */
function appliedOrThrow(resultSet: MigrationResultSet): string[] {
  const results = resultSet.results ?? [];
  if (resultSet.error !== undefined) {
    const failed = results.find((result) => result.status === 'Error');
    const reason =
      resultSet.error instanceof Error ? resultSet.error.message : String(resultSet.error);
    throw new PostgresMigrationError(
      failed
        ? `PostgreSQL migration ${failed.migrationName} failed: ${reason}`
        : `PostgreSQL migrations failed: ${reason}`,
      { migrationName: failed?.migrationName, cause: resultSet.error },
    );
  }
  return results.filter((result) => result.status === 'Success').map((r) => r.migrationName);
}

/** The indexes the post-migration step keeps built: every index of a large table of `descriptor`. */
export function deferredPostgresIndexes(
  descriptor: SchemaDescriptor = SCHEMA_DESCRIPTOR,
): IndexDescriptor[] {
  return descriptor.tables.filter((table) => table.large).flatMap((table) => table.indexes);
}

/** The advisory lock key of the post-migration step (Kysely's migration lock is another key). */
const DEFERRED_INDEX_LOCK_KEY = sql.raw('7451062315930470731');
const DEFERRED_INDEX_LOCK_POLL_MS = 250;
const DEFERRED_INDEX_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The post-migration step: builds `CONCURRENTLY`, outside any transaction, each of `indexes` the
 * current schema lacks or holds invalid (an invalid one is dropped `CONCURRENTLY` first), under a
 * session-level advisory lock taken by polling. Resolves to the names built; rejects with a
 * {@link PostgresMigrationError} naming the index whose build failed (its invalid leftover is
 * dropped). Indexes are looked up by name in the connection's current schema (`search_path`).
 */
export async function buildDeferredPostgresIndexes(
  db: PostgresKysely,
  indexes: readonly IndexDescriptor[],
  options: { lockTimeoutMs?: number } = {},
): Promise<string[]> {
  if (indexes.length === 0) {
    return [];
  }
  return db.connection().execute(async (connection) => {
    const deadline = Date.now() + (options.lockTimeoutMs ?? DEFERRED_INDEX_LOCK_TIMEOUT_MS);
    for (;;) {
      const { rows } = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_lock(${DEFERRED_INDEX_LOCK_KEY}) AS locked`.execute(connection);
      if (rows[0].locked) {
        break;
      }
      if (Date.now() > deadline) {
        throw new PostgresMigrationError(
          'Timed out waiting for another migrator to finish building the large-table indexes',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, DEFERRED_INDEX_LOCK_POLL_MS));
    }
    try {
      const { rows } = await sql<{ name: string; valid: boolean }>`
        SELECT c.relname AS name, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relnamespace = current_schema()::regnamespace
      `.execute(connection);
      const existing = new Map(rows.map((row) => [row.name, row.valid]));
      const built: string[] = [];
      for (const index of indexes) {
        const valid = existing.get(index.name);
        if (valid === true) {
          continue;
        }
        const dropInvalid = sql.raw(
          `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdentifier(index.name)}`,
        );
        if (valid === false) {
          await dropInvalid.execute(connection);
        }
        try {
          await sql.raw(emitIndexDdl(index, { concurrently: true })).execute(connection);
        } catch (error) {
          await dropInvalid.execute(connection).catch(() => undefined);
          const reason = error instanceof Error ? error.message : String(error);
          throw new PostgresMigrationError(
            `Building the index ${index.name} on ${index.table} CONCURRENTLY failed: ${reason}`,
            { cause: error },
          );
        }
        built.push(index.name);
      }
      return built;
    } finally {
      await sql`SELECT pg_advisory_unlock(${DEFERRED_INDEX_LOCK_KEY})`.execute(connection);
    }
  });
}

/**
 * Applies every pending migration, under the migration lock, then runs the post-migration step
 * (the large-table indexes built `CONCURRENTLY`). Rejects with a {@link PostgresMigrationError}
 * naming the migration that failed (the whole batch is rolled back) or the index whose build
 * failed (the migrations stay applied).
 */
export async function migratePostgresSchema(
  db: PostgresKysely,
  options: PostgresMigratorOptions = {},
): Promise<PostgresMigrationResult> {
  const applied = appliedOrThrow(await createPostgresMigrator(db, options).migrateToLatest());
  const deferred = options.deferredIndexes ?? (options.migrations ? [] : deferredPostgresIndexes());
  const builtIndexes = await buildDeferredPostgresIndexes(db, deferred);
  return { applied, builtIndexes };
}

/**
 * {@link migratePostgresSchema}, resolving to the names of the migrations applied (none when
 * another migrator applied them first).
 */
export async function migratePostgresToLatest(
  db: PostgresKysely,
  options: PostgresMigratorOptions = {},
): Promise<string[]> {
  return (await migratePostgresSchema(db, options)).applied;
}

/** The names of the migrations not applied yet, in name order (reads only). */
export async function getPendingPostgresMigrations(
  db: PostgresKysely,
  options: PostgresMigratorOptions = {},
): Promise<string[]> {
  const migrations = await createPostgresMigrator(db, options).getMigrations();
  return migrations
    .filter((migration) => migration.executedAt === undefined)
    .map((migration) => migration.name);
}

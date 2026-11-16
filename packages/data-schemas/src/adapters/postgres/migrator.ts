/**
 * The PostgreSQL schema migrator (docs/postgres-port/PHASE4.md §5, D6): Kysely's `Migrator`
 * with an in-code provider (`./migrations`, imported statically because tsdown bundles the
 * package). Must not import `mongoose`, `mongodb` or `bson`.
 *
 * - The pending migrations are applied in name order, all in one transaction (PostgreSQL has
 *   transactional DDL; that is how Kysely runs them): when one fails, none of the batch stays
 *   applied. So a statement that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`)
 *   needs its own step outside this migrator. `allowUnorderedMigrations` is on: parallel units
 *   and upstream merges interleave timestamps, so a migration older than the latest applied one
 *   still runs.
 * - Concurrent migrators (several replicas booting at once) are serialized by Kysely's lock: a
 *   session-level advisory lock (`pg_advisory_lock`) taken before the state is read, so the
 *   second migrator waits, then finds nothing left to apply.
 * - The migration tables (`kysely_migration`, `kysely_migration_lock`) live in the configured
 *   schema (`POSTGRES_SCHEMA`); a schema other than `public` is created when missing.
 */
import { Migrator } from 'kysely';
import type { Migration, MigrationResultSet } from 'kysely';
import type { PostgresKysely } from './types';
import { POSTGRES_MIGRATIONS } from './migrations';

/** What the migrator works on: the schema, and the migrations (the package's by default). */
export interface PostgresMigratorOptions {
  /** The schema holding the tables and the migration tables; `public` when not given. */
  schema?: string;
  /** The migrations by name; {@link POSTGRES_MIGRATIONS} when not given (specs pass their own). */
  migrations?: Readonly<Record<string, Migration>>;
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

/**
 * Applies every pending migration, under the migration lock, and resolves to the names applied
 * (none when another migrator applied them first). Rejects with a {@link PostgresMigrationError}
 * naming the one that failed; the whole batch is rolled back.
 */
export async function migratePostgresToLatest(
  db: PostgresKysely,
  options: PostgresMigratorOptions = {},
): Promise<string[]> {
  return appliedOrThrow(await createPostgresMigrator(db, options).migrateToLatest());
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

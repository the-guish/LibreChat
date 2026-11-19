/**
 * The version checks of the copy tool (docs/postgres-port/PHASE4.md §8 X1, run order step 3): the
 * PostgreSQL schema is migrated to the descriptor of this LibreChat version, and the copy is
 * refused when either side does not match it.
 *
 * - **PostgreSQL**: a database holding migrations this version does not know was migrated by a
 *   newer LibreChat, and is refused before anything is written. Otherwise the pending migrations
 *   are applied (only listed on a dry run), and the live tables are compared with the descriptor:
 *   every table and column with its type. A drift (a hand edit, a failed migration) is refused.
 * - **MongoDB**: every index this version's schemas declare on a collection the source holds must
 *   exist there. LibreChat builds them at boot, so a missing one means the source never ran this
 *   version (or a legacy migration it needs, such as `migrate:tenant-indexes`, was not run:
 *   PLAN.md, "MongoDB-only legacy scripts"). The check can be overridden for deployments that
 *   build indexes by hand (`autoIndex` off), and its findings are then reported as warnings.
 */
import { sql } from 'kysely';
import type { Db } from 'mongodb';
import type { SchemaDescriptor } from '~/adapters/postgres/schema/descriptor';
import type { PostgresKysely } from '~/adapters/postgres/types';
import type { SchemaReport } from './report';
import { migratePostgresSchema } from '~/adapters/postgres/migrator';
import { checkPostgresServer } from '~/adapters/postgres/connection';
import { POSTGRES_MIGRATIONS } from '~/adapters/postgres/migrations';

/** Thrown when the copy is refused before anything is written. */
export class MongoToPostgresCopyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MongoToPostgresCopyRefusedError';
  }
}

/** The names of the migrations applied to `schema` (none when the migration table is missing). */
async function appliedMigrations(db: PostgresKysely, schema: string): Promise<string[]> {
  const table = `"${schema}".kysely_migration`;
  const { rows: exists } = await sql<{ present: boolean }>`
    SELECT to_regclass(${table}) IS NOT NULL AS present
  `.execute(db);
  if (!exists[0]?.present) {
    return [];
  }
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM ${sql.raw(table)} ORDER BY name
  `.execute(db);
  return rows.map((row) => row.name);
}

/** A descriptor column type as `format_type` spells it. */
function catalogType(sqlType: string): string {
  return sqlType
    .replace(/ COLLATE "[^"]*"/, '')
    .replace(/^timestamptz/, 'timestamp with time zone');
}

/** The differences between the live tables of `schema` and `descriptor` (empty when none). */
export async function findSchemaDrift(
  db: PostgresKysely,
  schema: string,
  descriptor: SchemaDescriptor,
): Promise<string[]> {
  const { rows } = await sql<{ table: string; column: string; type: string }>`
    SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = ${schema}::regnamespace AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
  `.execute(db);
  const live = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const columns = live.get(row.table) ?? new Map<string, string>();
    columns.set(row.column, row.type);
    live.set(row.table, columns);
  }
  const drift: string[] = [];
  for (const table of descriptor.tables) {
    const columns = live.get(table.name);
    if (!columns) {
      drift.push(`table ${table.name} is missing`);
      continue;
    }
    for (const column of table.columns) {
      const type = columns.get(column.name);
      const expected = catalogType(column.sqlType);
      if (type === undefined) {
        drift.push(`column ${table.name}.${column.name} is missing`);
      } else if (type !== expected) {
        drift.push(`column ${table.name}.${column.name} is ${type}, expected ${expected}`);
      }
    }
  }
  return drift;
}

/** Lists a few entries of a long list, for a refusal message. */
function some(list: readonly string[], max = 10): string {
  const shown = list.slice(0, max).join('; ');
  return list.length > max ? `${shown}; and ${list.length - max} more` : shown;
}

/**
 * Brings `schema` to this version's descriptor (see the module header): refuses a database a
 * newer version migrated, applies the pending migrations (lists them on a dry run), then refuses
 * a drift from `descriptor`.
 */
export async function preparePostgresSchema(
  db: PostgresKysely,
  schema: string,
  descriptor: SchemaDescriptor,
  options: { dryRun: boolean },
): Promise<SchemaReport> {
  await checkPostgresServer(db);
  const known = Object.keys(POSTGRES_MIGRATIONS).sort();
  const applied = await appliedMigrations(db, schema);
  const unknown = applied.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new MongoToPostgresCopyRefusedError(
      `The PostgreSQL schema "${schema}" holds migrations this LibreChat version does not know (${some(unknown)}): it belongs to a newer version. Run the copy with the LibreChat version that matches it, or copy into an empty database.`,
    );
  }
  const pending = known.filter((name) => !applied.includes(name));
  if (options.dryRun) {
    if (pending.length === 0) {
      const drift = await findSchemaDrift(db, schema, descriptor);
      if (drift.length > 0) {
        throw new MongoToPostgresCopyRefusedError(
          `The PostgreSQL schema "${schema}" does not match this LibreChat version's tables: ${some(drift)}`,
        );
      }
    }
    return { schema, applied: [], pending };
  }
  const result = await migratePostgresSchema(db, { schema });
  const drift = await findSchemaDrift(db, schema, descriptor);
  if (drift.length > 0) {
    throw new MongoToPostgresCopyRefusedError(
      `The PostgreSQL schema "${schema}" does not match this LibreChat version's tables after migrating: ${some(drift)}`,
    );
  }
  return { schema, applied: result.applied, pending: [] };
}

/**
 * The indexes this version's schemas declare that the source lacks, on the collections it holds
 * (`present`), as `<collection>.<index name>`. Plugin indexes (MeiliSearch's, only built when it
 * is configured) are left out.
 */
export async function findMissingSourceIndexes(
  db: Db,
  descriptor: SchemaDescriptor,
  present: ReadonlySet<string>,
): Promise<string[]> {
  const expected = new Map<string, Set<string>>();
  for (const table of descriptor.tables) {
    const root =
      table.kind === 'collection' ||
      (table.kind !== 'raw' &&
        descriptor.tables.some(
          (other) => other.kind === 'collection' && other.collection === table.collection,
        ));
    if (!root || !present.has(table.collection)) {
      continue;
    }
    const names = expected.get(table.collection) ?? new Set<string>();
    for (const index of table.indexes) {
      for (const source of index.sources) {
        if (!source.plugin) names.add(source.mongoName);
      }
    }
    expected.set(table.collection, names);
  }
  const missing: string[] = [];
  for (const [collection, names] of expected) {
    if (names.size === 0) continue;
    const indexes = await db.collection(collection).listIndexes().toArray();
    const existing = new Set(indexes.map((index) => String(index.name)));
    for (const name of [...names].sort()) {
      if (!existing.has(name)) missing.push(`${collection}.${name}`);
    }
  }
  return missing;
}

/** The refusal for {@link findMissingSourceIndexes}'s findings. */
export function sourceMismatchError(missing: readonly string[]): MongoToPostgresCopyRefusedError {
  return new MongoToPostgresCopyRefusedError(
    `The MongoDB source does not match this LibreChat version: it lacks indexes this version builds at boot (${some(missing)}). Run this LibreChat version on MongoDB once (and the legacy migrations it needs), or pass --allow-source-index-mismatch when the indexes are managed by hand.`,
  );
}

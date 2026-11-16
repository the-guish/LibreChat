/**
 * Drift specs 2 and 3 (docs/postgres-port/PHASE4.md §5), on a real server:
 *
 * 2. The checked-in migrations, applied to an empty database (with the post-migration index
 *    step) and introspected (`pg_attribute`, `pg_constraint`, `pg_index`, `pg_proc`, `pg_type`),
 *    equal the descriptor's expected DDL applied to another empty schema: the same tables,
 *    columns (type, collation, nullability), constraints, indexes, domain and helper functions.
 *    It fails on a missing or hand-edited migration (a probe below replays a tampered one).
 * 3. Every mongoose index (the models', the plugin overrides', the raw collections') has its
 *    PostgreSQL index in the migrated database: the same keys (and directions with MongoDB's
 *    null order), uniqueness, partial or sparse predicate on the same paths, and TTL rule.
 */
import { sql, Kysely, PostgresDialect } from 'kysely';
import type { Migration } from 'kysely';
import type { Pool } from 'pg';
import type { IndexDescriptor, TableDescriptor, IndexSourceDescriptor } from './descriptor';
import type { PostgresKysely, PostgresTables } from '../types';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { primaryKeyName, defaultMongoIndexName } from './descriptor';
import { SCHEMA_DESCRIPTOR } from './descriptor.generated';
import { emitSchemaDdl, emitPreludeDdl } from './emitDdl';
import * as initial from '../migrations/0001_initial';
import { migratePostgresSchema } from '../migrator';
import { POSTGRES_MIGRATIONS } from '../migrations';
import { createPostgresPool } from '../connection';
import { HELPER_FUNCTIONS_DDL } from './functions';
import { collectSchemaSources } from './generate';

const MIGRATED = 'lc_drift_migrated';
const EXPECTED = 'lc_drift_expected';
const TAMPERED = 'lc_drift_tampered';

/** Everything a schema holds, as the catalogs describe it, with the schema name taken out. */
interface SchemaIntrospection {
  tables: Record<
    string,
    {
      columns: Array<{ name: string; type: string; collation: string | null; notNull: boolean }>;
      constraints: Array<{ name: string; type: string; definition: string }>;
    }
  >;
  indexes: Array<{ name: string; table: string; definition: string; valid: boolean }>;
  domains: Array<{ name: string; definition: string }>;
  functions: Array<{ name: string; definition: string }>;
}

async function introspect(pool: Pool, schema: string): Promise<SchemaIntrospection> {
  const strip = (text: string) => text.split(`"${schema}".`).join('').split(`${schema}.`).join('');
  const query = async <T extends Record<string, unknown>>(text: string) =>
    (await pool.query<T>(text, [schema])).rows;
  const tables: SchemaIntrospection['tables'] = {};
  const relations = await query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c
     WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r'
       AND c.relname NOT IN ('kysely_migration', 'kysely_migration_lock')
     ORDER BY 1`,
  );
  for (const { name } of relations) tables[name] = { columns: [], constraints: [] };
  const columns = await query<{
    table: string;
    name: string;
    type: string;
    collation: string | null;
    not_null: boolean;
  }>(
    `SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            co.collname AS collation, a.attnotnull AS not_null
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
     WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY 1, 2`,
  );
  for (const column of columns) {
    tables[column.table]?.columns.push({
      name: column.name,
      type: strip(column.type),
      collation: column.collation,
      notNull: column.not_null,
    });
  }
  const constraints = await query<{
    table: string;
    name: string;
    type: string;
    definition: string;
  }>(
    `SELECT c.relname AS table, k.conname AS name, k.contype AS type,
            pg_get_constraintdef(k.oid) AS definition
     FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
     WHERE c.relnamespace = $1::regnamespace
     ORDER BY 1, 2`,
  );
  for (const constraint of constraints) {
    tables[constraint.table]?.constraints.push({
      name: constraint.name,
      type: constraint.type,
      definition: strip(constraint.definition),
    });
  }
  const indexes = await query<{ name: string; table: string; definition: string; valid: boolean }>(
    `SELECT c.relname AS name, t.relname AS table, pg_get_indexdef(i.indexrelid) AS definition,
            i.indisvalid AS valid
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
     WHERE c.relnamespace = $1::regnamespace
       AND t.relname NOT IN ('kysely_migration', 'kysely_migration_lock')
     ORDER BY 1`,
  );
  const domains = await query<{ name: string; definition: string }>(
    `SELECT t.typname AS name,
            format_type(t.typbasetype, t.typtypmod) || ' ' || coalesce(co.collname, '') || ' ' ||
            coalesce((SELECT string_agg(pg_get_constraintdef(k.oid), ' ' ORDER BY k.conname)
                      FROM pg_constraint k WHERE k.contypid = t.oid), '') AS definition
     FROM pg_type t LEFT JOIN pg_collation co ON co.oid = t.typcollation AND t.typcollation <> 0
     WHERE t.typnamespace = $1::regnamespace AND t.typtype = 'd'
     ORDER BY 1`,
  );
  const functions = await query<{ name: string; definition: string }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
            pg_get_functiondef(p.oid) AS definition
     FROM pg_proc p WHERE p.pronamespace = $1::regnamespace
     ORDER BY 1`,
  );
  return {
    tables,
    indexes: indexes.map((index) => ({ ...index, definition: strip(index.definition) })),
    domains: domains.map((domain) => ({ ...domain, definition: strip(domain.definition) })),
    functions: functions.map((fn) => ({ ...fn, definition: strip(fn.definition) })),
  };
}

describePostgres('PostgreSQL schema drift: migrations replayed vs the descriptor', () => {
  const database = usePostgresTestDatabase();
  const pools: Pool[] = [];
  const kyselys: PostgresKysely[] = [];
  let admin: Pool;
  let migrated: SchemaIntrospection;
  let expected: SchemaIntrospection;
  let applied: string[];
  let builtIndexes: string[];

  /** A pool whose connections have `search_path` set to `schema`. */
  const poolFor = (schema: string): Pool => {
    const pool = createPostgresPool({ uri: database.uri, schema, autoMigrate: true });
    pools.push(pool);
    return pool;
  };
  const kyselyFor = (schema: string): PostgresKysely => {
    const db = new Kysely<PostgresTables>({
      dialect: new PostgresDialect({ pool: poolFor(schema) }),
    });
    kyselys.push(db);
    return db;
  };

  beforeAll(async () => {
    admin = database.pool();
    const result = await migratePostgresSchema(kyselyFor(MIGRATED), { schema: MIGRATED });
    applied = result.applied;
    builtIndexes = result.builtIndexes;

    await admin.query(`CREATE SCHEMA ${EXPECTED}`);
    const reference = poolFor(EXPECTED);
    for (const statement of [
      ...emitPreludeDdl(),
      ...HELPER_FUNCTIONS_DDL,
      ...emitSchemaDdl(SCHEMA_DESCRIPTOR, { prelude: false }),
    ]) {
      await reference.query(statement);
    }
    migrated = await introspect(admin, MIGRATED);
    expected = await introspect(admin, EXPECTED);
  }, 180_000);

  afterAll(async () => {
    for (const db of kyselys) await db.destroy().catch(() => undefined);
    for (const pool of pools) await pool.end().catch(() => undefined);
  });

  it('applies every migration on an empty database, with nothing left to build concurrently', () => {
    expect(applied).toEqual(Object.keys(POSTGRES_MIGRATIONS));
    expect(builtIndexes).toEqual([]);
    expect(migrated.indexes.filter((index) => !index.valid)).toEqual([]);
  });

  it('creates exactly the tables, columns, constraints and indexes of the descriptor', () => {
    expect(Object.keys(migrated.tables).sort()).toEqual(
      SCHEMA_DESCRIPTOR.tables.map((table) => table.name).sort(),
    );
    for (const table of SCHEMA_DESCRIPTOR.tables) {
      expect({
        table: table.name,
        columns: migrated.tables[table.name].columns.map((column) => column.name),
      }).toEqual({ table: table.name, columns: table.columns.map((c) => c.name).sort() });
    }
    const sqlIndexes = SCHEMA_DESCRIPTOR.tables.flatMap((table) => [
      primaryKeyName(table),
      ...table.indexes.map((index) => index.name),
    ]);
    expect(migrated.indexes.map((index) => index.name)).toEqual(sqlIndexes.sort());
    expect(migrated.tables).toEqual(expected.tables);
    expect(migrated.indexes).toEqual(expected.indexes);
  });

  it('creates the lc_object_id domain and the lc_* helper functions as defined', () => {
    expect(migrated.domains).toEqual(expected.domains);
    expect(migrated.domains.map((domain) => domain.name)).toEqual(['lc_object_id']);
    expect(migrated.functions).toEqual(expected.functions);
    expect(migrated.functions.map((fn) => fn.name)).toEqual([
      'lc_fail(message text)',
      'lc_fail(message text, sample anyelement)',
      'lc_nulls_clear(nulls text[], path text)',
      'lc_nulls_set(nulls text[], path text, is_null boolean)',
      'lc_sort_key(value jsonb, ascending boolean)',
      'lc_sort_key_value(value jsonb)',
      'lc_sort_number(value double precision)',
    ]);
  });

  it('fails on a hand-edited or incomplete migration (spec-local probe)', async () => {
    const statements = initial.statements.filter(
      (statement) => !statement.startsWith('CREATE INDEX "messages__conversationId'),
    );
    expect(statements.length).toBeLessThan(initial.statements.length);
    const tampered: Record<string, Migration> = {
      '0001_initial': {
        up: async (db) => {
          for (const statement of statements) {
            /** One hand edit: a text column loses its "C" collation. */
            await sql
              .raw(statement.replace('"title" text COLLATE "C"', '"title" text'))
              .execute(db);
          }
        },
      },
    };
    await migratePostgresSchema(kyselyFor(TAMPERED), { schema: TAMPERED, migrations: tampered });
    const result = await introspect(admin, TAMPERED);
    expect(result.tables).not.toEqual(expected.tables);
    expect(result.indexes).not.toEqual(expected.indexes);
    const missing = expected.indexes
      .map((index) => index.name)
      .filter((name) => !result.indexes.some((index) => index.name === name));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((name) => name.startsWith('messages__conversationId'))).toBe(true);
  }, 120_000);

  describe('drift spec 3: every mongoose index has its PostgreSQL index', () => {
    interface LiveIndex {
      name: string;
      table: string;
      unique: boolean;
      valid: boolean;
      method: string;
      predicate: string | null;
      keys: string[];
      options: number[];
    }
    let live: Map<string, LiveIndex>;

    beforeAll(async () => {
      const { rows } = await admin.query<LiveIndex>(
        `SELECT c.relname AS name, t.relname AS table, i.indisunique AS unique,
                i.indisvalid AS valid, am.amname AS method,
                pg_get_expr(i.indpred, i.indrelid) AS predicate,
                ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
                      FROM generate_series(1, i.indnkeyatts) AS k ORDER BY k) AS keys,
                i.indoption::int2[] AS options
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid JOIN pg_am am ON am.oid = c.relam
         WHERE c.relnamespace = $1::regnamespace`,
        [MIGRATED],
      );
      live = new Map(rows.map((row) => [row.name, row]));
    });

    /** Every (table, SQL index) of the descriptor serving a MongoDB index, by collection and name. */
    const served = new Map<string, Array<{ table: TableDescriptor; index: IndexDescriptor }>>();
    const sourceOf = new Map<string, IndexSourceDescriptor>();
    for (const table of SCHEMA_DESCRIPTOR.tables) {
      for (const index of table.indexes) {
        for (const source of index.sources) {
          const key = `${table.collection} ${source.mongoName}`;
          served.set(key, [...(served.get(key) ?? []), { table, index }]);
          sourceOf.set(key, source);
        }
      }
    }
    const cases = collectSchemaSources().flatMap((source) =>
      source.indexes.map((index) => {
        const name =
          typeof index.options.name === 'string'
            ? index.options.name
            : defaultMongoIndexName(index.fields);
        return [`${source.collection} ${name}`, index] as const;
      }),
    );

    it('covers every index declared on the mongoose schemas', () => {
      expect(cases.length).toBeGreaterThanOrEqual(361);
      expect(cases.filter(([key]) => !served.has(key)).map(([key]) => key)).toEqual([]);
    });

    it.each(cases)('%s', (key, mongo) => {
      const parts = served.get(key)!;
      const source = sourceOf.get(key)!;
      expect(source.fields).toEqual(mongo.fields);
      const unique = mongo.options.unique === true;
      const partial =
        mongo.options.partialFilterExpression !== undefined || mongo.options.sparse === true;
      if (unique) {
        expect(parts).toHaveLength(1);
      }
      /** Document path of a key of `table`. */
      const documentPath = (table: TableDescriptor, path: string): string => {
        if (table.kind === 'element') {
          return table.path!;
        }
        return table.path ? `${table.path}.${path}` : path;
      };
      const covered = new Set<string>();
      for (const { table, index } of parts) {
        const found = live.get(index.name);
        expect({ index: index.name, exists: Boolean(found), valid: found?.valid }).toEqual({
          index: index.name,
          exists: true,
          valid: true,
        });
        expect({ index: index.name, unique: found!.unique }).toEqual({ index: index.name, unique });
        expect({ index: index.name, partial: found!.predicate !== null }).toEqual({
          index: index.name,
          partial,
        });
        expect(found!.table).toBe(table.name);
        expect(found!.method).toBe(index.method);
        expect(found!.keys).toHaveLength(index.keys.length);
        index.keys.forEach((descriptorKey, position) => {
          const liveKey = found!.keys[position].replace(/"/g, '');
          if (descriptorKey.column !== undefined) {
            expect(liveKey).toBe(descriptorKey.column);
          } else {
            const column = descriptorKey.expression!.match(/^\(*"([^"]+)"/)![1];
            expect(liveKey).toContain(column);
            for (const segment of descriptorKey.path.split('.').slice(1)) {
              expect(liveKey).toContain(segment);
            }
          }
          if (index.method === 'btree') {
            /** indoption: bit 0 DESC, bit 1 NULLS FIRST; MongoDB's null order per direction. */
            const option = found!.options[position];
            expect({
              key: descriptorKey.path,
              desc: (option & 1) === 1,
              nullsFirst: (option & 2) === 2,
            }).toEqual({
              key: descriptorKey.path,
              desc: descriptorKey.direction === -1,
              nullsFirst: descriptorKey.direction === 1,
            });
          }
          covered.add(documentPath(table, descriptorKey.path));
        });
      }
      /** Every MongoDB key path is a key of one of its SQL indexes (a json key covers subpaths). */
      for (const [path, direction] of mongo.fields) {
        const hit = [...covered].some(
          (keyPath) => keyPath === path || path.startsWith(`${keyPath}.`),
        );
        expect({ path, covered: hit }).toEqual({ path, covered: true });
        const exact = parts.flatMap(({ table, index }) =>
          index.keys.filter((k) => documentPath(table, k.path) === path),
        );
        if (exact.length > 0 && parts.every(({ index }) => index.method === 'btree')) {
          expect(exact.map((k) => k.direction)).toContain(direction);
        }
      }
      /** A single SQL index keeps the MongoDB key order. */
      if (parts.length === 1 && parts[0].index.method === 'btree') {
        expect(parts[0].index.keys.map((k) => documentPath(parts[0].table, k.path))).toEqual(
          mongo.fields.map(([path]) => path),
        );
      }
      /** The partial or sparse predicate tests the filter's (or the keys') columns. */
      if (partial) {
        const filterPaths = (filter: Record<string, unknown>): string[] =>
          Object.entries(filter).flatMap(([path, value]) =>
            path === '$and' && Array.isArray(value)
              ? value.flatMap((entry) => filterPaths(entry as Record<string, unknown>))
              : [path],
          );
        const paths = mongo.options.partialFilterExpression
          ? filterPaths(mongo.options.partialFilterExpression as Record<string, unknown>)
          : mongo.fields.map(([path]) => path);
        for (const { table, index } of parts) {
          const predicate = live.get(index.name)!.predicate!.replace(/"/g, '');
          for (const path of paths) {
            const relativePath =
              table.kind === 'collection' || table.kind === 'raw'
                ? path
                : path.slice(table.path!.length + 1);
            const column = table.columns.find((c) => c.path === relativePath);
            expect({ index: index.name, path, column: column?.name }).toEqual({
              index: index.name,
              path,
              column: expect.any(String),
            });
            expect(predicate).toContain(column!.name);
          }
        }
      }
      /** A TTL index has the sweeper's TTL rule, served by one of its SQL indexes. */
      if (mongo.options.expireAfterSeconds !== undefined) {
        const rules = parts.flatMap(({ table }) => table.ttl);
        const rule = rules.find((entry) => entry.mongoName === source.mongoName);
        expect(rule).toMatchObject({ expireAfterSeconds: mongo.options.expireAfterSeconds });
        expect(live.get(rule!.index)?.valid).toBe(true);
      }
    });
  });
});

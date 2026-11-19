import fs from 'node:fs';
import os from 'node:os';
import ts from 'typescript';
import path from 'node:path';
import { Schema } from 'mongoose';
import {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { SchemaDescriptor } from './descriptor';
import type { SchemaFilePaths } from './files';
import {
  migrationName,
  planMigration,
  isMigrationName,
  emitMigrationIndex,
  emitMigrationModule,
  INITIAL_MIGRATION_NAME,
} from './migrationModule';
import {
  SCHEMA_FILES,
  planSchemaFiles,
  listMigrationModules,
  findOutOfDateSchemaFiles,
} from './files';
import { emitSchemaDdl, emitPreludeDdl } from './emitDdl';
import { buildSchemaDescriptor } from './descriptor';
import { HELPER_FUNCTIONS_DDL } from './functions';
import { introspectSchema } from './generate';
import { runSchemaGenerator } from './cli';

const sub = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });

function describeThings(schema: Schema, large = false): SchemaDescriptor {
  const descriptor = buildSchemaDescriptor([introspectSchema(schema, { collection: 'things' })]);
  return large
    ? { ...descriptor, tables: descriptor.tables.map((table) => ({ ...table, large: true })) }
    : descriptor;
}

/** Evaluates a generated migration module (transpiled to CommonJS) and returns its exports. */
function loadModule(source: string): Record<string, unknown> {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, require);
  return module.exports;
}

describe('PostgreSQL migration modules', () => {
  it('creates the domain, the helper functions, then the whole schema in the first migration', () => {
    const next = describeThings(
      new Schema({ a: String, items: [sub({ b: String })] }).index({ a: 1 }),
      true,
    );
    const plan = planMigration(null, next);
    expect(plan.statements).toEqual([
      ...emitPreludeDdl(),
      ...HELPER_FUNCTIONS_DDL,
      ...emitSchemaDdl(next, { prelude: false }),
    ]);
    /** A new table's indexes are built in the migration, even on a large table: it is empty. */
    expect(plan.deferredIndexes).toEqual([]);
  });

  it('leaves new indexes on large tables to the post-migration step, and drops with IF EXISTS', () => {
    const previous = describeThings(new Schema({ a: String, b: String }).index({ a: 1 }), true);
    const nextSchema = new Schema({ a: String, b: String, c: Number });
    nextSchema.index({ a: 1, b: -1 });
    nextSchema.index({ c: 1 });
    const plan = planMigration(previous, describeThings(nextSchema, true));
    expect(plan.deferredIndexes).toEqual(['things__a__b_desc', 'things__c']);
    expect(plan.statements).toEqual([
      'DROP INDEX IF EXISTS "things__a"',
      'ALTER TABLE "things" ADD COLUMN "c" double precision',
    ]);
    expect(plan.statements.join('\n')).not.toMatch(/CONCURRENTLY|CREATE INDEX/);

    /** On a table that is not large, the same change builds the index in the migration. */
    const small = planMigration(
      describeThings(new Schema({ a: String, b: String }).index({ a: 1 })),
      describeThings(nextSchema),
    );
    expect(small.deferredIndexes).toEqual([]);
    expect(small.statements).toEqual([
      'DROP INDEX "things__a"',
      'ALTER TABLE "things" ADD COLUMN "c" double precision',
      'CREATE INDEX "things__a__b_desc" ON "things" ("a" ASC NULLS FIRST, "b" DESC NULLS LAST)',
      'CREATE INDEX "things__c" ON "things" ("c" ASC NULLS FIRST)',
    ]);
  });

  it('writes a module whose statements survive template-literal escaping, with an up()', async () => {
    const tricky = [
      "SELECT `back`, ${not_interpolated}, E'\\n', $lc$ \\d $lc$",
      'CREATE TABLE "x" (\n  "y" text\n)',
    ];
    const source = emitMigrationModule('202601020304_tricky', {
      changes: [],
      statements: tricky,
      deferredIndexes: ['messages__a', 'messages__b'],
    });
    expect(source).toContain('Indexes on large tables built `CONCURRENTLY`');
    expect(source).toContain('messages__a messages__b');
    const loaded = loadModule(source);
    expect(loaded.statements).toEqual(tricky);
    const executed: string[] = [];
    const db = new Kysely<unknown>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      log: (event) => {
        executed.push(event.query.sql);
      },
    });
    await (loaded.up as (kysely: Kysely<unknown>) => Promise<void>)(db);
    expect(executed).toEqual(tricky);
  });

  it('names migrations by UTC minute and slug, the first one 0001_initial', () => {
    const now = new Date(Date.UTC(2026, 10, 16, 9, 5, 59));
    expect(migrationName('Add widget fields!', now)).toBe('202611160905_add_widget_fields');
    expect(() => migrationName('  ', now)).toThrow(/slug/);
    expect(isMigrationName(INITIAL_MIGRATION_NAME)).toBe(true);
    expect(isMigrationName('202611160905_add_widget_fields')).toBe(true);
    expect(isMigrationName('2026_add')).toBe(false);
    expect(isMigrationName('202611160905_Add')).toBe(false);
  });

  it('lists every migration in index.ts, in the repository import order', () => {
    const source = emitMigrationIndex(['202611160905_add_widget_fields', '0001_initial']);
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    expect(imports).toEqual([
      "import type { Migration } from 'kysely';",
      "import * as m202611160905AddWidgetFields from './202611160905_add_widget_fields';",
      "import * as m0001Initial from './0001_initial';",
    ]);
    expect(source).toContain(
      [
        "  '0001_initial': m0001Initial,",
        "  '202611160905_add_widget_fields': m202611160905AddWidgetFields,",
      ].join('\n'),
    );
    expect(() => emitMigrationIndex(['bad name'])).toThrow(/not a migration name/);
  });
});

describe('db:generate (checked-in files)', () => {
  let root: string;
  let paths: SchemaFilePaths;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pg-files-'));
    paths = { schemaDir: path.join(root, 'schema'), migrationsDir: path.join(root, 'migrations') };
    fs.mkdirSync(paths.schemaDir);
    fs.mkdirSync(paths.migrationsDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (plan: ReturnType<typeof planSchemaFiles>) => {
    for (const file of plan.writes) fs.writeFileSync(file.path, file.content);
  };

  it('writes 0001_initial first, nothing new while unchanged, then a stamped migration', () => {
    const first = describeThings(new Schema({ a: String }).index({ a: 1 }), true);
    const initial = planSchemaFiles(first, paths);
    expect(initial.migration).toBe(INITIAL_MIGRATION_NAME);
    expect(findOutOfDateSchemaFiles(initial).map((file) => path.relative(root, file))).toEqual([
      `schema/${SCHEMA_FILES.descriptor}`,
      `schema/${SCHEMA_FILES.kysely}`,
      `schema/${SCHEMA_FILES.snapshot}`,
      'migrations/0001_initial.ts',
      'migrations/index.ts',
    ]);
    write(initial);
    expect(listMigrationModules(paths.migrationsDir)).toEqual(['0001_initial']);

    const unchanged = planSchemaFiles(first, paths);
    expect(unchanged.migration).toBeUndefined();
    expect(findOutOfDateSchemaFiles(unchanged)).toEqual([]);

    const changed = describeThings(new Schema({ a: String, b: Date }).index({ b: 1 }), true);
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4));
    const next = planSchemaFiles(changed, paths, { slug: 'add b', now });
    expect(next.migration).toBe('202601020304_add_b');
    expect(next.deferredIndexes).toEqual(['things__b']);
    write(next);
    expect(listMigrationModules(paths.migrationsDir)).toEqual([
      '0001_initial',
      '202601020304_add_b',
    ]);
    expect(fs.readFileSync(path.join(paths.migrationsDir, 'index.ts'), 'utf8')).toContain(
      "'202601020304_add_b': m202601020304AddB,",
    );
    expect(findOutOfDateSchemaFiles(planSchemaFiles(changed, paths))).toEqual([]);
  });

  it('refuses a missing snapshot while migrations exist, and stray files in migrations/', () => {
    const descriptor = describeThings(new Schema({ a: String }));
    write(planSchemaFiles(descriptor, paths));
    fs.rmSync(path.join(paths.schemaDir, SCHEMA_FILES.snapshot));
    expect(() => planSchemaFiles(descriptor, paths)).toThrow(/snapshot.json is missing/);
    fs.writeFileSync(path.join(paths.migrationsDir, 'notes.ts'), '');
    expect(() => listMigrationModules(paths.migrationsDir)).toThrow(/not named like a migration/);
  });

  it('runs as the CLI: --write updates the files, --check fails while they are out of date', () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const descriptor = describeThings(new Schema({ a: String }));
    expect(runSchemaGenerator(['--check'], log, { paths, descriptor })).toBe(1);
    expect(lines).toContain(
      'The PostgreSQL schema files are out of date: run `npm run db:generate`.',
    );
    expect(runSchemaGenerator(['--write'], log, { paths, descriptor })).toBe(0);
    expect(lines).toContain('new migration: 0001_initial');
    lines.length = 0;
    expect(runSchemaGenerator(['--check'], log, { paths, descriptor })).toBe(0);
    expect(runSchemaGenerator(['--write'], log, { paths, descriptor })).toBe(0);
    expect(lines).toContain('No schema change since the latest migration.');
    expect(lines.filter((line) => line.startsWith('wrote '))).toEqual([]);
    expect(() => runSchemaGenerator(['--write', '--out', root], log)).toThrow(
      /--write and --check/,
    );
    expect(() => runSchemaGenerator(['--write', '--check'], log)).toThrow(/exclude each other/);
    expect(() => runSchemaGenerator(['--name'], log)).toThrow(/--name needs a slug/);
  });
});

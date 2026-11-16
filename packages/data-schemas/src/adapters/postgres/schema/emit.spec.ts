import ts from 'typescript';
import path from 'node:path';
import { Schema } from 'mongoose';
import type { SchemaDescriptor } from './descriptor';
import { emitSchemaDdl, emitTableDdl, emitIndexDdl, OBJECT_ID_DOMAIN_DDL } from './emitDdl';
import { emitKyselyTypes, tableInterfaceName } from './emitKysely';
import { buildSchemaDescriptor } from './descriptor';
import { introspectSchema } from './generate';

const sub = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });

function sample(): SchemaDescriptor {
  const schema = new Schema(
    {
      title: String,
      tags: [String],
      at: Date,
      days: [Date],
      blob: Buffer,
      meta: Schema.Types.Mixed,
      items: [sub({ sku: String, qty: Number })],
      'odd-name': Boolean,
    },
    { timestamps: true },
  );
  schema.index({ title: 1, at: -1 }, { unique: true });
  schema.index({ tags: 1 });
  schema.index({ 'items.sku': 1 }, { sparse: true });
  return buildSchemaDescriptor([introspectSchema(schema, { collection: 'things' })]);
}

describe('PostgreSQL DDL emitter', () => {
  const descriptor = sample();

  it('emits a table with its columns, primary key and system columns', () => {
    expect(emitTableDdl(descriptor.tables[0])).toBe(
      [
        'CREATE TABLE "things" (',
        '  "title" text COLLATE "C",',
        '  "tags" text[] COLLATE "C",',
        '  "at" timestamptz,',
        '  "days" timestamptz[],',
        '  "blob" bytea,',
        '  "meta" json,',
        '  "items" integer,',
        '  "odd-name" boolean,',
        '  "_id" lc_object_id NOT NULL,',
        '  "createdAt" timestamptz,',
        '  "updatedAt" timestamptz,',
        '  "__v" integer,',
        '  "_nulls" text[] COLLATE "C",',
        '  "_extra" jsonb,',
        '  CONSTRAINT "things__pkey" PRIMARY KEY ("_id")',
        ')',
      ].join('\n'),
    );
  });

  it('emits a child table keyed by (_parent, _ord) with a cascading parent key', () => {
    expect(emitTableDdl(descriptor.tables[1])).toBe(
      [
        'CREATE TABLE "things__items" (',
        '  "_parent" lc_object_id NOT NULL,',
        '  "_ord" integer NOT NULL,',
        '  "sku" text COLLATE "C",',
        '  "qty" double precision,',
        '  "_nulls" text[] COLLATE "C",',
        '  "_extra" jsonb,',
        '  CONSTRAINT "things__items__pkey" PRIMARY KEY ("_parent", "_ord"),',
        '  CONSTRAINT "things__items__parent_fkey" FOREIGN KEY ("_parent") REFERENCES "things" ("_id") ON DELETE CASCADE',
        ')',
      ].join('\n'),
    );
  });

  it('emits btree (NULLS NOT DISTINCT uniques, MongoDB null order), GIN and child indexes', () => {
    const indexes = descriptor.tables.flatMap((table) =>
      table.indexes.map((index) => emitIndexDdl(index)),
    );
    expect(indexes).toEqual([
      'CREATE UNIQUE INDEX "things__title__at_desc" ON "things" ("title" ASC NULLS FIRST, "at" DESC NULLS LAST) NULLS NOT DISTINCT',
      'CREATE INDEX "things__tags__gin" ON "things" USING gin ("tags")',
      `CREATE INDEX "things__items__sku__p" ON "things__items" ("sku" ASC NULLS FIRST) WHERE ("sku" IS NOT NULL OR 'sku' = ANY ("_nulls"))`,
    ]);
    expect(emitIndexDdl(descriptor.tables[0].indexes[1], { concurrently: true })).toBe(
      'CREATE INDEX CONCURRENTLY "things__tags__gin" ON "things" USING gin ("tags")',
    );
  });

  it('emits the domain first, tables parents first, then the indexes', () => {
    const statements = emitSchemaDdl({ ...descriptor, tables: [...descriptor.tables].reverse() });
    expect(statements[0]).toBe(OBJECT_ID_DOMAIN_DDL);
    expect(statements[1]).toMatch(/^CREATE TABLE "things" /);
    expect(statements[2]).toMatch(/^CREATE TABLE "things__items" /);
    expect(statements.slice(3).every((statement) => statement.includes(' INDEX '))).toBe(true);
    expect(emitSchemaDdl(descriptor, { prelude: false })[0]).toMatch(/^CREATE TABLE/);
  });
});

describe('Kysely type emitter', () => {
  const descriptor = sample();
  const source = emitKyselyTypes(descriptor);

  it('names one interface per table and maps column types as the pool reads them', () => {
    expect(tableInterfaceName('conversations__codeWorkspaces')).toBe(
      'ConversationsCodeWorkspacesTable',
    );
    expect(source).toContain('export interface ThingsTable {');
    expect(source).toContain('  title: string | null;');
    expect(source).toContain('  tags: string[] | null;');
    expect(source).toContain('  at: Timestamp | null;');
    expect(source).toContain('  days: Date[] | null;');
    expect(source).toContain('  blob: Buffer | null;');
    expect(source).toContain('  meta: string | null;');
    expect(source).toContain('  "odd-name": boolean | null;');
    expect(source).toContain('  _id: string;');
    expect(source).toContain('  things__items: ThingsItemsTable;');
  });

  it('compiles, and types queries over the tables', () => {
    const directory = path.join(__dirname);
    const files: Record<string, string> = {
      [path.join(directory, '__emitted_db.ts')]: source,
      [path.join(directory, '__emitted_usage.ts')]: [
        "import type { Kysely } from 'kysely';",
        "import type { Database } from './__emitted_db';",
        'export async function read(db: Kysely<Database>): Promise<Array<string | null>> {',
        "  const rows = await db.selectFrom('things__items').select(['_parent', 'sku']).execute();",
        '  const id: string = rows[0]._parent;',
        '  void id;',
        '  return rows.map((row) => row.sku);',
        '}',
        '// @ts-expect-error unknown column',
        "export const wrong = (db: Kysely<Database>) => db.selectFrom('things').select('missing');",
      ].join('\n'),
    };
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      types: ['node'],
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, ...rest) =>
      files[fileName] !== undefined
        ? ts.createSourceFile(fileName, files[fileName], languageVersion)
        : getSourceFile(fileName, languageVersion, ...rest);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (fileName) => files[fileName] !== undefined || fileExists(fileName);
    const readFile = host.readFile.bind(host);
    host.readFile = (fileName) => files[fileName] ?? readFile(fileName);
    const program = ts.createProgram(Object.keys(files), options, host);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file && files[diagnostic.file.fileName] !== undefined)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  }, 60_000);
});

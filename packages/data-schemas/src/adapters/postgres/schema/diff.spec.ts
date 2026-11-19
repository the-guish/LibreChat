import { Schema } from 'mongoose';
import type { SchemaDescriptor } from './descriptor';
import { diffSchemaDescriptors, emitMigrationDdl } from './diff';
import { buildSchemaDescriptor } from './descriptor';
import { SchemaGenerationError } from './naming';
import { introspectSchema } from './generate';
import { emitSchemaDdl } from './emitDdl';

const sub = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });

function describeThings(schema: Schema, collection = 'things'): SchemaDescriptor {
  return buildSchemaDescriptor([introspectSchema(schema, { collection })]);
}

function large(descriptor: SchemaDescriptor): SchemaDescriptor {
  return { ...descriptor, tables: descriptor.tables.map((table) => ({ ...table, large: true })) };
}

describe('PostgreSQL snapshot diff', () => {
  it('creates everything from an empty database, the prelude first', () => {
    const next = describeThings(
      new Schema({ a: String, items: [sub({ b: String })] }).index({ a: 1 }),
    );
    const statements = emitMigrationDdl(diffSchemaDescriptors(null, next), { prelude: true });
    expect(statements.map((statement) => statement.sql)).toEqual(emitSchemaDdl(next));
    expect(statements.every((statement) => !statement.concurrently)).toBe(true);
  });

  it('finds no change between equal descriptors', () => {
    const descriptor = describeThings(new Schema({ a: String }).index({ a: 1 }));
    expect(
      diffSchemaDescriptors(descriptor, describeThings(new Schema({ a: String }).index({ a: 1 }))),
    ).toEqual([]);
  });

  it('adds new fields as nullable columns and new subdocument arrays as child tables', () => {
    const previous = describeThings(new Schema({ a: String }));
    const next = describeThings(new Schema({ a: String, b: Number, items: [sub({ c: String })] }));
    expect(emitMigrationDdl(diffSchemaDescriptors(previous, next)).map((s) => s.sql)).toEqual([
      expect.stringMatching(/^CREATE TABLE "things__items" \(/),
      'ALTER TABLE "things" ADD COLUMN "b" double precision',
      'ALTER TABLE "things" ADD COLUMN "items" integer',
    ]);
  });

  it('moves a removed field into _extra (tagged encoding, explicit nulls) before dropping it', () => {
    const previous = describeThings(new Schema({ a: String, gone: Date }));
    const next = describeThings(new Schema({ a: String }));
    const changes = diffSchemaDescriptors(previous, next);
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'dropColumn', table: 'things', moveToExtra: true }),
    ]);
    const statements = emitMigrationDdl(changes).map((s) => s.sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(`jsonb_build_object('$date'`);
    expect(statements[0]).toContain(`WHERE "gone" IS NOT NULL`);
    expect(statements[1]).toContain(`array_remove("_nulls", 'gone')`);
    expect(statements[2]).toBe('ALTER TABLE "things" DROP COLUMN "gone"');
  });

  it('alters a type only by a total cast, otherwise asks for a hand-written migration', () => {
    const toJson = diffSchemaDescriptors(
      describeThings(new Schema({ a: String })),
      describeThings(new Schema({ a: Schema.Types.Mixed })),
    );
    expect(emitMigrationDdl(toJson).map((s) => s.sql)).toEqual([
      'ALTER TABLE "things" ALTER COLUMN "a" TYPE json USING to_json("a")',
    ]);
    const toText = diffSchemaDescriptors(
      describeThings(new Schema({ a: Number })),
      describeThings(new Schema({ a: String })),
    );
    expect(emitMigrationDdl(toText).map((s) => s.sql)).toEqual([
      'ALTER TABLE "things" ALTER COLUMN "a" TYPE text COLLATE "C" USING "a"::text',
    ]);
    expect(() =>
      diffSchemaDescriptors(
        describeThings(new Schema({ a: String })),
        describeThings(new Schema({ a: Number })),
      ),
    ).toThrow(/not a total cast/);
    expect(() =>
      diffSchemaDescriptors(
        describeThings(new Schema({ a: String })),
        describeThings(new Schema({ a: { b: String } })),
      ),
    ).toThrow(SchemaGenerationError);
  });

  it('refuses a removed table and a changed primary key', () => {
    const withItems = describeThings(new Schema({ items: [sub({ c: String })] }));
    expect(() => diffSchemaDescriptors(withItems, describeThings(new Schema({})))).toThrow(
      /table "things__items" \(things.items\) was removed/,
    );
    expect(() =>
      diffSchemaDescriptors(
        describeThings(new Schema({ a: String })),
        describeThings(new Schema({ _id: String, a: String })),
      ),
    ).toThrow(/not a total cast|primary key/);
  });

  it('creates, recreates and drops indexes and hint checks; CONCURRENTLY on large tables', () => {
    const previous = large(
      describeThings(new Schema({ a: String, b: String }).index({ a: 1 }).index({ b: 1 })),
    );
    const next = large(
      describeThings(
        new Schema({ a: String, b: String })
          .index({ a: 1 }, { unique: true })
          .index({ a: 1, b: 1 }),
      ),
    );
    const statements = emitMigrationDdl(diffSchemaDescriptors(previous, next));
    expect(statements).toEqual([
      { sql: 'DROP INDEX CONCURRENTLY "things__a"', concurrently: true },
      { sql: 'DROP INDEX CONCURRENTLY "things__b"', concurrently: true },
      {
        sql: 'CREATE UNIQUE INDEX CONCURRENTLY "things__a" ON "things" ("a" ASC NULLS FIRST) NULLS NOT DISTINCT',
        concurrently: true,
      },
      {
        sql: 'CREATE INDEX CONCURRENTLY "things__a__b" ON "things" ("a" ASC NULLS FIRST, "b" ASC NULLS FIRST)',
        concurrently: true,
      },
    ]);
    const hinted = buildSchemaDescriptor(
      [introspectSchema(new Schema({ m: Schema.Types.Mixed }), { collection: 'things' })],
      {
        columnTypes: [],
        elementTables: [],
        pluginPaths: [],
        largeTables: { collections: [], reason: '' },
        jsonHints: [{ collection: 'things', path: 'm', subpaths: ['x'], reason: 'spec' }],
      },
    );
    const plain = describeThings(new Schema({ m: Schema.Types.Mixed }));
    expect(emitMigrationDdl(diffSchemaDescriptors(plain, hinted)).map((s) => s.sql)).toEqual([
      expect.stringMatching(/^ALTER TABLE "things" ADD CONSTRAINT "things__m__x__hint" CHECK \(/),
    ]);
    expect(emitMigrationDdl(diffSchemaDescriptors(hinted, plain)).map((s) => s.sql)).toEqual([
      'ALTER TABLE "things" DROP CONSTRAINT "things__m__x__hint"',
    ]);
  });
});

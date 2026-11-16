import { Schema, Types } from 'mongoose';
import type { Pool } from 'pg';
import type { ChildReadMode } from './assemble';
import type { CorpusVariant } from './corpusD';
import type { RecordTables } from './tables';
import { generateSchemaDescriptor, introspectSchema } from '../schema/generate';
import { getNulReplacementCount, resetNulReplacementCount } from '../values';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { readChildRows, readRecords, selectRecord } from './assemble';
import { decomposeRecord, insertStatements } from './decompose';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { corpusId, generateCorpusDocument } from './corpusD';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { createSchemaEngine } from '../schema/engine';
import { emitSchemaDdl } from '../schema/emitDdl';
import { absenceSql, presenceSql } from './nulls';
import { indexRecordTables } from './tables';

const descriptor = generateSchemaDescriptor();
const tables = indexRecordTables(descriptor);
const engine = createSchemaEngine();

/** The values an `enum` allows at a document path of `collection`. */
function enumOf(collection: string) {
  return (path: string) => {
    const type = engine.model(collection).schema.path(path) as unknown as
      | { enumValues?: unknown[]; caster?: { enumValues?: unknown[] } }
      | undefined;
    const values = type?.enumValues ?? type?.caster?.enumValues;
    return values && values.length > 0 ? values : undefined;
  };
}

/** Every hidden path of `collection`'s tables, as document paths (`+path` for all of them). */
function hiddenPaths(collection: string): string[] {
  return descriptor.tables
    .filter((table) => table.collection === collection)
    .flatMap((table) =>
      table.hiddenPaths.map((path) => (table.path ? `${table.path}.${path}` : path)),
    );
}

/**
 * A lean MongoDB read of `built` (a `toObject()`): ids as hex (R7), binaries as `Buffer`s, `_id`
 * first (the server moves it there) and the version key last (set on insert).
 */
function expectedRecord(
  built: Record<string, unknown>,
  versionKey: string | null,
): Record<string, unknown> {
  const normalize = (value: unknown): unknown => {
    if (
      value === null ||
      typeof value !== 'object' ||
      value instanceof Date ||
      Buffer.isBuffer(value)
    ) {
      return value;
    }
    const bson = value as {
      _bsontype?: string;
      toHexString?: () => string;
      buffer?: Uint8Array;
      position?: number;
    };
    if (bson._bsontype === 'Binary') {
      return Buffer.from(bson.buffer!.subarray(0, bson.position));
    }
    if (typeof bson.toHexString === 'function') {
      return bson.toHexString();
    }
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  };
  const plain = normalize(built) as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  if ('_id' in plain) ordered._id = plain._id;
  for (const [key, value] of Object.entries(plain)) {
    if (key !== '_id' && key !== versionKey) ordered[key] = value;
  }
  if (versionKey && versionKey in plain) ordered[versionKey] = plain[versionKey];
  return ordered;
}

/** A serialization that keeps key order at every depth (dates, buffers, `-0` spelled out). */
function ordered(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (Buffer.isBuffer(value)) return `Buffer(${value.toString('hex')})`;
  if (Array.isArray(value)) return `[${value.map(ordered).join(',')}]`;
  return `{${Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)}:${ordered(item)}`)
    .join(',')}}`;
}

/** Inserts decomposed records in one transaction. */
async function insert(
  pool: Pool,
  all: RecordTables,
  records: ReturnType<typeof decomposeRecord>[],
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of insertStatements(all, records)) {
      await client.query(statement.text, statement.values);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const VARIANTS: CorpusVariant[] = ['full', 'nulls', 'topNulls', 'empty'];
const MODES: ChildReadMode[] = ['subselect', 'batched'];

describePostgres('PostgreSQL record codec', () => {
  const database = usePostgresTestDatabase();
  let pool: Pool;

  beforeAll(async () => {
    pool = database.pool();
    for (const statement of emitSchemaDdl(descriptor)) {
      await pool.query(statement);
    }
  }, 180_000);

  describe('corpus D round trips: generated document → engine → insert → assemble equals toObject()', () => {
    const roots = tables.roots.map((root) => root.descriptor.collection);

    it('covers every production table: 53 collections and 10 raw collections', () => {
      expect(roots).toHaveLength(63);
      expect(new Set(engine.collections)).toEqual(new Set(roots));
    });

    it.each(roots)('%s', async (collection) => {
      const root = tables.collection(collection);
      const { versionKey, idType, systemColumns } = {
        ...root.descriptor,
        systemColumns: root.systemColumns,
      };
      let seed = 1;
      for (const variant of VARIANTS) {
        for (const mode of MODES) {
          seed += 1;
          const input = generateCorpusDocument(tables, collection, variant, {
            seed,
            enumOf: enumOf(collection),
          });
          const built = await engine.buildDocument(collection, input, { validate: false });
          const decomposed = decomposeRecord(tables, collection, built);
          await insert(pool, tables, [decomposed]);
          const key = idType
            ? { where: '"t"."_id" = $1', values: [decomposed.id] }
            : {
                where: root.descriptor.primaryKey
                  .map((column, index) => `"t".${JSON.stringify(column)} = $${index + 1}`)
                  .join(' AND '),
                values: root.descriptor.primaryKey.map((column) => decomposed.row[column]),
              };
          const [record] = await readRecords(pool, tables, collection, {
            children: mode,
            projection: { includeHidden: hiddenPaths(collection) },
            ...key,
          });
          /** The next variant may hold the same unique values (child rows go by cascade). */
          await pool.query(
            `DELETE FROM ${JSON.stringify(root.descriptor.name)} AS "t" WHERE ${key.where}`,
            key.values,
          );
          let expected = expectedRecord(built, versionKey);
          if (!systemColumns) {
            /** No `_nulls` on this table: an explicit null reads back as missing. */
            expected = Object.fromEntries(
              Object.entries(expected).filter(([, value]) => value !== null),
            );
          }
          if (variant === 'empty') {
            /**
             * Defaults applied after the given paths (arrays of subdocuments, Maps) sit at their
             * schema position here, where MongoDB keeps them after the given ones (R7).
             */
            expect(record).toEqual(expected);
          } else {
            expect({ variant, mode, record: ordered(record) }).toEqual({
              variant,
              mode,
              record: ordered(expected),
            });
          }
        }
      }
    });
  });

  describe('key order', () => {
    it('is _id, the declared paths in schema order, the version key, then _extra keys', async () => {
      const input = generateCorpusDocument(tables, 'conversations', 'full', {
        seed: 501,
        enumOf: enumOf('conversations'),
      });
      const built = await engine.buildDocument('conversations', input, { validate: false });
      const decomposed = decomposeRecord(tables, 'conversations', { ...built, legacyField: 1 });
      await insert(pool, tables, [decomposed]);
      const [record] = await readRecords(pool, tables, 'conversations', {
        where: '"t"."_id" = $1',
        values: [decomposed.id],
        projection: { includeHidden: hiddenPaths('conversations') },
      });
      const keys = Object.keys(record);
      const schemaOrder = Object.keys(built).filter((key) => key !== '_id' && key !== '__v');
      expect(keys).toEqual(['_id', ...schemaOrder, '__v', 'legacyField']);
      expect(keys.indexOf('createdAt')).toBeGreaterThan(keys.indexOf('title'));
      expect(keys.indexOf('_meiliIndex')).toBeLessThan(keys.indexOf('__v'));
      const mixedPath = tables
        .collection('conversations')
        .descriptor.fields.find((field) => field.kind === 'json');
      expect(
        Object.keys((record as Record<string, Record<string, unknown>>)[mixedPath!.path] ?? {}),
      ).toEqual(
        Object.keys((built as Record<string, Record<string, unknown>>)[mixedPath!.path] ?? {}),
      );
    });

    it('keeps a subdocument _id where its schema has it, and json key order exactly', async () => {
      const built = await engine.buildDocument(
        'users',
        {
          _id: corpusId(77),
          email: 'Key@Order.test',
          personalization: { memories: false },
          plugins: [{ zeta: 1, alpha: 2 }],
        },
        { validate: false },
      );
      await insert(pool, tables, [decomposeRecord(tables, 'users', built)]);
      const [record] = await readRecords(pool, tables, 'users', {
        where: '"t"."_id" = $1',
        values: [corpusId(77)],
      });
      expect(Object.keys(record.personalization as object)).toEqual(
        Object.keys(built.personalization as object),
      );
      expect(Object.keys((record.plugins as object[])[0])).toEqual(['zeta', 'alpha']);
      expect(record.email).toBe('key@order.test');
    });
  });

  describe('_nulls', () => {
    const ids = [1, 2, 3].map((n) => corpusId(0x900 + n));

    beforeAll(async () => {
      const records = [
        { _id: ids[0], conversationId: 'c1', title: null, agentEventActor: null, tags: null },
        { _id: ids[1], conversationId: 'c2' },
        { _id: ids[2], conversationId: 'c3', title: 'set', agentEventActor: {}, tags: [] },
      ];
      await insert(
        pool,
        tables,
        records.map((record) => decomposeRecord(tables, 'conversations', record, { mode: 'raw' })),
      );
    });

    it('reads explicit nulls as null and omits missing paths', async () => {
      const records = await readRecords(pool, tables, 'conversations', {
        where: '"t"."_id" = ANY ($1)',
        values: [ids],
        orderBy: '"t"."_id"',
        projection: { include: ['title', 'agentEventActor', 'tags'] },
      });
      expect(records).toEqual([
        { _id: ids[0], title: null, agentEventActor: null, tags: null },
        { _id: ids[1] },
        { _id: ids[2], title: 'set', agentEventActor: {}, tags: [] },
      ]);
    });

    it('serves `null` (IS NULL) and `$exists` (the presence rule) in SQL', async () => {
      const select = async (where: string) =>
        (
          await pool.query<{ _id: string }>(
            `SELECT "_id" FROM "conversations" AS "t" WHERE "_id" = ANY ($1) AND ${where} ORDER BY "_id"`,
            [ids],
          )
        ).rows.map((row) => row._id);
      expect(await select('"t"."title" IS NULL')).toEqual([ids[0], ids[1]]);
      expect(await select(presenceSql('title', 'title', { alias: 't' }))).toEqual([ids[0], ids[2]]);
      expect(
        await select(absenceSql('agentEventActor', 'agentEventActor', { alias: 't' })),
      ).toEqual([ids[1]]);
    });
  });

  describe('_extra (D7) and projections', () => {
    const id = corpusId(0xe00);

    beforeAll(async () => {
      await insert(pool, tables, [
        decomposeRecord(
          tables,
          'sharedlinks',
          {
            _id: id,
            shareId: 'share',
            isPublic: true,
            title: 'kept',
            fileSnapshots: [{ file_id: 'f', legacyKey: 'old' }],
            conversationId: { not: 'a string' },
          },
          { mode: 'raw' },
        ),
      ]);
    });

    it('merges undeclared and misfit values after the declared keys, in child rows too', async () => {
      const [record] = await readRecords(pool, tables, 'sharedlinks', {
        where: '"t"."_id" = $1',
        values: [id],
      });
      const keys = Object.keys(record);
      expect(keys.slice(-2).sort()).toEqual(['conversationId', 'isPublic']);
      expect(record).toMatchObject({
        shareId: 'share',
        title: 'kept',
        isPublic: true,
        conversationId: { not: 'a string' },
        fileSnapshots: [{ file_id: 'f', legacyKey: 'old' }],
      });
    });

    it('applies inclusion and exclusion projections to declared and _extra keys', async () => {
      const [included] = await readRecords(pool, tables, 'sharedlinks', {
        where: '"t"."_id" = $1',
        values: [id],
        projection: { include: ['title', 'isPublic', 'fileSnapshots.file_id'], exclude: ['_id'] },
      });
      expect(included).toEqual({
        title: 'kept',
        fileSnapshots: [{ file_id: 'f' }],
        isPublic: true,
      });
      const [excluded] = await readRecords(pool, tables, 'sharedlinks', {
        where: '"t"."_id" = $1',
        values: [id],
        projection: { exclude: ['isPublic', 'fileSnapshots', 'title'] },
      });
      expect(excluded).not.toHaveProperty('isPublic');
      expect(excluded).not.toHaveProperty('fileSnapshots');
      expect(excluded).toHaveProperty('shareId', 'share');
    });

    it('leaves hidden paths out unless named, and selects only the columns a projection needs', async () => {
      const built = await engine.buildDocument(
        'messages',
        { _id: corpusId(0xe01), messageId: 'm', conversationId: 'c', user: 'u' },
        { validate: false },
      );
      await insert(pool, tables, [decomposeRecord(tables, 'messages', built)]);
      const read = (projection: object) =>
        readRecords(pool, tables, 'messages', {
          where: '"t"."_id" = $1',
          values: [corpusId(0xe01)],
          projection,
        });
      const [plain] = await read({});
      expect(plain).not.toHaveProperty('_meiliIndex');
      const [withHidden] = await read({ includeHidden: ['_meiliIndex', '_meiliCleanupVersion'] });
      expect(withHidden).toMatchObject({ _meiliIndex: false, _meiliCleanupVersion: 1 });
      const narrow = selectRecord(tables, 'messages', { projection: { include: ['text'] } });
      expect(narrow.columns.map((column) => column.name)).toEqual([
        '_id',
        'text',
        '_nulls',
        '_extra',
      ]);
      expect(narrow.children).toEqual([]);
    });
  });

  describe('child reads', () => {
    it('reads the child rows of a batch of parents with one query per child table', async () => {
      const records = await Promise.all(
        [1, 2, 3].map(async (n) =>
          decomposeRecord(
            tables,
            'balances',
            await engine.buildDocument(
              'balances',
              generateCorpusDocument(tables, 'balances', 'full', { seed: 700 + n }),
              { validate: false },
            ),
          ),
        ),
      );
      await insert(pool, tables, records);
      const projection = { includeHidden: hiddenPaths('balances') };
      const select = selectRecord(tables, 'balances', { children: 'batched', projection });
      expect(select.children.length).toBeGreaterThan(0);
      const { rows } = await pool.query(
        `SELECT ${select.sql} FROM "balances" AS "t" WHERE "_id" = ANY ($1) ORDER BY "_id"`,
        [records.map((record) => record.id)],
      );
      let queries = 0;
      const counting = {
        query: (text: string, values?: unknown[]) => {
          queries += 1;
          return pool.query(text, values);
        },
      };
      const batch = await readChildRows(
        counting,
        select,
        rows.map((row) => row._id as string),
      );
      expect(queries).toBe(select.children.length);
      const batched = rows.map((row) => select.decode(row, batch));
      const subselected = await readRecords(pool, tables, 'balances', {
        projection,
        where: '"t"."_id" = ANY ($1)',
        values: [records.map((record) => record.id)],
        orderBy: '"t"."_id"',
      });
      expect(batched.map(ordered)).toEqual(subselected.map(ordered));
    });

    it('aggregates child rows wider than json_build_array takes (chunked)', async () => {
      const element: Record<string, unknown> = {};
      for (let index = 0; index < 120; index++) element[`f${index}`] = Number;
      const schema = new Schema({ items: [new Schema(element, { _id: false })] });
      const wide = buildSchemaDescriptor(
        [introspectSchema(schema, { collection: 'widethings' })],
        NO_SCHEMA_OVERRIDES,
      );
      for (const statement of emitSchemaDdl(wide, { prelude: false })) {
        await pool.query(statement);
      }
      const wideTables = indexRecordTables(wide);
      const item = Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [`f${index}`, index]),
      );
      await insert(pool, wideTables, [
        decomposeRecord(wideTables, 'widethings', { _id: corpusId(1), items: [item, item] }),
      ]);
      const [record] = await readRecords(pool, wideTables, 'widethings');
      expect(record).toEqual({ _id: corpusId(1), items: [item, item] });
    });
  });

  describe('U+0000 (D8)', () => {
    it('stores U+FFFD in text, arrays, json, child rows and _extra; json stays castable to jsonb', async () => {
      resetNulReplacementCount();
      const id = new Types.ObjectId().toHexString();
      const built = await engine.buildDocument(
        'conversations',
        {
          _id: id,
          conversationId: 'nul\u0000id',
          title: 'a\u0000b',
          tags: ['t\u0000'],
          examples: [{ 'k\u0000': 'v\u0000' }],
          codeWorkspaces: [{ environmentId: 'e\u0000' }],
        },
        { validate: false },
      );
      await insert(pool, tables, [
        decomposeRecord(tables, 'conversations', { ...built, legacy: 'x\u0000' }),
      ]);
      expect(getNulReplacementCount()).toBe(7);
      const [record] = await readRecords(pool, tables, 'conversations', {
        where: '"t"."_id" = $1',
        values: [id],
      });
      expect(record).toMatchObject({
        conversationId: 'nul�id',
        title: 'a�b',
        tags: ['t�'],
        examples: [{ 'k�': 'v�' }],
        codeWorkspaces: [{ environmentId: 'e�' }],
        legacy: 'x�',
      });
      const { rows } = await pool.query(
        `SELECT "examples"::jsonb AS examples FROM "conversations" WHERE "_id" = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      resetNulReplacementCount();
    });
  });
});

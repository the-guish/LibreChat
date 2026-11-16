import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { StoreFilter } from '~/ports/query';
import type { PgCollection } from './index';
import {
  castTypedRecord,
  TYPED_CORPUS_PATHS,
  TYPED_CORPUS_COLLECTION,
  typedCorpusSchemaDefinition,
} from '~/ports/query.corpus.typed';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createSchemaEngineForSchemas } from '../schema/engine';
import { buildStoreQueryCorpus } from '~/ports/query.corpus';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { HELPER_FUNCTIONS_DDL } from '../schema/functions';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { emitSchemaDdl } from '../schema/emitDdl';
import { StoreQueryError } from '~/ports/query';
import { createPgCollections } from './index';

/**
 * Corpus B (docs/postgres-port/PHASE4.md §2.5, §8 C1): corpus A's update and upsert cases whose
 * paths the typed schema declares, run through `PgCollection` on the typed tables (typed columns,
 * flattened subdocuments, `T[]`, a child table for `items`, a `json` column for `meta`) and through
 * mongoose on MongoDB, on the same cast record. The stored records must be equal (ids as hex, key
 * order aside), and an update MongoDB refuses must be refused. Tier 1 runs with the shadow check on.
 */

type Doc = Record<string, unknown>;

const subdocument = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });
const schema = new Schema(
  typedCorpusSchemaDefinition({
    ObjectId: Schema.Types.ObjectId,
    Mixed: Schema.Types.Mixed,
    subdocument,
  }),
  { versionKey: false, autoIndex: false },
);
const tables = indexRecordTables(
  buildSchemaDescriptor(
    [introspectSchema(schema, { collection: TYPED_CORPUS_COLLECTION })],
    NO_SCHEMA_OVERRIDES,
  ),
);
const corpus = buildStoreQueryCorpus((hex) => new Types.ObjectId(hex));

const declared = (path: string) => TYPED_CORPUS_PATHS.includes(path.split('.')[0]);
const updatePaths = (update: Doc): string[] =>
  Object.entries(update).flatMap(([key, value]) =>
    key.startsWith('$') ? Object.keys(value as Doc) : [key],
  );
const filterPaths = (filter: StoreFilter): string[] =>
  Object.entries(filter).flatMap(([key, value]) =>
    key === '$or' || key === '$and' ? (value as StoreFilter[]).flatMap(filterPaths) : [key],
  );

/**
 * R1's documented refusal (PHASE4.md §8 R1, "Caster versus mongoose"): `$push`/`$addToSet` of an
 * array into a scalar array, which mongoose casts element by element and MongoDB stores; the
 * caster refuses it with a `StoreQueryError`.
 */
const REFUSED_BY_THE_CASTER: ReadonlySet<string> = new Set(['$push an array as one element']);

const updates = corpus.updates.filter(({ update }) => updatePaths(update).every(declared));
const upserts = corpus.upserts.filter(
  ({ filter, update }) =>
    updatePaths(update).every(declared) && filterPaths(filter).every(declared),
);

/** A comparable form: ids as hex (R7), dates tagged. */
function canonical(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

/** A record as the store takes it: ObjectIds as hex, everything else as it is. */
function storeForm(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(storeForm);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, storeForm(nested)]),
    );
  }
  return value;
}

const withoutId = (record: Doc | null | undefined): Doc => {
  const { _id: _ignored, ...rest } = record ?? {};
  return rest;
};

/** Runs `fn`, giving its result or `{ failed: error }`. */
async function outcome<T>(fn: () => Promise<T>): Promise<T | { failed: unknown }> {
  try {
    return await fn();
  } catch (error) {
    return { failed: error };
  }
}
const failed = (value: unknown) =>
  typeof value === 'object' && value !== null && 'failed' in (value as Doc);

describePostgres('PgCollection: corpus B updates and upserts on typed tables vs MongoDB', () => {
  const database = usePostgresTestDatabase();
  let server: MongoMemoryServer;
  let Model: mongoose.Model<Doc>;
  let collection: PgCollection;
  let records: Map<string, Doc>;
  const previousShadow = process.env.POSTGRES_UPDATE_SHADOW_CHECK;

  beforeAll(async () => {
    process.env.POSTGRES_UPDATE_SHADOW_CHECK = 'true';
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    Model = mongoose.model<Doc>('StoreQueryTypedCollection', schema, TYPED_CORPUS_COLLECTION);
    records = new Map(
      corpus.records.map((record) => [
        record.label as string,
        castTypedRecord(record, (input) => {
          const document = new Model(input);
          const error = document.validateSync();
          return {
            object: document.toObject({ minimize: false, versionKey: false, depopulate: true }),
            castErrors: Object.entries(error?.errors ?? {})
              .filter(([, item]) => item.name === 'CastError')
              .map(([path]) => path),
          };
        }),
      ]),
    );
    const pool = database.pool();
    for (const statement of [...emitSchemaDdl(tables.descriptor), ...HELPER_FUNCTIONS_DDL]) {
      await pool.query(statement);
    }
    collection = createPgCollections({
      db: database.kysely(),
      descriptor: tables,
      engine: createSchemaEngineForSchemas([{ collection: TYPED_CORPUS_COLLECTION, schema }]),
    }).collection(TYPED_CORPUS_COLLECTION);
  }, 180_000);

  afterAll(async () => {
    if (previousShadow === undefined) delete process.env.POSTGRES_UPDATE_SHADOW_CHECK;
    else process.env.POSTGRES_UPDATE_SHADOW_CHECK = previousShadow;
    await mongoose.disconnect();
    await server?.stop();
  });

  beforeEach(async () => {
    await Model.collection.deleteMany({});
    await database.truncateAll();
  });

  it('runs the declared cases', () => {
    expect(updates.length).toBeGreaterThan(60);
    expect(upserts.length).toBeGreaterThan(1);
  });

  it.each(updates.filter(({ name }) => REFUSED_BY_THE_CASTER.has(name)))(
    'update refused by the caster (R1): $name',
    async ({ target, update }) => {
      const record = records.get(target)!;
      const id = (record._id as Types.ObjectId).toHexString();
      await expect(collection.updateOne({ _id: id }, update)).rejects.toThrow(StoreQueryError);
    },
  );

  it.each(updates.filter(({ name }) => !REFUSED_BY_THE_CASTER.has(name)))(
    'update: $name',
    async ({ target, update }) => {
      const record = records.get(target)!;
      await Model.collection.insertOne({ ...record });
      await createPgCollections({ db: database.kysely(), descriptor: tables, engine: null })
        .raw(TYPED_CORPUS_COLLECTION)
        .insertOne(storeForm(record) as Doc);
      const id = (record._id as Types.ObjectId).toHexString();
      const mongo = await outcome(() => Model.updateOne({ _id: id }, update));
      const pg = await outcome(() => collection.updateOne({ _id: id }, update));
      expect(failed(pg)).toBe(failed(mongo));
      const mongoRecord = await Model.findById(id).select('+secret +pin').lean<Doc>();
      const pgRecord = await collection.findOne({ _id: id }, { projection: '+secret +pin' });
      expect(canonical(pgRecord)).toEqual(canonical(mongoRecord));
    },
  );

  it.each([
    'label',
    'name',
    'n',
    'flag',
    'at',
    'tags',
    'refs',
    'ref',
    'profile.city',
    'items.sku',
    'meta',
  ])('distinct %s equals MongoDB', async (path) => {
    const all = [...records.values()];
    await Model.collection.insertMany(all.map((record) => ({ ...record })));
    await createPgCollections({ db: database.kysely(), descriptor: tables, engine: null })
      .raw(TYPED_CORPUS_COLLECTION)
      .insertMany(all.map((record) => storeForm(record) as Doc));
    const key = (values: unknown[]) =>
      values.map((value) => JSON.stringify(canonical(value))).sort();
    const mongo = await Model.distinct(path);
    const pg = await collection.distinct(path);
    expect(key(pg)).toEqual(key(mongo));
    expect(key(await collection.distinct(path, { flag: true }))).toEqual(
      key(await Model.distinct(path, { flag: true })),
    );
  });

  it.each(upserts)('upsert: $name', async ({ filter, update }) => {
    const mongo = await outcome(() => Model.updateOne(filter, update, { upsert: true }));
    const pg = await outcome(() => collection.updateOne(filter, update, { upsert: true }));
    expect(failed(pg)).toBe(failed(mongo));
    const mongoRecords = await Model.find({}).select('+secret +pin').lean<Doc[]>();
    const pgRecords = await collection.find({}, { projection: '+secret +pin' });
    expect(pgRecords.map((record) => canonical(withoutId(record)))).toEqual(
      mongoRecords.map((record) => canonical(withoutId(record))),
    );
  });
});

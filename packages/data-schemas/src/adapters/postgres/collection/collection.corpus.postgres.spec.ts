import { Schema } from 'mongoose';
import type { StoreFilter, StoreUpdate } from '~/ports/query';
import type { RecordTables } from '../records/tables';
import type { PgCollections } from './index';
import { applyStoreUpdate, matchesStoreFilter, storeFilterInsertSeed } from '~/ports/query';
import { buildStoreQueryCorpus, CORPUS_HIDDEN_FIELDS } from '~/ports/query.corpus';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createSchemaEngineForSchemas } from '../schema/engine';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { HELPER_FUNCTIONS_DDL } from '../schema/functions';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { emitSchemaDdl } from '../schema/emitDdl';
import { createPgCollections } from './index';

/**
 * Corpus A's update and upsert cases (`ports/query.corpus.ts`; `query.differential.spec.ts` checks
 * the reference evaluator against MongoDB on them) through `PgCollection` (docs/postgres-port/
 * PHASE4.md §2.5, §8 C1). As in Q1's corpus A spec, every top-level key is a `json` column, so
 * whole-column assignments take tier 1 and everything else (subpaths, `$inc`, `$push`, ...) takes
 * tier 2. Each update must leave the record the evaluator computes (and so MongoDB), or fail where
 * it fails; each upsert must insert the evaluator's seed-plus-update record. Tier 1 runs with the
 * shadow check on, and in document mode (an engine over the corpus schema) and raw mode.
 */

class Hex {
  constructor(private readonly hex: string) {}
  toHexString(): string {
    return this.hex;
  }
}

type Doc = Record<string, unknown>;

const corpus = buildStoreQueryCorpus((hex) => new Hex(hex));
const COLLECTION = 'storequerycorpus';

function corpusKeys(): string[] {
  const keys = new Set<string>();
  for (const record of corpus.records) Object.keys(record).forEach((key) => keys.add(key));
  for (const { update } of [...corpus.updates, ...corpus.upserts]) {
    for (const [key, value] of Object.entries(update)) {
      const paths = key.startsWith('$') ? Object.keys(value as Doc) : [key];
      paths.forEach((path) => keys.add(path.split('.')[0]));
    }
  }
  const visit = (filter: StoreFilter): void => {
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$or' || key === '$and') (value as StoreFilter[]).forEach(visit);
      else keys.add(key.split('.')[0]);
    }
  };
  corpus.upserts.forEach(({ filter }) => visit(filter));
  keys.delete('_id');
  return [...keys];
}

const definition: Record<string, unknown> = {};
for (const key of corpusKeys()) {
  definition[key] = CORPUS_HIDDEN_FIELDS.includes(key)
    ? { type: Schema.Types.Mixed, select: false }
    : Schema.Types.Mixed;
}
const schema = new Schema(definition, { versionKey: false, strict: false, minimize: false });
const tables: RecordTables = indexRecordTables(
  buildSchemaDescriptor(
    [introspectSchema(schema, { collection: COLLECTION })],
    NO_SCHEMA_OVERRIDES,
  ),
);

/** A comparable form: ids as their hex (R7), dates tagged so they never equal strings. */
function canonical(value: unknown): unknown {
  if (value instanceof Hex) return value.toHexString();
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

const withoutId = (record: Doc): Doc => {
  const { _id: _ignored, ...rest } = record;
  return rest;
};

describePostgres('PgCollection: corpus A updates and upserts vs the reference evaluator', () => {
  const database = usePostgresTestDatabase();
  let collections: PgCollections;
  const previousShadow = process.env.POSTGRES_UPDATE_SHADOW_CHECK;

  beforeAll(async () => {
    process.env.POSTGRES_UPDATE_SHADOW_CHECK = 'true';
    const pool = database.pool();
    for (const statement of [...emitSchemaDdl(tables.descriptor), ...HELPER_FUNCTIONS_DDL]) {
      await pool.query(statement);
    }
    collections = createPgCollections({
      db: database.kysely(),
      descriptor: tables,
      engine: createSchemaEngineForSchemas([{ collection: COLLECTION, schema }]),
    });
  }, 120_000);

  afterAll(() => {
    if (previousShadow === undefined) delete process.env.POSTGRES_UPDATE_SHADOW_CHECK;
    else process.env.POSTGRES_UPDATE_SHADOW_CHECK = previousShadow;
  });

  beforeEach(async () => {
    await database.truncateAll();
    await collections.raw(COLLECTION).insertMany(corpus.records);
  });

  it('runs the whole update corpus: 86 updates, 11 upserts', () => {
    expect(corpus.updates).toHaveLength(86);
    expect(corpus.upserts).toHaveLength(11);
  });

  describe.each(['document', 'raw'] as const)('%s mode', (mode) => {
    const collection = () =>
      mode === 'raw' ? collections.raw(COLLECTION) : collections.collection(COLLECTION);

    describe('updates', () => {
      it.each(corpus.updates)('$name', async ({ target, update, fails }) => {
        const record = corpus.records.find((candidate) => candidate.label === target)!;
        const id = (record._id as Hex).toHexString();
        const before = await collection().find({}, { projection: '+secret +pin' });
        if (fails) {
          expect(() => applyStoreUpdate(record, update)).toThrow();
          await expect(collection().updateOne({ _id: id }, update)).rejects.toThrow();
          expect(canonical(await collection().find({}, { projection: '+secret +pin' }))).toEqual(
            canonical(before),
          );
          return;
        }
        const expected = applyStoreUpdate(record, update);
        const result = await collection().updateOne({ _id: id }, update);
        expect(result.matchedCount).toBe(1);
        const actual = await collection().findOne({ _id: id }, { projection: '+secret +pin' });
        expect(canonical(actual)).toEqual(canonical(expected));
        expect(result.modifiedCount).toBe(
          JSON.stringify(canonical(expected)) === JSON.stringify(canonical(record)) ? 0 : 1,
        );
      });
    });

    describe('upserts', () => {
      it.each(corpus.upserts)('$name', async ({ filter, update }) => {
        await database.truncateAll();
        const expected = applyStoreUpdate(storeFilterInsertSeed(filter), update as StoreUpdate, {
          inserting: true,
        });
        const result = await collection().updateOne(filter, update, { upsert: true });
        expect(result.upsertedCount).toBe(1);
        const all = await collection().find({}, { projection: '+secret +pin' });
        expect(all).toHaveLength(1);
        expect(all[0]._id).toBe(result.upsertedId);
        expect(canonical(withoutId(all[0]))).toEqual(canonical(withoutId(expected)));
        /** A second run updates what the first inserted when it matches the filter, else inserts. */
        const matches = matchesStoreFilter(expected, filter);
        const again = await collection().updateOne(filter, update, { upsert: true });
        expect(again).toMatchObject({
          matchedCount: matches ? 1 : 0,
          upsertedCount: matches ? 0 : 1,
        });
      });
    });
  });
});

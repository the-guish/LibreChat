import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PgCollection } from './index';
import {
  NOW,
  maskVolatile,
  evaluateUpdate,
  storeRecordForm,
  canonicalRecord,
  updateCaseFilter,
  EXTENDED_RECORDS,
  EXTENDED_UPDATES,
  EXTENDED_UPSERTS,
  EXTENDED_FILTERS,
  evaluateProjection,
  EXTENDED_PROJECTIONS,
  evaluateFilterLabels,
  EXTENDED_CORPUS_COLLECTION,
  extendedCorpusSchemaDefinition,
} from '../evaluator/corpusC';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createSchemaEngineForSchemas } from '../schema/engine';
import { castTypedRecord } from '~/ports/query.corpus.typed';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { HELPER_FUNCTIONS_DDL } from '../schema/functions';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { createRecordCaster } from '../records/cast';
import { resolveRecordPath } from '../records/paths';
import { emitSchemaDdl } from '../schema/emitDdl';
import { StoreQueryError } from '~/ports/query';
import { createPgCollections } from './index';

/**
 * Corpus C (docs/postgres-port/PHASE4.md §2.5, §8 C2) on PostgreSQL: filters, `$elemMatch`
 * projections, updates and upserts through `PgCollection` on the typed tables (child tables,
 * `T[]`, `json`, a child table under a subdocument), against the extended evaluator (SQL equals
 * the evaluator) and against MongoDB through mongoose on the same records. Updates run twice:
 * with the shadow check on (tier 1 checked against the evaluator on the locked pre-image) and off
 * (tier 1's own lock, recheck and write path).
 */

type Doc = Record<string, unknown>;

const subdocument = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });
const schema = new Schema(
  extendedCorpusSchemaDefinition({
    ObjectId: Schema.Types.ObjectId,
    Mixed: Schema.Types.Mixed,
    subdocument,
  }),
  { versionKey: false, autoIndex: false },
);
const tables = indexRecordTables(
  buildSchemaDescriptor(
    [introspectSchema(schema, { collection: EXTENDED_CORPUS_COLLECTION })],
    NO_SCHEMA_OVERRIDES,
  ),
);
const engine = createSchemaEngineForSchemas([{ collection: EXTENDED_CORPUS_COLLECTION, schema }]);
const caster = createRecordCaster(tables, { engine });

async function outcome<T>(fn: () => Promise<T>): Promise<T | { failed: unknown }> {
  try {
    return await fn();
  } catch (error) {
    return { failed: error };
  }
}
const failure = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'failed' in (value as Doc)
    ? (value as { failed: unknown }).failed
    : null;

const evaluate = (
  records: Doc[],
  filter: Doc,
  update: Doc,
  options: { arrayFilters?: Doc[]; many?: boolean; upsert?: boolean },
) => {
  try {
    const cast = caster.castUpdate(EXTENDED_CORPUS_COLLECTION, update, { undeclared: 'strip' });
    return evaluateUpdate(
      records,
      {
        filter: caster.castFilter(EXTENDED_CORPUS_COLLECTION, filter),
        update: cast,
        arrayFilters: options.arrayFilters
          ? caster.castArrayFilters(EXTENDED_CORPUS_COLLECTION, cast, options.arrayFilters)
          : undefined,
      },
      { many: options.many, upsert: options.upsert, now: () => NOW },
    );
  } catch (error) {
    if (!(error instanceof StoreQueryError)) throw error;
    return { records, failed: error, matched: 0 };
  }
};

describePostgres('PgCollection: corpus C (extended operators) vs the evaluator and MongoDB', () => {
  const database = usePostgresTestDatabase();
  let server: MongoMemoryServer;
  let Model: mongoose.Model<Doc>;
  let records: Doc[];
  let shadowed: PgCollection;
  let direct: PgCollection;
  let raw: PgCollection;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    Model = mongoose.model<Doc>('StoreQueryExtendedPg', schema, EXTENDED_CORPUS_COLLECTION);
    records = EXTENDED_RECORDS.map((record) =>
      castTypedRecord(record, (input) => {
        const document = new Model(input);
        const error = document.validateSync();
        return {
          object: document.toObject({ minimize: false, versionKey: false, depopulate: true }),
          castErrors: Object.keys(error?.errors ?? {}),
        };
      }),
    );
    const pool = database.pool();
    for (const statement of [...emitSchemaDdl(tables.descriptor), ...HELPER_FUNCTIONS_DDL]) {
      await pool.query(statement);
    }
    const make = (shadowCheck: boolean) =>
      createPgCollections({
        db: database.kysely(),
        descriptor: tables,
        engine,
        now: () => NOW,
        shadowCheck,
      });
    shadowed = make(true).collection(EXTENDED_CORPUS_COLLECTION);
    direct = make(false).collection(EXTENDED_CORPUS_COLLECTION);
    raw = make(false).raw(EXTENDED_CORPUS_COLLECTION);
  }, 180_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  const seed = async () => {
    await database.truncateAll();
    await raw.insertMany(records.map((record) => storeRecordForm(record) as Doc));
    await Model.collection.deleteMany({});
    await Model.collection.insertMany(records.map((record) => ({ ...record })));
  };

  const readPg = async (collection: PgCollection, volatile?: string[]) =>
    (await collection.find({}, { sort: { _id: 1 } })).map((record) =>
      maskVolatile(record, volatile),
    );
  const readMongo = async (volatile?: string[]) =>
    (await Model.find({}).sort({ _id: 1 }).lean<Doc[]>()).map((record) =>
      maskVolatile(record, volatile),
    );

  describe('reads', () => {
    beforeAll(seed);

    it.each(EXTENDED_FILTERS.filter((entry) => entry.castFails))(
      'filter refused: $name',
      async ({ filter }) => {
        await expect(direct.find(filter)).rejects.toThrow(StoreQueryError);
      },
    );

    it.each(EXTENDED_FILTERS.filter((entry) => !entry.castFails))(
      'filter: $name',
      async ({ filter }) => {
        const pg = (await direct.find(filter, { projection: 'label' }))
          .map((record) => record.label as string)
          .sort();
        const cast = caster.castFilter(EXTENDED_CORPUS_COLLECTION, filter);
        expect(pg).toEqual(evaluateFilterLabels(records, cast));
        const mongo = (await Model.find(filter).select('label').lean<Doc[]>())
          .map((record) => record.label as string)
          .sort();
        expect(pg).toEqual(mongo);
      },
    );

    it.each(EXTENDED_PROJECTIONS)('projection: $name', async ({ projection }) => {
      const pg = await direct.find({}, { projection: projection as never, sort: { _id: 1 } });
      const elemMatches = new Map<string, Doc>();
      for (const [field, value] of Object.entries(projection)) {
        if (value !== null && typeof value === 'object') {
          elemMatches.set(
            field,
            caster.castCondition(
              resolveRecordPath(tables, tables.collection(EXTENDED_CORPUS_COLLECTION), field),
              '$elemMatch',
              (value as Doc).$elemMatch,
            ) as Doc,
          );
        }
      }
      const expected = records.map((record) => evaluateProjection(record, projection, elemMatches));
      expect(pg.map(canonicalRecord)).toEqual(expected.map(canonicalRecord));
      const mongo = await Model.find({}, projection as mongoose.ProjectionType<Doc>)
        .sort({ _id: 1 })
        .lean<Doc[]>();
      expect(pg.map(canonicalRecord)).toEqual(mongo.map(canonicalRecord));
    });
  });

  describe.each([
    ['shadow check on', () => shadowed],
    ['shadow check off', () => direct],
  ])('updates (%s)', (_mode, collectionOf) => {
    beforeEach(seed);

    it.each(EXTENDED_UPDATES.filter((entry) => !entry.refused))('update: $name', async (entry) => {
      const collection = collectionOf();
      const filter = updateCaseFilter(entry);
      const options = entry.arrayFilters ? { arrayFilters: entry.arrayFilters } : {};
      const pg = await outcome(() =>
        entry.many
          ? collection.updateMany(filter, entry.update, options)
          : collection.updateOne(filter, entry.update, options),
      );
      if (entry.refusedByPostgres) {
        expect(failure(pg)).toBeInstanceOf(StoreQueryError);
        return;
      }
      const evaluated = evaluate(records, filter, entry.update, {
        arrayFilters: entry.arrayFilters,
        many: entry.many,
      });
      if (failure(pg) && !(failure(pg) instanceof StoreQueryError)) {
        throw failure(pg);
      }
      expect(Boolean(failure(pg))).toBe(Boolean(evaluated.failed));
      const stored = await readPg(collection, entry.volatile);
      expect(stored).toEqual(
        evaluated.records.map((record) => maskVolatile(record, entry.volatile)),
      );
      if (!failure(pg) && !entry.many) {
        expect((pg as { matchedCount: number }).matchedCount).toBe(evaluated.matched);
      }
      const mongo = await outcome(() =>
        entry.many
          ? Model.updateMany(filter, entry.update, options)
          : Model.updateOne(filter, entry.update, options),
      );
      expect(Boolean(failure(pg))).toBe(Boolean(failure(mongo)));
      expect(stored).toEqual(await readMongo(entry.volatile));
    });

    it.each(EXTENDED_UPDATES.filter((entry) => entry.refused))(
      'refused update ($refused): $name',
      async (entry) => {
        await expect(
          collectionOf().updateOne(updateCaseFilter(entry), entry.update),
        ).rejects.toThrow(StoreQueryError);
      },
    );

    it.each(EXTENDED_UPSERTS)('upsert: $name', async ({ filter, update, arrayFilters }) => {
      const collection = collectionOf();
      const options = { upsert: true, ...(arrayFilters ? { arrayFilters } : {}) };
      const pg = await outcome(() => collection.updateOne(filter, update, options));
      if (failure(pg) && !(failure(pg) instanceof StoreQueryError)) {
        throw failure(pg);
      }
      const evaluated = evaluate(records, filter, update, { arrayFilters, upsert: true });
      expect(Boolean(failure(pg))).toBe(Boolean(evaluated.failed));
      const withoutId = ({ _id: _ignored, ...rest }: Doc) => rest;
      const stored = (await readPg(collection)).map((record) => withoutId(record as Doc));
      expect(stored).toEqual(evaluated.records.map((record) => canonicalRecord(withoutId(record))));
      const mongo = await outcome(() => Model.updateOne(filter, update, options));
      expect(Boolean(failure(pg))).toBe(Boolean(failure(mongo)));
      expect(stored).toEqual((await readMongo()).map((record) => withoutId(record as Doc)));
    });
  });
});

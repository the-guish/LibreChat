import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  NOW,
  maskVolatile,
  evaluateUpdate,
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
} from './corpusC';
import { createSchemaEngineForSchemas } from '../schema/engine';
import { castTypedRecord } from '~/ports/query.corpus.typed';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { createRecordCaster } from '../records/cast';
import { resolveRecordPath } from '../records/paths';
import { StoreQueryError } from '~/ports/query';

/**
 * Corpus C (docs/postgres-port/PHASE4.md §2.5, §8 C2) on MongoDB: the extended evaluator, over
 * filters, updates and `arrayFilters` cast by the descriptor caster and records cast by mongoose,
 * equals MongoDB through mongoose on every case (filters, `$elemMatch` projections, updates and
 * upserts), and fails where MongoDB fails. Cases the primitive refuses (`refused`) must be refused
 * by the evaluator with a `StoreQueryError`.
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
const failed = (value: unknown) =>
  typeof value === 'object' && value !== null && 'failed' in (value as Doc);

const castUpdateOf = (update: Doc, arrayFilters?: Doc[]) => {
  const cast = caster.castUpdate(EXTENDED_CORPUS_COLLECTION, update, { undeclared: 'strip' });
  return {
    update: cast,
    arrayFilters: arrayFilters
      ? caster.castArrayFilters(EXTENDED_CORPUS_COLLECTION, cast, arrayFilters)
      : undefined,
  };
};

describe('corpus C: the extended evaluator equals MongoDB', () => {
  let server: MongoMemoryServer;
  let Model: mongoose.Model<Doc>;
  let records: Doc[];

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    Model = mongoose.model<Doc>('StoreQueryExtended', schema, EXTENDED_CORPUS_COLLECTION);
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
  }, 120_000);

  it('casts every record whole', () => {
    expect(records.map((record) => Object.keys(record).length)).toEqual(
      EXTENDED_RECORDS.map((record) => Object.keys(record).length),
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  beforeEach(async () => {
    await Model.collection.deleteMany({});
    await Model.collection.insertMany(records.map((record) => ({ ...record })));
  });

  const readAll = async (volatile?: string[]) =>
    (await Model.find({}).sort({ _id: 1 }).lean<Doc[]>()).map((record) =>
      maskVolatile(record, volatile),
    );

  it('has a case per shape', () => {
    expect(EXTENDED_FILTERS.length).toBeGreaterThan(80);
    expect(EXTENDED_UPDATES.length).toBeGreaterThan(55);
  });

  it.each(EXTENDED_FILTERS.filter((entry) => entry.castFails))(
    'filter refused by both: $name',
    async ({ filter }) => {
      await expect(Model.find(filter).lean()).rejects.toThrow();
      expect(() => caster.castFilter(EXTENDED_CORPUS_COLLECTION, filter)).toThrow(StoreQueryError);
    },
  );

  it.each(EXTENDED_FILTERS.filter((entry) => !entry.castFails))(
    'filter: $name',
    async ({ filter }) => {
      const mongo = (await Model.find(filter).select('label').lean<Doc[]>())
        .map((record) => record.label as string)
        .sort();
      const cast = caster.castFilter(EXTENDED_CORPUS_COLLECTION, filter);
      expect(evaluateFilterLabels(records, cast)).toEqual(mongo);
    },
  );

  it.each(EXTENDED_PROJECTIONS)('projection: $name', async ({ projection }) => {
    const mongo = await Model.find({}, projection as mongoose.ProjectionType<Doc>)
      .sort({ _id: 1 })
      .lean<Doc[]>();
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
    const ours = records.map((record) => evaluateProjection(record, projection, elemMatches));
    expect(ours.map(canonicalRecord)).toEqual(mongo.map(canonicalRecord));
  });

  it.each(EXTENDED_UPDATES.filter((entry) => !entry.refused))('update: $name', async (entry) => {
    const filter = updateCaseFilter(entry);
    const options = entry.arrayFilters ? { arrayFilters: entry.arrayFilters } : {};
    const mongo = await outcome(() =>
      entry.many
        ? Model.updateMany(filter, entry.update, options)
        : Model.updateOne(filter, entry.update, options),
    );
    let evaluated: { records: Doc[]; failed: unknown };
    try {
      const cast = castUpdateOf(entry.update, entry.arrayFilters);
      evaluated = evaluateUpdate(
        records,
        {
          filter: caster.castFilter(EXTENDED_CORPUS_COLLECTION, filter),
          update: cast.update,
          arrayFilters: cast.arrayFilters,
        },
        { many: entry.many, now: () => NOW },
      );
    } catch (error) {
      if (!(error instanceof StoreQueryError)) throw error;
      evaluated = { records, failed: error };
    }
    expect(Boolean(evaluated.failed)).toBe(failed(mongo));
    expect(evaluated.records.map((record) => maskVolatile(record, entry.volatile))).toEqual(
      await readAll(entry.volatile),
    );
  });

  it.each(EXTENDED_UPDATES.filter((entry) => entry.refused))(
    'refused update ($refused): $name',
    ({ update, arrayFilters }) => {
      const run = () => {
        const cast = castUpdateOf(update, arrayFilters);
        return evaluateUpdate(
          records,
          { filter: { label: 'alpha' }, update: cast.update, arrayFilters: cast.arrayFilters },
          { now: () => NOW },
        );
      };
      let failure: unknown;
      try {
        failure = run().failed;
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(StoreQueryError);
    },
  );

  it.each(EXTENDED_UPSERTS)('upsert: $name', async ({ filter, update, arrayFilters }) => {
    const options = { upsert: true, ...(arrayFilters ? { arrayFilters } : {}) };
    const mongo = await outcome(() => Model.updateOne(filter, update, options));
    let evaluated: { records: Doc[]; failed: unknown };
    try {
      const cast = castUpdateOf(update, arrayFilters);
      evaluated = evaluateUpdate(
        records,
        {
          filter: caster.castFilter(EXTENDED_CORPUS_COLLECTION, filter),
          update: cast.update,
          arrayFilters: cast.arrayFilters,
        },
        { upsert: true, now: () => NOW },
      );
    } catch (error) {
      if (!(error instanceof StoreQueryError)) throw error;
      evaluated = { records, failed: error };
    }
    expect(Boolean(evaluated.failed)).toBe(failed(mongo));
    const withoutId = ({ _id: _ignored, ...rest }: Doc) => rest;
    expect(evaluated.records.map((record) => canonicalRecord(withoutId(record)))).toEqual(
      (await readAll()).map((record) => withoutId(record as Doc)),
    );
  });
});

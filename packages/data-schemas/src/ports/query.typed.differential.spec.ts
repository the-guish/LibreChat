import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { RecordCaster } from '~/adapters/postgres/records/cast';
import type { StoreFilter, StoreSort } from './query';
import {
  castTypedRecord,
  typedRecordHex,
  TYPED_EXTRA_RECORDS,
  buildTypedCorpusCases,
  TYPED_CORPUS_COLLECTION,
  typedCorpusSchemaDefinition,
} from './query.corpus.typed';
import {
  StoreQueryError,
  matchesStoreFilter,
  compareByStoreSort,
  applyStoreProjection,
} from './query';
import { buildSchemaDescriptor } from '~/adapters/postgres/schema/descriptor';
import { buildStoreQueryCorpus, CORPUS_HIDDEN_FIELDS } from './query.corpus';
import { NO_SCHEMA_OVERRIDES } from '~/adapters/postgres/schema/overrides';
import { indexRecordTables } from '~/adapters/postgres/records/tables';
import { introspectSchema } from '~/adapters/postgres/schema/generate';
import { createRecordCaster } from '~/adapters/postgres/records/cast';

/**
 * Corpus B (`query.corpus.typed.ts`, docs/postgres-port/PHASE4.md §2.5) on MongoDB: the ground
 * truth of the typed query cases. For every case inside the reference evaluator's language,
 * `evaluator ∘ descriptor cast` (R1's caster casting the filter, the records cast through the
 * typed schema) must equal MongoDB through a mongoose model of the same schema; a filter mongoose
 * refuses with a `CastError` must be refused by the caster with a `StoreQueryError`. Cases beyond
 * the evaluator (`$size`, numeric segments, dotted projections) are compared with MongoDB by the
 * PostgreSQL spec directly.
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

const corpusA = buildStoreQueryCorpus((hex) => new Types.ObjectId(hex));
const cases = buildTypedCorpusCases(corpusA);
const caster: RecordCaster = createRecordCaster(
  indexRecordTables(
    buildSchemaDescriptor(
      [introspectSchema(schema, { collection: TYPED_CORPUS_COLLECTION })],
      NO_SCHEMA_OVERRIDES,
    ),
  ),
);

let server: MongoMemoryServer;
let Model: mongoose.Model<Doc>;
let records: Doc[];

const labels = (docs: Doc[]): string[] => docs.map((doc) => doc.label as string);
const sortedLabels = (docs: Doc[]): string[] => labels(docs).sort();
const withTieBreak = (sort: StoreSort): StoreSort => ('_id' in sort ? sort : { ...sort, _id: 1 });

/** A comparable form: ids as hex, dates tagged. */
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

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  Model = mongoose.model<Doc>('StoreQueryTyped', schema, TYPED_CORPUS_COLLECTION);
  const inputs = [
    ...corpusA.records,
    ...TYPED_EXTRA_RECORDS.map((record, index) => ({
      _id: new Types.ObjectId(typedRecordHex(index + 1)),
      ...record,
    })),
  ];
  records = inputs.map((record) =>
    castTypedRecord(record, (input) => {
      const document = new Model(input);
      const error = document.validateSync();
      const castErrors = Object.entries(error?.errors ?? {})
        .filter(([, item]) => item.name === 'CastError')
        .map(([path]) => path);
      return {
        object: document.toObject({ minimize: false, versionKey: false, depopulate: true }),
        castErrors,
      };
    }),
  );
  await Model.collection.insertMany(records.map((record) => ({ ...record })));
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('query language on a typed schema: evaluator ∘ descriptor cast vs MongoDB', () => {
  it('casts the corpus records through the typed schema', () => {
    const byLabel = new Map(records.map((record) => [record.label, record]));
    expect(byLabel.get('carol')).toMatchObject({ n: 5, email: 'carol@example.com' });
    expect(byLabel.get('carol')?.at).toBeInstanceOf(Date);
    expect(byLabel.get('no-name')).toMatchObject({ tags: ['solo'], scores: [7] });
    expect(byLabel.get('no-name')).toMatchObject({ profile: null });
    expect(byLabel.get('null-name')).not.toHaveProperty('profile');
    expect(byLabel.get('null-name')).not.toHaveProperty('items');
    expect(byLabel.get('Alice')).toMatchObject({ email: 'alice@example.org' });
  });

  describe('filters', () => {
    it.each(cases.filters.filter((entry) => !entry.beyondEvaluator))(
      '$name',
      async ({ filter, castFails }) => {
        if (castFails) {
          await expect(Model.find(filter as mongoose.FilterQuery<Doc>).lean()).rejects.toThrow();
          expect(() => caster.castFilter(TYPED_CORPUS_COLLECTION, filter)).toThrow(StoreQueryError);
          return;
        }
        const expected = await Model.find(filter as mongoose.FilterQuery<Doc>)
          .select('+secret +pin')
          .lean<Doc[]>();
        const cast = caster.castFilter(TYPED_CORPUS_COLLECTION, filter) as StoreFilter;
        const actual = records.filter((record) => matchesStoreFilter(record, cast));
        expect(sortedLabels(actual)).toEqual(sortedLabels(expected));
      },
    );
  });

  describe('projections', () => {
    it.each(cases.projections.filter((entry) => !entry.beyondEvaluator))(
      '$name',
      async ({ projection }) => {
        const query = Model.find({}).sort({ _id: 1 });
        if (projection) query.select(projection);
        const expected = await query.lean<Doc[]>();
        const actual = [...records]
          .sort(compareByStoreSort({ _id: 1 }))
          .map((record) => applyStoreProjection(record, projection, CORPUS_HIDDEN_FIELDS));
        expect(canonical(actual)).toEqual(canonical(expected));
      },
    );
  });

  describe('sorts', () => {
    it.each(cases.sorts)('$name', async ({ sort }) => {
      const total = withTieBreak(sort);
      const expected = await Model.find({}).sort(total).lean<Doc[]>();
      const actual = [...records].sort(compareByStoreSort(total));
      expect(labels(actual)).toEqual(labels(expected));
    });
  });
});

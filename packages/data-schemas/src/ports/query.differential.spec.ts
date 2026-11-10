import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { StoreFilter, StoreSort } from './query';
import {
  applyStoreProjection,
  applyStoreQueryOptions,
  applyStoreUpdate,
  assertStoreFilter,
  assertStoreProjection,
  assertStoreSort,
  assertStoreUpdate,
  compareByStoreSort,
  matchesStoreFilter,
  storeFilterInsertSeed,
  StoreQueryError,
} from './query';
import { buildStoreQueryCorpus, CORPUS_HIDDEN_FIELDS } from './query.corpus';

/**
 * Differential test of the query language's reference evaluator against MongoDB: every case of
 * the corpus (`./query.corpus`) runs through mongoose on an in-memory MongoDB and through the
 * evaluator, and the results must be equal. This is the ground truth an adapter for another
 * database is later tested against.
 *
 * The collection's schema declares what the MongoDB adapter's schemas would: the id fields
 * (`ref`, `refs`), which mongoose casts from hex strings, and the hidden (`select: false`) fields.
 * Every other path is undeclared (`strict: false`), so mongoose passes it to MongoDB as given.
 * Records are inserted through the driver, bypassing mongoose, so they hold exactly the corpus
 * values.
 */

type Doc = Record<string, unknown>;

const corpus = buildStoreQueryCorpus((hex) => new Types.ObjectId(hex));
const byLabel = new Map(corpus.records.map((record) => [record.label as string, record]));

let server: MongoMemoryServer;
let Model: mongoose.Model<Doc>;

/** A comparable form: ids and Dates tagged so they never equal strings. */
function canonical(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return { $id: value.toHexString() };
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

const labels = (docs: Doc[]): string[] => docs.map((doc) => doc.label as string);
const sortedLabels = (docs: Doc[]): string[] => labels(docs).sort();

/** MongoDB does not order ties; the corpus sorts end with `_id` so both sides are total. */
const withTieBreak = (sort: StoreSort): StoreSort => ('_id' in sort ? sort : { ...sort, _id: 1 });

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  const schema = new mongoose.Schema<Doc>(
    {
      ref: mongoose.Schema.Types.ObjectId,
      refs: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
      secret: { type: String, select: false },
      pin: { type: String, select: false },
    },
    { strict: false, versionKey: false, autoIndex: false },
  );
  Model = mongoose.model<Doc>('StoreQueryCorpus', schema);
  await Model.collection.insertMany(corpus.records.map((record) => ({ ...record })));
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('query language: evaluator vs MongoDB', () => {
  it('has a broad corpus', () => {
    expect(corpus.records.length).toBeGreaterThanOrEqual(12);
    expect(corpus.filters.length).toBeGreaterThanOrEqual(100);
    expect(new Set(corpus.filters.map((c) => c.name)).size).toBe(corpus.filters.length);
    expect(new Set(corpus.updates.map((c) => c.name)).size).toBe(corpus.updates.length);
  });

  describe('filters', () => {
    it.each(corpus.filters)('$name', async ({ filter }) => {
      assertStoreFilter(filter);
      const expected = await Model.find(filter as mongoose.FilterQuery<Doc>)
        .select('+secret +pin')
        .lean<Doc[]>();
      const actual = corpus.records.filter((record) => matchesStoreFilter(record, filter));
      expect(sortedLabels(actual)).toEqual(sortedLabels(expected));
    });
  });

  describe('projections', () => {
    it.each(corpus.projections)('$name', async ({ projection }) => {
      assertStoreProjection(projection);
      const query = Model.find({}).sort({ _id: 1 });
      if (projection) {
        query.select(projection);
      }
      const expected = await query.lean<Doc[]>();
      const actual = corpus.records.map((record) =>
        applyStoreProjection(record, projection, CORPUS_HIDDEN_FIELDS),
      );
      expect(canonical(actual)).toEqual(canonical(expected));
    });
  });

  describe('sorts', () => {
    it.each(corpus.sorts)('$name', async ({ sort }) => {
      assertStoreSort(sort);
      const total = withTieBreak(sort);
      const expected = await Model.find({}).sort(total).lean<Doc[]>();
      const actual = [...corpus.records].sort(compareByStoreSort(total));
      expect(labels(actual)).toEqual(labels(expected));
    });
  });

  describe('paging', () => {
    it.each(corpus.queryOptions)('$name', async ({ options }) => {
      const sort = withTieBreak(options.sort);
      const query = Model.find({}).sort(sort);
      if (options.offset != null && options.offset > 0) query.skip(options.offset);
      if (options.limit != null && options.limit > 0) query.limit(options.limit);
      const expected = await query.lean<Doc[]>();
      const actual = applyStoreQueryOptions(corpus.records, { ...options, sort });
      expect(labels(actual)).toEqual(labels(expected));
    });
  });

  describe('updates', () => {
    it.each(corpus.updates)('$name', async ({ target, update, fails }) => {
      assertStoreUpdate(update);
      const record = byLabel.get(target) as Doc;
      const _id = record._id as Types.ObjectId;
      await Model.collection.deleteOne({ _id });
      await Model.collection.insertOne({ ...record });

      let mongoError: unknown;
      try {
        await Model.updateOne({ _id }, update as mongoose.UpdateQuery<Doc>);
      } catch (error) {
        mongoError = error;
      }
      const stored = await Model.collection.findOne({ _id });

      let evaluated: Doc | undefined;
      let evaluatorError: unknown;
      try {
        evaluated = applyStoreUpdate(record, update);
      } catch (error) {
        evaluatorError = error;
      }

      await Model.collection.deleteOne({ _id });
      await Model.collection.insertOne({ ...record });

      if (fails) {
        expect(mongoError).toBeDefined();
        expect(evaluatorError).toBeInstanceOf(StoreQueryError);
        expect(canonical(stored)).toEqual(canonical(record));
        return;
      }
      expect(mongoError).toBeUndefined();
      expect(evaluatorError).toBeUndefined();
      expect(canonical(evaluated)).toEqual(canonical(stored));
    });
  });

  describe('upserts', () => {
    let Upserted: mongoose.Model<Doc>;

    beforeAll(() => {
      Upserted = mongoose.model<Doc>('StoreQueryUpsert', Model.schema.clone(), 'storequeryupserts');
    });

    it.each(corpus.upserts)('$name', async ({ filter, update }) => {
      assertStoreFilter(filter);
      assertStoreUpdate(update);
      await Upserted.collection.deleteMany({});
      await Upserted.updateOne(
        filter as mongoose.FilterQuery<Doc>,
        update as mongoose.UpdateQuery<Doc>,
        {
          upsert: true,
        },
      );
      const stored = await Upserted.collection.find({}).toArray();
      expect(stored).toHaveLength(1);
      const { _id: _generated, ...inserted } = stored[0];

      const evaluated = applyStoreUpdate(storeFilterInsertSeed(filter as StoreFilter), update, {
        inserting: true,
      });
      expect(canonical(evaluated)).toEqual(canonical(inserted));
    });
  });
});

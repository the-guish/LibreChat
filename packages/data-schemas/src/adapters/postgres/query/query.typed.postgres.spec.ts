import mongoose, { Schema, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Pool } from 'pg';
import type { StoreFilter, StoreSort } from '~/ports/query';
import {
  castTypedRecord,
  typedRecordHex,
  TYPED_EXTRA_RECORDS,
  buildTypedCorpusCases,
  TYPED_CORPUS_COLLECTION,
  typedCorpusSchemaDefinition,
} from '~/ports/query.corpus.typed';
import { StoreQueryError, matchesStoreFilter, compareByStoreSort } from '~/ports/query';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { decomposeRecord, insertStatements } from '../records/decompose';
import { buildStoreQueryCorpus } from '~/ports/query.corpus';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { HELPER_FUNCTIONS_DDL } from '../schema/functions';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { emitSchemaDdl } from '../schema/emitDdl';
import { createQueryTranslator } from './index';

/**
 * Corpus B (`ports/query.corpus.typed.ts`, docs/postgres-port/PHASE4.md §2.5) on PostgreSQL: the
 * typed schema mapped by the generator's rules (typed columns, flattened subdocuments with shape
 * columns, `T[]` columns, a child table for `items`, a `json` column for `meta`). Every case must
 * give what MongoDB gives through a mongoose model of the same schema (run here, on the same cast
 * records), and, where the reference evaluator expresses the case, what `evaluator ∘ cast` gives
 * (`query.typed.differential.spec.ts` checks that the two agree on MongoDB). A filter mongoose
 * refuses must be refused with a `StoreQueryError`.
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
const translator = createQueryTranslator(tables);
const corpusA = buildStoreQueryCorpus((hex) => new Types.ObjectId(hex));
const cases = buildTypedCorpusCases(corpusA);

const labels = (docs: Doc[]): string[] => docs.map((doc) => doc.label as string);
const sortedLabels = (docs: Doc[]): string[] => labels(docs).sort();
const withTieBreak = (sort: StoreSort): StoreSort => ('_id' in sort ? sort : { ...sort, _id: 1 });

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

describePostgres('query translator: corpus B on typed PostgreSQL tables vs MongoDB', () => {
  const database = usePostgresTestDatabase();
  let pool: Pool;
  let server: MongoMemoryServer;
  let Model: mongoose.Model<Doc>;
  let records: Doc[];
  let diverted: unknown[] = [];

  async function find(query: Parameters<typeof translator.find>[1]): Promise<Doc[]> {
    const read = translator.find(TYPED_CORPUS_COLLECTION, query);
    const { rows } = await pool.query(read.text, read.values);
    return read.decode(rows);
  }

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    Model = mongoose.model<Doc>('StoreQueryTypedPostgres', schema, TYPED_CORPUS_COLLECTION);
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
        return {
          object: document.toObject({ minimize: false, versionKey: false, depopulate: true }),
          castErrors: Object.entries(error?.errors ?? {})
            .filter(([, item]) => item.name === 'CastError')
            .map(([path]) => path),
        };
      }),
    );
    await Model.collection.insertMany(records.map((record) => ({ ...record })));

    pool = database.pool();
    for (const statement of [...emitSchemaDdl(tables.descriptor), ...HELPER_FUNCTIONS_DDL]) {
      await pool.query(statement);
    }
    const decomposed = records.map((record) =>
      decomposeRecord(tables, TYPED_CORPUS_COLLECTION, record, { mode: 'raw' }),
    );
    diverted = decomposed.flatMap((record) => record.diverted);
    for (const statement of insertStatements(tables, decomposed)) {
      await pool.query(statement.text, statement.values);
    }
  }, 180_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('stores every cast record in its declared columns (nothing diverted to _extra)', () => {
    expect(diverted).toEqual([]);
  });

  it('maps the typed schema to typed columns, a child table and a json column', () => {
    const table = tables.collection(TYPED_CORPUS_COLLECTION).descriptor;
    const kinds = Object.fromEntries(table.fields.map((field) => [field.path, field.kind]));
    expect(kinds).toMatchObject({
      n: 'scalar',
      tags: 'array',
      refs: 'array',
      profile: 'object',
      items: 'children',
      meta: 'json',
    });
  });

  it('reads back every record as MongoDB returns it', async () => {
    const expected = await Model.find({}).select('+secret +pin').sort({ _id: 1 }).lean<Doc[]>();
    const actual = await find({ projection: '+secret +pin', sort: { _id: 1 } });
    expect(canonical(actual)).toEqual(canonical(expected));
  });

  describe('filters', () => {
    it.each(cases.filters)('$name', async ({ filter, castFails, beyondEvaluator }) => {
      if (castFails) {
        expect(() => translator.find(TYPED_CORPUS_COLLECTION, { filter })).toThrow(StoreQueryError);
        return;
      }
      const mongo = await Model.find(filter as mongoose.FilterQuery<Doc>)
        .select('+secret +pin')
        .lean<Doc[]>();
      const actual = await find({ filter, projection: '+secret +pin' });
      expect(sortedLabels(actual)).toEqual(sortedLabels(mongo));
      if (!beyondEvaluator) {
        const cast = translator.caster.castFilter(TYPED_CORPUS_COLLECTION, filter) as StoreFilter;
        expect(sortedLabels(actual)).toEqual(
          sortedLabels(records.filter((record) => matchesStoreFilter(record, cast))),
        );
      }
    });
  });

  describe('projections', () => {
    it.each(cases.projections)('$name', async ({ projection }) => {
      const query = Model.find({}).sort({ _id: 1 });
      if (projection) query.select(projection);
      const mongo = await query.lean<Doc[]>();
      const actual = await find({ projection, sort: { _id: 1 } });
      expect(canonical(actual)).toEqual(canonical(mongo));
    });
  });

  describe('sorts', () => {
    it.each(cases.sorts)('$name', async ({ sort }) => {
      const total = withTieBreak(sort);
      const mongo = await Model.find({}).sort(total).lean<Doc[]>();
      const actual = await find({ sort: total, projection: 'label' });
      expect(labels(actual)).toEqual(labels(mongo));
      expect(labels(actual)).toEqual(labels([...records].sort(compareByStoreSort(total))));
    });

    it('refuses a sort by a whole subdocument', () => {
      expect(() => translator.find(TYPED_CORPUS_COLLECTION, { sort: { profile: 1 } })).toThrow(
        StoreQueryError,
      );
    });
  });
});

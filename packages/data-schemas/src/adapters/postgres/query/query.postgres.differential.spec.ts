import { Schema } from 'mongoose';
import type { Pool } from 'pg';
import type { StoreFilter, StoreSort } from '~/ports/query';
import type { RecordTables } from '../records/tables';
import {
  matchesStoreFilter,
  assertStoreFilter,
  applyStoreProjection,
  applyStoreQueryOptions,
  compareByStoreSort,
} from '~/ports/query';
import { buildStoreQueryCorpus, CORPUS_HIDDEN_FIELDS } from '~/ports/query.corpus';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { decomposeRecord, insertStatements } from '../records/decompose';
import { usePostgresIcuDatabase } from '~/test/postgres/icu';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { HELPER_FUNCTIONS_DDL } from '../schema/functions';
import { NO_SCHEMA_OVERRIDES } from '../schema/overrides';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { emitSchemaDdl } from '../schema/emitDdl';
import { createQueryTranslator } from './index';

/**
 * Corpus A (`ports/query.corpus.ts`, the cases `query.differential.spec.ts` checks against
 * MongoDB) on PostgreSQL (docs/postgres-port/PHASE4.md §2.5): every top-level key of the records is
 * declared `Mixed`, so the whole corpus runs through the `json` side of the translator (the side
 * that serves the schemas' `json` columns); `_id` is a typed id column and `secret`/`pin` are
 * hidden. Every filter, projection, sort and paging case must give what the reference evaluator
 * gives (and so MongoDB), on a database with the C locale and on one with the ICU `en-US` locale
 * (a missing `COLLATE "C"` would show there). The update and upsert cases are the collection
 * primitive's (C1).
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

/**
 * Every top-level key of the records, the updates and upserts, and the filters (the corpus is
 * schemaless, MongoDB's `strict: false`; here an undeclared path is refused, R9), in first-seen
 * order.
 */
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
  [...corpus.filters, ...corpus.upserts].forEach(({ filter }) => visit(filter));
  for (const { sort } of corpus.sorts)
    Object.keys(sort).forEach((key) => keys.add(key.split('.')[0]));
  keys.delete('_id');
  return [...keys];
}

/**
 * The corpus descriptor; `indexed` declares an index on every key, which the generator maps to a
 * GIN `jsonb_path_ops` index per `json` column, so equality and `$in` also get the translator's
 * lax jsonpath prefilter (the C database runs with it, the ICU database without).
 */
function corpusTables(indexed: boolean): RecordTables {
  const definition: Record<string, unknown> = {};
  const keys = corpusKeys();
  for (const key of keys) {
    definition[key] = CORPUS_HIDDEN_FIELDS.includes(key)
      ? { type: Schema.Types.Mixed, select: false }
      : Schema.Types.Mixed;
  }
  const schema = new Schema(definition, { versionKey: false, strict: false });
  if (indexed) {
    keys.forEach((key) => schema.index({ [key]: 1 }));
  }
  return indexRecordTables(
    buildSchemaDescriptor(
      [introspectSchema(schema, { collection: COLLECTION })],
      NO_SCHEMA_OVERRIDES,
    ),
  );
}

const LOCALES = {
  C: corpusTables(true),
  ICU: corpusTables(false),
} as const;
type Locale = keyof typeof LOCALES;

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

/**
 * Sorts whose key is a whole object: F3's `lc_sort_key` orders objects by their `jsonb` text, an
 * approximation of MongoDB's field-by-field order (PHASE4.md §8 F3), so only the places of the
 * other records are compared.
 */
const OBJECT_SORTS: ReadonlySet<string> = new Set(['objects', 'objects descending']);

const labels = (docs: Doc[]): string[] => docs.map((doc) => doc.label as string);
const sortedLabels = (docs: Doc[]): string[] => labels(docs).sort();
const withTieBreak = (sort: StoreSort): StoreSort => ('_id' in sort ? sort : { ...sort, _id: 1 });

async function prepare(pool: Pool, tables: RecordTables): Promise<void> {
  for (const statement of emitSchemaDdl(tables.descriptor)) {
    await pool.query(statement);
  }
  for (const statement of HELPER_FUNCTIONS_DDL) {
    await pool.query(statement);
  }
  const records = corpus.records.map((record) =>
    decomposeRecord(tables, COLLECTION, record, { mode: 'raw' }),
  );
  for (const statement of insertStatements(tables, records)) {
    await pool.query(statement.text, statement.values);
  }
}

const translators = {
  C: createQueryTranslator(LOCALES.C),
  ICU: createQueryTranslator(LOCALES.ICU),
};

async function find(
  locale: Locale,
  pool: Pool,
  query: Parameters<(typeof translators)['C']['find']>[1],
): Promise<Doc[]> {
  const read = translators[locale].find(COLLECTION, query);
  const { rows } = await pool.query(read.text, read.values);
  return read.decode(rows);
}

describePostgres('query translator: corpus A on PostgreSQL vs the reference evaluator', () => {
  const database = usePostgresTestDatabase();
  const icu = usePostgresIcuDatabase(database);
  const pools: Record<'C' | 'ICU', Pool | undefined> = { C: undefined, ICU: undefined };

  beforeAll(async () => {
    pools.C = database.pool();
    pools.ICU = icu.pool();
    await prepare(pools.C, LOCALES.C);
    await prepare(pools.ICU, LOCALES.ICU);
  }, 180_000);

  it('runs the whole read corpus: 142 filters, 29 projections, 27 sorts, 7 paging cases', () => {
    expect(corpus.filters).toHaveLength(142);
    expect(corpus.projections).toHaveLength(29);
    expect(corpus.sorts).toHaveLength(27);
    expect(corpus.queryOptions).toHaveLength(7);
  });

  describe.each(['C', 'ICU'] as const)('%s database', (locale) => {
    const pool = () => pools[locale] as Pool;

    it('has GIN indexes on the json columns, and the jsonpath prefilter, on the C database only', () => {
      const gins = LOCALES[locale].collection(COLLECTION).descriptor.indexes;
      expect(gins.length > 0).toBe(locale === 'C');
      const { text } = translators[locale].find(COLLECTION, { filter: { 'items.sku': 'a1' } });
      expect(text.includes('@?')).toBe(locale === 'C');
    });

    it('has the locale it is named for', async () => {
      const { rows } = await pool().query(
        'SELECT datlocprovider, daticulocale FROM pg_database WHERE datname = current_database()',
      );
      expect(rows[0].datlocprovider).toBe(locale === 'ICU' ? 'i' : 'c');
    });

    describe('filters', () => {
      it.each(corpus.filters)('$name', async ({ filter }) => {
        assertStoreFilter(filter);
        const expected = corpus.records.filter((record) =>
          matchesStoreFilter(record, filter as StoreFilter),
        );
        const actual = await find(locale, pool(), { filter, projection: '+secret +pin' });
        expect(sortedLabels(actual)).toEqual(sortedLabels(expected));
      });
    });

    describe('projections', () => {
      it.each(corpus.projections)('$name', async ({ projection }) => {
        const expected = [...corpus.records]
          .sort(compareByStoreSort({ _id: 1 }))
          .map((record) => applyStoreProjection(record, projection, CORPUS_HIDDEN_FIELDS));
        const actual = await find(locale, pool(), { projection, sort: { _id: 1 } });
        expect(canonical(actual)).toEqual(canonical(expected));
      });
    });

    describe('sorts', () => {
      it.each(corpus.sorts.filter(({ name }) => !OBJECT_SORTS.has(name)))(
        '$name',
        async ({ sort }) => {
          const total = withTieBreak(sort);
          const expected = [...corpus.records].sort(compareByStoreSort(total));
          const actual = await find(locale, pool(), { sort: total, projection: 'label' });
          expect(labels(actual)).toEqual(labels(expected));
        },
      );

      it.each(corpus.sorts.filter(({ name }) => OBJECT_SORTS.has(name)))(
        '$name (documented divergence: objects order by their jsonb text)',
        async ({ sort }) => {
          const total = withTieBreak(sort);
          const expected = labels([...corpus.records].sort(compareByStoreSort(total)));
          const actual = labels(await find(locale, pool(), { sort: total, projection: 'label' }));
          const [path] = Object.keys(sort);
          const isObject = (label: string) => {
            const value = corpus.records.find((record) => record.label === label)?.[path];
            return value !== null && typeof value === 'object' && !Array.isArray(value);
          };
          /** Records whose key is not an object keep MongoDB's places, the objects fill the rest. */
          expect(actual.map((label) => (isObject(label) ? '<object>' : label))).toEqual(
            expected.map((label) => (isObject(label) ? '<object>' : label)),
          );
          expect([...actual].sort()).toEqual([...expected].sort());
        },
      );
    });

    describe('paging', () => {
      it.each(corpus.queryOptions)('$name', async ({ options }) => {
        const sort = withTieBreak(options.sort);
        const expected = applyStoreQueryOptions(corpus.records, { ...options, sort });
        const actual = await find(locale, pool(), {
          sort,
          limit: options.limit,
          offset: options.offset,
          projection: 'label',
        });
        expect(labels(actual)).toEqual(labels(expected));
      });
    });
  });
});

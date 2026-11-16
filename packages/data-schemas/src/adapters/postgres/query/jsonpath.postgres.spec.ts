import type { Pool } from 'pg';
import type { StoreFilter } from '~/ports/query';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { decomposeRecord, insertStatements } from '../records/decompose';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { indexRecordTables } from '../records/tables';
import { matchesStoreFilter } from '~/ports/query';
import { readRecords } from '../records/assemble';
import { createQueryTranslator } from './index';

/**
 * Hinted `json` subpaths on PostgreSQL (docs/postgres-port/PHASE4.md §1.6, §2.1): the eight
 * `agenttriggerdeliveries.envelope` paths compare the descriptor's expression `(envelope::jsonb
 * #> '{...}')` (which the btree expression indexes serve) instead of walking the value. Whatever
 * the envelope holds (missing keys, `null`, scalars on the way, numbers, booleans), the results
 * must be the reference evaluator's. The same filters on an unhinted subpath of the same values
 * (`envelope.event.source.other`, not hinted) take the exact candidate walk and must agree too.
 */

const tables = indexRecordTables(SCHEMA_DESCRIPTOR);
const translator = createQueryTranslator(tables);
const COLLECTION = 'agenttriggerdeliveries';
const ID = (n: number) => n.toString(16).padStart(24, '0');

const ENVELOPES: Array<Record<string, unknown> | null | undefined> = [
  {
    event: { source: { type: 'a', id: 'x1', other: 'a' }, type: 'e1', payload: { taskId: 't1' } },
    target: { conversationId: 'c1', bindingId: 'b1' },
  },
  { event: { source: { type: 'b', id: 5, other: 'b' } }, target: { conversationId: null } },
  { event: { source: null } },
  { event: 'scalar' },
  undefined,
  null,
  { event: { source: { type: 'A', id: 'x2', other: 'A' } }, target: { conversationId: 'c2' } },
  { event: { source: { type: true, id: 5.0, other: true } } },
  { event: { source: { type: 'é', id: -1, other: 'é' } } },
  { event: { source: {} }, target: {} },
];

const VALUE_FILTERS: Array<Record<string, unknown>> = [
  { $eq: 'a' },
  { $eq: 'A' },
  { $eq: true },
  { $eq: null },
  { $exists: true },
  { $exists: false },
  { $ne: 'a' },
  { $ne: null },
  { $in: ['a', 'b'] },
  { $in: ['a', null] },
  { $nin: ['a', true] },
  { $gt: 'B' },
  { $lte: 'a' },
  { $gt: 'z' },
  { $regex: '^a', $options: 'i' },
  { $regex: '^é' },
];

const ID_FILTERS: Array<Record<string, unknown>> = [
  { $eq: 5 },
  { $eq: '5' },
  { $gte: 5 },
  { $lt: 0 },
  { $in: [5, 'x1'] },
  { $ne: 5 },
];

describePostgres('query translator: hinted json subpaths', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let pool: Pool;
  let records: Array<Record<string, unknown>>;

  beforeAll(async () => {
    pool = database.pool();
    const decomposed = ENVELOPES.map((envelope, index) =>
      decomposeRecord(
        tables,
        COLLECTION,
        {
          _id: ID(index + 1),
          deliveryKey: `delivery-${index}`,
          ...(envelope === undefined ? {} : { envelope }),
        },
        { mode: 'raw' },
      ),
    );
    for (const statement of insertStatements(tables, decomposed)) {
      await pool.query(statement.text, statement.values);
    }
    records = await readRecords(pool, tables, COLLECTION, { orderBy: '"t"."_id"' });
  });

  /** Asserts the SQL's records equal the evaluator's; returns the SQL text. */
  async function check(path: string, condition: Record<string, unknown>): Promise<string> {
    const filter = { [path]: '$eq' in condition ? condition.$eq : condition };
    const read = translator.find(COLLECTION, { filter, projection: '_id' });
    const { rows } = await pool.query(read.text, read.values);
    const actual = read.decode(rows).map((record) => record._id);
    const cast = translator.caster.castFilter(COLLECTION, filter) as StoreFilter;
    const expected = records
      .filter((record) => matchesStoreFilter(record, cast))
      .map((record) => record._id);
    expect({ filter, ids: actual.sort() }).toEqual({ filter, ids: expected.sort() });
    return read.text;
  }

  it('compares hinted paths on the descriptor expression', () => {
    const { text } = translator.find(COLLECTION, {
      filter: { 'envelope.event.source.type': 'a' },
    });
    expect(text).toContain(`(("t"."envelope")::jsonb #> '{"event","source","type"}') = $1::jsonb`);
  });

  it.each(VALUE_FILTERS)('envelope.event.source.type %j (hinted)', async (condition) => {
    const text = await check('envelope.event.source.type', condition);
    expect(text).toContain("#> '{");
  });

  it.each(VALUE_FILTERS)('envelope.event.source.other %j (unhinted)', async (condition) => {
    const text = await check('envelope.event.source.other', condition);
    expect(text).not.toContain("#> '{");
  });

  it.each(ID_FILTERS)('envelope.event.source.id %j (hinted, numbers)', async (condition) => {
    expect(await check('envelope.event.source.id', condition)).toContain("#> '{");
  });

  it.each([{ $eq: null }, { $exists: false }, { $ne: null }, { $eq: 'c1' }])(
    'envelope.target.conversationId %j (hinted, explicit null)',
    async (condition) => {
      expect(await check('envelope.target.conversationId', condition)).toContain("#> '{");
    },
  );
});

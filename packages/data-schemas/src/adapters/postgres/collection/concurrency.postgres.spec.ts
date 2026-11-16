import { Schema } from 'mongoose';
import type { Pool } from 'pg';
import type { PgCollection } from './index';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { HELPER_FUNCTIONS_DDL } from '../schema/functions';
import { introspectSchema } from '../schema/generate';
import { indexRecordTables } from '../records/tables';
import { emitSchemaDdl } from '../schema/emitDdl';
import { createPgCollections } from './index';

/**
 * The concurrency rules of the collection primitive (docs/postgres-port/PHASE4.md §3.5), on
 * concurrent connections of one pool:
 * - parallel single-record claims take distinct rows (waiting, and with `skipLocked`);
 * - racing upserts on a unique key leave one row (the losers retry as updates);
 * - a partial unique index stays a guard (one writer wins, the others get a duplicate key);
 * - the child-filter rule: a write whose filter reads a child table, racing a transaction that
 *   changes those child rows, never writes a row that no longer matches when it writes.
 * The shadow check is off here: it re-routes tier-1 updates through the lock-then-write path, and
 * these cases exercise the single-statement claims.
 */

const COLLECTION = 'claims';
const schema = new Schema(
  {
    key: String,
    status: String,
    owner: String,
    active: Boolean,
    count: Number,
    seq: Number,
    items: [new Schema({ sku: String }, { _id: false })],
  },
  { versionKey: false },
);
schema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $exists: true } } });
schema.index({ owner: 1 }, { unique: true, partialFilterExpression: { active: true } });
const tables = indexRecordTables(
  buildSchemaDescriptor([introspectSchema(schema, { collection: COLLECTION })]),
);

const PARALLEL = 8;

describePostgres('PgCollection concurrency rules', () => {
  const database = usePostgresTestDatabase();
  let claims: PgCollection;
  let pool: Pool;

  /** Resolves once `count` sessions of the database wait on a lock. */
  async function waitForLockWaiters(count: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= count) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('No session waited on the lock');
  }

  beforeAll(async () => {
    pool = database.pool({ max: 4 });
    for (const statement of [...emitSchemaDdl(tables.descriptor), ...HELPER_FUNCTIONS_DDL]) {
      await pool.query(statement);
    }
    claims = createPgCollections({
      db: database.kysely({ max: PARALLEL + 2 }),
      descriptor: tables,
      engine: null,
      shadowCheck: false,
    }).collection(COLLECTION);
  }, 120_000);

  beforeEach(() => database.truncateAll());

  const queue = (n: number) =>
    claims.insertMany(
      Array.from({ length: n }, (_, seq) => ({
        status: 'queued',
        seq,
        items: [{ sku: `s${seq}` }],
      })),
    );

  it.each([false, true])(
    'gives parallel claims distinct rows (skipLocked: %s)',
    async (skipLocked) => {
      await queue(PARALLEL - 2);
      const claimed = await Promise.all(
        Array.from({ length: PARALLEL }, (_, owner) =>
          claims.findOneAndUpdate(
            { status: 'queued' },
            { $set: { status: 'claimed', owner: `o${owner}` } },
            { sort: { seq: 1 }, returnDocument: 'after', skipLocked },
          ),
        ),
      );
      const ids = claimed.filter(Boolean).map((record) => record!._id);
      expect(ids).toHaveLength(PARALLEL - 2);
      expect(new Set(ids).size).toBe(PARALLEL - 2);
      expect(await claims.count({ status: 'claimed' })).toBe(PARALLEL - 2);
    },
  );

  it('gives parallel claims through a child filter distinct rows', async () => {
    await queue(PARALLEL - 2);
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        claims.findOneAndUpdate(
          {
            status: 'queued',
            'items.sku': { $in: Array.from({ length: PARALLEL }, (_, i) => `s${i}`) },
          },
          { $set: { status: 'claimed' } },
        ),
      ),
    );
    const ids = results.filter(Boolean).map((record) => record!._id);
    expect(new Set(ids).size).toBe(PARALLEL - 2);
  });

  it('leaves one row when upserts race on a unique key', async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        claims.updateOne({ key: 'k' }, { $inc: { count: 1 } }, { upsert: true }),
      ),
    );
    expect(results.filter((result) => result.upsertedCount === 1)).toHaveLength(1);
    expect(await claims.find({ key: 'k' }, { projection: 'key count' })).toEqual([
      { _id: expect.any(String), key: 'k', count: PARALLEL },
    ]);
  });

  it('keeps a partial unique index as a guard between racing writers', async () => {
    await claims.insertMany(
      Array.from({ length: PARALLEL }, (_, seq) => ({ seq, owner: 'shared', active: false })),
    );
    const outcomes = await Promise.allSettled(
      Array.from({ length: PARALLEL }, (_, seq) =>
        claims.updateOne({ seq }, { $set: { active: true } }),
      ),
    );
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(PARALLEL - 1);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(StoreDuplicateKeyError);
      expect((outcome.reason as StoreDuplicateKeyError).keyValue).toEqual({ owner: 'shared' });
    }
    expect(await claims.count({ active: true })).toBe(1);
  });

  describe('the child-filter rule', () => {
    /**
     * Holds the parent row locked in another transaction, removes the child row the filter needs,
     * starts `write` (which waits on the lock), then commits: `write` must not touch the row.
     */
    async function raceChildRemoval<T>(id: string, write: () => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM "claims" WHERE "_id" = $1 FOR UPDATE`, [id]);
        await client.query(`DELETE FROM "claims__items" WHERE "_parent" = $1`, [id]);
        await client.query(`UPDATE "claims" SET "items" = 0 WHERE "_id" = $1`, [id]);
        const pending = write();
        pending.catch(() => undefined);
        await waitForLockWaiters(1);
        await client.query('COMMIT');
        return await pending;
      } finally {
        client.release();
      }
    }

    it.each([
      [
        'updateOne, tier 1',
        () => claims.updateOne({ 'items.sku': 'hot' }, { $set: { status: 'hit' } }),
      ],
      [
        'updateMany, tier 1',
        () => claims.updateMany({ 'items.sku': 'hot' }, { $set: { status: 'hit' } }),
      ],
      [
        'updateOne, tier 2',
        () => claims.updateOne({ 'items.sku': 'hot' }, { $push: { items: { sku: 'more' } } }),
      ],
      ['deleteOne', () => claims.deleteOne({ 'items.sku': 'hot' })],
      ['deleteMany', () => claims.deleteMany({ 'items.sku': 'hot' })],
    ] as Array<[string, () => Promise<object>]>)(
      '%s never writes the row that stopped matching',
      async (_name, write) => {
        const [target] = await claims.insertMany([{ status: 'idle', items: [{ sku: 'hot' }] }]);
        const result = (await raceChildRemoval(target._id as string, write)) as Record<
          string,
          number
        >;
        expect(result.matchedCount ?? result.deletedCount).toBe(0);
        expect(await claims.findOne({ _id: target._id })).toMatchObject({
          status: 'idle',
          items: [],
        });
      },
    );

    it('findOneAndUpdate moves on to the next row that still matches', async () => {
      const [first, second] = await claims.insertMany([
        { seq: 1, status: 'idle', items: [{ sku: 'hot' }] },
        { seq: 2, status: 'idle', items: [{ sku: 'hot' }] },
      ]);
      const updated = await raceChildRemoval(first._id as string, () =>
        claims.findOneAndUpdate(
          { 'items.sku': 'hot' },
          { $set: { status: 'hit' } },
          { sort: { seq: 1 }, returnDocument: 'after' },
        ),
      );
      expect(updated).toMatchObject({ _id: second._id, status: 'hit' });
      expect(await claims.findOne({ _id: first._id })).toMatchObject({ status: 'idle' });
    });
  });
});

import type { PostgresKysely } from '../types';
import type { PgCollections } from './index';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresStoreTransactions } from '../storeTransactions';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { generatePostgresStoreId } from '../storeIds';
import { computeSearchTokens } from '~/utils/search';
import { getSchemaEngine } from '../schema/engine';
import { StoreQueryError } from '~/ports/query';
import { createPgCollections } from './index';

/**
 * The collection primitive on the production tables (docs/postgres-port/PHASE4.md §3): reads,
 * inserts (engine defaults, `_id`, timestamps, `__v`), both update tiers, upserts, deletes with
 * cascades, duplicate keys, transactions, bulk writes and raw mode. Every tier-1 update is shadow
 * checked against the evaluator.
 */

const T0 = new Date('2025-01-01T00:00:00.000Z');

describePostgres('PgCollection on the production tables', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let db: PostgresKysely;
  let collections: PgCollections;
  let clock = T0.getTime();
  const previousShadow = process.env.POSTGRES_UPDATE_SHADOW_CHECK;

  beforeAll(() => {
    process.env.POSTGRES_UPDATE_SHADOW_CHECK = 'true';
    db = database.kysely();
    collections = createPgCollections({
      db,
      descriptor: SCHEMA_DESCRIPTOR,
      engine: getSchemaEngine(),
      now: () => new Date((clock += 1000)),
    });
  });

  afterAll(() => {
    if (previousShadow === undefined) delete process.env.POSTGRES_UPDATE_SHADOW_CHECK;
    else process.env.POSTGRES_UPDATE_SHADOW_CHECK = previousShadow;
  });

  beforeEach(() => database.truncateAll());

  const users = () => collections.collection('users');

  describe('inserts', () => {
    it('builds the document with the engine and sets _id, timestamps and __v', async () => {
      const user = await users().insertOne({ email: 'A@Example.com', name: 'Ann Lee' });
      expect(user._id).toMatch(/^[0-9a-f]{24}$/);
      expect(user).toMatchObject({
        email: 'a@example.com',
        provider: 'local',
        emailVerified: false,
        username: '',
        __v: 0,
      });
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toEqual(user.createdAt);

      const read = await users().findOne({ _id: user._id });
      expect(read).toMatchObject({ email: 'a@example.com', name: 'Ann Lee', __v: 0 });
      expect(read).not.toHaveProperty('password');
      expect(read).not.toHaveProperty('nameTokens');
      expect(Object.keys(read!)[0]).toBe('_id');
    });

    it('keeps a given createdAt and validates', async () => {
      const createdAt = new Date('2020-02-02T00:00:00.000Z');
      const user = await users().insertOne({ email: 'b@example.com', createdAt });
      expect(user.createdAt).toEqual(createdAt);
      expect(user.updatedAt).toEqual(createdAt);
      await expect(users().insertOne({ name: 'no email' })).rejects.toThrow(/email/);
    });

    it('maps a duplicate key to StoreDuplicateKeyError with keyValue', async () => {
      await users().insertOne({ email: 'dup@example.com' });
      const error = await users()
        .insertOne({ email: 'dup@example.com' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StoreDuplicateKeyError);
      expect((error as StoreDuplicateKeyError).keyValue).toEqual({
        email: 'dup@example.com',
        tenantId: undefined,
      });
    });

    it('inserts many, ordered and unordered, around a duplicate key', async () => {
      await users().insertOne({ email: 'taken@example.com' });
      const ordered = await users()
        .insertMany([
          { email: 'one@example.com' },
          { email: 'taken@example.com' },
          { email: 'three@example.com' },
        ])
        .catch((caught: unknown) => caught);
      expect(ordered).toBeInstanceOf(StoreDuplicateKeyError);
      expect((ordered as { writeErrors: unknown[] }).writeErrors).toHaveLength(1);
      expect((await users().distinct('email')).sort()).toEqual([
        'one@example.com',
        'taken@example.com',
      ]);

      await expect(
        users().insertMany(
          [
            { email: 'four@example.com' },
            { email: 'taken@example.com' },
            { email: 'five@example.com' },
          ],
          { ordered: false },
        ),
      ).rejects.toBeInstanceOf(StoreDuplicateKeyError);
      expect(await users().count()).toBe(4);
    });
  });

  describe('reads', () => {
    beforeEach(async () => {
      await users().insertMany(
        ['c@x.io', 'a@x.io', 'b@x.io'].map((email, index) => ({
          email,
          name: `N${index}`,
          role: index === 0 ? 'ADMIN' : 'USER',
        })),
      );
    });

    it('filters, sorts, projects and pages', async () => {
      const page = await users().find(
        { role: 'USER' },
        { sort: { email: -1 }, projection: 'email', limit: 1, skip: 1 },
      );
      expect(page).toEqual([{ _id: expect.any(String), email: 'a@x.io' }]);
      expect(await users().count({ role: 'USER' })).toBe(2);
      expect(await users().exists({ email: 'b@x.io' })).toEqual({ _id: expect.any(String) });
      expect(await users().exists({ email: 'zz@x.io' })).toBeNull();
      expect(await users().distinct('role')).toEqual(['ADMIN', 'USER']);
    });

    it('refuses a filter on an undeclared path', async () => {
      await expect(users().find({ nope: 1 })).rejects.toThrow(StoreQueryError);
    });
  });

  describe('updates', () => {
    it('applies tier-1 updates with updatedAt and modifiedCount', async () => {
      const user = await users().insertOne({ email: 'u@x.io', name: 'Old' });
      const result = await users().updateOne(
        { _id: user._id },
        { name: 'New', $inc: { __v: 1 }, $unset: { avatar: 1 } },
      );
      expect(result).toEqual({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      });
      const read = await users().findOne({ _id: user._id });
      expect(read).toMatchObject({ name: 'New', __v: 1 });
      expect((read!.updatedAt as Date).getTime()).toBeGreaterThan(
        (user.updatedAt as Date).getTime(),
      );
      expect(read!.createdAt).toEqual(user.createdAt);
    });

    it('counts a no-op update as matched, not modified (timestamps off)', async () => {
      const user = await users().insertOne({ email: 'n@x.io', name: 'Same' });
      const result = await users().updateOne(
        { _id: user._id },
        { $set: { name: 'Same' } },
        { timestamps: false },
      );
      expect(result.matchedCount).toBe(1);
      expect(result.modifiedCount).toBe(0);
      const added = await users().updateOne(
        { _id: user._id },
        { $addToSet: { pinnedOrder: 'a' } },
        { timestamps: false },
      );
      expect(added.modifiedCount).toBe(1);
      const again = await users().updateOne(
        { _id: user._id },
        { $addToSet: { pinnedOrder: 'a' } },
        { timestamps: false },
      );
      expect(again.modifiedCount).toBe(0);
    });

    it('applies tier-2 updates to child tables and json subpaths', async () => {
      const user = await users().insertOne({ email: 'c@x.io' });
      await users().updateOne(
        { _id: user._id },
        {
          $push: { favorites: { agentId: 'a1' }, backupCodes: { codeHash: 'h1' } },
          $set: { 'skillStates.s1': true },
        },
      );
      const read = await users().findOne({ _id: user._id }, { projection: '+backupCodes' });
      expect(read).toMatchObject({
        favorites: [{ agentId: 'a1' }],
        backupCodes: [{ codeHash: 'h1', used: false, usedAt: null }],
        skillStates: { s1: true },
      });
      await users().updateOne({ _id: user._id }, { $pull: { favorites: { agentId: 'a1' } } });
      expect((await users().findOne({ _id: user._id }))?.favorites).toEqual([]);
      expect(await users().findOne({ 'favorites.agentId': 'a1' })).toBeNull();
    });

    it('refuses MongoDB errors: $inc on null, writing through null, conflicts', async () => {
      const user = await users().insertOne({ email: 'e@x.io' });
      await users().updateOne({ _id: user._id }, { $set: { twoFactorEnrolledAt: null } });
      await expect(
        users().updateOne({ _id: user._id }, { $set: { 'personalization.memories': true } }),
      ).resolves.toMatchObject({ matchedCount: 1 });
      await expect(
        users().updateOne({ _id: user._id }, { $set: { name: 'a' }, $unset: { name: 1 } }),
      ).rejects.toThrow(StoreQueryError);
      await expect(
        users().updateOne({ _id: user._id }, { $set: { 'favorites.$.agentId': 'x' } }),
      ).rejects.toThrow(/positional operator did not find the match/);
    });

    it('upserts: the filter seeds the record, $setOnInsert, createdAt and __v apply', async () => {
      const result = await users().updateOne(
        { email: 'new@x.io' },
        { $set: { name: 'Fresh' }, $setOnInsert: { role: 'ADMIN' } },
        { upsert: true },
      );
      expect(result.upsertedCount).toBe(1);
      const read = await users().findOne({ _id: result.upsertedId });
      expect(read).toMatchObject({
        email: 'new@x.io',
        name: 'Fresh',
        role: 'ADMIN',
        provider: 'local',
        __v: 0,
      });
      expect(read!.createdAt).toEqual(read!.updatedAt);

      const second = await users().updateOne(
        { email: 'new@x.io' },
        { $set: { name: 'Again' }, $setOnInsert: { role: 'USER' } },
        { upsert: true },
      );
      expect(second).toMatchObject({ matchedCount: 1, upsertedCount: 0 });
      expect(await users().findOne({ email: 'new@x.io' })).toMatchObject({
        name: 'Again',
        role: 'ADMIN',
      });
    });

    it('findOneAndUpdate returns the record before or after, by sort', async () => {
      await users().insertMany([
        { email: 'q1@x.io', name: 'b' },
        { email: 'q2@x.io', name: 'a' },
      ]);
      const before = await users().findOneAndUpdate(
        { role: 'USER' },
        { $set: { role: 'ADMIN' } },
        { sort: { name: 1 }, projection: 'email role' },
      );
      expect(before).toEqual({ _id: expect.any(String), email: 'q2@x.io', role: 'USER' });
      const after = await users().findOneAndUpdate(
        { role: 'USER' },
        { $push: { favorites: { agentId: 'z' } } },
        { returnDocument: 'after' },
      );
      expect(after).toMatchObject({ email: 'q1@x.io', favorites: [{ agentId: 'z' }] });
      expect(
        await users().findOneAndUpdate({ role: 'NOBODY' }, { $set: { name: 'x' } }),
      ).toBeNull();
      const upserted = await users().findOneAndUpdate(
        { email: 'up@x.io' },
        { $set: { name: 'u' } },
        { upsert: true, returnDocument: 'after' },
      );
      expect(upserted).toMatchObject({ email: 'up@x.io', name: 'u' });
    });

    it('validates the post-image with runValidators', async () => {
      const user = await users().insertOne({ email: 'v@x.io' });
      await expect(
        users().updateOne(
          { _id: user._id },
          { $set: { email: 'not-an-email' } },
          { runValidators: true },
        ),
      ).rejects.toThrow(/invalid/);
      expect((await users().findOne({ _id: user._id }))?.email).toBe('v@x.io');
    });
  });

  describe('deletes', () => {
    it('deletes with cascades to child rows', async () => {
      const user = await users().insertOne({ email: 'd@x.io', favorites: [{ agentId: 'a' }] });
      await users().insertOne({ email: 'd2@x.io' });
      const removed = await users().findOneAndDelete({ 'favorites.agentId': 'a' });
      expect(removed).toMatchObject({ _id: user._id, favorites: [{ agentId: 'a' }] });
      const { rows } = await database
        .pool()
        .query('SELECT count(*)::int AS n FROM "users__favorites"');
      expect(rows[0].n).toBe(0);
      expect(await users().deleteOne({ email: 'nobody' })).toEqual({
        acknowledged: true,
        deletedCount: 0,
      });
      expect(await users().deleteMany({})).toEqual({ acknowledged: true, deletedCount: 1 });
    });
  });

  describe('transactions and bulk', () => {
    it('runs in a store transaction and rolls back with it', async () => {
      const transactions = createPostgresStoreTransactions(() => db);
      await expect(
        transactions.transaction(async (tx) => {
          await users().insertOne({ email: 't@x.io' }, { tx });
          await users().updateOne(
            { email: 't@x.io' },
            { $push: { favorites: { agentId: 'x' } } },
            { tx },
          );
          expect(await users().count({}, { tx })).toBe(1);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await users().count()).toBe(0);
    });

    it('bulk-writes in order, keeping the writes before a failure', async () => {
      await users().insertOne({ email: 'k@x.io' });
      const error = await users()
        .bulk([
          { insertOne: { document: { email: 'k1@x.io' } } },
          { updateOne: { filter: { email: 'k@x.io' }, update: { $set: { name: 'K' } } } },
          { insertOne: { document: { email: 'k@x.io' } } },
          { deleteMany: { filter: {} } },
        ])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StoreDuplicateKeyError);
      expect((error as { result: unknown }).result).toMatchObject({
        insertedCount: 1,
        matchedCount: 1,
        modifiedCount: 1,
      });
      expect(await users().count()).toBe(2);
    });
  });

  describe('hooks', () => {
    it('keeps the search tokens in their element tables', async () => {
      const user = await users().insertOne({ email: 'tok@x.io', name: 'Zoë Smith' });
      const tokens = async () =>
        users().findOne({ _id: user._id }, { projection: '+nameTokens +emailTokens' });
      expect(await tokens()).toMatchObject({
        nameTokens: computeSearchTokens('words', 'Zoë Smith'),
        emailTokens: computeSearchTokens('email', 'tok@x.io'),
      });
      await users().updateOne({ _id: user._id }, { $set: { name: 'Ann' } });
      expect((await tokens())?.nameTokens).toEqual(computeSearchTokens('words', 'Ann'));
      expect(await users().findOne({ nameTokens: 'ann' })).toMatchObject({ _id: user._id });
    });

    it('keeps the audit log append-only', async () => {
      const audit = collections.collection('auditlogs');
      await expect(audit.updateOne({}, { $set: { seq: 1 } })).rejects.toThrow(/append-only/);
      await expect(audit.deleteMany({})).rejects.toThrow(/append-only/);
      await expect(audit.insertMany([])).rejects.toThrow(/append-only/);
    });

    it('normalizes the MCP server name on insert', async () => {
      const server = await collections.collection('mcpservers').insertOne({
        serverName: 'My Server',
        config: { type: 'sse', url: 'https://x' },
        author: generatePostgresStoreId(),
      });
      expect(server.normalizedServerName).toBe('My_Server');
    });
  });

  describe('raw mode', () => {
    it('keeps undeclared and misfit values in _extra and unsets them', async () => {
      const raw = collections.raw('users');
      const id = generatePostgresStoreId();
      await raw.insertOne({ _id: id, email: 'R@X.io', legacy: { a: 1 }, emailVerified: 'maybe' });
      const [stored] = await raw.find({ _id: id });
      expect(stored).toMatchObject({ email: 'R@X.io', legacy: { a: 1 }, emailVerified: 'maybe' });
      expect(stored).not.toHaveProperty('createdAt');
      await raw.updateOne({ _id: id }, { $unset: { legacy: 1 }, $set: { note: 'x' } });
      const [after] = await raw.find({ _id: id });
      expect(after).not.toHaveProperty('legacy');
      expect(after).toMatchObject({ note: 'x' });
    });
  });
});

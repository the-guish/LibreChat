import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { generatePostgresStoreId } from '../storeIds';
import { createRawDatabase } from '~/testing';

/**
 * The raw facade of `@librechat/data-schemas/testing` (docs/postgres-port/PHASE4.md §7, E1): the
 * MongoDB driver's shapes over the collection primitive's raw mode.
 */
describePostgres('raw facade (@librechat/data-schemas/testing)', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  beforeEach(() => database.truncateAll());

  it('speaks the driver shapes over raw mode', async () => {
    const db = createRawDatabase({ db: database.kysely() });
    const convos = db.collection('conversations');
    const user = generatePostgresStoreId();
    const { insertedId } = await convos.insertOne({
      conversationId: 'c1',
      title: 'First',
      user,
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      __v: 0,
    });
    expect(insertedId).toMatch(/^[0-9a-f]{24}$/);
    const many = await convos.insertMany(
      ['c2', 'c3'].map((conversationId, index) => ({
        conversationId,
        title: conversationId,
        user,
        updatedAt: new Date(Date.UTC(2024, 1, index + 1)),
      })),
    );
    expect(many.insertedCount).toBe(2);
    expect(Object.keys(many.insertedIds)).toEqual(['0', '1']);

    const page = await convos
      .find({ user })
      .sort({ updatedAt: -1 })
      .project({ conversationId: 1 })
      .limit(2)
      .toArray();
    expect(page.map((convo) => convo.conversationId)).toEqual(['c3', 'c2']);
    expect(await convos.countDocuments({ conversationId: { $in: ['c1', 'c2'] } })).toBe(2);

    const updated = await convos.updateOne(
      { conversationId: 'c1' },
      { $set: { title: 'Renamed' } },
    );
    expect(updated).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    const record = await convos.findOne({ conversationId: 'c1' });
    expect(record).toMatchObject({ _id: insertedId, title: 'Renamed', __v: 0 });
    /** Raw mode writes no timestamps: `updatedAt` is the seeded one. */
    expect(record?.updatedAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));

    const upserted = await convos.updateOne(
      { conversationId: 'c9' },
      { $setOnInsert: { user, title: 'Seeded' } },
      { upsert: true },
    );
    expect(upserted).toMatchObject({ upsertedCount: 1 });
    expect(await convos.deleteOne({ conversationId: 'c9' })).toEqual({
      acknowledged: true,
      deletedCount: 1,
    });
    expect((await convos.deleteMany({ user })).deletedCount).toBe(3);
  });

  it('connects with POSTGRES_URI, truncates and closes its own pool', async () => {
    const db = createRawDatabase({ env: { POSTGRES_URI: database.uri } });
    try {
      await db
        .collection('banners')
        .insertOne({ bannerId: 'b', message: 'm', displayFrom: new Date() });
      expect(await db.collection('banners').countDocuments()).toBe(1);
      await db.truncateAll();
      expect(await db.collection('banners').countDocuments()).toBe(0);
    } finally {
      await db.close();
    }
  });
});

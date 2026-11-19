import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { UndeclaredPathError } from '../records/paths';
import { generatePostgresStoreId } from '../storeIds';
import { createRawDatabase } from '~/testing';

/**
 * The raw facade's filters on paths the schema does not declare (E2): matched as the driver
 * matches them, against the values raw writes keep in `_extra`, where the primitive refuses them
 * (R9). The e2e specs assert absence that way (`assistants` by `name`, a field it does not store).
 */
describePostgres('raw facade: filters on undeclared paths', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });

  beforeEach(() => database.truncateAll());

  it('matches undeclared paths against _extra in every call that takes a filter', async () => {
    const db = createRawDatabase({ db: database.kysely() });
    const assistants = db.collection('assistants');
    const user = generatePostgresStoreId();

    expect(await assistants.findOne({ name: 'missing' })).toBeNull();
    expect(await assistants.countDocuments({ name: 'missing' })).toBe(0);

    const { insertedId } = await assistants.insertOne({
      user,
      assistant_id: 'asst_1',
      name: 'Kept in _extra',
      meta: { level: 2 },
    });
    await assistants.insertOne({ user, assistant_id: 'asst_2' });

    expect(await assistants.findOne({ name: 'Kept in _extra' })).toMatchObject({
      _id: insertedId,
      assistant_id: 'asst_1',
      name: 'Kept in _extra',
    });
    expect(await assistants.findOne({ name: 'Kept in _extra', assistant_id: 'asst_2' })).toBeNull();
    expect(await assistants.countDocuments({ 'meta.level': { $gte: 2 } })).toBe(1);
    expect(await assistants.countDocuments({ name: { $exists: false } })).toBe(1);

    const either = await assistants
      .find({ $or: [{ name: { $regex: '^Kept' } }, { assistant_id: 'asst_2' }] })
      .sort({ assistant_id: -1 })
      .project({ assistant_id: 1 })
      .toArray();
    expect(either.map((record) => record.assistant_id)).toEqual(['asst_2', 'asst_1']);

    /** Id objects (the driver's `ObjectId`) compare as their hex, as records carry ids. */
    const idObject = { toHexString: () => user };
    expect(await assistants.countDocuments({ user: idObject, name: { $exists: true } })).toBe(1);

    const updated = await assistants.updateMany(
      { name: 'Kept in _extra' },
      { $set: { assistant_id: 'asst_renamed' } },
    );
    expect(updated).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    expect(await assistants.findOne({ assistant_id: 'asst_renamed' })).toMatchObject({
      _id: insertedId,
    });

    expect(await assistants.deleteMany({ 'meta.level': 2 })).toEqual({
      acknowledged: true,
      deletedCount: 1,
    });
    expect(await assistants.countDocuments()).toBe(1);
  });

  it('still refuses an upsert whose undeclared filter matches nothing', async () => {
    const db = createRawDatabase({ db: database.kysely() });
    await expect(
      db
        .collection('assistants')
        .updateOne({ name: 'nobody' }, { $set: { assistant_id: 'asst_9' } }, { upsert: true }),
    ).rejects.toBeInstanceOf(UndeclaredPathError);
    expect(await db.collection('assistants').countDocuments()).toBe(0);
  });
});

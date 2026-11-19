import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTransactionMethods } from './transaction';
import { createModels } from '~/models';

/**
 * `initializeNullBalanceCredits`, the compare-and-set the schedule service ran on the `Balance`
 * model directly to initialize an existing balance whose credits are still unset: the same
 * filter, update, sort and options.
 */

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createTransactionMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createTransactionMethods(mongoose, {
    getMultiplier: () => 1,
    getCacheMultiplier: () => null,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Balance.collection.deleteMany({});
});

const balances = () => mongoose.models.Balance.collection;

/** The schedule service's former write, verbatim. */
const formerInitialize = (
  userId: string,
  { tokenCredits, sync }: { tokenCredits: number; sync?: Record<string, unknown> },
) =>
  mongoose.models.Balance.findOneAndUpdate(
    { user: userId, tokenCredits: null },
    { $set: { tokenCredits, ...(sync && Object.keys(sync).length > 0 ? sync : {}) } },
    { new: true, sort: { _id: 1 } },
  ).lean();

describe('initializeNullBalanceCredits', () => {
  it('initializes a null-credit balance with the sync fields and returns it', async () => {
    const user = new mongoose.Types.ObjectId();
    await balances().insertOne({ user, tokenCredits: null });

    const record = await methods.initializeNullBalanceCredits(user.toString(), 500, {
      autoRefillEnabled: true,
      refillAmount: 100,
    });

    expect(record).toMatchObject({ tokenCredits: 500, autoRefillEnabled: true, refillAmount: 100 });
    expect(String(record?.user)).toBe(user.toString());
  });

  it('matches a record whose credit field is absent', async () => {
    const user = new mongoose.Types.ObjectId();
    await balances().insertOne({ user });

    await expect(
      methods.initializeNullBalanceCredits(user.toString(), 7, {}),
    ).resolves.toMatchObject({ tokenCredits: 7 });
    await expect(balances().findOne({ user })).resolves.toMatchObject({ tokenCredits: 7 });
  });

  it('leaves a balance with credits untouched and creates none', async () => {
    const user = new mongoose.Types.ObjectId();
    await balances().insertOne({ user, tokenCredits: 0 });
    const absent = new mongoose.Types.ObjectId();

    await expect(methods.initializeNullBalanceCredits(user.toString(), 500)).resolves.toBeNull();
    await expect(methods.initializeNullBalanceCredits(absent.toString(), 500)).resolves.toBeNull();
    await expect(balances().findOne({ user })).resolves.toMatchObject({ tokenCredits: 0 });
    await expect(balances().countDocuments({})).resolves.toBe(1);
  });

  it('updates the oldest null-credit record, as the former write did', async () => {
    const user = new mongoose.Types.ObjectId();
    const older = new mongoose.Types.ObjectId();
    const newer = new mongoose.Types.ObjectId();
    await balances().insertMany([
      { _id: newer, user, tokenCredits: null },
      { _id: older, user, tokenCredits: null },
    ]);

    const record = await methods.initializeNullBalanceCredits(user.toString(), 1);
    expect(String(record?._id)).toBe(older.toString());

    const former = await formerInitialize(user.toString(), { tokenCredits: 2 });
    expect(String((former as { _id: unknown })._id)).toBe(newer.toString());
  });

  it('writes the same record as the former write', async () => {
    const sync = { refillIntervalValue: 30, refillIntervalUnit: 'days' as const };
    const mine = new mongoose.Types.ObjectId();
    const theirs = new mongoose.Types.ObjectId();
    const _id = new mongoose.Types.ObjectId();
    const _id2 = new mongoose.Types.ObjectId();
    await balances().insertMany([
      { _id, user: mine, tokenCredits: null },
      { _id: _id2, user: theirs, tokenCredits: null },
    ]);

    const record = await methods.initializeNullBalanceCredits(mine.toString(), 42, sync);
    const former = await formerInitialize(theirs.toString(), { tokenCredits: 42, sync });

    const strip = (doc: unknown) => {
      const { _id: _ignored, user: _user, ...rest } = doc as Record<string, unknown>;
      return rest;
    };
    expect(strip(record)).toEqual(strip(former));
  });
});

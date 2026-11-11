import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { AllMethods } from './index';
import { createModels } from '~/models';
import { createMethods } from './index';

/**
 * The store methods that replace the queries the `config/` admin scripts ran on the models
 * directly: each runs that exact query, compared here with the former query, verbatim.
 * - `getCurrentBannerRecord`, `deleteBannerRecord` (`delete-banner`), `saveBanner`
 *   (`update-banner`);
 * - `findBalanceCreditsByUsers` (`list-balances`), `setBalanceCredits` (`set-balance`);
 * - `countConvosByUser`, `countMessagesByUser` (`user-stats`);
 * - `insertMessageRecords`, `createConvoRecord` (`create-error-convo`).
 */

let mongoServer: MongoMemoryServer;
let methods: AllMethods;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  for (const name of ['Banner', 'Balance', 'Conversation', 'Message']) {
    await mongoose.models[name].collection.deleteMany({});
  }
});

const oid = () => new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY);
/** A fixed date, for records seeded twice and compared. */
const SEEDED = new Date('2024-06-01T00:00:00Z');
/** Plain, comparable form of a record (ids and dates as strings). */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('banner records', () => {
  const banners = () => mongoose.models.Banner.collection;

  /** `delete-banner`'s former read, verbatim. */
  const formerCurrentBanner = () => {
    const now = new Date();
    return mongoose.models.Banner.findOne({
      displayFrom: { $lte: now },
      $or: [{ displayTo: { $gte: now } }, { displayTo: null }],
    });
  };

  it('reads the banner whose window holds now, whatever its type and visibility', async () => {
    await banners().insertMany([
      { bannerId: 'past', message: 'past', displayFrom: at(-10), displayTo: at(-5) },
      { bannerId: 'future', message: 'future', displayFrom: at(5) },
      {
        bannerId: 'popup',
        message: 'popup',
        displayFrom: at(-1),
        displayTo: null,
        type: 'popup',
        isPublic: false,
      },
    ]);

    const record = await methods.getCurrentBannerRecord();

    expect(record?.bannerId).toBe('popup');
    /** A plain record, as stored: the former document added the schema's defaults on read. */
    expect(plain(record)).toEqual(plain(await formerCurrentBanner().lean()));
    expect(record).not.toHaveProperty('persistable');
    expect((await formerCurrentBanner())?.persistable).toBe(false);
    expect(await methods.getBanner({} as never)).toBeNull();
  });

  it('reads an open-ended banner and a banner still in its window alike', async () => {
    await banners().insertOne({ bannerId: 'open', message: 'open', displayFrom: at(-1) });
    expect((await methods.getCurrentBannerRecord())?.bannerId).toBe('open');
    expect((await formerCurrentBanner())?.bannerId).toBe('open');

    await banners().deleteMany({});
    await banners().insertOne({
      bannerId: 'window',
      message: 'window',
      displayFrom: at(-1),
      displayTo: at(1),
    });
    expect((await methods.getCurrentBannerRecord())?.bannerId).toBe('window');
  });

  it('reads none when no window holds now', async () => {
    await banners().insertOne({
      bannerId: 'b',
      message: 'b',
      displayFrom: at(-3),
      displayTo: at(-2),
    });
    expect(await methods.getCurrentBannerRecord()).toBeNull();
    expect(await formerCurrentBanner()).toBeNull();
  });

  it('deletes the banner record by its id, and a gone one is a no-op', async () => {
    const keep = oid();
    const drop = oid();
    await banners().insertMany([
      { _id: keep, bannerId: 'keep', message: 'keep', displayFrom: at(-1) },
      { _id: drop, bannerId: 'drop', message: 'drop', displayFrom: at(-1) },
    ]);

    await methods.deleteBannerRecord(drop.toString());
    await methods.deleteBannerRecord(drop.toString());

    const left = await banners().find({}).toArray();
    expect(left.map((banner) => String(banner._id))).toEqual([keep.toString()]);
  });

  const fields = (message: string) => ({
    displayFrom: new Date('2024-01-01T00:00:00Z'),
    displayTo: null,
    message,
    bannerId: `id-${message}`,
    isPublic: true,
    persistable: false,
  });

  /** `update-banner`'s former write, verbatim. */
  const formerSave = async (values: ReturnType<typeof fields>) => {
    const Banner = mongoose.models.Banner;
    const existingBanner = await Banner.findOne();
    if (existingBanner) {
      return Banner.findByIdAndUpdate(existingBanner._id, values, { new: true });
    }
    return Banner.create(values);
  };

  /** The stored banners without their ids and timestamps, which differ between runs. */
  const storedBanners = async () =>
    (await banners().find({}).sort({ _id: 1 }).toArray()).map(
      ({ _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest }) => rest,
    );

  it('creates the banner record when there is none, as the former write did', async () => {
    const created = await methods.saveBanner(fields('first'));
    const mine = await storedBanners();

    await banners().deleteMany({});
    const formerCreated = await formerSave(fields('first'));
    const former = await storedBanners();

    expect(mine).toEqual(former);
    expect(mine).toHaveLength(1);
    expect(created).toMatchObject({ message: 'first', isPublic: true, type: 'banner' });
    const withoutRun = ({
      _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...rest
    }: Record<string, unknown>) => rest;
    expect(plain(withoutRun(created as never))).toEqual(
      plain(withoutRun(formerCreated?.toObject() as never)),
    );
  });

  it('replaces the first banner record found, leaving any other, as the former write did', async () => {
    const seed = () =>
      banners().insertMany([
        { bannerId: 'a', message: 'a', displayFrom: SEEDED, type: 'popup', isPublic: false },
        { bannerId: 'b', message: 'b', displayFrom: SEEDED },
      ]);

    await seed();
    const updated = await methods.saveBanner(fields('second'));
    const mine = await storedBanners();

    await banners().deleteMany({});
    await seed();
    await formerSave(fields('second'));
    const former = await storedBanners();

    expect(mine).toEqual(former);
    expect(mine).toHaveLength(2);
    expect(updated).toMatchObject({ message: 'second', bannerId: 'id-second', type: 'popup' });
    expect(updated?.displayTo).toBeNull();
  });
});

describe('balance credits', () => {
  const balances = () => mongoose.models.Balance.collection;

  /** `list-balances`' former read, verbatim. */
  const formerCredits = (userIds: mongoose.Types.ObjectId[]) =>
    mongoose.models.Balance.aggregate([
      { $match: { user: { $in: userIds } } },
      { $sort: { _id: 1 } },
      { $group: { _id: '$user', tokenCredits: { $first: '$tokenCredits' } } },
    ]);

  it("reads each listed user's oldest balance credits, as the former aggregation did", async () => {
    const [a, b, c, unlisted] = [oid(), oid(), oid(), oid()];
    await balances().insertMany([
      { _id: new mongoose.Types.ObjectId('64c000000000000000000001'), user: a, tokenCredits: 100 },
      { _id: new mongoose.Types.ObjectId('64c000000000000000000002'), user: a, tokenCredits: 999 },
      { user: b },
      { user: unlisted, tokenCredits: 5 },
    ]);

    const credits = await methods.findBalanceCreditsByUsers([a, b.toString(), c]);

    const byUser = (rows: Array<{ user: string; tokenCredits: number | null }>) =>
      [...rows].sort((x, y) => x.user.localeCompare(y.user));
    expect(byUser(credits)).toEqual(
      byUser([
        { user: a.toString(), tokenCredits: 100 },
        { user: b.toString(), tokenCredits: null },
      ]),
    );
    const former = await formerCredits([a, b, c]);
    expect(byUser(credits)).toEqual(
      byUser(former.map((row) => ({ user: String(row._id), tokenCredits: row.tokenCredits }))),
    );
  });

  it('reads none for no users', async () => {
    await balances().insertOne({ user: oid(), tokenCredits: 1 });
    expect(await methods.findBalanceCreditsByUsers([])).toEqual([]);
  });

  /** `set-balance`'s former write, verbatim. */
  const formerSet = async (user: mongoose.Types.ObjectId, amount: number | string) =>
    (await mongoose.models.Balance.findOneAndUpdate(
      { user },
      { tokenCredits: amount },
      { new: true, sort: { _id: 1 } },
    ).lean()) ??
    (await mongoose.models.Balance.findOneAndUpdate(
      { _id: user },
      { $set: { tokenCredits: amount }, $setOnInsert: { user } },
      { upsert: true, new: true },
    ).lean());

  /** The stored balances in insertion order; `lastRefill` only where seeded (else creation time). */
  const storedBalances = async () =>
    plain(
      (await balances().find({}).sort({ _id: 1 }).toArray()).map(({ lastRefill, ...rest }) => ({
        ...rest,
        lastRefill: rest.refillMode === 'reset' ? lastRefill : 'creation time',
      })),
    ) as Array<Record<string, unknown>>;

  it("sets the credits of the user's oldest balance only, as the former write did", async () => {
    const user = oid();
    const seed = () =>
      balances().insertMany([
        {
          _id: new mongoose.Types.ObjectId('64c000000000000000000001'),
          user,
          tokenCredits: 1,
          refillMode: 'reset',
          autoRefillEnabled: true,
          refillAmount: 50,
          refillIntervalValue: 1,
          refillIntervalUnit: 'days',
          lastRefill: new Date('2020-01-01T00:00:00Z'),
        },
        { _id: new mongoose.Types.ObjectId('64c000000000000000000002'), user, tokenCredits: 2 },
      ]);

    await seed();
    const set = await methods.setBalanceCredits(user.toString(), 777);
    const mine = await storedBalances();

    await balances().deleteMany({});
    await seed();
    const former = await formerSet(user, 777);

    expect(mine).toEqual(await storedBalances());
    expect(set?.tokenCredits).toBe(777);
    expect(String(set?._id)).toBe('64c000000000000000000001');
    expect(plain(set)).toEqual(plain(former));
  });

  it('creates a balance keyed by the user when there is none, as the former write did', async () => {
    const user = oid();
    const set = await methods.setBalanceCredits(user.toString(), 5);
    const mine = await storedBalances();

    await balances().deleteMany({});
    const former = await formerSet(user, 5);

    expect(mine).toEqual(await storedBalances());
    expect(mine).toEqual([
      expect.objectContaining({ _id: user.toString(), user: user.toString() }),
    ]);
    const withoutRefill = ({ lastRefill: _lastRefill, ...rest }: Record<string, unknown>) => rest;
    expect(plain(withoutRefill(set as never))).toEqual(plain(withoutRefill(former as never)));
  });

  it('casts the credits as the former write did (the script passes them as typed)', async () => {
    const user = oid();
    await balances().insertOne({ user, tokenCredits: 1 });

    const set = await methods.setBalanceCredits(user.toString(), '42' as unknown as number);

    expect(set?.tokenCredits).toBe(42);
    await expect(
      methods.setBalanceCredits(user.toString(), 'many' as unknown as number),
    ).rejects.toThrow(/Cast to Number failed/);
  });
});

describe('records per user', () => {
  /** `user-stats`' former count, verbatim, keyed as the script keyed it. */
  const formerCount = async (name: string) => {
    const rows = await mongoose.models[name].aggregate([
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map(({ _id, count }) => [String(_id), count]));
  };
  const keyed = (rows: Array<{ user: string | null; count: number }>) =>
    new Map(rows.map(({ user, count }) => [String(user), count]));

  it('counts the conversations of each user, as the former aggregation did', async () => {
    await mongoose.models.Conversation.collection.insertMany([
      { conversationId: 'c1', user: 'u1', endpoint: 'openAI' },
      { conversationId: 'c2', user: 'u1', endpoint: 'openAI' },
      { conversationId: 'c3', user: 'u2', endpoint: 'openAI' },
      { conversationId: 'c4', endpoint: 'openAI' },
    ]);

    const counts = await methods.countConvosByUser();

    expect(keyed(counts)).toEqual(
      new Map([
        ['u1', 2],
        ['u2', 1],
        ['null', 1],
      ]),
    );
    expect(counts).toContainEqual({ user: null, count: 1 });
    expect(keyed(counts)).toEqual(await formerCount('Conversation'));
  });

  it('counts the messages of each user, as the former aggregation did', async () => {
    const message = (messageId: string, user?: string) => ({
      messageId,
      conversationId: 'c1',
      ...(user != null ? { user } : {}),
    });
    await mongoose.models.Message.collection.insertMany([
      message('m1', 'u1'),
      message('m2', 'u2'),
      message('m3', 'u2'),
      message('m4', 'u2'),
    ]);

    const counts = await methods.countMessagesByUser();

    expect(keyed(counts)).toEqual(
      new Map([
        ['u1', 1],
        ['u2', 3],
      ]),
    );
    expect(keyed(counts)).toEqual(await formerCount('Message'));
  });

  it('counts none in an empty collection', async () => {
    expect(await methods.countConvosByUser()).toEqual([]);
    expect(await methods.countMessagesByUser()).toEqual([]);
  });
});

describe('seeded records', () => {
  const messageRecords = (conversationId: string) => [
    {
      messageId: `${conversationId}-1`,
      conversationId,
      user: 'u1',
      text: 'prompt',
      isCreatedByUser: true,
      error: false,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    },
    {
      messageId: `${conversationId}-2`,
      conversationId,
      user: 'u1',
      text: 'failure',
      isCreatedByUser: false,
      error: true,
      createdAt: new Date('2024-01-01T00:00:01Z'),
      updatedAt: new Date('2024-01-01T00:00:01Z'),
    },
  ];
  /** The stored messages without their ids, which differ between runs. */
  const storedMessages = async () =>
    plain(
      (await mongoose.models.Message.collection.find({}).sort({ messageId: 1 }).toArray()).map(
        ({ _id, ...rest }) => rest,
      ),
    );

  it('inserts message records as given, their timestamps kept, as the former write did', async () => {
    await methods.insertMessageRecords(messageRecords('c1'));
    const mine = await storedMessages();

    await mongoose.models.Message.collection.deleteMany({});
    await mongoose.models.Message.insertMany(messageRecords('c1'), { timestamps: false } as never);

    expect(mine).toEqual(await storedMessages());
    expect(mine[0]).toMatchObject({ createdAt: '2024-01-01T00:00:00.000Z', __v: 0 });
  });

  it('rejects message records that cannot be stored, as the former write did', async () => {
    const invalid = [{ conversationId: 'c1', user: 'u1' }];
    await expect(methods.insertMessageRecords(invalid)).rejects.toThrow(/messageId/);
    await expect(
      mongoose.models.Message.insertMany(invalid, { timestamps: false } as never),
    ).rejects.toThrow(/messageId/);
  });

  it('creates a conversation record as given, with timestamps, as the former write did', async () => {
    const record = {
      conversationId: 'c1',
      user: 'u1',
      title: 'Gallery',
      endpoint: 'openAI',
      model: 'gpt-4o',
      isArchived: false,
    };
    /** The stored conversation without the fields that differ between runs. */
    const stored = async () => {
      const [doc] = await mongoose.models.Conversation.collection.find({}).toArray();
      const { _id, createdAt, updatedAt, ...rest } = doc;
      expect(createdAt).toBeInstanceOf(Date);
      expect(updatedAt).toBeInstanceOf(Date);
      return plain(rest);
    };

    await methods.createConvoRecord(record);
    const mine = await stored();

    await mongoose.models.Conversation.collection.deleteMany({});
    await mongoose.models.Conversation.create(record);

    expect(mine).toEqual(await stored());
    expect(mine).toMatchObject(record);
  });
});

import mongoose, { Mongoose } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { KeyValueStore } from '~/ports/keyValueStore';
import { KEY_VALUE_STORE_METHODS } from '~/ports/keyValueStore';
import { createMongoKeyValueStore } from './keyValueStore';
import { createMongoDataStoreBackend } from './backend';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

function collection(name: string) {
  return mongoose.connection.db!.collection(name);
}

async function indexNames(name: string): Promise<string[]> {
  return (await collection(name).indexes()).map((index) => index.name ?? '');
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('MongoDB key-value store', () => {
  it('has every port method, each listed once, and is served by the backend', () => {
    const store = createMongoDataStoreBackend(mongoose).createKeyValueStore({ name: 'kv_methods' });
    expect(Object.keys(store).sort()).toEqual([...KEY_VALUE_STORE_METHODS].sort());
    expect(new Set(KEY_VALUE_STORE_METHODS).size).toBe(KEY_VALUE_STORE_METHODS.length);
  });

  it('rejects before the connection is open, without reporting an error', async () => {
    const onError = jest.fn();
    const store = createMongoKeyValueStore(new Mongoose(), { name: 'kv', onError });
    await expect(store.get('a')).rejects.toThrow(
      'Mongoose connection not ready. Ensure connectDb() is called first.',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports an error opening the store before rejecting with it', async () => {
    const onError = jest.fn();
    const noDatabase = { connection: { readyState: 1, db: undefined } } as unknown as Mongoose;
    const store = createMongoKeyValueStore(noDatabase, { name: 'kv', onError });
    await expect(store.set('a', 'b')).rejects.toThrow('MongoDB database not available');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });

  describe('in a collection', () => {
    let store: KeyValueStore;

    beforeAll(() => {
      store = createMongoKeyValueStore(mongoose, { name: 'kv_entries' });
    });

    beforeEach(async () => {
      await collection('kv_entries').deleteMany({});
    });

    it('stores one document per key, stamping expiresAt from the ttl', async () => {
      const before = Date.now();
      await store.set('ns:a', 'one', 60_000);
      await store.set('ns:b', 'two');
      await store.set('ns:a', 'uno', 60_000);

      expect(await store.get('ns:a')).toBe('uno');
      expect(await store.get('ns:b')).toBe('two');
      expect(await store.get('ns:missing')).toBeUndefined();

      const docs = await collection('kv_entries').find({}).sort({ key: 1 }).toArray();
      expect(docs.map(({ key, value }) => ({ key, value }))).toEqual([
        { key: 'ns:a', value: 'uno' },
        { key: 'ns:b', value: 'two' },
      ]);
      expect((docs[0].expiresAt as Date).getTime()).toBeGreaterThanOrEqual(before + 60_000);
      expect(docs[1].expiresAt).toBeNull();
    });

    it('indexes the collection by key and expires entries through a TTL index', async () => {
      await store.set('k', 'v');
      await waitFor(async () => (await indexNames('kv_entries')).includes('expiresAt_1'));
      const indexes = await collection('kv_entries').indexes();
      expect(indexes.find((index) => index.name === 'key_1')?.key).toEqual({ key: 1 });
      expect(indexes.find((index) => index.name === 'expiresAt_1')?.expireAfterSeconds).toBe(0);
    });

    it('reads many keys in order, deletes and checks keys', async () => {
      await store.set('a', '1');
      await store.set('c', '3');
      expect(await store.getMany(['c', 'b', 'a'])).toEqual(['3', undefined, '1']);
      expect(await store.has('a')).toBe(true);
      expect(await store.has('b')).toBe(false);
      expect(await store.delete('a')).toBe(true);
      expect(await store.delete('a')).toBe(false);
      expect(await store.deleteMany(['b', 'c'])).toBe(true);
      expect(await store.deleteMany(['b', 'c'])).toBe(false);
    });

    it('clears the keys starting with the namespace, or every key', async () => {
      await store.set('bans:1', 'x');
      await store.set('bansx:2', 'x');
      await store.set('other:3', 'x');
      await store.clear('bans');
      expect(await store.getMany(['bans:1', 'bansx:2', 'other:3'])).toEqual([
        undefined,
        undefined,
        'x',
      ]);
      await store.clear();
      expect(await collection('kv_entries').countDocuments({})).toBe(0);
    });

    it('shares entries with every store of the same name', async () => {
      const other = createMongoKeyValueStore(mongoose, { name: 'kv_entries' });
      await store.set('shared', 'yes');
      expect(await other.get('shared')).toBe('yes');
    });
  });

  it('builds no index when the connection disables auto indexing', async () => {
    const unindexed = new Mongoose();
    await unindexed.connect(mongo.getUri(), { autoIndex: false });
    try {
      const store = createMongoKeyValueStore(unindexed, { name: 'kv_unindexed' });
      await store.set('k', 'v');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await indexNames('kv_unindexed')).toEqual(['_id_']);
    } finally {
      await unindexed.disconnect();
    }
  });

  describe('with large values', () => {
    let store: KeyValueStore;

    beforeAll(() => {
      store = createMongoKeyValueStore(mongoose, { name: 'kv_large', largeValues: true });
    });

    it('keeps each value as a GridFS file in the bucket named after the store', async () => {
      const value = 'x'.repeat(300_000);
      await store.set('big', value, 60_000);
      expect(await store.get('big')).toBe(value);
      expect(await store.get('absent')).toBeUndefined();
      expect(await store.getMany(['big', 'absent'])).toEqual([value, undefined]);
      expect(await store.has('big')).toBe(true);

      const file = await collection('kv_large.files').findOne({ filename: 'big' });
      expect(file?.metadata?.expiresAt).toBeInstanceOf(Date);
      expect(file?.metadata?.lastAccessed).toBeInstanceOf(Date);
    });

    it('deletes files by key and clears the bucket', async () => {
      await store.set('one', 'a');
      await store.set('two', 'b');
      expect(await store.delete('one')).toBe(true);
      expect(await store.delete('one')).toBe(true);
      expect(await store.has('one')).toBe(false);
      expect(await store.deleteMany(['one'])).toBe(false);
      expect(await store.deleteMany(['two'])).toBe(true);

      await store.set('three', 'c');
      await store.clear('ignored');
      expect(await store.has('three')).toBe(false);
      await expect(store.clear()).resolves.toBeUndefined();
    });
  });
});

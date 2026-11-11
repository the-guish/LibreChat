/**
 * The MongoDB key-value store (`~/ports/keyValueStore`), moved from `keyvMongo` in
 * `@librechat/api`: one document per entry (`{ key, value, expiresAt }`) in the collection named
 * after the store, indexed by `key` and with a TTL index on `expiresAt`, or with `largeValues`
 * one GridFS file per entry in the bucket named after the store.
 *
 * It uses the database of the given mongoose's default connection, which must be connected
 * before the first operation (the store never connects or closes it). Each opened collection
 * or bucket is kept per mongoose instance and store name, so every store of that name shares
 * it, and its indexes are requested once.
 */
import type { Mongoose, mongo } from 'mongoose';
import type { KeyValueStore, KeyValueStoreOptions } from '~/ports/keyValueStore';
import { buildIndexWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

/** The MongoDB store's options: the port's, plus the GridFS bucket's read preference. */
export interface MongoKeyValueStoreOptions extends KeyValueStoreOptions {
  readPreference?: mongo.ReadPreference;
}

interface GridFSClient {
  bucket: mongo.GridFSBucket;
  store: mongo.Collection;
  db: mongo.Db;
}

interface CollectionClient {
  store: mongo.Collection;
  db: mongo.Db;
}

type Client = GridFSClient | CollectionClient;

const clientsByMongoose = new WeakMap<Mongoose, Map<string, Client>>();

function isGridFSClient(client: Client): client is GridFSClient {
  return (client as GridFSClient).bucket != null;
}

/** A key-value store on `mongoose`'s default connection; see the module header. */
export function createMongoKeyValueStore(
  mongoose: Mongoose,
  options: MongoKeyValueStoreOptions,
): KeyValueStore {
  const { name, largeValues, readPreference, onError } = options;

  let storeMap = clientsByMongoose.get(mongoose);
  if (!storeMap) {
    storeMap = new Map();
    clientsByMongoose.set(mongoose, storeMap);
  }
  const clients = storeMap;

  async function getClient(): Promise<Client> {
    const storeKey = `${name}:${largeValues ? 'gridfs' : 'collection'}`;

    const existing = clients.get(storeKey);
    if (existing) {
      return existing;
    }

    if (mongoose.connection.readyState !== 1) {
      throw new Error('Mongoose connection not ready. Ensure connectDb() is called first.');
    }

    try {
      const db = mongoose.connection.db as unknown as mongo.Db | undefined;
      if (!db) {
        throw new Error('MongoDB database not available');
      }

      let client: Client;

      if (largeValues) {
        const bucket = new mongoose.mongo.GridFSBucket(db, {
          readPreference,
          bucketName: name,
        });
        const store = db.collection(`${name}.files`);
        client = { bucket, store, db };
      } else {
        const collection = name || 'keyv';
        const store = db.collection(collection);
        client = { store, db };
        /** Every read and upsert filters on `key`; unindexed, each one scans the collection.
         *  Built in the background, and skipped when the deployment disables auto indexing. */
        if (mongoose.connection.config?.autoIndex !== false) {
          buildIndexWithRetry(
            () => store.createIndex({ key: 1 }),
            `KeyvMongo "${collection}" key index`,
          ).catch((error: unknown) => {
            logger.warn(`[KeyvMongo] Could not index "${collection}" by key`, error);
          });
          /** `set` stamps `expiresAt` from the ttl (null when there is none, which a TTL index
           *  ignores), so entries Keyv already treats as expired are also removed from disk. */
          buildIndexWithRetry(
            () => store.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
            `KeyvMongo "${collection}" expiry index`,
          ).catch((error: unknown) => {
            logger.warn(`[KeyvMongo] Could not add expiry index to "${collection}"`, error);
          });
        }
      }

      clients.set(storeKey, client);
      return client;
    } catch (error) {
      onError?.(error);
      throw error;
    }
  }

  const store: KeyValueStore = {
    async get(key) {
      const client = await getClient();

      if (largeValues && isGridFSClient(client)) {
        await client.store.updateOne(
          {
            filename: key,
          },
          {
            $set: {
              'metadata.lastAccessed': new Date(),
            },
          },
        );

        const stream = client.bucket.openDownloadStreamByName(key);

        return new Promise<string | undefined>((resolve) => {
          const resp: Uint8Array[] = [];
          stream.on('error', () => {
            resolve(undefined);
          });

          stream.on('end', () => {
            const data = Buffer.concat(resp).toString('utf8');
            resolve(data);
          });

          stream.on('data', (chunk: Uint8Array) => {
            resp.push(chunk);
          });
        });
      }

      const document = await client.store.findOne({ key: { $eq: key } });

      if (!document) {
        return undefined;
      }

      return document.value;
    },

    async getMany(keys) {
      const client = await getClient();

      if (largeValues) {
        const promises = [];
        for (const key of keys) {
          promises.push(store.get(key));
        }

        const values = await Promise.allSettled(promises);
        const data: Array<string | undefined> = [];
        for (const value of values) {
          data.push(value.status === 'fulfilled' ? value.value : undefined);
        }

        return data;
      }

      const values = await client.store
        .find({ key: { $in: keys } })
        .project({ _id: 0, value: 1, key: 1 })
        .toArray();

      const results: Array<string | undefined> = [...keys];
      let i = 0;
      for (const key of keys) {
        const rowIndex = values.findIndex((row) => row.key === key);
        results[i] = rowIndex > -1 ? values[rowIndex].value : undefined;
        i++;
      }

      return results;
    },

    async set(key, value, ttl) {
      const client = await getClient();
      const expiresAt = typeof ttl === 'number' ? new Date(Date.now() + ttl) : null;

      if (largeValues && isGridFSClient(client)) {
        const stream = client.bucket.openUploadStream(key, {
          metadata: {
            expiresAt,
            lastAccessed: new Date(),
          },
        });

        return new Promise((resolve) => {
          stream.on('finish', () => {
            resolve(stream);
          });
          stream.end(value);
        });
      }

      await client.store.updateOne(
        { key: { $eq: key } },
        { $set: { key, value, expiresAt } },
        { upsert: true },
      );
    },

    async delete(key) {
      const client = await getClient();

      if (largeValues && isGridFSClient(client)) {
        try {
          const bucket = new mongoose.mongo.GridFSBucket(client.db, {
            bucketName: name,
          });
          const files = await bucket.find({ filename: key }).toArray();
          if (files.length > 0) {
            await client.bucket.delete(files[0]._id);
          }
          return true;
        } catch {
          return false;
        }
      }

      const object = await client.store.deleteOne({ key: { $eq: key } });
      return object.deletedCount > 0;
    },

    async deleteMany(keys) {
      const client = await getClient();

      if (largeValues && isGridFSClient(client)) {
        const bucket = new mongoose.mongo.GridFSBucket(client.db, {
          bucketName: name,
        });
        const files = await bucket.find({ filename: { $in: keys } }).toArray();
        if (files.length === 0) {
          return false;
        }

        await Promise.all(files.map(async (file) => client.bucket.delete(file._id)));
        return true;
      }

      const object = await client.store.deleteMany({ key: { $in: keys } });
      return object.deletedCount > 0;
    },

    async clear(namespace) {
      const client = await getClient();

      if (largeValues && isGridFSClient(client)) {
        try {
          await client.bucket.drop();
        } catch (error: unknown) {
          // Throw error if not "namespace not found" error
          const errorCode =
            error instanceof Error && 'code' in error
              ? (error as { code?: number }).code
              : undefined;
          if (errorCode !== 26) {
            throw error;
          }
        }
      }

      await client.store.deleteMany({
        key: { $regex: namespace ? `^${namespace}:*` : '' },
      });
    },

    async has(key) {
      const client = await getClient();
      const filter = { [largeValues ? 'filename' : 'key']: { $eq: key } };
      const document = await client.store.countDocuments(filter, { limit: 1 });
      return document !== 0;
    },
  };

  return store;
}

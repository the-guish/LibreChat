/**
 * The MongoDB `ContractHarness` (`~/contracts/harness`; docs/postgres-port/PHASE4.md §7): the
 * contract suites' view of the MongoDB backend, on the server `engine` provides
 * (mongodb-memory-server in the specs).
 *
 * - The stores are `createMethods(mongoose, deps).stores` on `mongoose` (the default instance
 *   unless one is given), with every model registered (`createModels`).
 * - `seedRaw` is a driver insert of each record cast by its collection's model (when the
 *   collection has one), declared top-level fields only: undeclared fields, and fields whose
 *   value the schema cannot cast, are inserted as given. No defaults, validators, setters,
 *   hooks or tenant scoping, as with the PostgreSQL raw mode (§3.2).
 * - `readRaw` reads with the driver and converts ObjectIds to their hex strings and BSON
 *   binaries to `Buffer`s, so a suite compares the same values on both backends.
 */
import defaultMongoose from 'mongoose';
import type { Mongoose, Model } from 'mongoose';
import type { ContractHarness, RawRecord } from '~/contracts/harness';
import type { CreateMethodsDeps } from '~/compose/types';
import { mongoStoreIds } from './storeIds';
import { createMethods } from '~/methods';
import { createModels } from '~/models';

/** The server a harness runs on. */
export interface MongoContractEngine {
  /** Starts or locates the server and returns its connection URI. */
  connect(): Promise<string>;
  /** Releases the server once the harness has disconnected from it. */
  release(): Promise<void>;
}

/** Converts what the driver read into canonical form (ids as hex, binaries as Buffers). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  const bson = value as { _bsontype?: unknown; toHexString?: () => string; buffer?: unknown };
  if (bson._bsontype === 'ObjectId' && typeof bson.toHexString === 'function') {
    return bson.toHexString();
  }
  if (bson._bsontype === 'Binary' && bson.buffer instanceof Uint8Array) {
    const binary = value as { buffer: Uint8Array; position?: number };
    return Buffer.from(binary.buffer.subarray(0, binary.position ?? binary.buffer.length));
  }
  const result: RawRecord = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = canonical(item);
  }
  return result;
}

/**
 * `record` with its declared top-level fields cast by `model` (`Model.castObject`); a field the
 * schema does not declare, or whose value it cannot cast, is kept as given. Key order is kept.
 */
function castRaw(model: Model<unknown>, record: RawRecord): RawRecord {
  const declared = (key: string) => model.schema.pathType(key) !== 'adhocOrUndefined';
  const uncastable = new Set<string>();
  let cast: RawRecord | undefined;
  for (let attempt = 0; attempt <= Object.keys(record).length && !cast; attempt++) {
    const input: RawRecord = {};
    for (const [key, value] of Object.entries(record)) {
      if (declared(key) && !uncastable.has(key)) {
        input[key] = value;
      }
    }
    try {
      cast = model.castObject(input) as RawRecord;
    } catch (error) {
      const failed = Object.keys((error as { errors?: object }).errors ?? {});
      if (failed.length === 0) {
        throw error;
      }
      for (const path of failed) {
        uncastable.add(path.split('.')[0]);
      }
    }
  }
  const result: RawRecord = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = cast && declared(key) && !uncastable.has(key) && key in cast ? cast[key] : value;
  }
  return result;
}

/** The MongoDB contract harness on `mongoose` (the default instance unless given). */
export function createMongoContractHarness(
  engine: MongoContractEngine,
  mongoose: Mongoose = defaultMongoose,
): ContractHarness {
  const db = () => {
    const database = mongoose.connection.db;
    if (!database) {
      throw new Error('The MongoDB contract harness is not set up');
    }
    return database;
  };
  const modelOf = (collection: string): Model<unknown> | undefined =>
    Object.values(mongoose.models).find(
      // eslint-disable-next-line no-restricted-syntax -- reads the collection's name only
      (model) => model.collection.collectionName === collection,
    ) as Model<unknown> | undefined;

  return {
    name: 'mongo',
    ids: mongoStoreIds,

    async setup() {
      await mongoose.connect(await engine.connect());
      createModels(mongoose);
    },

    async teardown() {
      await mongoose.disconnect();
      await engine.release();
    },

    createStores: (deps?: CreateMethodsDeps) => createMethods(mongoose, deps).stores,

    async reset() {
      const collections = await db().collections();
      await Promise.all(collections.map((collection) => collection.deleteMany({})));
    },

    async seedRaw(collection, records) {
      if (records.length === 0) {
        return;
      }
      const model = modelOf(collection);
      const documents = records.map((record) => (model ? castRaw(model, record) : { ...record }));
      await db().collection(collection).insertMany(documents);
    },

    async readRaw(collection) {
      const documents = await db().collection(collection).find({}).sort({ _id: 1 }).toArray();
      return documents.map((document) => canonical(document) as RawRecord);
    },
  };
}

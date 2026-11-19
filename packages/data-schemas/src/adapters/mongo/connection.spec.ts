import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { DataStoreQueryObservation } from '~/ports/connection';
import type { MongoConnectionCache } from './connection';
import {
  instrumentMongooseQueries,
  toMongooseConnectOptions,
  readMongoConnectionSettings,
  createMongoDataStoreConnection,
} from './connection';
import { createMongoDataStoreBackend } from './backend';
import { getDataStoreBackend } from '../backend';
import logger from '~/config/winston';

describe('readMongoConnectionSettings / toMongooseConnectOptions', () => {
  it('throws without MONGO_URI', () => {
    expect(() => readMongoConnectionSettings({})).toThrow(
      'Please define the MONGO_URI environment variable',
    );
  });

  it('passes only bufferCommands when nothing else is set', () => {
    const settings = readMongoConnectionSettings({ MONGO_URI: 'mongodb://h/db' });
    expect(settings.uri).toBe('mongodb://h/db');
    expect(toMongooseConnectOptions(settings)).toEqual({ bufferCommands: false });
  });

  it('reads the pool and index variables as connectDb always has', () => {
    const settings = readMongoConnectionSettings({
      MONGO_URI: 'mongodb://h/db',
      MONGO_MAX_POOL_SIZE: '20',
      MONGO_MIN_POOL_SIZE: '2',
      MONGO_MAX_CONNECTING: '3',
      MONGO_MAX_IDLE_TIME_MS: '1000',
      MONGO_WAIT_QUEUE_TIMEOUT_MS: '500',
      MONGO_AUTO_INDEX: 'false',
      MONGO_AUTO_CREATE: ' TRUE ',
    });
    expect(toMongooseConnectOptions(settings)).toEqual({
      bufferCommands: false,
      maxPoolSize: 20,
      minPoolSize: 2,
      maxConnecting: 3,
      maxIdleTimeMS: 1000,
      waitQueueTimeoutMS: 500,
      autoIndex: false,
      autoCreate: true,
    });
  });

  it('leaves out pool values that are not positive numbers and blank flags', () => {
    const settings = readMongoConnectionSettings({
      MONGO_URI: 'mongodb://h/db',
      MONGO_MAX_POOL_SIZE: 'abc',
      MONGO_MIN_POOL_SIZE: '0',
      MONGO_AUTO_INDEX: '  ',
      MONGO_AUTO_CREATE: 'yes',
    });
    expect(toMongooseConnectOptions(settings)).toEqual({
      bufferCommands: false,
      autoCreate: false,
    });
  });
});

describe('instrumentMongooseQueries', () => {
  class SuccessQuery {
    model = { modelName: 'User' };
    op = 'findOne';
    exec(): unknown {
      return Promise.resolve({ _id: 'user-1' });
    }
  }

  it('reports successful, rejected and throwing queries once each', async () => {
    const observations: DataStoreQueryObservation[] = [];
    instrumentMongooseQueries({ Query: SuccessQuery }, (o) => observations.push(o));
    await expect(new SuccessQuery().exec()).resolves.toEqual({ _id: 'user-1' });

    class RejectingQuery {
      model = undefined;
      op = 'updateOne';
      exec(): unknown {
        return Promise.reject(new Error('rejected'));
      }
    }
    instrumentMongooseQueries({ Query: RejectingQuery }, (o) => observations.push(o));
    await expect(new RejectingQuery().exec()).rejects.toThrow('rejected');

    class ThrowingQuery {
      model = { modelName: 'Message' };
      op = 'find';
      exec(): unknown {
        throw new Error('sync');
      }
    }
    instrumentMongooseQueries({ Query: ThrowingQuery }, (o) => observations.push(o));
    expect(() => new ThrowingQuery().exec()).toThrow('sync');

    expect(observations.map(({ durationSeconds: _d, ...rest }) => rest)).toEqual([
      { model: 'User', operation: 'findOne', status: 'success' },
      { model: undefined, operation: 'updateOne', status: 'error' },
      { model: 'Message', operation: 'find', status: 'error' },
    ]);
    for (const { durationSeconds } of observations) {
      expect(durationSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it('patches a prototype once', async () => {
    const first = jest.fn();
    const second = jest.fn();
    class Query {
      exec(): unknown {
        return Promise.resolve(1);
      }
    }
    instrumentMongooseQueries({ Query }, first);
    const patched = Query.prototype.exec;
    instrumentMongooseQueries({ Query }, second);
    expect(Query.prototype.exec).toBe(patched);
    await new Query().exec();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('does nothing without a query prototype', () => {
    expect(() => instrumentMongooseQueries({}, jest.fn())).not.toThrow();
  });
});

describe('createMongoDataStoreConnection', () => {
  let server: MongoMemoryServer;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('throws without MONGO_URI before touching the connection', () => {
    expect(() =>
      createMongoDataStoreConnection(mongoose, { env: {}, cache: { conn: null, promise: null } }),
    ).toThrow('Please define the MONGO_URI environment variable');
  });

  it('installs query instrumentation before the URI check', () => {
    const Query = class {
      exec(): unknown {
        return undefined;
      }
    };
    const original = Query.prototype.exec;
    expect(() =>
      createMongoDataStoreConnection({ Query } as unknown as typeof mongoose, {
        env: {},
        observeQueries: jest.fn(),
      }),
    ).toThrow('Please define the MONGO_URI environment variable');
    expect(Query.prototype.exec).not.toBe(original);
  });

  it('connects, caches, reports health and closes', async () => {
    const cache: MongoConnectionCache = { conn: null, promise: null };
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const connection = createMongoDataStoreConnection(mongoose, {
      env: { MONGO_URI: server.getUri(), MONGO_MAX_POOL_SIZE: '7' },
      cache,
    });

    expect(connection.getState()).toBe('disconnected');
    expect(connection.isConnected()).toBe(false);
    await expect(connection.health()).resolves.toEqual({ ok: false, state: 'disconnected' });

    const handle = await connection.connect();
    expect(handle).toBe(mongoose);
    expect(cache.conn).toBe(mongoose);
    expect(mongoose.get('strictQuery')).toBe(true);
    expect(info).toHaveBeenCalledWith('Mongo Connection options');
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({ bufferCommands: false, maxPoolSize: 7 }, null, 2),
    );
    expect(connection.getState()).toBe('connected');
    expect(connection.isConnected()).toBe(true);

    const health = await connection.health();
    expect(health.ok).toBe(true);
    expect(health.state).toBe('connected');
    expect(typeof health.latencyMs).toBe('number');

    await expect(connection.connect()).resolves.toBe(mongoose);

    await connection.close();
    expect(connection.getState()).toBe('disconnected');
    await expect(connection.connect()).resolves.toBe(mongoose);
    expect(connection.isConnected()).toBe(true);
    info.mockRestore();
  });

  it('logs connection errors as connectDb always has', () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    createMongoDataStoreConnection(mongoose, {
      env: { MONGO_URI: server.getUri() },
      cache: { conn: null, promise: null },
    });
    const failure = new Error('boom');
    mongoose.connection.emit('error', failure);
    expect(error).toHaveBeenCalledWith('[connectDb] MongoDB connection error:', failure);
    error.mockRestore();
  });

  it('uses global.mongoose as the cache by default', () => {
    const holder = globalThis as { mongoose?: MongoConnectionCache };
    delete holder.mongoose;
    createMongoDataStoreConnection(mongoose, { env: { MONGO_URI: server.getUri() } });
    expect(holder.mongoose).toEqual({ conn: null, promise: null });
    const kept = holder.mongoose;
    createMongoDataStoreConnection(mongoose, { env: { MONGO_URI: server.getUri() } });
    expect(holder.mongoose).toBe(kept);
  });
});

describe('MongoDB data store backend', () => {
  it('is the process backend, created once', () => {
    expect(getDataStoreBackend()).toBe(getDataStoreBackend());
    expect(getDataStoreBackend().name).toBe('mongo');
  });

  it('registers the models and builds the methods on its mongoose instance', () => {
    const backend = createMongoDataStoreBackend(mongoose);
    const models = backend.registerModels();
    expect(models.Message).toBe(mongoose.models.Message);
    expect(models.Conversation).toBe(mongoose.models.Conversation);
    const methods = backend.createMethods();
    expect(typeof methods.stores.conversations.getConvo).toBe('function');
  });
});

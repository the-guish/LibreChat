import type { Mongoose } from 'mongoose';
import type {
  DataStoreHealth,
  DataStoreConnection,
  DataStoreQueryObserver,
  DataStoreConnectionState,
  DataStoreConnectionOptions,
} from '~/ports/connection';
import logger from '~/config/winston';

/** The connection options read from the `MONGO_*` variables; unset ones are left out. */
export interface MongoConnectionSettings {
  uri: string;
  /** The maximum number of connections in the connection pool. */
  maxPoolSize?: number;
  /** The minimum number of connections in the connection pool. */
  minPoolSize?: number;
  /** The maximum number of connections that may be in the process of being established concurrently by the connection pool. */
  maxConnecting?: number;
  /** The maximum number of milliseconds that a connection can remain idle in the pool before being removed and closed. */
  maxIdleTimeMS?: number;
  /** The maximum time in milliseconds that a thread can wait for a connection to become available. */
  waitQueueTimeoutMS?: number;
  /** Set to false to disable automatic index creation for all models associated with this connection. */
  autoIndex?: boolean;
  /** Set to `false` to disable Mongoose automatically calling `createCollection()` on every model created on this connection. */
  autoCreate?: boolean;
}

/**
 * The connection cached across hot reloads in development (`global.mongoose`), which keeps
 * connections from growing during API route use. `conn` is the connected mongoose instance.
 */
export interface MongoConnectionCache {
  conn: Mongoose | null;
  promise: Promise<Mongoose> | null;
}

/** The MongoDB adapter for `DataStoreConnection`; `connect` resolves to the mongoose instance. */
export type MongoDataStoreConnection = DataStoreConnection<Mongoose>;

/** The part of a mongoose instance the query instrumentation patches. */
export interface MongooseQueryHost {
  Query?: { prototype: object };
}

const MISSING_URI_MESSAGE = 'Please define the MONGO_URI environment variable';

/** Whether a variable is set, as `optionalEnabled` in `@librechat/api` reads it. */
function optionalEnabled(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.toLowerCase().trim() === 'true';
}

/**
 * Reads the connection settings from the `MONGO_*` variables. Throws when `MONGO_URI` is not
 * set; a pool variable that is unset, not a number or `0` is left out.
 */
export function readMongoConnectionSettings(
  env: Readonly<Record<string, string | undefined>>,
): MongoConnectionSettings {
  const uri = env.MONGO_URI;
  if (!uri) {
    throw new Error(MISSING_URI_MESSAGE);
  }
  return {
    uri,
    maxPoolSize: parseInt(env.MONGO_MAX_POOL_SIZE as string) || undefined,
    minPoolSize: parseInt(env.MONGO_MIN_POOL_SIZE as string) || undefined,
    maxConnecting: parseInt(env.MONGO_MAX_CONNECTING as string) || undefined,
    maxIdleTimeMS: parseInt(env.MONGO_MAX_IDLE_TIME_MS as string) || undefined,
    waitQueueTimeoutMS: parseInt(env.MONGO_WAIT_QUEUE_TIMEOUT_MS as string) || undefined,
    autoIndex: optionalEnabled(env.MONGO_AUTO_INDEX),
    autoCreate: optionalEnabled(env.MONGO_AUTO_CREATE),
  };
}

/** The options `mongoose.connect` is called with: only the settings that are set. */
export function toMongooseConnectOptions(
  settings: MongoConnectionSettings,
): Record<string, number | boolean> {
  const { maxPoolSize, minPoolSize, maxConnecting, maxIdleTimeMS, waitQueueTimeoutMS } = settings;
  const { autoIndex, autoCreate } = settings;
  return {
    bufferCommands: false,
    ...(maxPoolSize ? { maxPoolSize } : {}),
    ...(minPoolSize ? { minPoolSize } : {}),
    ...(maxConnecting ? { maxConnecting } : {}),
    ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
    ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
    ...(autoIndex != undefined ? { autoIndex } : {}),
    ...(autoCreate != undefined ? { autoCreate } : {}),
  };
}

const QUERY_INSTRUMENTED = Symbol.for('librechat.mongooseQueryMetrics.instrumented');

const getElapsedSeconds = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;

const labelOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Reports every query `exec` of `mongoose` to `observer`: model name, operation, outcome and
 * duration, including errors thrown before a promise is returned. Patches
 * `mongoose.Query.prototype.exec` once per prototype; later calls change nothing.
 */
export function instrumentMongooseQueries(
  mongoose: MongooseQueryHost,
  observer: DataStoreQueryObserver,
): void {
  type ExecContext = { model?: { modelName?: unknown }; op?: unknown };
  type Exec = (this: ExecContext, ...args: unknown[]) => unknown;
  const queryPrototype = mongoose.Query?.prototype as
    | { exec: Exec; [QUERY_INSTRUMENTED]?: boolean }
    | undefined;

  if (!queryPrototype || queryPrototype[QUERY_INSTRUMENTED]) return;

  const originalExec = queryPrototype.exec;
  queryPrototype.exec = function instrumentedExec(this: ExecContext, ...args: unknown[]) {
    const startedAt = process.hrtime.bigint();
    const model = labelOf(this.model?.modelName);
    const operation = labelOf(this.op);
    const report = (status: 'success' | 'error') =>
      observer({ model, operation, status, durationSeconds: getElapsedSeconds(startedAt) });

    let result: unknown;
    try {
      result = originalExec.apply(this, args);
    } catch (error) {
      report('error');
      throw error;
    }

    return Promise.resolve(result).then(
      (value) => {
        report('success');
        return value;
      },
      (error) => {
        report('error');
        throw error;
      },
    );
  };
  queryPrototype[QUERY_INSTRUMENTED] = true;
}

/** mongoose's `readyState` codes. */
const READY_STATES: Record<number, DataStoreConnectionState> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

function getGlobalConnectionCache(): MongoConnectionCache {
  const holder = globalThis as { mongoose?: MongoConnectionCache };
  if (!holder.mongoose) {
    holder.mongoose = { conn: null, promise: null };
  }
  return holder.mongoose;
}

/**
 * The MongoDB connection, in the order the server has always set it up: query instrumentation
 * (when `observeQueries` is given), the `MONGO_URI` check (throws), the settings, the
 * connection cache (`global.mongoose` unless `cache` is given) and the connection error logger.
 * `connect` sets `strictQuery` and connects with `bufferCommands: false` and the pool settings
 * that are set, logging them first.
 */
export function createMongoDataStoreConnection(
  mongoose: Mongoose,
  options: DataStoreConnectionOptions & { cache?: MongoConnectionCache },
): MongoDataStoreConnection {
  if (options.observeQueries) {
    instrumentMongooseQueries(mongoose, options.observeQueries);
  }

  const settings = readMongoConnectionSettings(options.env);
  const cached = options.cache ?? getGlobalConnectionCache();

  mongoose.connection.on('error', (err) => {
    logger.error('[connectDb] MongoDB connection error:', err);
  });

  /**
   * As `connectDb` has always done. `_readyState` is a field of mongoose's `Connection`, not of
   * the mongoose instance cached in `conn`, so a cached instance never counts as ready here and
   * every call after the first calls `mongoose.connect` again (mongoose resolves it at once
   * while the connection is open); kept as is, since changing it changes connection behavior.
   */
  async function connect(): Promise<Mongoose> {
    const conn = cached.conn as (Mongoose & { _readyState?: number }) | null;
    if (conn && conn?._readyState === 1) {
      return conn;
    }

    const disconnected = conn && conn?._readyState !== 1;
    if (!cached.promise || disconnected) {
      const opts = toMongooseConnectOptions(settings);
      logger.info('Mongo Connection options');
      logger.info(JSON.stringify(opts, null, 2));
      mongoose.set('strictQuery', true);
      cached.promise = mongoose.connect(settings.uri, opts).then((connected) => {
        return connected;
      });
    }
    cached.conn = await cached.promise;

    return cached.conn;
  }

  async function close(): Promise<void> {
    await mongoose.disconnect();
  }

  function getState(): DataStoreConnectionState {
    return READY_STATES[mongoose.connection.readyState] ?? 'disconnected';
  }

  function isConnected(): boolean {
    return getState() === 'connected';
  }

  async function health(): Promise<DataStoreHealth> {
    const state = getState();
    const db = mongoose.connection.db;
    if (state !== 'connected' || !db) {
      return { ok: false, state };
    }
    const startedAt = Date.now();
    try {
      await db.admin().ping();
      return { ok: true, state, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        state,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { connect, close, getState, isConnected, health };
}

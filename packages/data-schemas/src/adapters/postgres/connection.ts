/**
 * The PostgreSQL connection (`DataStoreConnection`; docs/postgres-port/PHASE4.md §6). Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * Settings come from the environment it is given:
 * - `POSTGRES_URI` (required; `createPostgresDataStoreConnection` throws without it);
 * - `POSTGRES_SCHEMA` (default `public`): the schema of every table, set as the connections'
 *   `search_path`; a lowercase identifier;
 * - `POSTGRES_POOL_MAX`: the pool size (`pg`'s default, 10, when unset, `0` or not a number);
 * - `POSTGRES_AUTO_MIGRATE` (default `true`, D6): apply pending migrations on `connect`; with
 *   `false`, `connect` refuses a database whose migration level is behind the code's;
 * - `POSTGRES_TTL_INTERVAL_MS` (default 60 s): the period of the TTL sweeper (`./ttlSweeper`, I4),
 *   which the connection starts once connected and stops before closing its pool.
 *
 * `connect` opens one `pg` pool with a Kysely instance over it, checks the server (below), runs
 * the migrations and the post-migration index step (`migrator.ts`) or checks the migration level,
 * starts the TTL sweeper on it, and resolves to the {@link PostgresHandle}. Calls while it is
 * connecting or connected share that handle (a process-wide cache, as with MongoDB, unless a
 * `cache` is given); `close` stops the sweeper (waiting for a pass in progress) and closes the
 * pool, and after it a new handle is opened. Boot checks, each refusing `connect`:
 * - `server_version_num >= 150000` (D6: `NULLS NOT DISTINCT` unique indexes need 15);
 * - the `und-x-icu` collation exists (case-insensitive regexes, §2.4);
 * - `standard_conforming_strings` is `on`.
 *
 * `json` and `jsonb` values are read as their text, so the tagged codec (`values.ts`) decodes
 * them with key order kept. With `observeQueries`, every query made through the Kysely instance
 * is reported (table, operation, outcome, duration), as the MongoDB connection reports mongoose
 * queries; queries made on the pool directly (the LangGraph saver) are not.
 */
import { Pool, types as pgTypes } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { LogEvent, Migration } from 'kysely';
import type {
  DataStoreHealth,
  DataStoreConnection,
  DataStoreQueryObserver,
  DataStoreConnectionState,
  DataStoreConnectionOptions,
} from '~/ports/connection';
import type { PostgresHandle, PostgresKysely, PostgresTables } from './types';
import type { PostgresMigrationResult } from './migrator';
import type { PostgresTtlSweeper } from './ttlSweeper';
import { getPendingPostgresMigrations, migratePostgresSchema } from './migrator';
import { createPostgresTtlSweeper, readTtlIntervalMs } from './ttlSweeper';
import logger from '~/config/winston';

/** The connection settings read from the `POSTGRES_*` variables. */
export interface PostgresConnectionSettings {
  uri: string;
  /** The schema the tables live in (`search_path`). */
  schema: string;
  /** The pool size, when set. */
  poolMax?: number;
  /** Whether `connect` applies pending migrations (otherwise it checks the level). */
  autoMigrate: boolean;
}

/** The process-wide connection state, shared by the connections created with it. */
export interface PostgresConnectionCache {
  handle: PostgresHandle | null;
  promise: Promise<PostgresHandle> | null;
}

/** The PostgreSQL adapter for `DataStoreConnection`; `connect` resolves to the handle. */
export interface PostgresDataStoreConnection extends DataStoreConnection<PostgresHandle> {
  /** The handle while connected, `null` otherwise (for the stores, which query through it). */
  getHandle(): PostgresHandle | null;
}

/** Options of {@link createPostgresDataStoreConnection} beyond the port's. */
export interface PostgresConnectionOptions extends DataStoreConnectionOptions {
  /** The connection state to share; the process-wide one when not given. */
  cache?: PostgresConnectionCache;
  /** The migrations to apply or check; the package's when not given (specs pass their own). */
  migrations?: Readonly<Record<string, Migration>>;
}

const MISSING_URI_MESSAGE = 'Please define the POSTGRES_URI environment variable';
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** The oldest server the backend runs on (D6). */
export const MIN_POSTGRES_VERSION_NUM = 150000;

/** OIDs of `json` and `jsonb`, read as text so the tagged codec parses them. */
const JSON_OID = 114;
const JSONB_OID = 3802;

/** Whether a variable is set, as `optionalEnabled` in `@librechat/api` reads it. */
function optionalEnabled(value: string | undefined): boolean | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.toLowerCase().trim() === 'true';
}

/**
 * Reads the connection settings from the `POSTGRES_*` variables. Throws when `POSTGRES_URI` is
 * not set, or `POSTGRES_SCHEMA` is not a lowercase identifier.
 */
export function readPostgresConnectionSettings(
  env: Readonly<Record<string, string | undefined>>,
): PostgresConnectionSettings {
  const uri = env.POSTGRES_URI;
  if (!uri) {
    throw new Error(MISSING_URI_MESSAGE);
  }
  const schema = env.POSTGRES_SCHEMA?.trim() || 'public';
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(
      `POSTGRES_SCHEMA must be a lowercase identifier (letters, digits, _), got "${schema}"`,
    );
  }
  const poolMax = parseInt(env.POSTGRES_POOL_MAX as string) || undefined;
  return {
    uri,
    schema,
    ...(poolMax && poolMax > 0 ? { poolMax } : {}),
    autoMigrate: optionalEnabled(env.POSTGRES_AUTO_MIGRATE) ?? true,
  };
}

/** The type parsers of the backend's pool: `pg`'s, with `json`/`jsonb` read as text. */
function createTypeParsers(): { getTypeParser: typeof pgTypes.getTypeParser } {
  const asText = (value: string): string => value;
  return {
    getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
      oid === JSON_OID || oid === JSONB_OID
        ? asText
        : pgTypes.getTypeParser(oid, format as 'text')) as typeof pgTypes.getTypeParser,
  };
}

/** The `pg` pool for `settings`: `search_path` set to the schema, `json` read as text. */
export function createPostgresPool(settings: PostgresConnectionSettings): Pool {
  const pool = new Pool({
    connectionString: settings.uri,
    ...(settings.poolMax ? { max: settings.poolMax } : {}),
    options: `-c search_path=${settings.schema}`,
    types: createTypeParsers(),
  });
  /**
   * A client losing its server emits `error`: on the pool while idle, on the client itself while
   * checked out (in a transaction). Unhandled, either would end the process; the query in
   * flight fails on its own, and `pg-pool` discards the broken client when it is released.
   */
  pool.on('error', (error) => {
    logger.error('[connectDb] PostgreSQL pool error:', error);
  });
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.error('[connectDb] PostgreSQL connection error:', error);
    });
  });
  return pool;
}

const OPERATIONS: Record<string, string> = {
  SelectQueryNode: 'select',
  InsertQueryNode: 'insert',
  UpdateQueryNode: 'update',
  DeleteQueryNode: 'delete',
  MergeQueryNode: 'merge',
};

type Node = { kind?: unknown; [key: string]: unknown } | undefined;

/** The table a query node names first (`from`, `into` or `table`), unwrapping aliases. */
function tableOf(node: Node): string | undefined {
  if (!node) {
    return undefined;
  }
  const from = node.from as { froms?: Node[] } | undefined;
  let table = (from?.froms?.[0] ?? node.into ?? node.table) as Node;
  if (table?.kind === 'AliasNode') {
    table = table.node as Node;
  }
  if (table?.kind !== 'TableNode') {
    return undefined;
  }
  const identifier = (table.table as Node)?.identifier as Node;
  return typeof identifier?.name === 'string' ? identifier.name : undefined;
}

/** The operation of a compiled query: the query kind, or the first keyword of raw SQL. */
function operationOf(node: Node, sqlText: string): string | undefined {
  const kind = typeof node?.kind === 'string' ? node.kind : undefined;
  if (kind && OPERATIONS[kind]) {
    return OPERATIONS[kind];
  }
  const keyword = /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i.exec(sqlText)?.[1];
  return keyword ? keyword.toLowerCase() : kind;
}

/** Kysely's `log` hook reporting each query to `observer` (which must not throw). */
export function createQueryLogObserver(
  observer: DataStoreQueryObserver,
): (event: LogEvent) => void {
  return (event) => {
    const node = event.query.query as unknown as Node;
    observer({
      model: tableOf(node),
      operation: operationOf(node, event.query.sql),
      status: event.level === 'error' ? 'error' : 'success',
      durationSeconds: event.queryDurationMillis / 1000,
    });
  };
}

/** The TTL sweeper of each open handle, stopped before its pool is closed. */
const ttlSweepers = new WeakMap<PostgresHandle, PostgresTtlSweeper>();

/** The TTL sweeper running on `handle` (while it is open), for specs and diagnostics. */
export function getPostgresTtlSweeper(handle: PostgresHandle): PostgresTtlSweeper | undefined {
  return ttlSweepers.get(handle);
}

/** The process-wide connection state (`globalThis.librechatPostgres`). */
function getGlobalConnectionCache(): PostgresConnectionCache {
  const holder = globalThis as { librechatPostgres?: PostgresConnectionCache };
  if (!holder.librechatPostgres) {
    holder.librechatPostgres = { handle: null, promise: null };
  }
  return holder.librechatPostgres;
}

/** What the boot checks read from the server. */
export interface PostgresServerFacts {
  /** `server_version_num`, such as 160015. */
  versionNum: number;
  /** `server_version`, such as `16.15`. */
  version: string;
  /** `standard_conforming_strings`. */
  standardConformingStrings: string;
  /** Whether the `und-x-icu` collation exists. */
  hasIcu: boolean;
}

/**
 * The boot checks (PHASE4.md §6) on what the server reported: PostgreSQL 15 or later, the
 * `und-x-icu` collation, `standard_conforming_strings` on. Throws the first that fails.
 */
export function assertPostgresServerFacts(facts: PostgresServerFacts): void {
  if (facts.versionNum < MIN_POSTGRES_VERSION_NUM) {
    throw new Error(`PostgreSQL 15 or later is required; the server is ${facts.version}`);
  }
  if (!facts.hasIcu) {
    throw new Error(
      'PostgreSQL must be built with ICU: the collation "und-x-icu" does not exist (case-insensitive matching needs it)',
    );
  }
  if (facts.standardConformingStrings !== 'on') {
    throw new Error('PostgreSQL must run with standard_conforming_strings = on');
  }
}

/** Reads the facts the boot checks need from the server `db` is connected to. */
export async function readPostgresServerFacts(db: PostgresKysely): Promise<PostgresServerFacts> {
  const { rows } = await sql<{
    version_num: number;
    version: string;
    standard_conforming_strings: string;
    has_icu: boolean;
  }>`
    SELECT current_setting('server_version_num')::int AS version_num,
           current_setting('server_version') AS version,
           current_setting('standard_conforming_strings') AS standard_conforming_strings,
           EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu') AS has_icu
  `.execute(db);
  const row = rows[0];
  return {
    versionNum: row.version_num,
    version: row.version,
    standardConformingStrings: row.standard_conforming_strings,
    hasIcu: row.has_icu,
  };
}

/** The boot checks on the server `db` is connected to; rejects with the first that fails. */
export async function checkPostgresServer(db: PostgresKysely): Promise<void> {
  assertPostgresServerFacts(await readPostgresServerFacts(db));
}

/** Logs what a run of the migrator did, when it did something. */
function logMigrationResult({ applied, builtIndexes }: PostgresMigrationResult): void {
  if (applied.length > 0) {
    logger.info(`[connectDb] Applied PostgreSQL migrations: ${applied.join(', ')}`);
  }
  if (builtIndexes.length > 0) {
    logger.info(`[connectDb] Built PostgreSQL indexes concurrently: ${builtIndexes.join(', ')}`);
  }
}

/**
 * Migrates the database of the `POSTGRES_*` settings of `env` (`npm run db:migrate`, for
 * deployments that migrate before rolling out; `POSTGRES_AUTO_MIGRATE` is ignored): runs the boot
 * checks, applies the pending migrations, then builds the missing large-table indexes
 * `CONCURRENTLY` (`migratePostgresSchema`), and closes its pool.
 */
export async function runPostgresMigrations(options: {
  env: Readonly<Record<string, string | undefined>>;
  /** The migrations to apply; the package's when not given (specs pass their own). */
  migrations?: Readonly<Record<string, Migration>>;
}): Promise<PostgresMigrationResult> {
  const settings = readPostgresConnectionSettings(options.env);
  const pool = createPostgresPool(settings);
  const db: PostgresKysely = new Kysely<PostgresTables>({ dialect: new PostgresDialect({ pool }) });
  try {
    await checkPostgresServer(db);
    return await migratePostgresSchema(db, {
      schema: settings.schema,
      migrations: options.migrations,
    });
  } finally {
    await db.destroy();
  }
}

/**
 * The PostgreSQL connection for the `POSTGRES_*` settings of `options.env` (read here, so a
 * missing `POSTGRES_URI` throws now). Nothing is opened until `connect`.
 */
export function createPostgresDataStoreConnection(
  options: PostgresConnectionOptions,
): PostgresDataStoreConnection {
  const settings = readPostgresConnectionSettings(options.env);
  const cache = options.cache ?? getGlobalConnectionCache();
  const migrationOptions = { schema: settings.schema, migrations: options.migrations };
  let closing = false;

  async function open(): Promise<PostgresHandle> {
    const pool = createPostgresPool(settings);
    const db: PostgresKysely = new Kysely<PostgresTables>({
      dialect: new PostgresDialect({ pool }),
      ...(options.observeQueries ? { log: createQueryLogObserver(options.observeQueries) } : {}),
    });
    try {
      await checkPostgresServer(db);
      if (settings.autoMigrate) {
        logMigrationResult(await migratePostgresSchema(db, migrationOptions));
      } else {
        const pending = await getPendingPostgresMigrations(db, migrationOptions);
        if (pending.length > 0) {
          throw new Error(
            `The PostgreSQL schema is behind this version (${pending.length} migrations pending: ${pending.join(', ')}). Run \`npm run db:migrate\` or set POSTGRES_AUTO_MIGRATE=true.`,
          );
        }
      }
    } catch (error) {
      await db.destroy().catch(() => undefined);
      throw error;
    }
    logger.info('PostgreSQL Connection options');
    logger.info(
      JSON.stringify(
        { schema: settings.schema, poolMax: settings.poolMax, autoMigrate: settings.autoMigrate },
        null,
        2,
      ),
    );
    const handle: PostgresHandle = { db, pool, schema: settings.schema };
    const sweeper = createPostgresTtlSweeper(db, { intervalMs: readTtlIntervalMs(options.env) });
    ttlSweepers.set(handle, sweeper);
    sweeper.start();
    return handle;
  }

  async function connect(): Promise<PostgresHandle> {
    if (cache.handle) {
      return cache.handle;
    }
    if (!cache.promise) {
      const promise = open().then(
        (handle) => {
          if (cache.promise === promise) {
            cache.handle = handle;
          }
          return handle;
        },
        (error: unknown) => {
          if (cache.promise === promise) {
            cache.promise = null;
          }
          throw error;
        },
      );
      cache.promise = promise;
    }
    return cache.promise;
  }

  async function close(): Promise<void> {
    const pending = cache.promise;
    cache.handle = null;
    cache.promise = null;
    if (!pending) {
      return;
    }
    closing = true;
    try {
      const handle = await pending.catch(() => null);
      if (handle) {
        await ttlSweepers.get(handle)?.stop();
        ttlSweepers.delete(handle);
      }
      await handle?.db.destroy();
    } finally {
      closing = false;
    }
  }

  function getState(): DataStoreConnectionState {
    if (closing) {
      return 'disconnecting';
    }
    if (cache.handle) {
      return 'connected';
    }
    return cache.promise ? 'connecting' : 'disconnected';
  }

  function isConnected(): boolean {
    return getState() === 'connected';
  }

  async function health(): Promise<DataStoreHealth> {
    const state = getState();
    const handle = cache.handle;
    if (state !== 'connected' || !handle) {
      return { ok: false, state };
    }
    const startedAt = Date.now();
    try {
      await sql`SELECT 1`.execute(handle.db);
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

  return { connect, close, getState, isConnected, health, getHandle: () => cache.handle };
}

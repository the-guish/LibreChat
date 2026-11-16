/**
 * `keyvMongo` (the Keyv store adapter on the main database's key-value store) with
 * `DATABASE_BACKEND=postgres` (docs/postgres-port/PHASE4.md §8 I1): the same adapter, reaching
 * `key_value_entries` through `getDataStoreBackend().createKeyValueStore`, used as the server
 * uses it (a Keyv namespace per cache, ttl kept by Keyv) and swept by the TTL sweeper (I4).
 *
 * The server: `POSTGRES_TEST_URI` when set (the suite works in a schema of its own, dropped
 * afterwards), otherwise a temporary cluster started from the installed server binaries (as
 * `postgres` when running as root) and stopped afterwards. Without either the suite is skipped
 * with a warning, unless `REQUIRE_POSTGRES_TESTS=true`.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { Keyv } from 'keyv';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getDataStoreBackend } from '@librechat/data-schemas';
import type { PostgresHandle, PostgresDataStoreConnection } from '@librechat/data-schemas';
import keyvMongo from './keyvMongo';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

type Store = typeof keyvMongo;
const KeyvMongo = keyvMongo.constructor as new (options: {
  collection: string;
  useGridFS?: boolean;
}) => Store;

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const asPostgres = (argv: string[]) =>
  isRoot ? ['runuser', '-u', 'postgres', '--', ...argv] : argv;

function findBinDir(): string | undefined {
  const has = (dir: string) =>
    ['initdb', 'pg_ctl', 'postgres'].every((name) => fs.existsSync(path.join(dir, name)));
  if (process.env.POSTGRES_TEST_BIN_DIR) {
    return has(process.env.POSTGRES_TEST_BIN_DIR) ? process.env.POSTGRES_TEST_BIN_DIR : undefined;
  }
  const root = '/usr/lib/postgresql';
  const versions = fs.existsSync(root)
    ? fs.readdirSync(root).filter((entry) => /^\d+$/.test(entry))
    : [];
  const candidates = [
    ...versions.sort((a, b) => Number(b) - Number(a)).map((v) => path.join(root, v, 'bin')),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
  ];
  return candidates.find(has);
}

const binDir = process.env.POSTGRES_TEST_URI ? undefined : findBinDir();
const available = Boolean(process.env.POSTGRES_TEST_URI || binDir);
if (!available && process.env.REQUIRE_POSTGRES_TESTS !== 'true') {
  console.warn('[postgres tests] Skipping keyvMongo on PostgreSQL: no PostgreSQL server');
}
const describePostgres =
  available || process.env.REQUIRE_POSTGRES_TESTS === 'true' ? describe : describe.skip;

function run(argv: string[]): void {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`\`${argv.join(' ')}\` failed: ${result.stderr ?? result.error?.message}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** A temporary cluster; resolves to its URI and how to stop it. */
async function startCluster(): Promise<{ uri: string; stop: () => void }> {
  if (!binDir) {
    throw new Error('REQUIRE_POSTGRES_TESTS=true, but there is no PostgreSQL server');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-keyv-pg-'));
  fs.chmodSync(root, 0o755);
  if (isRoot) {
    const uid = Number(spawnSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).stdout.trim());
    const gid = Number(spawnSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).stdout.trim());
    fs.chownSync(root, uid, gid);
  }
  const dataDir = path.join(root, 'data');
  const stop = () => {
    const argv = asPostgres([
      path.join(binDir, 'pg_ctl'),
      '-D',
      dataDir,
      '-m',
      'immediate',
      'stop',
    ]);
    spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' });
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    run(
      asPostgres([
        path.join(binDir, 'initdb'),
        '-D',
        dataDir,
        '--auth=trust',
        '--encoding=UTF8',
        '--locale=C',
        '--username=postgres',
        '--no-sync',
      ]),
    );
    const port = await freePort();
    run(
      asPostgres([
        path.join(binDir, 'pg_ctl'),
        '-D',
        dataDir,
        '-l',
        path.join(root, 'server.log'),
        '-w',
        '-o',
        `-p ${port} -k ${root} -c listen_addresses=127.0.0.1 -c fsync=off`,
        'start',
      ]),
    );
    return { uri: `postgresql://postgres@127.0.0.1:${port}/postgres`, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describePostgres('keyvMongo on PostgreSQL (DATABASE_BACKEND=postgres)', () => {
  const previousBackend = process.env.DATABASE_BACKEND;
  const schema = process.env.POSTGRES_TEST_URI
    ? `lc_keyv_${process.pid}_${Date.now().toString(36)}`
    : 'public';
  let stopCluster: (() => void) | undefined;
  let connection: PostgresDataStoreConnection | undefined;
  let env: Record<string, string>;
  let handle: PostgresHandle;

  const entries = async (store: string) =>
    (
      await handle.pool.query<{ key: string; value: string | null; expires_at: Date | null }>(
        'SELECT key, value, expires_at FROM key_value_entries WHERE store = $1 ORDER BY key',
        [store],
      )
    ).rows;

  beforeAll(async () => {
    process.env.DATABASE_BACKEND = 'postgres';
    let uri = process.env.POSTGRES_TEST_URI;
    if (!uri) {
      const cluster = await startCluster();
      uri = cluster.uri;
      stopCluster = cluster.stop;
    }
    env = {
      POSTGRES_URI: uri,
      POSTGRES_SCHEMA: schema,
      POSTGRES_ALLOW_INCOMPLETE_STORES: 'true',
      POSTGRES_TTL_INTERVAL_MS: '100',
    };
  }, 120_000);

  afterAll(async () => {
    if (connection && schema !== 'public') {
      await handle?.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await connection?.close();
    stopCluster?.();
    if (previousBackend === undefined) {
      delete process.env.DATABASE_BACKEND;
    } else {
      process.env.DATABASE_BACKEND = previousBackend;
    }
  }, 60_000);

  it('rejects while the database is not connected, without emitting an error', async () => {
    expect(getDataStoreBackend().name).toBe('postgres');
    const store = new KeyvMongo({ collection: 'keyv_early' });
    const onError = jest.fn();
    store.on('error', onError);
    await expect(store.get('k')).rejects.toThrow('PostgreSQL is not connected');
    expect(onError).not.toHaveBeenCalled();

    connection = getDataStoreBackend().createConnection({
      env,
    }) as unknown as PostgresDataStoreConnection;
    handle = (await connection.connect()) as PostgresHandle;
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
  }, 120_000);

  it('keeps the logs store in key_value_entries, the expiry stamped from the ttl', async () => {
    const before = Date.now();
    await keyvMongo.set('ban:1', 'value', 60_000);
    await keyvMongo.set('no-ttl', 'kept');
    expect(await keyvMongo.get('ban:1')).toBe('value');
    expect(await keyvMongo.getMany(['no-ttl', 'none', 'ban:1'])).toEqual([
      'kept',
      undefined,
      'value',
    ]);
    expect(await keyvMongo.has('ban:1')).toBe(true);
    const rows = await entries('logs');
    expect(rows.map(({ key, value }) => [key, value])).toEqual([
      ['ban:1', 'value'],
      ['no-ttl', 'kept'],
    ]);
    expect(rows[0].expires_at!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(rows[1].expires_at).toBeNull();
    expect(await keyvMongo.delete('ban:1')).toBe(true);
    expect(await keyvMongo.deleteMany(['ban:1', 'no-ttl'])).toBe(true);
    expect(await entries('logs')).toEqual([]);
  });

  it('serves Keyv namespaces as the server uses them, clearing one namespace only', async () => {
    const bans = new Keyv({ store: new KeyvMongo({ collection: 'logs_ns' }), namespace: 'ban' });
    const domains = new Keyv({
      store: new KeyvMongo({ collection: 'logs_ns' }),
      namespace: 'encoded_domains',
    });
    await bans.set('user-1', { type: 'ban', expiresAt: 1 }, 60_000);
    await domains.set('example.com', 'ZXhhbXBsZQ==');
    expect(await bans.get('user-1')).toEqual({ type: 'ban', expiresAt: 1 });
    expect(await domains.get('example.com')).toBe('ZXhhbXBsZQ==');
    expect((await entries('logs_ns')).map((row) => row.key)).toEqual([
      'ban:user-1',
      'encoded_domains:example.com',
    ]);

    await bans.clear();
    expect(await bans.get('user-1')).toBeUndefined();
    expect(await domains.get('example.com')).toBe('ZXhhbXBsZQ==');
  });

  it('lets Keyv drop an expired value on read', async () => {
    const cache = new Keyv({ store: new KeyvMongo({ collection: 'logs_ttl' }), namespace: 'n' });
    await cache.set('short', 'gone soon', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await cache.get('short')).toBeUndefined();
  });

  it('has the TTL sweeper remove expired entries from disk', async () => {
    const store = new KeyvMongo({ collection: 'logs_swept' });
    await store.set('expired', 'x', 1);
    await store.set('fresh', 'y', 3_600_000);
    await waitFor(async () => (await entries('logs_swept')).length === 1);
    expect((await entries('logs_swept')).map((row) => row.key)).toEqual(['fresh']);
  });

  it('keeps large values (useGridFS) apart from the plain store of the same name', async () => {
    const large = new KeyvMongo({ collection: 'blobs', useGridFS: true });
    const plain = new KeyvMongo({ collection: 'blobs' });
    const value = 'x'.repeat(500_000);
    await large.set('big', value);
    await plain.set('big', 'small');
    expect(await large.get('big')).toBe(value);
    expect(await plain.get('big')).toBe('small');
    expect((await entries('blobs.files')).map((row) => [row.key, row.value])).toEqual([
      ['big', null],
    ]);
    await large.clear();
    expect(await large.has('big')).toBe(false);
    expect(await plain.has('big')).toBe(true);
  });
});

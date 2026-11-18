import { sql } from 'kysely';
import type { PostgresDataStoreConnection } from './connection';
import type { PostgresKysely } from './types';
import {
  POSTGRES_CREDENTIAL_MARKER_ID,
  POSTGRES_CREDENTIAL_MARKER_TABLE,
  createPostgresCredentialMarkerStore,
} from './credentialMarker';
import {
  CREDENTIAL_MARKER_ID,
  CREDENTIAL_MARKER_COLLECTION,
} from '~/adapters/mongo/credentialMarker';
import { KEY_VALUE_TABLE, createPostgresKeyValueStore, keyValueStoreColumn } from './keyValueStore';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { createPostgresDataStoreBackend } from './backend';
import { getNulReplacementCount } from './values';

/**
 * What the PostgreSQL key-value store and credential marker keep in their tables (the
 * backend-neutral behavior is in `contracts/keyValueStore.contract.ts` and
 * `contracts/credentialMarker.contract.ts`).
 */
describe('PostgreSQL key-value store and credential marker, without a database', () => {
  it('are served by the backend', async () => {
    const backend = createPostgresDataStoreBackend();
    expect(backend.getCredentialMarkerStore()).toBeNull();
    await expect(backend.createKeyValueStore({ name: 'cache' }).get('k')).rejects.toThrow(
      'PostgreSQL is not connected',
    );
  });

  it('keep the MongoDB names, so the copy tool maps them by name', () => {
    expect(POSTGRES_CREDENTIAL_MARKER_TABLE).toBe(CREDENTIAL_MARKER_COLLECTION);
    expect(POSTGRES_CREDENTIAL_MARKER_ID).toBe(CREDENTIAL_MARKER_ID);
    expect(keyValueStoreColumn({ name: 'logs' })).toBe('logs');
    expect(keyValueStoreColumn({ name: '' })).toBe('keyv');
    expect(keyValueStoreColumn({ name: 'logs', largeValues: true })).toBe('logs.files');
  });
});

describePostgres('PostgreSQL key-value store and credential marker', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let db: PostgresKysely;

  beforeAll(() => {
    db = database.kysely();
  });
  beforeEach(() => database.truncateAll());

  const rows = async () =>
    (
      await sql<{
        store: string;
        key: string;
        value: string | null;
        value_bytes: Buffer | null;
        expires_at: Date | null;
      }>`SELECT store, key, value, value_bytes, expires_at FROM ${sql.table(
        KEY_VALUE_TABLE,
      )} ORDER BY store, key`.execute(db)
    ).rows;

  it('keeps one row per store and key, with the expiry stamped from the ttl', async () => {
    const store = createPostgresKeyValueStore(() => db, { name: 'logs' });
    const before = Date.now();
    await store.set('ban:1', 'one', 60_000);
    await store.set('ban:2', 'two');
    await store.set('ban:1', 'uno', 120_000);
    const stored = await rows();
    expect(
      stored.map(({ store, key, value, value_bytes }) => [store, key, value, value_bytes]),
    ).toEqual([
      ['logs', 'ban:1', 'uno', null],
      ['logs', 'ban:2', 'two', null],
    ]);
    expect(stored[0].expires_at!.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(stored[0].expires_at!.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(stored[1].expires_at).toBeNull();
    await store.set('ban:1', 'kept');
    expect((await rows())[0].expires_at).toBeNull();
  });

  it('keeps large values as bytes under <name>.files, with their expiry', async () => {
    const store = createPostgresKeyValueStore(() => db, { name: 'logs', largeValues: true });
    await store.set('big', 'é'.repeat(10), 60_000);
    const [row] = await rows();
    expect(row).toMatchObject({ store: 'logs.files', key: 'big', value: null });
    expect(row.value_bytes).toEqual(Buffer.from('é'.repeat(10), 'utf8'));
    expect(row.expires_at).toBeInstanceOf(Date);
  });

  it('replaces U+0000 with U+FFFD in keys and values, and finds the key again (D8)', async () => {
    const store = createPostgresKeyValueStore(() => db, { name: 'logs' });
    const before = getNulReplacementCount();
    await store.set('a\u0000b', 'x\u0000y');
    expect(getNulReplacementCount()).toBe(before + 2);
    expect(await store.get('a\u0000b')).toBe('x�y');
    expect(await store.has('a�b')).toBe(true);
    expect(await store.delete('a\u0000b')).toBe(true);
  });

  it('treats the namespace of clear as text, not as a pattern', async () => {
    const store = createPostgresKeyValueStore(() => db, { name: 'logs' });
    await store.set('a_b:1', 'x');
    await store.set('axb:1', 'x');
    await store.set('a%:1', 'x');
    await store.clear('a_');
    await store.clear('a%');
    expect(await store.getMany(['a_b:1', 'axb:1', 'a%:1'])).toEqual([undefined, 'x', undefined]);
  });

  it('records the marker as the primary row, fingerprints in the tagged json encoding', async () => {
    const markers = createPostgresCredentialMarkerStore(db);
    const createdAt = new Date('2026-01-01T00:00:00.123Z');
    await markers.recordMarkerIfAbsent({ fingerprints: { CREDS_KEY: 'abc' }, createdAt });
    const { rows: stored } = await sql<{
      _id: string;
      fingerprints: string;
      createdAt: Date;
      _nulls: unknown;
      _extra: unknown;
    }>`SELECT * FROM ${sql.table(POSTGRES_CREDENTIAL_MARKER_TABLE)}`.execute(db);
    expect(stored).toEqual([
      {
        _id: 'primary',
        fingerprints: '{"CREDS_KEY":"abc"}',
        createdAt,
        _nulls: null,
        _extra: null,
      },
    ]);
    expect(await markers.readMarker()).toEqual({
      _id: 'primary',
      fingerprints: { CREDS_KEY: 'abc' },
      createdAt,
    });
  });

  it('reads legacy marker fields kept in _extra after the stated ones (D7)', async () => {
    await sql`INSERT INTO ${sql.table(POSTGRES_CREDENTIAL_MARKER_TABLE)}
      ("_id", "fingerprints", "createdAt", "_extra")
      VALUES ('primary', '{"A":"1"}', '2026-01-01T00:00:00Z', '{"version":2}')`.execute(db);
    const marker = await createPostgresCredentialMarkerStore(db).readMarker();
    expect(marker).toEqual({
      _id: 'primary',
      fingerprints: { A: '1' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      version: 2,
    });
    expect(Object.keys(marker!)).toEqual(['_id', 'fingerprints', 'createdAt', 'version']);
  });

  it('serve the stores on the connection the backend opened, and stop with it', async () => {
    const backend = createPostgresDataStoreBackend();
    const connection: PostgresDataStoreConnection = backend.createConnection({
      env: database.env({ POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' }),
      cache: { handle: null, promise: null },
    });
    const store = backend.createKeyValueStore({ name: 'logs' });
    await expect(store.set('k', 'v')).rejects.toThrow('PostgreSQL is not connected');
    await connection.connect();
    try {
      await store.set('k', 'v');
      expect(await store.get('k')).toBe('v');
      expect(await backend.getCredentialMarkerStore()!.hasUsers()).toBe(false);
    } finally {
      await connection.close();
    }
    expect(backend.getCredentialMarkerStore()).toBeNull();
    await expect(store.get('k')).rejects.toThrow('PostgreSQL is not connected');
  });
});

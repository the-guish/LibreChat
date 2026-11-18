import { Mongoose, mongo } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MongoClient } from 'mongodb';
import type { Pool } from 'pg';
import type { PostgresDataStoreConnection } from '~/adapters/postgres/connection';
import type { MongoToPostgresCopyOptions, MongoToPostgresReport } from './index';
import { createMongoContractHarness } from '~/adapters/mongo/contractHarness';
import { createPostgresDataStoreBackend } from '~/adapters/postgres/backend';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { copyMongoToPostgres, formatMongoToPostgresReport } from './index';
import { createMongoKeyValueStore } from '~/adapters/mongo/keyValueStore';
import { MongoToPostgresCopyRefusedError } from './schema';

/**
 * The copy tool's engine (docs/postgres-port/PHASE4.md §8 X1) from a memory MongoDB into
 * PostgreSQL test databases: legacy shapes and their report (`_extra` per path, U+0000, `Long`s
 * beyond 2^53, BSON types), the `_meili*` flags, key-value collections and GridFS buckets, a
 * repeated and a resumed copy, the dry run, a collection filter, and the refusals.
 */
/**
 * The backend reading the copy back: `POSTGRES_ALLOW_INCOMPLETE_STORES` lets it connect while a
 * backend member is still missing (until B1); a backend without the escape hatch ignores it.
 */
const BACKEND_ENV = { POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' };
const mongoose = new Mongoose();
let server: MongoMemoryServer;
const harness = createMongoContractHarness(
  {
    async connect() {
      server = await MongoMemoryServer.create();
      return server.getUri();
    },
    async release() {
      await server.stop();
    },
  },
  mongoose,
);

const db = () => mongoose.connection.db!;
const client = () => mongoose.connection.getClient() as unknown as MongoClient;
const oid = (hex: string) => new mongo.ObjectId(hex);
const hex = (n: number) => n.toString(16).padStart(24, '0');

function copy(env: Record<string, string>, options: Partial<MongoToPostgresCopyOptions> = {}) {
  return copyMongoToPostgres({
    mongo: { client: client(), dbName: db().databaseName },
    env,
    batchSize: 2,
    ...options,
  });
}

function entry(report: MongoToPostgresReport, collection: string) {
  const found = report.collections.find((item) => item.collection === collection);
  if (!found) throw new Error(`no report for ${collection}`);
  return found;
}

/** Legacy and edge shapes, inserted with the driver as an old deployment could hold them. */
async function seedLegacy(): Promise<void> {
  await db()
    .collection('users')
    .insertMany([
      {
        _id: oid(hex(1)),
        name: 'Null\u0000Byte',
        email: 'one@example.com',
        legacyFlag: true,
        provider: 'local',
        plugins: [{ $legacy: 1 }],
        personalization: { memories: true, oldSetting: 'x' },
        favorites: [{ agentId: 'agent-1', legacy: 2 }],
        skillStates: { a: true, b: false },
        nameTokens: ['null', 'byte'],
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        _id: oid(hex(2)),
        name: 'Misfit',
        email: 42,
        favorites: [null],
        termsAccepted: 'yes',
      },
      { _id: oid(hex(3)), name: 'Plain', email: 'three@example.com', role: 'USER' },
    ]);
  await db()
    .collection('messages')
    .insertMany([
      {
        _id: oid(hex(10)),
        messageId: 'm1',
        conversationId: 'c1',
        user: hex(1),
        text: 'hello',
        tokenCount: mongo.Long.fromString('9007199254740993'),
        _meiliIndex: true,
        _meiliIndexVersion: 'v3',
        content: [{ type: 'text', text: 'hi\u0000' }],
        metadata: { blob: new mongo.Binary(Buffer.from('abc')), when: new Date(5) },
      },
      {
        _id: oid(hex(11)),
        messageId: 'm2',
        conversationId: 'c1',
        user: hex(1),
        text: 'decimal',
        tokenCount: mongo.Decimal128.fromString('1.5'),
      },
    ]);
  await db()
    .collection('conversations')
    .insertOne({
      _id: oid(hex(20)),
      conversationId: 'c1',
      user: hex(1),
      title: 'Legacy',
      messages: [oid(hex(10)), hex(11)],
      tags: ['a', 'b'],
      examples: [{ input: { content: 'x' } }],
      codeWorkspaces: [{ environmentId: 'e1', workspaceId: 'w1', agentIds: ['x'] }],
      _meiliIndex: false,
    });
  await db()
    .collection('passkeys')
    .insertOne({
      _id: oid(hex(30)),
      userId: oid(hex(1)),
      credentialId: 'cred',
      publicKey: new mongo.Binary(Buffer.from([1, 2, 3, 0])),
      counter: 7,
    });
}

describePostgres('MongoDB → PostgreSQL copy', () => {
  beforeAll(() => harness.setup(), 120_000);
  afterAll(() => harness.teardown());

  describe('a copy of legacy shapes', () => {
    const database = usePostgresTestDatabase({ template: 'empty' });
    let pool: Pool;
    let report: MongoToPostgresReport;

    beforeAll(async () => {
      await harness.reset();
      await seedLegacy();
      await db().collection('unknown_things').insertOne({ whatever: 1 });
      pool = database.pool();
      report = await copy(database.env());
    }, 120_000);

    it('migrates the empty database, copies and verifies every record', () => {
      expect(report.dryRun).toBe(false);
      expect(report.schema.applied).toContain('0001_initial');
      expect(report.ok).toBe(true);
      for (const collection of ['users', 'messages', 'conversations', 'passkeys']) {
        const item = entry(report, collection);
        expect(item).toMatchObject({ failed: 0, mismatched: 0, existing: 0 });
        expect(item.verified).toBe(item.read);
        expect(item.inserted).toBe(item.read);
      }
      expect(report.skippedCollections).toEqual([
        expect.objectContaining({ collection: 'unknown_things', documents: 1 }),
      ]);
      expect(formatMongoToPostgresReport(report)).toContain('no problems found');
    });

    it('reports every value moved to _extra by table and path', () => {
      const users = entry(report, 'users');
      const diverted = users.diverted.map(({ table, path, reason, sampleIds }) => ({
        table,
        path,
        reason,
        sampleIds,
      }));
      expect(diverted).toEqual(
        expect.arrayContaining([
          { table: 'users', path: 'legacyFlag', reason: 'undeclared', sampleIds: [hex(1)] },
          { table: 'users', path: 'plugins', reason: 'misfit', sampleIds: [hex(1)] },
          {
            table: 'users',
            path: 'personalization.oldSetting',
            reason: 'undeclared',
            sampleIds: [hex(1)],
          },
          { table: 'users__favorites', path: 'legacy', reason: 'undeclared', sampleIds: [hex(1)] },
          { table: 'users', path: 'email', reason: 'misfit', sampleIds: [hex(2)] },
          { table: 'users', path: 'favorites', reason: 'misfit', sampleIds: [hex(2)] },
          { table: 'users', path: 'termsAccepted', reason: 'misfit', sampleIds: [hex(2)] },
        ]),
      );
    });

    it('reports U+0000, Longs beyond 2^53 and unsupported BSON types', () => {
      expect(entry(report, 'users').nul).toEqual({ count: 1, sampleIds: [hex(1)] });
      const messages = entry(report, 'messages');
      expect(messages.nul).toEqual({ count: 1, sampleIds: [hex(10)] });
      expect(messages.longs).toEqual([
        { path: 'tokenCount', detail: '9007199254740993', count: 1, sampleIds: [hex(10)] },
      ]);
      expect(messages.unsupported).toEqual([
        { path: 'tokenCount', detail: 'Decimal128', count: 1, sampleIds: [hex(11)] },
      ]);
      const summary = formatMongoToPostgresReport(report);
      expect(summary).toContain('U+0000 replaced with U+FFFD in 1 record(s)');
      expect(summary).toContain('Long beyond 2^53 at tokenCount');
      expect(summary).toContain('_extra: legacy of users__favorites (undeclared)');
    });

    it('stores the values where the PostgreSQL reads find them', async () => {
      const backend = createPostgresDataStoreBackend();
      const connection: PostgresDataStoreConnection = backend.createConnection({
        env: database.env(BACKEND_ENV),
        cache: { handle: null, promise: null },
      });
      await connection.connect();
      try {
        const { rows } = await pool.query(
          `SELECT _extra::text AS extra, _nulls, "name" FROM users WHERE _id = $1`,
          [hex(1)],
        );
        expect(rows[0].name).toBe('Null�Byte');
        expect(JSON.parse(rows[0].extra)).toEqual({
          legacyFlag: true,
          plugins: [{ $legacy: 1 }],
          personalization: { oldSetting: 'x' },
        });
        const messages = await pool.query(
          `SELECT "messageId", "tokenCount", "_meiliIndex", "_meiliIndexVersion" FROM messages ORDER BY _id`,
        );
        expect(messages.rows).toEqual([
          {
            messageId: 'm1',
            tokenCount: 9007199254740992,
            _meiliIndex: true,
            _meiliIndexVersion: 'v3',
          },
          { messageId: 'm2', tokenCount: null, _meiliIndex: null, _meiliIndexVersion: null },
        ]);
        const stores = backend.createMethods().stores;
        const user = await stores.users.getUserById(hex(2));
        expect(user).toMatchObject({ name: 'Misfit', email: 42, favorites: [null] });
        const conversation = await pool.query(
          `SELECT messages::text[] AS messages, "codeWorkspaces" FROM conversations`,
        );
        expect(conversation.rows).toEqual([{ messages: [hex(10), hex(11)], codeWorkspaces: 1 }]);
        const passkey = await pool.query(`SELECT "publicKey" FROM passkeys`);
        expect(passkey.rows[0].publicKey).toEqual(Buffer.from([1, 2, 3, 0]));
      } finally {
        await connection.close();
      }
    });

    it('keeps what is there on a repeated run', async () => {
      const again = await copy(database.env());
      expect(again.ok).toBe(true);
      expect(again.schema.applied).toEqual([]);
      for (const item of again.collections) {
        expect(item.inserted).toBe(0);
        expect(item.existing).toBe(item.read - item.failed);
        expect(item.verified).toBe(item.read - item.failed);
      }
    });

    it('resumes an interrupted copy', async () => {
      /** What a crash between batches leaves: whole collections missing, a prefix of another. */
      await pool.query(`DELETE FROM users WHERE _id > $1`, [hex(1)]);
      await pool.query(`DELETE FROM conversations`);
      const resumed = await copy(database.env());
      expect(resumed.ok).toBe(true);
      expect(entry(resumed, 'users')).toMatchObject({
        read: 3,
        inserted: 2,
        existing: 1,
        verified: 3,
      });
      expect(entry(resumed, 'conversations')).toMatchObject({ read: 1, inserted: 1, verified: 1 });
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM "conversations__codeWorkspaces"`,
      );
      expect(rows[0].n).toBe(1);
    });

    it('fails the run when a record reads back different', async () => {
      await pool.query(`UPDATE users SET "name" = 'Changed' WHERE _id = $1`, [hex(3)]);
      const checked = await copy(database.env(), { collections: ['users'] });
      expect(checked.ok).toBe(false);
      expect(checked.collections.map((item) => item.collection)).toEqual(['users']);
      expect(entry(checked, 'users')).toMatchObject({
        mismatched: 1,
        mismatches: [{ id: hex(3), message: 'name: expected "Plain", found "Changed"' }],
      });
      expect(formatMongoToPostgresReport(checked)).toContain('VERIFY FAILED: 1 record(s) differ');
    });
  });

  describe('key-value collections and GridFS buckets', () => {
    const database = usePostgresTestDatabase({ template: 'empty' });

    it('copies them into key_value_entries, where the PostgreSQL stores read them', async () => {
      await harness.reset();
      const logs = createMongoKeyValueStore(mongoose, { name: 'logs' });
      await logs.set('ban:1', '{"value":1}', 60_000);
      await logs.set('plain', 'text');
      await logs.set('nul\u0000key', 'v\u0000');
      await db().collection('logs').insertOne({ key: 'plain', value: 'later duplicate' });
      const large = createMongoKeyValueStore(mongoose, { name: 'blobs', largeValues: true });
      await large.set('big', 'first');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await large.set('big', 'x'.repeat(300_000));
      await large.set('other', 'é');

      const report = await copy(database.env(), { batchSize: 50 });
      expect(report.ok).toBe(true);
      expect(entry(report, 'logs')).toMatchObject({
        kind: 'keyValue',
        read: 4,
        inserted: 3,
        verified: 3,
        duplicateKeys: 1,
        nul: { count: 1 },
      });
      expect(entry(report, 'blobs.files')).toMatchObject({
        kind: 'gridfs',
        read: 3,
        inserted: 2,
        verified: 2,
        duplicateKeys: 1,
      });

      const backend = createPostgresDataStoreBackend();
      const connection = backend.createConnection({
        env: database.env(BACKEND_ENV),
        cache: { handle: null, promise: null },
      });
      await connection.connect();
      try {
        const copiedLogs = backend.createKeyValueStore({ name: 'logs' });
        expect(await copiedLogs.getMany(['ban:1', 'plain', 'nul\u0000key'])).toEqual([
          '{"value":1}',
          'text',
          'v�',
        ]);
        const copiedLarge = backend.createKeyValueStore({ name: 'blobs', largeValues: true });
        expect(await copiedLarge.get('big')).toBe('x'.repeat(300_000));
        expect(await copiedLarge.get('other')).toBe('é');
        expect(await backend.createKeyValueStore({ name: 'blobs' }).get('big')).toBeUndefined();
        const pool = database.pool();
        const { rows } = await pool.query(
          `SELECT key, expires_at FROM key_value_entries WHERE store = 'logs' ORDER BY key`,
        );
        expect(rows.find((row) => row.key === 'ban:1').expires_at).toBeInstanceOf(Date);
        expect(rows.find((row) => row.key === 'plain').expires_at).toBeNull();
      } finally {
        await connection.close();
      }
    });
  });

  describe('a dry run', () => {
    const database = usePostgresTestDatabase({ template: 'empty' });

    it('reads and reports, and writes nothing (not even the migrations)', async () => {
      await harness.reset();
      await seedLegacy();
      const report = await copy(database.env(), { dryRun: true });
      expect(report).toMatchObject({ dryRun: true, ok: true });
      expect(report.schema.pending).toContain('0001_initial');
      expect(entry(report, 'users')).toMatchObject({ read: 3, inserted: 0, verified: 0 });
      expect(entry(report, 'users').diverted.length).toBeGreaterThan(0);
      const { rows } = await database
        .pool()
        .query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
      expect(rows[0].n).toBe(0);
      expect(formatMongoToPostgresReport(report)).toContain('Dry run (nothing written)');
    });
  });

  describe('refusals', () => {
    const database = usePostgresTestDatabase({ template: 'migrated' });

    beforeAll(async () => {
      await harness.reset();
      await seedLegacy();
    });

    it('refuses a PostgreSQL schema migrated by a newer version, writing nothing', async () => {
      const pool = database.pool();
      await pool.query(
        `INSERT INTO kysely_migration (name, timestamp) VALUES ('209901010000_future', now()::text)`,
      );
      try {
        await expect(copy(database.env())).rejects.toThrow(MongoToPostgresCopyRefusedError);
        await expect(copy(database.env())).rejects.toThrow(/209901010000_future/);
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users`);
        expect(rows[0].n).toBe(0);
      } finally {
        await pool.query(`DELETE FROM kysely_migration WHERE name = '209901010000_future'`);
      }
    });

    it('refuses a PostgreSQL schema that drifted from the descriptor', async () => {
      const pool = database.pool();
      await pool.query(`ALTER TABLE banners DROP COLUMN "message"`);
      await expect(copy(database.env())).rejects.toThrow(/column banners\.message is missing/);
    });

    it('refuses a source missing the indexes of this version, unless told otherwise', async () => {
      const indexes = await db().collection('passkeys').listIndexes().toArray();
      const name = indexes.map((index) => String(index.name)).find((n) => n !== '_id_')!;
      await db().collection('passkeys').dropIndex(name);
      try {
        await expect(copy(database.env(), { dryRun: true })).rejects.toThrow(
          new RegExp(`passkeys\\.${name}`),
        );
        await expect(
          copy(database.env(), { dryRun: true, allowSourceIndexMismatch: true }),
        ).rejects.toThrow(/banners\.message/);
      } finally {
        await mongoose.model('Passkey').createIndexes();
      }
    });
  });
});

import { Schema } from 'mongoose';
import type { Pool, PoolClient } from 'pg';
import type { SchemaDescriptor } from './descriptor';
import type { SchemaOverrides } from './overrides';
import { buildSchemaDescriptor, parentKeyName, primaryKeyName } from './descriptor';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { generateSchemaDescriptor, introspectSchema } from './generate';
import { diffSchemaDescriptors, emitMigrationDdl } from './diff';
import { emitSchemaDdl, emitPreludeDdl } from './emitDdl';
import { NO_SCHEMA_OVERRIDES } from './overrides';

const sub = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });

/** The descriptor of one hand-made schema, collection `things`. */
function handMade(schema: Schema, overrides: Partial<SchemaOverrides> = {}): SchemaDescriptor {
  return buildSchemaDescriptor([introspectSchema(schema, { collection: 'things' })], {
    ...NO_SCHEMA_OVERRIDES,
    ...overrides,
  });
}

/** What `format_type` prints for a descriptor SQL type. */
function formatType(sqlType: string): string {
  return sqlType.replace(' COLLATE "C"', '').replace('timestamptz', 'timestamp with time zone');
}

const ID = (n: number) => n.toString(16).padStart(24, '0');

describePostgres('PostgreSQL schema DDL', () => {
  const database = usePostgresTestDatabase();
  let pool: Pool;

  beforeAll(async () => {
    pool = database.pool();
    for (const statement of emitPreludeDdl()) await pool.query(statement);
  });

  /** Runs `fn` on a client whose search path is a new schema `name` (then `public`). */
  async function inSchema<T>(name: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${name}`);
      await client.query(`SET search_path TO ${name}, public`);
      return await fn(client);
    } finally {
      await client.query('SET search_path TO public').catch(() => undefined);
      client.release();
    }
  }

  describe('every production table', () => {
    const descriptor = generateSchemaDescriptor();

    beforeAll(async () => {
      for (const statement of emitSchemaDdl(descriptor, { prelude: false })) {
        await pool.query(statement);
      }
    }, 120_000);

    it('creates every table with exactly the descriptor columns, types, collations and nullability', async () => {
      const { rows } = await pool.query<{
        table: string;
        column: string;
        type: string;
        collation: string | null;
        notnull: boolean;
      }>(
        `SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                co.collname AS collation, a.attnotnull AS notnull
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           LEFT JOIN pg_collation co ON co.oid = a.attcollation
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            AND c.relname NOT LIKE 'kysely_%'
          ORDER BY c.relname, a.attnum`,
      );
      const actual = new Map<string, typeof rows>();
      for (const row of rows) actual.set(row.table, [...(actual.get(row.table) ?? []), row]);
      expect([...actual.keys()].sort()).toEqual(descriptor.tables.map((t) => t.name).sort());
      for (const table of descriptor.tables) {
        expect({ table: table.name, columns: actual.get(table.name) }).toEqual({
          table: table.name,
          columns: table.columns.map((column) => ({
            table: table.name,
            column: column.name,
            type: formatType(column.sqlType),
            collation: /text|lc_object_id/.test(column.sqlType) ? 'C' : null,
            notnull: !column.nullable,
          })),
        });
      }
    });

    it('creates every index, primary key and parent foreign key', async () => {
      const { rows: indexes } = await pool.query<{
        name: string;
        unique: boolean;
        partial: boolean;
      }>(
        `SELECT ic.relname AS name, i.indisunique AS unique, i.indpred IS NOT NULL AS partial
           FROM pg_index i
           JOIN pg_class ic ON ic.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = ic.relnamespace
          WHERE n.nspname = 'public' AND ic.relname NOT LIKE 'kysely_%'`,
      );
      const expected = descriptor.tables.flatMap((table) => [
        { name: primaryKeyName(table), unique: true, partial: false },
        ...table.indexes.map((index) => ({
          name: index.name,
          unique: index.unique,
          partial: index.where !== undefined,
        })),
      ]);
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      expect(indexes.sort(byName)).toEqual(expected.sort(byName));

      const { rows: keys } = await pool.query<{ name: string; table: string }>(
        `SELECT con.conname AS name, c.relname AS table FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid WHERE con.contype = 'f'`,
      );
      expect(keys.map((key) => key.name).sort()).toEqual(
        descriptor.tables
          .filter((table) => table.parent)
          .map((table) => parentKeyName(table))
          .sort(),
      );
      const { rows: checks } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND conname LIKE '%__hint%'`,
      );
      expect(Number(checks[0].count)).toBe(
        descriptor.tables.reduce((sum, table) => sum + table.checks.length, 0),
      );
    });

    it('enforces the hint CHECKs: no array step, a scalar leaf', async () => {
      const insert = (id: number, envelope: unknown) =>
        pool.query(
          /** `deliveryKey` is unique and not sparse: missing equals null, as in MongoDB. */
          `INSERT INTO agenttriggerdeliveries (_id, "deliveryKey", envelope) VALUES ($1, $2, $3)`,
          [ID(id), `key-${id}`, JSON.stringify(envelope)],
        );
      await insert(1, { event: { source: { type: 'slack', id: 'x' } }, other: [1, { a: 2 }] });
      await insert(2, { target: {} });
      await insert(3, null);
      await expect(insert(4, { event: [{ source: { type: 'slack' } }] })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert(5, { event: { source: { type: ['slack'] } } })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert(6, { target: { bindingId: { nested: true } } })).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert(7, [{ event: { type: 'x' } }])).rejects.toMatchObject({ code: '23514' });
      const { rows } = await pool.query(
        `SELECT _id FROM agenttriggerdeliveries
          WHERE (("envelope"::jsonb) #> '{"event","source","type"}') = '"slack"'::jsonb`,
      );
      expect(rows).toEqual([{ _id: ID(1) }]);
    });

    it('enforces uniques with MongoDB sparse semantics (an explicit null is indexed)', async () => {
      await pool.query(`INSERT INTO tokens (_id, scope) VALUES ($1, NULL), ($2, NULL)`, [
        ID(11),
        ID(12),
      ]);
      await pool.query(`INSERT INTO tokens (_id, scope, _nulls) VALUES ($1, NULL, '{scope}')`, [
        ID(13),
      ]);
      await expect(
        pool.query(`INSERT INTO tokens (_id, scope, _nulls) VALUES ($1, NULL, '{scope}')`, [
          ID(14),
        ]),
      ).rejects.toMatchObject({ code: '23505' });
      await pool.query(`INSERT INTO tokens (_id, scope) VALUES ($1, 'a')`, [ID(15)]);
      await expect(
        pool.query(`INSERT INTO tokens (_id, scope) VALUES ($1, 'a')`, [ID(16)]),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('rejects ids that are not 24 lowercase hex digits, and cascades deletes to child tables', async () => {
      await expect(
        pool.query(`INSERT INTO conversations (_id) VALUES ('ABCDEF0123456789abcdef01')`),
      ).rejects.toMatchObject({ code: '23514' });
      await pool.query(`INSERT INTO conversations (_id, "codeWorkspaces") VALUES ($1, 2)`, [
        ID(21),
      ]);
      await pool.query(
        `INSERT INTO "conversations__codeWorkspaces" (_parent, _ord, "environmentId", "agentIds")
         VALUES ($1, 0, 'e1', ARRAY['a1']), ($1, 1, 'e2', NULL)`,
        [ID(21)],
      );
      await pool.query(`DELETE FROM conversations WHERE _id = $1`, [ID(21)]);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM "conversations__codeWorkspaces"`,
      );
      expect(rows).toEqual([{ n: 0 }]);
    });

    it('keeps json text as written (key order) while jsonb queries see the same values', async () => {
      const text = '{"z":1,"a":{"y":2,"b":3}}';
      await pool.query(`INSERT INTO agents (_id, model_parameters) VALUES ($1, $2)`, [
        ID(31),
        text,
      ]);
      const { rows } = await pool.query(
        `SELECT model_parameters, (model_parameters::jsonb #>> '{a,b}') AS b FROM agents WHERE _id = $1`,
        [ID(31)],
      );
      expect(rows).toEqual([{ model_parameters: text, b: '3' }]);
    });
  });

  describe('hand-made schemas, one per rule', () => {
    const cases: Array<[string, SchemaDescriptor]> = [
      [
        'scalars',
        handMade(
          new Schema({
            s: String,
            n: Number,
            b: Boolean,
            d: Date,
            o: Schema.Types.ObjectId,
            x: Buffer,
          }),
        ),
      ],
      ['string ids', handMade(new Schema({ _id: String, items: [sub({ a: String })] }))],
      [
        'objects',
        handMade(
          new Schema({ profile: { geo: { lat: Number } }, settings: new Schema({ t: String }) }),
        ),
      ],
      [
        'scalar arrays and element tables',
        handMade(new Schema({ tags: [String], refs: [Schema.Types.ObjectId], tokens: [String] }), {
          elementTables: [{ collection: 'things', path: 'tokens', reason: 'spec' }],
        }),
      ],
      [
        'child tables',
        handMade(
          new Schema({
            items: [
              sub({
                sku: String,
                tags: [String],
                meta: Schema.Types.Mixed,
                box: sub({ w: Number }),
              }),
            ],
            actor: sub({ manifest: [sub({ name: String })] }),
          }),
        ),
      ],
      [
        'json',
        handMade(
          new Schema({
            m: Schema.Types.Mixed,
            list: [Schema.Types.Mixed],
            map: { type: Map, of: Number },
          }),
        ),
      ],
      [
        'system fields',
        handMade(
          new Schema(
            { tenantId: String, hidden: { type: String, select: false } },
            { timestamps: true },
          ),
        ),
      ],
    ];

    it.each(cases)('applies the DDL of %s', async (label, descriptor) => {
      const name = `rule_${label.replace(/\W+/g, '_')}`;
      await inSchema(name, async (client) => {
        for (const statement of emitSchemaDdl(descriptor, { prelude: false })) {
          await client.query(statement);
        }
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`,
          [name],
        );
        expect(rows[0].n).toBe(descriptor.tables.length);
      });
    });

    it('applies partial, sparse, TTL, GIN and hinted indexes, and the planner uses them', async () => {
      const schema = new Schema({
        user: String,
        slot: Number,
        deleting: Boolean,
        expiresAt: Date,
        tags: [String],
        envelope: Schema.Types.Mixed,
        favorites: [sub({ agentId: String })],
      });
      schema.index(
        { user: 1, slot: 1 },
        { unique: true, partialFilterExpression: { deleting: false, slot: { $exists: true } } },
      );
      schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      schema.index({ tags: 1, user: 1 });
      schema.index({ 'envelope.target.id': 1 });
      schema.index({ 'favorites.agentId': 1 }, { sparse: true });
      const descriptor = handMade(schema, {
        jsonHints: [
          { collection: 'things', path: 'envelope', subpaths: ['target.id'], reason: 'spec' },
        ],
      });
      await inSchema('rule_indexes', async (client) => {
        for (const statement of emitSchemaDdl(descriptor, { prelude: false })) {
          await client.query(statement);
        }
        await client.query(`SET enable_seqscan = off`);
        const plan = async (query: string) =>
          (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query}`)).rows
            .map((row) => row['QUERY PLAN'])
            .join('\n');
        expect(await plan(`SELECT * FROM things WHERE tags @> ARRAY['a']`)).toContain(
          'things__tags__gin',
        );
        expect(
          await plan(
            `SELECT * FROM things WHERE (("envelope"::jsonb) #> '{target,id}') = '"x"'::jsonb`,
          ),
        ).toContain('things__envelope_target_id');
        expect(
          await plan(`SELECT * FROM things WHERE "user" = 'u' AND slot = 1 AND deleting = false`),
        ).toContain('things__user__slot__p');
        await client.query(`RESET enable_seqscan`);

        await client.query(
          `INSERT INTO things (_id, "user", slot, deleting) VALUES ($1, 'u', 1, false), ($2, 'u', 1, true)`,
          [ID(1), ID(2)],
        );
        await expect(
          client.query(
            `INSERT INTO things (_id, "user", slot, deleting) VALUES ($1, 'u', 1, false)`,
            [ID(3)],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      });
    });

    it('applies a migration diff on existing rows: new columns and tables, removed fields to _extra', async () => {
      const before = handMade(
        new Schema({
          keep: String,
          gone: Number,
          when: Date,
          bytes: Buffer,
          box: { w: Number, h: Number },
          widen: String,
        }),
      );
      const afterSchema = new Schema({
        keep: String,
        added: Boolean,
        widen: Schema.Types.Mixed,
        items: [sub({ a: String })],
      });
      afterSchema.index({ keep: 1 });
      const after = handMade(afterSchema);
      await inSchema('rule_migration', async (client) => {
        for (const statement of emitSchemaDdl(before, { prelude: false }))
          await client.query(statement);
        await client.query(
          `INSERT INTO things (_id, keep, gone, "when", bytes, box, box__w, box__h, widen, _nulls, _extra)
           VALUES ($1, 'k', 1.5, '2024-01-02T03:04:05.678Z', '\\x0102', true, 2, NULL, 'w', '{box.h}', '{"legacy":1}'),
                  ($2, 'k2', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{gone}', NULL)`,
          [ID(1), ID(2)],
        );
        const changes = diffSchemaDescriptors(before, after);
        for (const { sql } of emitMigrationDdl(changes)) await client.query(sql);
        const { rows } = await client.query(
          `SELECT _id, keep, added, widen, items, _nulls, _extra FROM things ORDER BY _id`,
        );
        expect(
          rows.map((row) => ({
            ...row,
            _extra: row._extra == null ? null : JSON.parse(row._extra),
          })),
        ).toEqual([
          {
            _id: ID(1),
            keep: 'k',
            added: null,
            widen: '"w"',
            items: null,
            _nulls: null,
            _extra: {
              box: { h: null, w: 2 },
              gone: 1.5,
              when: { $date: '2024-01-02T03:04:05.678Z' },
              bytes: { $binary: 'AQI=' },
              legacy: 1,
            },
          },
          {
            _id: ID(2),
            keep: 'k2',
            added: null,
            widen: null,
            items: null,
            _nulls: null,
            _extra: { gone: null },
          },
        ]);
        const { rows: tables } = await client.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'rule_migration' ORDER BY tablename`,
        );
        expect(tables.map((row) => row.tablename)).toEqual(['things', 'things__items']);
      });
    });
  });
});

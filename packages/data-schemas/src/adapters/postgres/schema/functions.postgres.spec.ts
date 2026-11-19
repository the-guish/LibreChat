/**
 * The `lc_*` helper functions of `0001_initial` (`functions.ts`) on a real server, in a copy of
 * the migrated test template (which also shows the harness gives the whole schema).
 */
import type { Pool } from 'pg';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { SCHEMA_DESCRIPTOR } from './descriptor.generated';
import { LC_FAIL_SQLSTATE } from './functions';

describePostgres('PostgreSQL lc_* helper functions', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let pool: Pool;

  beforeAll(() => {
    pool = database.pool();
  });

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> =>
    (await pool.query<{ v: T }>(`SELECT ${text} AS v`, values)).rows[0].v;

  it('runs in a copy of the migrated template: every table, truncated by truncateAll', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`,
    );
    const names = rows.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining(SCHEMA_DESCRIPTOR.tables.map((table) => table.name)),
    );
    const id = 'a'.repeat(24);
    await pool.query(`INSERT INTO presets (_id, title) VALUES ($1, 'x')`, [id]);
    await pool.query(`INSERT INTO "presets__codeWorkspaces" (_parent, _ord) VALUES ($1, 0)`, [id]);
    await pool.query(`CREATE SCHEMA other; CREATE TABLE other.things (id int)`);
    await pool.query(`INSERT INTO other.things VALUES (1)`);
    await database.truncateAll();
    expect(await one<number>(`(SELECT count(*)::int FROM presets)`)).toBe(0);
    expect(await one<number>(`(SELECT count(*)::int FROM "presets__codeWorkspaces")`)).toBe(0);
    expect(await one<number>(`(SELECT count(*)::int FROM other.things)`)).toBe(0);
    /** The migration level stays. */
    expect(await one<number>(`(SELECT count(*)::int FROM kysely_migration)`)).toBeGreaterThan(0);
  });

  it('lc_fail raises its SQLSTATE in any type position, only when reached', async () => {
    await expect(one(`lc_fail('nope')`)).rejects.toMatchObject({
      code: LC_FAIL_SQLSTATE,
      message: 'nope',
    });
    await expect(
      one(`CASE WHEN $1::float8 IS NULL THEN lc_fail('null $inc', NULL::float8) ELSE $1 + 1 END`, [
        null,
      ]),
    ).rejects.toMatchObject({ code: LC_FAIL_SQLSTATE, message: 'null $inc' });
    expect(
      await one<number>(
        `CASE WHEN $1::float8 IS NULL THEN lc_fail('null $inc', NULL::float8) ELSE $1 + 1 END`,
        [2],
      ),
    ).toBe(3);
  });

  it('lc_nulls_set and lc_nulls_clear maintain _nulls (NULL when empty, order kept)', async () => {
    const set = (nulls: string[] | null, path: string, isNull: boolean | null) =>
      one<string[] | null>(`lc_nulls_set($1::text[], $2, $3)`, [nulls, path, isNull]);
    expect(await set(null, 'a', true)).toEqual(['a']);
    expect(await set(['b'], 'a', true)).toEqual(['b', 'a']);
    expect(await set(['a', 'b'], 'a', true)).toEqual(['a', 'b']);
    expect(await set(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(await set(['a'], 'a', false)).toBeNull();
    expect(await set(null, 'a', false)).toBeNull();
    expect(await set(['a'], 'a', null)).toBeNull();
    const clear = (nulls: string[] | null, path: string) =>
      one<string[] | null>(`lc_nulls_clear($1::text[], $2)`, [nulls, path]);
    expect(await clear(['x', 'box', 'box.w', 'boxer', 'box.h.d'], 'box')).toEqual(['x', 'boxer']);
    expect(await clear(['box.w'], 'box')).toBeNull();
    expect(await clear(null, 'box')).toBeNull();
  });

  it('lc_sort_key orders json values as MongoDB sorts them', async () => {
    /** Ascending MongoDB order; values on one line compare equal. */
    const ascending: Array<Array<string | null>> = [
      ['[]'],
      ['null', null],
      ['-1e300'],
      ['-5.5'],
      ['-0', '0', '0.0'],
      ['1e-300'],
      ['2'],
      ['10'],
      ['1e300'],
      ['""'],
      ['"A"'],
      ['"B"'],
      ['"a"'],
      ['"ab"'],
      ['"é"'],
      ['"😀"'],
      ['{"a":1}'],
      ['[[1]]'],
      ['{"$binary":"AQI="}'],
      ['false'],
      ['true'],
      ['{"$date":"1999-12-31T23:59:59.999Z"}'],
      ['{"$date":"2024-01-02T03:04:05.678Z"}'],
    ];
    const values = ascending.flat();
    const { rows } = await pool.query<{ position: number; key: string }>(
      `SELECT u.position::int AS position, lc_sort_key(u.value::jsonb, true) AS key
       FROM unnest($1::text[]) WITH ORDINALITY AS u (value, position)
       ORDER BY lc_sort_key(u.value::jsonb, true) COLLATE "C", u.position`,
      [values],
    );
    const keys = new Map(rows.map((row) => [values[row.position - 1], row.key]));
    for (let i = 0; i < ascending.length; i++) {
      for (const value of ascending[i]) {
        expect({ value, key: keys.get(value) }).toEqual({ value, key: keys.get(ascending[i][0]) });
        if (i > 0) {
          const before = keys.get(ascending[i - 1][0])!;
          expect({
            value,
            after: Buffer.compare(Buffer.from(before), Buffer.from(keys.get(value)!)),
          }).toEqual({
            value,
            after: -1,
          });
        }
      }
    }
  });

  it('lc_sort_key sorts an array by its minimum ascending and its maximum descending', async () => {
    const key = (value: string, ascending: boolean) =>
      one<string>(`lc_sort_key($1::jsonb, $2)`, [value, ascending]);
    expect(await key('[3, "x", null]', true)).toBe(await key('null', true));
    expect(await key('[3, "x"]', true)).toBe(await key('3', true));
    expect(await key('[3, "x"]', false)).toBe(await key('"x"', false));
    expect(await key('[]', false)).toBe('0');
    expect(await one<string>(`lc_sort_key(NULL, true)`)).toBe(await key('null', true));
  });
});

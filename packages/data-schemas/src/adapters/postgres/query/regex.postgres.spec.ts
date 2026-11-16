import type { Pool } from 'pg';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { usePostgresIcuDatabase } from '~/test/postgres/icu';
import { compileQuerySql, regexMatch, sql } from './sql';
import { translateRegex } from './regex';

/**
 * The regular expression translation (docs/postgres-port/PHASE4.md §2.4) on PostgreSQL: every
 * pattern, with and without `i`, must match exactly the strings JavaScript's `RegExp#test`
 * matches (the reference evaluator), on a C database and on an ICU `en-US` one. One documented
 * difference: ARE matches code points, as MongoDB's PCRE does, where JavaScript without `u`
 * matches UTF-16 code units (`.` against an emoji); that case is compared with the `u` flag. Also pins the
 * jsonpath check of §8 Q1: jsonpath compares strings by code point whatever the database locale,
 * while `jsonb` ordering follows the database collation (so the translator compares `json`
 * strings through `COLLATE "C"` text, never `jsonb` `<`).
 */

const STRINGS = [
  'alice',
  'Alice',
  'ALICE@EXAMPLE.ORG',
  'alice@example.com',
  'a.b',
  'a-b',
  'axb',
  'a\nb',
  'a b',
  'a b',
  'a b',
  'a\tb',
  'Élodie',
  'élodie',
  'ÉLODIE',
  '😀 smile',
  'ｚｅｄ',
  'ünïcödé',
  'x{2}',
  'word boundary',
  'wordy',
  'aab',
  'abab',
  '12345',
  'abc]',
  '',
  'ßtraße',
  'İstanbul',
];

const PATTERNS: Array<[string, string]> = [
  ['^al', ''],
  ['^al', 'i'],
  ['ALI', 'i'],
  ['^élo', 'i'],
  ['^ÉLO', 'i'],
  ['SMILE$', 'i'],
  ['^[a-z]+@example\\.(com|org)$', ''],
  ['^[a-z]+@example\\.(com|org)$', 'i'],
  ['a.b', ''],
  ['a.b', 'i'],
  ['a\\sb', ''],
  ['a\\Sb', ''],
  ['^\\w+$', ''],
  ['^\\w+$', 'i'],
  ['^\\W', ''],
  ['\\d{3}', ''],
  ['\\bword\\b', ''],
  ['\\Bord', ''],
  ['x\\{2\\}', ''],
  ['x{2}', ''],
  ['^(ab)+$', ''],
  ['^(a)\\1b$', ''],
  ['(?=ab)a', ''],
  ['a(?!a)b', ''],
  ['[^a-z]', ''],
  ['[^a-z]', 'i'],
  ['c\\]$', ''],
  ['^$', ''],
  ['😀', ''],
  /** `.` and an emoji: ARE (and MongoDB's PCRE) match code points, JavaScript code units. */
  ['^.\\s', 'u'],
  ['ｚ', 'i'],
  ['Ü', 'i'],
  ['\\u00e9', 'i'],
  ['\\x41', 'i'],
  ['ss', 'i'],
];

describePostgres('regular expressions on PostgreSQL match as JavaScript does', () => {
  const database = usePostgresTestDatabase();
  const icu = usePostgresIcuDatabase(database);
  let cPool: Pool | undefined;

  async function matches(pool: Pool, source: string, flags: string): Promise<string[]> {
    const regex = translateRegex(source, flags);
    const statement = compileQuerySql(
      sql`SELECT s FROM unnest(${sql.val(STRINGS)}::text[]) AS u (s) WHERE ${regexMatch(sql`u.s`, regex)} ORDER BY s`,
    );
    const { rows } = await pool.query(statement.text, statement.values);
    return rows.map((row) => row.s as string).sort();
  }

  describe.each(['C', 'ICU'] as const)('%s database', (locale) => {
    const pool = () => (locale === 'ICU' ? icu.pool() : (cPool ??= database.pool()));

    it.each(PATTERNS)('/%s/%s', async (source, flags) => {
      const expected = STRINGS.filter((value) => new RegExp(source, flags).test(value)).sort();
      /** `u` only stands for code point matching here: the pattern is translated without it. */
      expect(await matches(pool(), source, flags.replace('u', ''))).toEqual(expected);
    });
  });

  describe('string order inside json (ICU en-US database)', () => {
    it('jsonpath compares strings by code point, whatever the locale', async () => {
      const { rows } = await icu.pool().query(`SELECT
        '"B"'::jsonb @? '$ ? (@ < "a")' AS capital,
        '"é"'::jsonb @? '$ ? (@ > "z")' AS accent,
        '"ｚ"'::jsonb @? '$ ? (@ > "😀")' AS fullwidth`);
      expect(rows[0]).toEqual({ capital: true, accent: true, fullwidth: false });
    });

    it('jsonb ordering follows the database collation instead (not used by the translator)', async () => {
      const { rows } = await icu.pool().query(`SELECT '"B"'::jsonb < '"a"'::jsonb AS capital`);
      expect(rows[0].capital).toBe(false);
    });
  });
});

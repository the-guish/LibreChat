import type { Pool } from 'pg';
import type { FieldDescriptor } from '../schema/descriptor';
import type { RecordTable } from '../records/tables';
import type { StoreFilter } from '~/ports/query';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { decomposeRecord, insertStatements } from '../records/decompose';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { generateCorpusDocument } from '../records/corpusD';
import { createSchemaEngine } from '../schema/engine';
import { indexRecordTables } from '../records/tables';
import { matchesStoreFilter } from '~/ports/query';
import { readRecords } from '../records/assemble';
import { createQueryTranslator } from './index';
import { compileQuerySql, sql } from './sql';

/**
 * Corpus D filters (docs/postgres-port/PHASE4.md §2.5, R1's generator in `records/corpusD.ts`):
 * on every production table (53 collections and 10 raw collections, with their child and element
 * tables), each corpus D variant is built by the schema engine, inserted and read back, and every
 * declared path is filtered by equality with its value, `null`, `$ne`, `$exists: true` and
 * `$exists: false`. The SQL must agree with the reference evaluator over the record read back
 * (which R1's corpus D spec checks against `toObject()`). Catches mapping mistakes of the
 * translator (columns, shape columns, `_nulls`, child and element tables, `json`) mechanically.
 */

const descriptor = SCHEMA_DESCRIPTOR;
const tables = indexRecordTables(descriptor);
const translator = createQueryTranslator(tables);
const engine = createSchemaEngine();

const VARIANTS = ['full', 'nulls', 'topNulls', 'empty'] as const;

function enumOf(collection: string) {
  return (path: string) => {
    const type = engine.model(collection).schema.path(path) as unknown as
      | { enumValues?: unknown[]; caster?: { enumValues?: unknown[] } }
      | undefined;
    const values = type?.enumValues ?? type?.caster?.enumValues;
    return values && values.length > 0 ? values : undefined;
  };
}

/** A declared path of a collection's documents and whether equality applies to it. */
interface LeafPath {
  path: string;
  /** A scalar (or a scalar array's element) that equality can compare. */
  comparable: boolean;
}

/** Every declared path of `table`'s rows (document paths, under `prefix`). */
function leafPaths(
  table: RecordTable,
  fields: readonly FieldDescriptor[],
  prefix: string,
): LeafPath[] {
  const paths: LeafPath[] = [];
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.path.split('.').pop()}` : field.path;
    switch (field.kind) {
      case 'scalar':
        paths.push({ path, comparable: field.type !== 'buffer' });
        break;
      case 'array':
      case 'elements':
        paths.push({ path, comparable: field.element !== 'buffer' });
        break;
      case 'object':
        paths.push({ path, comparable: false });
        paths.push(...leafPaths(table, field.fields, path));
        break;
      case 'children': {
        paths.push({ path, comparable: false });
        const child = tables.table(field.table);
        paths.push(...leafPaths(child, child.descriptor.fields, path));
        break;
      }
      case 'json':
        paths.push({ path, comparable: false });
        break;
    }
  }
  return paths;
}

/** The first value at `path` in `record` (through arrays, their first element). */
function valueAt(record: unknown, segments: readonly string[]): unknown {
  let current = record;
  for (const segment of segments) {
    while (Array.isArray(current)) current = current[0];
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  while (Array.isArray(current)) current = current[0];
  return current;
}

describePostgres('query translator: corpus D filters on every production table', () => {
  const database = usePostgresTestDatabase({ template: 'migrated' });
  let pool: Pool;
  const roots = tables.roots.map((root) => root.descriptor.collection);

  beforeAll(() => {
    pool = database.pool();
  });

  it('covers every production table: 53 collections and 10 raw collections', () => {
    expect(roots).toHaveLength(63);
  });

  it.each(roots)('%s', async (collection) => {
    const root = tables.collection(collection);
    const paths = leafPaths(root, root.descriptor.fields, '');
    const keyColumns = root.descriptor.primaryKey;
    let seed = 700;
    let checked = 0;
    for (const variant of VARIANTS) {
      seed += 1;
      const input = generateCorpusDocument(tables, collection, variant, {
        seed,
        enumOf: enumOf(collection),
      });
      const built = await engine.buildDocument(collection, input, { validate: false });
      const decomposed = decomposeRecord(tables, collection, built);
      for (const statement of insertStatements(tables, [decomposed])) {
        await pool.query(statement.text, statement.values);
      }
      const key = keyColumns.map((column) => decomposed.row[column]);
      const where = keyColumns.map(
        (column, index) => `"t".${JSON.stringify(column)} = $${index + 1}`,
      );
      const [record] = await readRecords(pool, tables, collection, {
        where: where.join(' AND '),
        values: key,
        projection: { includeHidden: [...root.hidden] },
      });

      const filters: StoreFilter[] = [];
      for (const { path, comparable } of paths) {
        filters.push(
          { [path]: null },
          { [path]: { $exists: true } },
          { [path]: { $exists: false } },
        );
        const value = comparable ? valueAt(record, path.split('.')) : undefined;
        if (value !== undefined && value !== null) {
          filters.push({ [path]: value as never }, { [path]: { $ne: value as never } });
        }
      }
      const keyCondition = sql.join(
        keyColumns.map((column, index) => sql`${sql.id('t', column)} = ${sql.val(key[index])}`),
        sql` AND `,
      );
      const columns = filters.map(
        (filter, index) =>
          sql`(${translator.filter(collection, filter as Record<string, unknown>)}) AS ${sql.id(`f${index}`)}`,
      );
      const statement = compileQuerySql(
        sql`SELECT ${sql.join(columns, sql`, `)} FROM ${sql.id(root.descriptor.name)} AS "t" WHERE ${keyCondition}`,
      );
      const { rows } = await pool.query(statement.text, statement.values);
      expect(rows).toHaveLength(1);
      const mismatches = filters.flatMap((filter, index) => {
        const cast = translator.caster.castFilter(collection, filter as Record<string, unknown>);
        const expected = matchesStoreFilter(record, cast as StoreFilter);
        const actual = rows[0][`f${index}`] === true;
        return expected === actual ? [] : [{ variant, filter, expected, actual }];
      });
      expect(mismatches).toEqual([]);
      checked += filters.length;
      await pool.query(
        `DELETE FROM ${JSON.stringify(root.descriptor.name)} AS "t" WHERE ${where.join(' AND ')}`,
        key,
      );
    }
    expect(checked).toBeGreaterThan(0);
  });
});

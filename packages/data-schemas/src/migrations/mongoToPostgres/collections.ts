/**
 * The copy of one collection (or raw collection) into its table and child tables
 * (docs/postgres-port/PHASE4.md §8 X1, "Per collection"):
 *
 * 1. The source is streamed with the driver, oldest `_id` first, in batches, with 64-bit
 *    integers read as `bigint` (the driver would round those beyond 2^53 silently).
 * 2. Each document's BSON values are normalized (`bson.ts`), then the document is decomposed in
 *    the record codec's raw mode with exact values (`decomposeRecord`, `rawValues: 'exact'`): a
 *    parent row, child and element rows, `_nulls`, and `_extra` for what the schema does not
 *    describe or what does not fit its storage (D7), each such path reported.
 * 3. A batch is one transaction: `INSERT ... ON CONFLICT (_id) DO NOTHING RETURNING _id` for the
 *    parents, then the child rows of the parents it inserted. A record already there (an earlier
 *    run stopped half way) is left as it is with its children, so a run can be repeated until
 *    it completes. When the batch fails (a unique index the source data breaks), each record is
 *    retried in its own transaction and the ones that still fail are reported.
 * 4. Each record of the batch is read back through the collection primitive's raw mode (the
 *    assembled record, `_extra` merged) and compared with its source in canonical form
 *    (`canonical.ts`).
 */
import type { Db, Document } from 'mongodb';
import type { Pool, PoolClient } from 'pg';
import type { DecomposedRecord, RecordTables } from '~/adapters/postgres/records';
import type { PgCollections } from '~/adapters/postgres/collection';
import type { CollectionCopyReport } from './report';
import { decomposeRecord, insertRowsStatements } from '~/adapters/postgres/records';
import { addProblem, emptyCollectionReport, entryOf, sample } from './report';
import { normalizeBsonDocument, describeSourceId } from './bson';
import { toCanonical, firstDifference } from './canonical';

/** What a collection copy works with. */
export interface CollectionCopyContext {
  source: Db;
  pool: Pool;
  collections: PgCollections;
  tables: RecordTables;
  batchSize: number;
  dryRun: boolean;
  log(message: string): void;
}

/** A source document ready to write. */
interface Prepared {
  id: string;
  source: Record<string, unknown>;
  record: DecomposedRecord;
}

/** A short, safe description of a failure (no values: they may hold user data). */
export function describeFailure(error: unknown): string {
  if (error && typeof error === 'object') {
    const pg = error as { code?: unknown; constraint?: unknown; message?: unknown };
    if (pg.code === '23505') {
      return `duplicate key in PostgreSQL${typeof pg.constraint === 'string' ? ` (${pg.constraint})` : ''}`;
    }
    if (typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
      return `PostgreSQL error ${pg.code}${typeof pg.constraint === 'string' ? ` (${pg.constraint})` : ''}`;
    }
    if (typeof pg.message === 'string') {
      return pg.message.length > 300 ? `${pg.message.slice(0, 299)}…` : pg.message;
    }
  }
  return String(error);
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Inserts `records` (all of one table) unless their `_id` exists, with the children of the ones
 * inserted, on `client`; resolves to the ids inserted.
 */
async function insertRecords(
  client: PoolClient,
  tables: RecordTables,
  records: readonly DecomposedRecord[],
): Promise<Set<string>> {
  const inserted = new Set<string>();
  if (records.length === 0) {
    return inserted;
  }
  const table = records[0].table;
  for (const statement of insertRowsStatements(
    tables,
    table,
    records.map((record) => record.row),
  )) {
    const { rows } = await client.query<{ _id: string }>(
      `${statement.text} ON CONFLICT ("_id") DO NOTHING RETURNING "_id"`,
      statement.values,
    );
    for (const row of rows) inserted.add(row._id);
  }
  const children = new Map<string, Array<Record<string, unknown>>>();
  for (const record of records) {
    if (record.id === null || !inserted.has(record.id)) continue;
    for (const child of record.children) {
      const rows = children.get(child.table) ?? [];
      rows.push(...child.rows);
      children.set(child.table, rows);
    }
  }
  for (const [childTable, rows] of children) {
    for (const statement of insertRowsStatements(tables, childTable, rows)) {
      await client.query(statement.text, statement.values);
    }
  }
  return inserted;
}

/** Writes a batch (see the module header); resolves to the ids inserted and those that failed. */
async function writeBatch(
  context: CollectionCopyContext,
  report: CollectionCopyReport,
  batch: readonly Prepared[],
): Promise<Set<string>> {
  const records = batch.map((item) => item.record);
  try {
    const inserted = await inTransaction(context.pool, (client) =>
      insertRecords(client, context.tables, records),
    );
    report.inserted += inserted.size;
    report.existing += batch.length - inserted.size;
    return new Set();
  } catch {
    /** One record breaks the batch: retry each alone, so only the failing ones are left out. */
  }
  const failed = new Set<string>();
  for (const item of batch) {
    try {
      const inserted = await inTransaction(context.pool, (client) =>
        insertRecords(client, context.tables, [item.record]),
      );
      if (inserted.size > 0) report.inserted += 1;
      else report.existing += 1;
    } catch (error) {
      failed.add(item.id);
      report.failed += 1;
      addProblem(report.failures, { id: item.id, message: describeFailure(error) });
    }
  }
  return failed;
}

/** Reads the batch back and compares each record with its source. */
async function verifyBatch(
  context: CollectionCopyContext,
  report: CollectionCopyReport,
  collection: string,
  batch: readonly Prepared[],
): Promise<void> {
  if (batch.length === 0) return;
  const stored = await context.collections
    .raw(collection)
    .find({ _id: { $in: batch.map((item) => item.record.id) } });
  const byId = new Map(stored.map((record) => [String(record._id), record]));
  for (const item of batch) {
    const record = byId.get(item.record.id ?? '');
    const difference = record
      ? firstDifference(toCanonical(item.source), toCanonical(record))
      : { path: '(record)', expected: 'present', actual: 'missing' };
    if (difference) {
      report.mismatched += 1;
      addProblem(report.mismatches, {
        id: item.id,
        message: `${difference.path}: expected ${difference.expected}, found ${difference.actual}`,
      });
    } else {
      report.verified += 1;
    }
  }
}

/** Normalizes and decomposes one source document, recording what the report needs. */
function prepare(
  context: CollectionCopyContext,
  report: CollectionCopyReport,
  collection: string,
  document: Document,
): Prepared | undefined {
  const id = describeSourceId(document._id);
  const { value, findings } = normalizeBsonDocument(document);
  if (findings.nulStrings > 0) sample(report.nul, id);
  for (const long of findings.longs) {
    sample(
      entryOf(
        report.longs,
        (entry) => entry.path === long.path,
        () => ({ path: long.path, detail: long.value, count: 0, sampleIds: [] }),
      ),
      id,
    );
  }
  for (const item of findings.unsupported) {
    sample(
      entryOf(
        report.unsupported,
        (entry) => entry.path === item.path && entry.detail === item.type,
        () => ({ path: item.path, detail: item.type, count: 0, sampleIds: [] }),
      ),
      id,
    );
  }
  let record: DecomposedRecord;
  try {
    record = decomposeRecord(context.tables, collection, value, {
      mode: 'raw',
      rawValues: 'exact',
      countNul: false,
    });
  } catch (error) {
    report.failed += 1;
    addProblem(report.failures, { id, message: describeFailure(error) });
    return undefined;
  }
  for (const diverted of record.diverted) {
    sample(
      entryOf(
        report.diverted,
        (entry) =>
          entry.table === diverted.table &&
          entry.path === diverted.path &&
          entry.reason === diverted.reason,
        () => ({ ...diverted, count: 0, sampleIds: [] }),
      ),
      id,
    );
  }
  return { id, source: value, record };
}

/** Copies the collection `collection` into its table (see the module header). */
export async function copyCollection(
  context: CollectionCopyContext,
  collection: string,
): Promise<CollectionCopyReport> {
  const table = context.tables.collection(collection).descriptor.name;
  const report = emptyCollectionReport(collection, 'table', table);
  const cursor = context.source
    .collection(collection)
    .find({}, { sort: { _id: 1 }, batchSize: context.batchSize, useBigInt64: true });
  let batch: Prepared[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    if (context.dryRun) return;
    const failed = await writeBatch(context, report, current);
    await verifyBatch(
      context,
      report,
      collection,
      current.filter((item) => !failed.has(item.id)),
    );
  };
  try {
    for await (const document of cursor) {
      report.read += 1;
      const prepared = prepare(context, report, collection, document);
      if (prepared) batch.push(prepared);
      if (batch.length >= context.batchSize) {
        await flush();
        if (report.read % (context.batchSize * 20) === 0) {
          context.log(`  ${collection}: ${report.read} read`);
        }
      }
    }
    await flush();
  } finally {
    await cursor.close();
  }
  return report;
}

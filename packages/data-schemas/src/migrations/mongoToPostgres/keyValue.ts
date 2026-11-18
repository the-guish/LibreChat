/**
 * The copy of the Keyv collections and their GridFS buckets into `key_value_entries`
 * (docs/postgres-port/PHASE4.md §8 I1 and X1): the `store` column is the MongoDB collection the
 * entries live in, so the PostgreSQL key-value store of the same name and mode finds them.
 *
 * - **A Keyv collection** (`{ key, value, expiresAt }` documents, `keyv` for the unnamed store):
 *   one row per key, `value` as text, `expires_at` from `expiresAt`. MongoDB has no unique index on
 *   `key`, and a read returns the first match in insertion order, so the first document of a key
 *   (in natural order) is kept and the others are counted as duplicates.
 * - **A GridFS bucket** (`<name>.files` with `<name>.chunks`, a `largeValues` store): one row per
 *   file name, the newest revision (as `openDownloadStreamByName` reads it), its bytes in
 *   `value_bytes`, `expires_at` from `metadata.expiresAt`; older revisions are counted as
 *   duplicates.
 *
 * Rows are inserted with `ON CONFLICT (store, key) DO NOTHING`, so a repeated run keeps the rows
 * an earlier one wrote, and read back and compared. Keys, text values and store names get U+0000
 * replaced with U+FFFD (D8), as the store does on write; bytes are copied as they are.
 */
import type { Db, Document } from 'mongodb';
import type { Pool } from 'pg';
import type { CollectionCopyReport } from './report';
import { addProblem, emptyCollectionReport, sample } from './report';
import { replaceNul } from '~/adapters/postgres/values';
import { describeFailure } from './collections';
import { describeSourceId } from './bson';

/** The table of the PostgreSQL key-value store. */
const TABLE = 'key_value_entries';
/** The fields of a Keyv document. */
const KEYV_FIELDS = new Set(['_id', 'key', 'value', 'expiresAt']);

/** One entry to write. */
interface Entry {
  sourceId: string;
  key: string;
  value: string | null;
  bytes: Buffer | null;
  expiresAt: Date | null;
}

/** Whether the documents of `collection` (a sample) look like Keyv entries. */
export async function isKeyvCollection(source: Db, collection: string): Promise<boolean> {
  const documents = await source.collection(collection).find({}).limit(20).toArray();
  return (
    documents.length > 0 &&
    documents.every(
      (document) =>
        typeof document.key === 'string' &&
        Object.keys(document).every((key) => KEYV_FIELDS.has(key)),
    )
  );
}

function hasNul(value: string | null): boolean {
  return value !== null && value.includes('\u0000');
}

/** Inserts `entries` of `store`; resolves to the keys inserted. */
async function insertEntries(
  pool: Pool,
  store: string,
  entries: readonly Entry[],
): Promise<Set<string>> {
  const values: unknown[] = [];
  const tuples = entries.map((entry) => {
    values.push(store, entry.key, entry.value, entry.bytes, entry.expiresAt);
    const n = values.length;
    return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  const { rows } = await pool.query<{ key: string }>(
    `INSERT INTO ${TABLE} (store, key, value, value_bytes, expires_at) VALUES ${tuples.join(', ')}
      ON CONFLICT (store, key) DO NOTHING RETURNING key`,
    values,
  );
  return new Set(rows.map((row) => row.key));
}

/** Reads `entries` back and compares them with what was written. */
async function verifyEntries(
  pool: Pool,
  report: CollectionCopyReport,
  store: string,
  entries: readonly Entry[],
): Promise<void> {
  const { rows } = await pool.query<{
    key: string;
    value: string | null;
    value_bytes: Buffer | null;
    expires_at: Date | null;
  }>(
    `SELECT key, value, value_bytes, expires_at FROM ${TABLE} WHERE store = $1 AND key = ANY ($2::text[])`,
    [store, entries.map((entry) => entry.key)],
  );
  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const entry of entries) {
    const row = byKey.get(entry.key);
    let problem: string | undefined;
    if (!row) {
      problem = 'missing in PostgreSQL';
    } else if (entry.bytes ? !row.value_bytes?.equals(entry.bytes) : row.value !== entry.value) {
      problem = 'the value differs';
    } else if ((row.expires_at?.getTime() ?? null) !== (entry.expiresAt?.getTime() ?? null)) {
      problem = 'the expiry differs';
    }
    if (problem) {
      report.mismatched += 1;
      addProblem(report.mismatches, { id: entry.sourceId, message: `${entry.key}: ${problem}` });
    } else {
      report.verified += 1;
    }
  }
}

/** Writes and verifies a batch of entries. */
async function flushEntries(
  pool: Pool,
  report: CollectionCopyReport,
  store: string,
  entries: Entry[],
  dryRun: boolean,
): Promise<void> {
  if (entries.length === 0 || dryRun) return;
  try {
    const inserted = await insertEntries(pool, store, entries);
    report.inserted += inserted.size;
    report.existing += entries.length - inserted.size;
  } catch (error) {
    report.failed += entries.length;
    addProblem(report.failures, { id: entries[0].sourceId, message: describeFailure(error) });
    return;
  }
  await verifyEntries(pool, report, store, entries);
}

function toExpiry(value: unknown): Date | null | undefined {
  if (value === null || value === undefined) return null;
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined;
}

/** Copies the Keyv collection `collection` (see the module header). */
export async function copyKeyvCollection(
  source: Db,
  pool: Pool,
  collection: string,
  options: { batchSize: number; dryRun: boolean },
): Promise<CollectionCopyReport> {
  const store = replaceNul(collection, { countNul: false });
  const report = emptyCollectionReport(collection, 'keyValue', TABLE);
  report.duplicateKeys = 0;
  const seen = new Set<string>();
  let batch: Entry[] = [];
  const cursor = source
    .collection(collection)
    .find({}, { sort: { $natural: 1 }, batchSize: options.batchSize });
  try {
    for await (const document of cursor) {
      report.read += 1;
      const sourceId = describeSourceId(document._id);
      const expiresAt = toExpiry(document.expiresAt);
      if (typeof document.key !== 'string' || expiresAt === undefined) {
        report.failed += 1;
        addProblem(report.failures, {
          id: sourceId,
          message: 'not a Keyv entry (key must be a string, expiresAt a date)',
        });
        continue;
      }
      if (
        document.value !== undefined &&
        document.value !== null &&
        typeof document.value !== 'string'
      ) {
        report.failed += 1;
        addProblem(report.failures, { id: sourceId, message: 'the value is not a string' });
        continue;
      }
      const rawValue = typeof document.value === 'string' ? document.value : null;
      if (hasNul(document.key) || hasNul(rawValue)) sample(report.nul, sourceId);
      const key = replaceNul(document.key, { countNul: false });
      if (seen.has(key)) {
        report.duplicateKeys += 1;
        continue;
      }
      seen.add(key);
      batch.push({
        sourceId,
        key,
        value: rawValue === null ? null : replaceNul(rawValue, { countNul: false }),
        bytes: null,
        expiresAt,
      });
      if (batch.length >= options.batchSize) {
        await flushEntries(pool, report, store, batch, options.dryRun);
        batch = [];
      }
    }
    await flushEntries(pool, report, store, batch, options.dryRun);
  } finally {
    await cursor.close();
  }
  return report;
}

/** The bytes of a GridFS file, from its chunks in order. */
async function readGridFile(source: Db, bucket: string, file: Document): Promise<Buffer> {
  const chunks = await source
    .collection(`${bucket}.chunks`)
    .find({ files_id: file._id }, { sort: { n: 1 } })
    .toArray();
  const parts = chunks.map((chunk) => {
    const data = chunk.data as { buffer?: Uint8Array; position?: number } | Buffer;
    if (Buffer.isBuffer(data)) return data;
    const bytes = data.buffer ?? new Uint8Array();
    return Buffer.from(bytes.subarray(0, data.position ?? bytes.length));
  });
  return Buffer.concat(parts);
}

/** Copies the GridFS bucket `bucket` (its `<bucket>.files` collection names the store). */
export async function copyGridFsBucket(
  source: Db,
  pool: Pool,
  bucket: string,
  options: { batchSize: number; dryRun: boolean },
): Promise<CollectionCopyReport> {
  const filesCollection = `${bucket}.files`;
  const store = replaceNul(filesCollection, { countNul: false });
  const report = emptyCollectionReport(filesCollection, 'gridfs', TABLE);
  report.duplicateKeys = 0;
  let previous: string | undefined;
  let batch: Entry[] = [];
  /** Newest revision first within a name, as `openDownloadStreamByName` picks it. */
  const cursor = source
    .collection(filesCollection)
    .find({}, { sort: { filename: 1, uploadDate: -1, _id: -1 }, batchSize: options.batchSize });
  try {
    for await (const file of cursor) {
      report.read += 1;
      const sourceId = describeSourceId(file._id);
      if (typeof file.filename !== 'string') {
        report.failed += 1;
        addProblem(report.failures, { id: sourceId, message: 'the file has no name' });
        continue;
      }
      if (file.filename === previous) {
        report.duplicateKeys += 1;
        continue;
      }
      previous = file.filename;
      const expiresAt = toExpiry((file.metadata as Document | undefined)?.expiresAt);
      if (hasNul(file.filename)) sample(report.nul, sourceId);
      batch.push({
        sourceId,
        key: replaceNul(file.filename, { countNul: false }),
        value: null,
        bytes: options.dryRun ? Buffer.alloc(0) : await readGridFile(source, bucket, file),
        expiresAt: expiresAt ?? null,
      });
      if (batch.length >= Math.max(1, Math.floor(options.batchSize / 10))) {
        await flushEntries(pool, report, store, batch, options.dryRun);
        batch = [];
      }
    }
    await flushEntries(pool, report, store, batch, options.dryRun);
  } finally {
    await cursor.close();
  }
  return report;
}

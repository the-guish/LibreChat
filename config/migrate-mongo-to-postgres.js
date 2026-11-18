/**
 * `npm run migrate:mongo-to-postgres`: copies a MongoDB deployment into PostgreSQL
 * (docs/postgres-port/PHASE4.md §8 X1). MongoDB only on its source side: it opens the source with
 * the MongoDB driver (`MONGO_URI`), so it is exempt from the data-layer lint rule by name, as the
 * other legacy scripts are; the copy itself is `copyMongoToPostgres` of `@librechat/data-schemas`
 * (build it first: `npm run build:data-schemas`).
 *
 * Run order:
 *   1. run the MongoDB-only legacy migrations this version still needs
 *      (docs/postgresql-migrating-from-mongodb.md);
 *   2. stop LibreChat;
 *   3-5. run this script: it refuses a source or target that does not match this LibreChat
 *      version, migrates PostgreSQL, copies every collection, the key-value entries and the
 *      agent checkpoints, and verifies each record;
 *   6. set `DATABASE_BACKEND=postgres` and start LibreChat.
 *
 * Usage:
 *   npm run migrate:mongo-to-postgres -- [--dry-run] [--collections=users,messages]
 *     [--batch-size=500] [--checkpoint-storage=<checkpoints>:<writes>]
 *     [--allow-source-index-mismatch] [--json]
 *
 * Reads `MONGO_URI` (the source), `POSTGRES_URI` and `POSTGRES_SCHEMA` (the target) from the
 * environment or `.env`. A repeated run keeps what an earlier one copied, so an interrupted copy
 * is resumed by running it again. Exits with 1 when the copy is refused, a record could not be
 * copied or a record reads back different from its source.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
const {
  copyMongoToPostgres,
  formatMongoToPostgresReport,
  MongoToPostgresCopyRefusedError,
} = require('@librechat/data-schemas');

/** @param {string} name */
function option(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/** @param {string} name */
function options(name) {
  const prefix = `--${name}=`;
  return process.argv
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
}

/** @returns {Array<{ checkpointCollectionName: string, checkpointWritesCollectionName: string }>} */
function checkpointStorages() {
  return options('checkpoint-storage').map((value) => {
    const [checkpointCollectionName, checkpointWritesCollectionName] = value.split(':');
    if (!checkpointCollectionName || !checkpointWritesCollectionName) {
      throw new Error(`--checkpoint-storage takes <checkpoints>:<writes>, got "${value}"`);
    }
    return { checkpointCollectionName, checkpointWritesCollectionName };
  });
}

(async () => {
  let exitCode = 0;
  /** @type {import('mongodb').MongoClient | undefined} */
  let client;
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI must name the MongoDB database to copy from');
    }
    if (!process.env.POSTGRES_URI) {
      throw new Error('POSTGRES_URI must name the PostgreSQL database to copy into');
    }
    const collections = option('collections');
    const batchSize = option('batch-size');
    client = await MongoClient.connect(process.env.MONGO_URI);
    const report = await copyMongoToPostgres({
      mongo: { client },
      env: process.env,
      dryRun: process.argv.includes('--dry-run'),
      collections: collections ? collections.split(',').map((name) => name.trim()) : undefined,
      batchSize: batchSize ? parseInt(batchSize, 10) || undefined : undefined,
      checkpointStorages: checkpointStorages(),
      allowSourceIndexMismatch: process.argv.includes('--allow-source-index-mismatch'),
      log: (message) => console.log(message),
    });
    console.log('');
    console.log(formatMongoToPostgresReport(report));
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    }
    exitCode = report.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof MongoToPostgresCopyRefusedError) {
      console.error(`Copy refused: ${error.message}`);
    } else {
      console.error('MongoDB → PostgreSQL copy failed:', error);
    }
    exitCode = 1;
  } finally {
    await client?.close();
  }
  process.exit(exitCode);
})();

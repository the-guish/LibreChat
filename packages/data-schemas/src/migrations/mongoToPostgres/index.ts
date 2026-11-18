/**
 * The MongoDB → PostgreSQL copy (docs/postgres-port/PHASE4.md §8 X1; the CLI is
 * `config/migrate-mongo-to-postgres.js`). {@link copyMongoToPostgres} runs steps 3 to 5 of the
 * run order, on a stopped deployment whose legacy MongoDB migrations have run:
 *
 * 3. **Versions** (`schema.ts`): the source must hold this version's indexes, the PostgreSQL
 *    schema must not be a newer version's; its pending migrations are applied and the live
 *    tables checked against the descriptor.
 * 4. **Copy**: every collection and raw collection of the descriptor into its tables
 *    (`collections.ts`: raw-mode decomposition, `_extra` for what does not fit, batched
 *    `INSERT ... ON CONFLICT (_id) DO NOTHING`); the Keyv collections and GridFS buckets into
 *    `key_value_entries` (`keyValue.ts`); the LangGraph checkpoints of every storage through the
 *    PostgreSQL saver (`checkpoints.ts`). The storage descriptors and deletion intents are raw
 *    collections, so they are copied as the others; `_meili*` flags are ordinary columns copied
 *    as they are, so the MeiliSearch index stays valid.
 * 5. **Verify**: each record is read back and compared with its source as it is written.
 *
 * Collections the tool does not know (no table, not a Keyv collection, a bucket or a checkpoint
 * storage) are left out and listed. The run is repeatable: rows already there are kept.
 */
import { Kysely, PostgresDialect } from 'kysely';
import type { MongoClient } from 'mongodb';
import type { CollectionCopyReport, MongoToPostgresReport } from './report';
import type { CheckpointStorageNames } from '~/ports/checkpointStore';
import type { PostgresTables } from '~/adapters/postgres/types';
import { createPostgresPool, readPostgresConnectionSettings } from '~/adapters/postgres/connection';
import { findMissingSourceIndexes, preparePostgresSchema, sourceMismatchError } from './schema';
import { SCHEMA_DESCRIPTOR } from '~/adapters/postgres/schema/descriptor.generated';
import { copyGridFsBucket, copyKeyvCollection, isKeyvCollection } from './keyValue';
import { copyCheckpointStorage, findCheckpointStorages } from './checkpoints';
import { createPgCollections } from '~/adapters/postgres/collection';
import { indexRecordTables } from '~/adapters/postgres/records';
import { copyCollection } from './collections';

export { formatMongoToPostgresReport } from './report';
export { MongoToPostgresCopyRefusedError } from './schema';
export type {
  SchemaReport,
  RecordProblem,
  SampledCount,
  DivertedPathReport,
  ConvertedPathReport,
  CheckpointCopyReport,
  CollectionCopyReport,
  MongoToPostgresReport,
} from './report';

/** Options of {@link copyMongoToPostgres}. */
export interface MongoToPostgresCopyOptions {
  /** The connected source: its client, and the database (the URI's when not given). */
  mongo: { client: MongoClient; dbName?: string };
  /** Where to copy: `POSTGRES_URI` and `POSTGRES_SCHEMA`, as the server reads them. */
  env: Readonly<Record<string, string | undefined>>;
  /** Read and check everything, write nothing (no migration either). */
  dryRun?: boolean;
  /** Copy only these MongoDB collections (a bucket by `<name>.files`, a storage by either name). */
  collections?: readonly string[];
  /** Documents per batch (and transaction). Default 500. */
  batchSize?: number;
  /** Checkpoint storages beyond the default and those the descriptors and intents name. */
  checkpointStorages?: readonly CheckpointStorageNames[];
  /** Report this version's indexes missing in MongoDB instead of refusing the copy. */
  allowSourceIndexMismatch?: boolean;
  /** Progress lines. */
  log?: (message: string) => void;
}

const DEFAULT_BATCH_SIZE = 500;

/** The names of the collections the source holds (system collections left out). */
async function listSourceCollections(
  client: MongoClient,
  dbName: string | undefined,
): Promise<Set<string>> {
  const collections = await client.db(dbName).listCollections({}, { nameOnly: true }).toArray();
  return new Set(
    collections
      .filter((entry) => entry.type === undefined || entry.type === 'collection')
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('system.')),
  );
}

/**
 * Copies the MongoDB database of `options.mongo` into the PostgreSQL database of `options.env`
 * (see the module header) and resolves to the report; `report.ok` is false when a record could
 * not be copied or reads back different. Rejects with a `MongoToPostgresCopyRefusedError` when
 * the versions do not match, before anything is written.
 */
export async function copyMongoToPostgres(
  options: MongoToPostgresCopyOptions,
): Promise<MongoToPostgresReport> {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun ?? false;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const client = options.mongo.client;
  const source = client.db(options.mongo.dbName);
  const present = await listSourceCollections(client, options.mongo.dbName);
  const wanted = (names: readonly string[]) =>
    !options.collections || names.some((name) => options.collections!.includes(name));

  const tables = indexRecordTables(SCHEMA_DESCRIPTOR);
  const sourceWarnings: string[] = [];
  const missingIndexes = await findMissingSourceIndexes(source, SCHEMA_DESCRIPTOR, present);
  if (missingIndexes.length > 0) {
    if (!options.allowSourceIndexMismatch) {
      throw sourceMismatchError(missingIndexes);
    }
    sourceWarnings.push(
      `MongoDB lacks ${missingIndexes.length} index(es) of this version: ${missingIndexes.slice(0, 10).join(', ')}`,
    );
  }

  const settings = readPostgresConnectionSettings(options.env);
  const pool = createPostgresPool(settings);
  const db = new Kysely<PostgresTables>({ dialect: new PostgresDialect({ pool }) });
  try {
    log(`Checking the PostgreSQL schema "${settings.schema}"`);
    const schema = await preparePostgresSchema(db, settings.schema, SCHEMA_DESCRIPTOR, { dryRun });
    const collections = createPgCollections({ db, descriptor: SCHEMA_DESCRIPTOR, engine: null });
    const reports: CollectionCopyReport[] = [];
    const handled = new Set<string>();

    for (const root of tables.roots) {
      const { collection } = root.descriptor;
      if (!root.descriptor.primaryKey.includes('_id') || !present.has(collection)) continue;
      handled.add(collection);
      if (!wanted([collection])) continue;
      log(`Copying ${collection}`);
      reports.push(
        await copyCollection(
          { source, pool, collections, tables, batchSize, dryRun, log },
          collection,
        ),
      );
    }

    const checkpointStorages = await findCheckpointStorages(
      source,
      present,
      options.checkpointStorages,
    );
    for (const storage of checkpointStorages) {
      handled.add(storage.checkpointCollectionName);
      handled.add(storage.checkpointWritesCollectionName);
    }

    for (const name of [...present].sort()) {
      if (handled.has(name) || !name.endsWith('.files')) continue;
      const bucket = name.slice(0, -'.files'.length);
      if (!present.has(`${bucket}.chunks`)) continue;
      handled.add(name);
      handled.add(`${bucket}.chunks`);
      if (!wanted([name, bucket])) continue;
      log(`Copying the GridFS bucket ${bucket}`);
      reports.push(await copyGridFsBucket(source, pool, bucket, { batchSize, dryRun }));
    }

    const skippedCollections: MongoToPostgresReport['skippedCollections'] = [];
    for (const name of [...present].sort()) {
      if (handled.has(name)) continue;
      if (await isKeyvCollection(source, name)) {
        handled.add(name);
        if (!wanted([name])) continue;
        log(`Copying the key-value collection ${name}`);
        reports.push(await copyKeyvCollection(source, pool, name, { batchSize, dryRun }));
        continue;
      }
      if (!wanted([name])) continue;
      skippedCollections.push({
        collection: name,
        documents: await source.collection(name).countDocuments(),
        reason: 'not part of LibreChat’s data model',
      });
    }

    const checkpoints = [];
    for (const storage of checkpointStorages) {
      if (!wanted([storage.checkpointCollectionName, storage.checkpointWritesCollectionName])) {
        continue;
      }
      log(`Copying the checkpoints of ${storage.checkpointCollectionName}`);
      checkpoints.push(
        await copyCheckpointStorage(
          { client, source, pool, schema: settings.schema, collections, dryRun, log },
          storage,
        ),
      );
    }

    const ok =
      reports.every((report) => report.failed === 0 && report.mismatched === 0) &&
      checkpoints.every((report) => report.failed === 0 && report.mismatched === 0);
    return {
      dryRun,
      schema,
      collections: reports,
      checkpoints,
      skippedCollections,
      sourceWarnings,
      ok,
    };
  } finally {
    await db.destroy();
  }
}

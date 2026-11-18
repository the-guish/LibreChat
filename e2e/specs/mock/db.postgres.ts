/**
 * The PostgreSQL half of `db.ts` (`E2E_DATABASE_BACKEND=postgres`, docs/postgres-port/PHASE4.md
 * §7, E1), loaded only on PostgreSQL: `withMongo(fn)` hands `fn` the raw facade of
 * `@librechat/data-schemas/testing` (`createRawDatabase`) in place of the driver's `Db`.
 *
 * `db.collection(name)` reaches the table of that collection through the collection primitive's
 * raw mode, with the driver's shapes: `find(filter, options)` with `sort`/`project`/`limit`/
 * `skip` and `toArray()`, `findOne`, `countDocuments`, `insertOne`/`insertMany`
 * (`insertedId(s)`), `updateOne`/`updateMany` (`upsert`), `deleteOne`/`deleteMany`. Values are
 * cast by the schema descriptor (24-hex strings and ObjectIds to ids, ISO strings to dates) with
 * no defaults, hooks or timestamps, as a driver write; undeclared fields go to `_extra`. Ids come
 * back as 24-hex strings, not ObjectIds. Filters take the portable query language (`$in`,
 * `$regex`, `$or`, ...), updates the primitive's operators (`$set`, `$unset`, `$setOnInsert`,
 * `$inc`, `$push`, ...). A filter on a path the schema does not declare is refused. Nothing else
 * of the driver's `Db` exists (`listCollections`, `aggregate`, `bulkWrite`, cursors beyond
 * `toArray`, sessions).
 */
import fs from 'fs';
import type { Db } from 'mongodb';
import { createRawDatabase } from '@librechat/data-schemas/testing';
import { getRuntimeEnvPath } from '../../setup/env';

/** `POSTGRES_URI` (and `POSTGRES_SCHEMA`) from the runtime env file `start-server*.js` wrote. */
function getPostgresEnv(): Record<string, string | undefined> {
  let runtimeEnv: Record<string, string | undefined> = {};
  try {
    runtimeEnv = JSON.parse(fs.readFileSync(getRuntimeEnvPath(), 'utf8')) as typeof runtimeEnv;
  } catch {
    /* fall through to the process environment */
  }
  const env = {
    POSTGRES_URI: runtimeEnv.POSTGRES_URI ?? process.env.POSTGRES_URI,
    POSTGRES_SCHEMA: runtimeEnv.POSTGRES_SCHEMA ?? process.env.POSTGRES_SCHEMA,
  };
  if (!env.POSTGRES_URI) {
    throw new Error(
      'E2E_DATABASE_BACKEND=postgres, but neither the runtime env file nor the environment names POSTGRES_URI',
    );
  }
  return env;
}

/** Opens the facade on the e2e PostgreSQL database, runs `fn`, and always closes its pool. */
export async function withPostgres<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const database = createRawDatabase({ env: getPostgresEnv() });
  try {
    return await fn(database as unknown as Db);
  } finally {
    await database.close();
  }
}

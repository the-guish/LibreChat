/**
 * The PostgreSQL `TenantEngineHarness` (`~/tenant/conformance`; docs/postgres-port/PHASE4.md §1.8):
 * the collection primitive's binding of the tenant policy, checked by the same portable suite as
 * the mongoose binding. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The suite's `conformances` collection (`name`, `tenantId` with an index, as the mongoose
 * harness declares it) is described by a hand-written source, mapped by the generator's rules and
 * created in a schema of its own (`lc_tenant_conformance`) on the database the engine gives, so
 * any database will do. The scoped operations go through `PgCollection` in document mode (no
 * engine: the descriptor casts) with the tenant policy bound; `seed` and `readAllUnscoped` through
 * its raw mode.
 */
import { Kysely, PostgresDialect } from 'kysely';
import type { TenantEngineHarness, TenantRow } from '~/tenant/conformance';
import type { PostgresKysely, PostgresTables } from '../types';
import type { CollectionSource } from '../schema/descriptor';
import type { PgCollections } from './collection';
import { buildSchemaDescriptor } from '../schema/descriptor';
import { HELPER_FUNCTIONS_DDL } from '../schema/functions';
import { createPostgresPool } from '../connection';
import { createPgCollections } from './collection';
import { emitSchemaDdl } from '../schema/emitDdl';
import { tenantPartitionFilter } from './tenant';
import { createSqlRunner } from './runner';

/** The server a harness runs on. */
export interface PostgresTenantEngine {
  readonly name: string;
  /** Starts or locates the server and returns the URI of a database to use. */
  connect(): Promise<string>;
  /** Releases the server once the harness has disconnected from it. */
  release(): Promise<void>;
}

const COLLECTION = 'conformances';
const SCHEMA = 'lc_tenant_conformance';

const leaf = (name: string, instance: string): CollectionSource['fields'][number] => ({
  kind: 'leaf',
  name,
  instance,
  hidden: false,
  transforms: [],
});

/** The suite's collection, as the generator would read the mongoose harness's schema. */
const SOURCE: CollectionSource = {
  collection: COLLECTION,
  kind: 'collection',
  fields: [leaf('name', 'String'), leaf('tenantId', 'String'), leaf('_id', 'ObjectId')],
  indexes: [{ fields: [['tenantId', 1]], options: {} }],
  timestamps: null,
  versionKey: null,
  strict: true,
};

export function createPostgresTenantHarness(engine: PostgresTenantEngine): TenantEngineHarness {
  let db: PostgresKysely | undefined;
  let collections: PgCollections | undefined;
  const ready = () => {
    if (!collections || !db) {
      throw new Error('The PostgreSQL tenant harness is not set up');
    }
    return { db, collections };
  };
  const scoped = () => ready().collections.collection(COLLECTION);
  const raw = () => ready().collections.raw(COLLECTION);

  return {
    name: engine.name,

    async setup() {
      const uri = await engine.connect();
      const pool = createPostgresPool({ uri, schema: SCHEMA, autoMigrate: false });
      db = new Kysely<PostgresTables>({ dialect: new PostgresDialect({ pool }) });
      const descriptor = buildSchemaDescriptor([SOURCE]);
      const runner = createSqlRunner(db);
      await runner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await runner.query(`CREATE SCHEMA ${SCHEMA}`);
      for (const statement of [...emitSchemaDdl(descriptor), ...HELPER_FUNCTIONS_DDL]) {
        await runner.query(statement);
      }
      collections = createPgCollections({
        db,
        descriptor,
        engine: null,
        tenantScoped: (collection) => collection === COLLECTION,
      });
    },

    async teardown() {
      if (db) {
        await createSqlRunner(db)
          .query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
          .catch(() => undefined);
        await db.destroy();
      }
      db = undefined;
      collections = undefined;
      await engine.release();
    },

    async reset() {
      await createSqlRunner(ready().db).query(`TRUNCATE "${COLLECTION}"`);
    },

    async seed(rows) {
      await raw().insertMany(rows.map((row) => ({ ...row })));
    },

    async readAllUnscoped() {
      const rows = await raw().find({});
      return rows.map(
        (row): TenantRow => ({ name: row.name as string, tenantId: row.tenantId as string }),
      );
    },

    async insert(row) {
      await scoped().insertOne({ ...row });
    },

    async findNames() {
      return (await scoped().find({})).map((row) => row.name as string);
    },

    async findNamesInPartition() {
      const rows = await scoped().find(tenantPartitionFilter('conformance'));
      return rows.map((row) => row.name as string);
    },

    count: () => scoped().count({}),

    async rename(from, to) {
      await scoped().updateOne({ name: from }, { $set: { name: to } });
    },

    async renameAndReassign(from, to, tenantId) {
      await scoped().updateOne({ name: from }, { $set: { name: to, tenantId } });
    },

    async remove(name) {
      await scoped().deleteOne({ name });
    },
  };
}

/**
 * An ICU-collated companion database for the translator's corpora (docs/postgres-port/PHASE4.md
 * §2.5, §6: "the translator corpora also run on a database with `LOCALE_PROVIDER icu ICU_LOCALE
 * 'en-US'`"), so a comparison missing its `COLLATE "C"` shows up as a different order there.
 *
 * ```ts
 * const database = usePostgresTestDatabase();
 * const icu = usePostgresIcuDatabase(database);
 * beforeAll(async () => { await icu.pool().query('...'); });
 * ```
 *
 * The database is created on the suite database's server (from `template0`, UTF-8, ICU `en-US`,
 * an empty `public` schema) in a `beforeAll` registered after the suite database's, and dropped
 * in `afterAll` (which may run after the suite database's own, so it keeps the server's URI). Its name carries the run's prefix, so the global teardown also removes it.
 */
import type { Pool } from 'pg';
import type { PostgresTestDatabase } from './index';
import { quoteIdentifier, withClient, withDatabase } from './server';
import { createPostgresPool } from '~/adapters/postgres/connection';

/** An ICU database next to a suite database. */
export interface PostgresIcuDatabase {
  readonly name: string;
  /** A pool on the ICU database (closed after the suite). */
  pool(): Pool;
}

/** Gives the current `describe` block an ICU-collated database next to `base`. */
export function usePostgresIcuDatabase(base: PostgresTestDatabase): PostgresIcuDatabase {
  let name: string | undefined;
  let adminUri: string | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    const database = `${base.name}_icu`;
    adminUri = base.server.adminUri;
    await withClient(adminUri, (client) =>
      client.query(
        `CREATE DATABASE ${quoteIdentifier(database)} TEMPLATE template0 ENCODING 'UTF8' ` +
          `LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C'`,
      ),
    );
    name = database;
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    pool = undefined;
    if (name && adminUri) {
      const database = name;
      await withClient(adminUri, (client) =>
        client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`),
      ).catch(() => undefined);
    }
    name = undefined;
  }, 60_000);

  return {
    get name() {
      if (!name) throw new Error('The ICU database is only available inside hooks and tests');
      return name;
    },
    pool: () => {
      if (!name) throw new Error('The ICU database is only available inside hooks and tests');
      pool ??= createPostgresPool({
        uri: withDatabase(adminUri as string, name),
        schema: 'public',
        autoMigrate: true,
      });
      return pool;
    },
  };
}

/**
 * The PostgreSQL key-value store (`~/ports/keyValueStore`; docs/postgres-port/PHASE4.md §8 I1):
 * one row per entry in the raw table `key_value_entries` (`0001_initial`), keyed by
 * `(store, key)`, which replaces MongoDB's Keyv collections and their GridFS buckets. Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * - `store` is the MongoDB collection the entries would live in: the store's name (`keyv` for an
 *   empty one), or with `largeValues` the bucket's files collection `<name>.files`. So a store and
 *   a `largeValues` store of the same name never share entries (as a collection and a bucket of
 *   the same name do not), and the copy tool (X1) maps each MongoDB collection to its rows.
 * - The value is `value` (text), or with `largeValues` `value_bytes` (its UTF-8 bytes, TOASTed by
 *   PostgreSQL instead of chunked by GridFS).
 * - `expires_at` is stamped from the ttl on every `set` (`NULL` without one), in both modes; the
 *   TTL sweeper (`./ttlSweeper`, I4) removes expired rows from disk. Reads never filter on it:
 *   Keyv checks the expiry it stores inside each value, as with MongoDB.
 *
 * The store reaches the database through `getDb` on each operation, so it "opens" on its first
 * operation, rejects while the backend is not connected and works once it is. There is nothing
 * else to open, so `onError` is never called. Keys, values and store names have U+0000 replaced
 * with U+FFFD (D8), in lookups too, so a key holding one still finds its entry.
 */
import { sql } from 'kysely';
import type { KeyValueStore, KeyValueStoreOptions } from '~/ports/keyValueStore';
import type { PostgresKysely } from './types';
import { replaceNul, toTextColumn } from './values';

/** The table holding every key-value store's entries. */
export const KEY_VALUE_TABLE = 'key_value_entries';

/** The `store` column value of the store `options` names (see the module header). */
export function keyValueStoreColumn(
  options: Pick<KeyValueStoreOptions, 'name' | 'largeValues'>,
): string {
  return options.largeValues ? `${options.name}.files` : options.name || 'keyv';
}

/** A key as written and looked up (U+0000 replaced, not counted again on reads). */
const lookupKey = (key: string): string => replaceNul(key, { countNul: false });

interface EntryRow {
  key: string;
  value: string | null;
  value_bytes: Buffer | null;
}

/** A key-value store on the PostgreSQL connection `getDb` returns; see the module header. */
export function createPostgresKeyValueStore(
  getDb: () => PostgresKysely,
  options: KeyValueStoreOptions,
): KeyValueStore {
  const largeValues = options.largeValues === true;
  const store = replaceNul(keyValueStoreColumn(options), { countNul: false });
  const table = sql.table(KEY_VALUE_TABLE);
  const valueOf = (row: EntryRow | undefined): string | undefined => {
    if (!row) {
      return undefined;
    }
    if (largeValues) {
      return row.value_bytes ? Buffer.from(row.value_bytes).toString('utf8') : undefined;
    }
    return row.value ?? undefined;
  };

  /** The entries under `keys`, by key. */
  async function readEntries(db: PostgresKysely, keys: string[]): Promise<Map<string, EntryRow>> {
    const { rows } = await sql<EntryRow>`
      SELECT key, value, value_bytes FROM ${table}
      WHERE store = ${store} AND key = ANY (${keys.map(lookupKey)}::text[])
    `.execute(db);
    return new Map(rows.map((row) => [row.key, row]));
  }

  async function deleteKeys(db: PostgresKysely, keys: string[]): Promise<number> {
    const result = await sql`
      DELETE FROM ${table} WHERE store = ${store} AND key = ANY (${keys.map(lookupKey)}::text[])
    `.execute(db);
    return Number(result.numAffectedRows ?? 0);
  }

  return {
    async get(key) {
      const db = getDb();
      const entries = await readEntries(db, [key]);
      return valueOf(entries.get(lookupKey(key)));
    },

    async getMany(keys) {
      const db = getDb();
      let entries: Map<string, EntryRow>;
      try {
        entries = await readEntries(db, keys);
      } catch (error) {
        /** With `largeValues` MongoDB reads each file on its own and answers `undefined` for a
         *  failed read; the store keeps that contract. */
        if (largeValues) {
          return keys.map(() => undefined);
        }
        throw error;
      }
      return keys.map((key) => valueOf(entries.get(lookupKey(key))));
    },

    async set(key, value, ttl) {
      const db = getDb();
      const expiresAt = typeof ttl === 'number' ? new Date(Date.now() + ttl) : null;
      const text = largeValues ? null : toTextColumn(value);
      const bytes = largeValues ? Buffer.from(value, 'utf8') : null;
      await sql`
        INSERT INTO ${table} (store, key, value, value_bytes, expires_at)
        VALUES (${store}, ${toTextColumn(key)}, ${text}, ${bytes}, ${expiresAt})
        ON CONFLICT (store, key) DO UPDATE
        SET value = EXCLUDED.value, value_bytes = EXCLUDED.value_bytes,
            expires_at = EXCLUDED.expires_at
      `.execute(db);
      return undefined;
    },

    async delete(key) {
      const db = getDb();
      if (largeValues) {
        /** As with GridFS: `true` whether or not a file existed, `false` when removing failed. */
        try {
          await deleteKeys(db, [key]);
          return true;
        } catch {
          return false;
        }
      }
      return (await deleteKeys(db, [key])) > 0;
    },

    async deleteMany(keys) {
      const db = getDb();
      return (await deleteKeys(db, keys)) > 0;
    },

    async clear(namespace) {
      const db = getDb();
      /** MongoDB matches `^<namespace>:*`, which is every key starting with the namespace; a
       *  `largeValues` store drops its whole bucket whatever the namespace. */
      if (namespace && !largeValues) {
        await sql`
          DELETE FROM ${table} WHERE store = ${store} AND starts_with(key, ${lookupKey(namespace)})
        `.execute(db);
        return;
      }
      await sql`DELETE FROM ${table} WHERE store = ${store}`.execute(db);
    },

    async has(key) {
      const db = getDb();
      const { rows } = await sql<{ found: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM ${table} WHERE store = ${store} AND key = ${lookupKey(key)}
        ) AS found
      `.execute(db);
      return rows[0].found === true;
    },
  };
}

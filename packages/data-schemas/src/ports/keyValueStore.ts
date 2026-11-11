/**
 * Key-value store port: the infrastructure cache that lives in the main database (bans and the
 * encoded domains, through `keyvMongo` in `@librechat/api`, a Keyv store). Nothing here may
 * import `mongoose` or the MongoDB driver, at runtime or as a type.
 *
 * The port covers exactly what that Keyv store adapter needs. Keyv itself keeps the namespace
 * prefix, serialization and expiry checks (the adapter reports no TTL support, so every value
 * Keyv writes carries its own expiry and Keyv drops expired values on read); the backend only
 * stores strings by key and removes expired entries from disk on its own schedule.
 *
 * Not a member of `DataStore`: a store is opened by name (`DataStoreBackend.createKeyValueStore`)
 * for the cache layer, not built once per process by the composition root.
 */
import { listPortMethods } from './common';

/** What {@link KeyValueStore} to open. */
export interface KeyValueStoreOptions {
  /**
   * The store's name: where its entries live (with MongoDB: the collection, or with
   * `largeValues` the GridFS bucket). Stores of the same name and `largeValues` share their
   * entries. An empty name means `keyv` for a store without `largeValues`.
   */
  name: string;
  /**
   * Whether values may exceed what one database record holds (with MongoDB: 16 MB), so the
   * backend keeps them in its large-object storage (with MongoDB: GridFS). Such entries are
   * not removed from disk when they expire.
   */
  largeValues?: boolean;
  /**
   * Called with the error, before the operation rejects with it, when opening the store fails
   * for a reason other than the database not being connected yet.
   */
  onError?: (error: unknown) => void;
}

/**
 * A key-value store. The store opens on its first operation, which rejects while the database
 * is not connected (and is retried on the next operation). Opening may start background work
 * (with MongoDB: the key and expiry index builds, skipped when the deployment disables auto
 * indexing); its failures are logged, not reported.
 */
export interface KeyValueStore {
  /** The value stored under `key`, or `undefined`. Expired entries not yet removed are returned. */
  get(key: string): Promise<string | undefined>;
  /** The value stored under each key, in the order of `keys` (`undefined` where none). */
  getMany(keys: string[]): Promise<Array<string | undefined>>;
  /**
   * Stores `value` under `key`, replacing any value there. With `ttl` (milliseconds) the entry
   * expires `ttl` ms from now and is removed from disk some time after that (with MongoDB: by
   * the TTL index on `expiresAt`); without it the entry never expires. Resolves to the
   * backend's own value, which carries no meaning for callers.
   */
  set(key: string, value: string, ttl?: number): Promise<unknown>;
  /**
   * Removes the entry under `key`; resolves whether one was removed. With `largeValues` it
   * resolves `true` whether or not an entry existed, and `false` only when the removal failed.
   */
  delete(key: string): Promise<boolean>;
  /** Removes the entries under `keys`; resolves whether any was removed. */
  deleteMany(keys: string[]): Promise<boolean>;
  /**
   * Removes every entry whose key starts with `namespace` (with MongoDB: the keys matching the
   * unescaped regular expression `^<namespace>:*`), or every entry without `namespace`. With
   * `largeValues` every entry is removed whatever the namespace.
   */
  clear(namespace?: string): Promise<void>;
  /** Whether an entry is stored under `key` (expired entries not yet removed included). */
  has(key: string): Promise<boolean>;
}

/** Every method of {@link KeyValueStore}, for adapters and conformance checks. */
export const KEY_VALUE_STORE_METHODS: ReadonlyArray<keyof KeyValueStore> =
  listPortMethods<KeyValueStore>({
    get: true,
    getMany: true,
    set: true,
    delete: true,
    deleteMany: true,
    clear: true,
    has: true,
  });

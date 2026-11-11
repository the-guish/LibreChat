import { EventEmitter } from 'events';
import { getDataStoreBackend, logger } from '@librechat/data-schemas';
import type { KeyValueStore } from '@librechat/data-schemas';

interface KeyvMongoOptions {
  url?: string;
  collection?: string;
  useGridFS?: boolean;
}

/**
 * A Keyv store adapter on a key-value store of the main database
 * (`getDataStoreBackend().createKeyValueStore`; with MongoDB, the collection named `collection`,
 * or its GridFS bucket with `useGridFS`). The key-value store opens on the first operation, so
 * the database must be connected by then; it reports no TTL support, so Keyv keeps each value's
 * expiry itself. `disconnect` is a no-op: the store never closes the shared connection.
 */
class KeyvMongoCustom extends EventEmitter {
  private opts: KeyvMongoOptions;
  private keyValueStore?: KeyValueStore;
  public ttlSupport: boolean;
  public namespace?: string;

  constructor(options: KeyvMongoOptions = {}) {
    super();

    this.opts = {
      url: 'mongodb://127.0.0.1:27017',
      collection: 'keyv',
      ...options,
    };

    this.ttlSupport = false;
  }

  /** The key-value store, created on first use from the process's data store backend. */
  private getStore(): KeyValueStore {
    this.keyValueStore ??= getDataStoreBackend().createKeyValueStore({
      name: this.opts.collection as string,
      largeValues: this.opts.useGridFS,
      onError: (error) => this.emit('error', error),
    });
    return this.keyValueStore;
  }

  async get(key: string): Promise<unknown> {
    return this.getStore().get(key);
  }

  async getMany(keys: string[]): Promise<unknown[]> {
    return this.getStore().getMany(keys);
  }

  async set(key: string, value: string, ttl?: number): Promise<unknown> {
    return this.getStore().set(key, value, ttl);
  }

  async delete(key: string): Promise<boolean> {
    return this.getStore().delete(key);
  }

  async deleteMany(keys: string[]): Promise<boolean> {
    return this.getStore().deleteMany(keys);
  }

  async clear(): Promise<void> {
    return this.getStore().clear(this.namespace);
  }

  async has(key: string): Promise<boolean> {
    return this.getStore().has(key);
  }

  // No-op disconnect
  async disconnect(): Promise<boolean> {
    // This is a no-op since we don't want to close the shared database connection
    return true;
  }
}

const keyvMongo: KeyvMongoCustom = new KeyvMongoCustom({
  collection: 'logs',
});

keyvMongo.on('error', (err) => logger.error('KeyvMongo connection error:', err));

export default keyvMongo;

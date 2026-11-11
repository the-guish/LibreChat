import mongoose from 'mongoose';
import type { MongoDataStoreBackend } from './mongo/backend';
import { createMongoDataStoreBackend } from './mongo/backend';

let backend: MongoDataStoreBackend | undefined;

/**
 * The process's data store backend: the one place where the database is chosen. Today it is
 * always MongoDB, on the `mongoose` instance this package and the server share; a PostgreSQL
 * backend is selected here once it exists. Created on first use and kept.
 */
export function getDataStoreBackend(): MongoDataStoreBackend {
  backend ??= createMongoDataStoreBackend(mongoose);
  return backend;
}

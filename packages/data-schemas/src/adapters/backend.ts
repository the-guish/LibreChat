import mongoose from 'mongoose';
import type { Types } from 'mongoose';
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

/**
 * The id value the chosen backend hands out on the records it stores (their `_id`, and what
 * `ids.toStoreId` returns): with MongoDB, an ObjectId. For code outside the data layer whose types
 * must name exactly the id a store method takes or returns, where `IdLike` is too wide: a
 * dependency type filled with the store's own methods (a wider parameter is rejected under strict
 * function types), or an id passed on to such a method. It lets that code state the type without
 * importing the database driver; prefer `IdLike` wherever it fits.
 */
export type StoreIdValue = Types.ObjectId;

import mongoose from 'mongoose';
import type { Types } from 'mongoose';
import type { MongoDataStoreBackend } from './mongo/backend';
import { createPostgresDataStoreBackend } from './postgres/backend';
import { createMongoDataStoreBackend } from './mongo/backend';

/** The databases a deployment can run on (`DATABASE_BACKEND`). */
export type DatabaseBackendName = 'mongo' | 'postgres';

let backend: MongoDataStoreBackend | undefined;

/**
 * The backend `DATABASE_BACKEND` names: `mongo` (the default, when unset or empty) or
 * `postgres`, in any case and surrounded by spaces. Throws for any other value, so a typo never
 * silently selects MongoDB.
 */
export function readDatabaseBackendName(value: string | undefined): DatabaseBackendName {
  const name = value?.trim().toLowerCase() ?? '';
  if (name === '' || name === 'mongo') {
    return 'mongo';
  }
  if (name === 'postgres') {
    return 'postgres';
  }
  throw new Error(`DATABASE_BACKEND must be "mongo" or "postgres", got "${value}"`);
}

/**
 * The process's data store backend: the one place where the database is chosen, by
 * `DATABASE_BACKEND`, read once on the first call (later changes to the variable are ignored).
 *
 * - `mongo` (the default): MongoDB, on the `mongoose` instance this package and the server
 *   share, exactly as before the switch existed.
 * - `postgres`: the PostgreSQL backend (`./postgres/backend`). Its stores are being written unit
 *   by unit; until all exist its connection refuses to connect unless
 *   `POSTGRES_ALLOW_INCOMPLETE_STORES=true` (docs/postgres-port/PHASE4.md, F1).
 *
 * Every backend is a `DataMethodsBackend` (`~/compose`): its `createMethods` composes the
 * database-neutral `DataMethods`. The function is still typed as the MongoDB backend, whose
 * methods (`AllMethods`) some callers' dependency types need (`shared-links/service.ts` hands
 * them to the access control service, whose principal ids are typed `StoreIdValue`); the
 * PostgreSQL backend is returned under that type until those callers are retyped against the
 * neutral types (by B1). Code that must work on both reaches only `DataMethodsBackend` members.
 */
export function getDataStoreBackend(): MongoDataStoreBackend {
  if (!backend) {
    backend =
      readDatabaseBackendName(process.env.DATABASE_BACKEND) === 'postgres'
        ? (createPostgresDataStoreBackend() as unknown as MongoDataStoreBackend)
        : createMongoDataStoreBackend(mongoose);
  }
  return backend;
}

/**
 * The id value the chosen backend hands out on the records it stores (their `_id`, and what
 * `ids.toStoreId` returns): with MongoDB, an ObjectId. For code outside the data layer whose types
 * must name exactly the id a store method takes or returns, where `IdLike` is too wide: a
 * dependency type filled with the store's own methods (a wider parameter is rejected under strict
 * function types), or an id passed on to such a method. It lets that code state the type without
 * importing the database driver; prefer `IdLike` wherever it fits. (With PostgreSQL the value is
 * the canonical 24-hex string; the type follows the MongoDB backend until B1 retypes it.)
 */
export type StoreIdValue = Types.ObjectId;

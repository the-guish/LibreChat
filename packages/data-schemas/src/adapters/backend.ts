import mongoose from 'mongoose';
import type { Types } from 'mongoose';
import type { DataMethodsBackend } from '~/compose/types';
import { createPostgresDataStoreBackend } from './postgres/backend';
import { createMongoDataStoreBackend } from './mongo/backend';

/** The databases a deployment can run on (`DATABASE_BACKEND`). */
export type DatabaseBackendName = 'mongo' | 'postgres';

let backend: DataMethodsBackend | undefined;

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
 * - `postgres`: the PostgreSQL backend (`./postgres/backend`; docs/postgres-port/PHASE4.md).
 *
 * Typed as the database-neutral `DataMethodsBackend` (`~/compose`), which both backends are: its
 * `createMethods` composes the `DataMethods` of the store ports, and its other members are the
 * `DataStoreBackend` port's. Code that needs one backend's own members (the MongoDB models of
 * `registerModels`, a PostgreSQL connection's handle) builds that backend itself.
 */
export function getDataStoreBackend(): DataMethodsBackend {
  if (!backend) {
    backend =
      readDatabaseBackendName(process.env.DATABASE_BACKEND) === 'postgres'
        ? createPostgresDataStoreBackend()
        : createMongoDataStoreBackend(mongoose);
  }
  return backend;
}

/**
 * The id type the stores' record types state for the ids they hand out (`_id`, references such as
 * `author` or `user`): `Types.ObjectId`, as the record types in `~/types` still name MongoDB's id
 * (docs/postgres-port/PLAN.md, "Open items and known leaks"). For code outside the data layer whose
 * types must name exactly the id a store method takes or returns, where `IdLike` is too wide: a
 * dependency type filled with the store's own methods (a wider parameter is rejected under strict
 * function types), or an id passed on to such a method. It lets that code state the type without
 * importing the database driver; prefer `IdLike` wherever it fits.
 *
 * At run time the value is what `getDataStoreBackend().ids.toStoreId` returns: an ObjectId with
 * MongoDB, the canonical 24-hex string with PostgreSQL. Both serve the uses this type is put to
 * (they print, compare and cast the same way). Stating it as `IdLike` needs the dependency types
 * and the record types' ids moved to `IdLike` together with the MongoDB methods' parameters, which
 * no backend needs at run time (PHASE4.md §8 B1).
 */
export type StoreIdValue = Types.ObjectId;

/**
 * Database-neutral building blocks shared by the ports. Nothing here may import `mongoose` or the
 * MongoDB driver, at runtime or as a type.
 */

/**
 * An id the store generated. With MongoDB it is an ObjectId, and methods accept `string |
 * Types.ObjectId` today; a port states the same parameter as `IdLike`, so its signature need not
 * name the driver's id type. Pass its string form or the id value the store handed out (an
 * ObjectId has `toHexString`), never an object built to look like one: the MongoDB adapter casts
 * what it is given.
 */
export type IdLike = string | { toHexString(): string };

/**
 * `T` with the fields `K`, which take a `Types.ObjectId` today, stated as {@link IdLike}. Whether
 * each field is optional, and whether it admits `null` or `undefined`, is kept. For the parameter
 * objects of a port (queries, create data), so the port need not name the driver's id type.
 */
export type WithIdLike<T, K extends keyof T> = {
  [P in keyof T]: P extends K ? IdLike | Extract<T[P], null | undefined> : T[P];
};

/**
 * What a delete reports:whether the store acknowledged it and how many records it removed. The
 * MongoDB driver's `DeleteResult` has exactly this shape.
 */
export interface DeleteCount {
  acknowledged: boolean;
  deletedCount: number;
}

/**
 * What an update of every matching record reports: whether the store acknowledged it, how many
 * records matched and how many it changed. The MongoDB driver's `UpdateResult` has these fields
 * (and the upsert's).
 */
export interface UpdateCount {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
}

/**
 * One `true` per method of `Port`. Typed as the full key set, so leaving a method out or naming
 * one the port lacks is a compile error.
 */
export type PortMethodSet<Port> = { readonly [K in keyof Port]-?: true };

/**
 * The method names of a port, from a {@link PortMethodSet}, for adapters and conformance checks.
 * Write `listPortMethods<SomeStore>({ ... })` so the compiler checks the set against the port.
 */
export function listPortMethods<Port>(methods: PortMethodSet<Port>): ReadonlyArray<keyof Port> {
  return Object.keys(methods) as Array<keyof Port>;
}

/**
 * Store id port: the format of the ids the store generates, for code outside the data layer that
 * validates, compares, casts or creates them without knowing what they look like. Nothing here
 * may import `mongoose` or the MongoDB driver, at runtime or as a type.
 *
 * With MongoDB the ids are ObjectIds: `isValid` is `ObjectId.isValid` (a 24-character hex
 * string in either case, an ObjectId, and whatever else the driver accepts), the canonical
 * string is the 24 lowercase hex characters `ObjectId#toString()` writes, and `toStoreId` is
 * the ObjectId itself. A PostgreSQL backend generates ids of the same 24-hex shape, so callers
 * that store, log or compare canonical strings keep working.
 *
 * Not a member of `DataStore`: the format belongs to the backend, not to a store of records, and
 * needs no connection (`DataStoreBackend.ids`).
 */
import type { IdLike } from './common';
import { listPortMethods } from './common';

export interface StoreIds {
  /** Whether `value` is, or names, an id of the store's format. */
  isValid(value: unknown): boolean;
  /**
   * The canonical string of the id `value` names (case-folded, so two spellings of one id give
   * the same string). Throws when `isValid` does not accept `value`.
   */
  toCanonicalString(value: unknown): string;
  /**
   * The id `value` names, as the id value the store hands out, for criteria the store matches as
   * given rather than casting them (ACL principal ids, see `AclEntryStore`). Throws when
   * `isValid` does not accept `value`.
   */
  toStoreId(value: unknown): IdLike;
  /** A new id, unique like the ones the store generates for its records, as its canonical string. */
  generate(): string;
}

/** Every method of {@link StoreIds}, for adapters and conformance checks. */
export const STORE_IDS_METHODS: ReadonlyArray<keyof StoreIds> = listPortMethods<StoreIds>({
  isValid: true,
  toCanonicalString: true,
  toStoreId: true,
  generate: true,
});

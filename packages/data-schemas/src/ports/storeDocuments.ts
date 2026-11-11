/**
 * Stored record size port: how large one record may be in the store, and how large a record is
 * once stored, for code outside the data layer that checks a write up front (a conversation
 * import refuses an oversized conversation or message before writing anything). Nothing here may
 * import `mongoose` or the MongoDB driver, at runtime or as a type.
 *
 * With MongoDB a record is a BSON document: the limit is the server's 16 MiB document limit and
 * the size is the BSON size of the record with the fields the store adds to a new one (`_id`
 * and mongoose's `__v`). A PostgreSQL backend states its own limit and measures the record as
 * it stores it; callers keep their own headroom below the limit.
 *
 * Not a member of `DataStore`: the limit belongs to the backend, not to a store of records, and
 * needs no connection (`DataStoreBackend.documents`).
 */
import { listPortMethods } from './common';

export interface StoreDocuments {
  /** The largest record the store accepts in one write, in the bytes `measureDocument` counts. */
  readonly maxDocumentBytes: number;
  /**
   * The size `record` takes when stored as a new record, including the fields the store adds to
   * it (fields `record` already has are counted with the value the store gives them). Throws when
   * the store cannot encode `record`.
   */
  measureDocument(record: Readonly<Record<string, unknown>>): number;
}

/** Every member of {@link StoreDocuments}, for adapters and conformance checks. */
export const STORE_DOCUMENTS_MEMBERS: ReadonlyArray<keyof StoreDocuments> =
  listPortMethods<StoreDocuments>({
    maxDocumentBytes: true,
    measureDocument: true,
  });

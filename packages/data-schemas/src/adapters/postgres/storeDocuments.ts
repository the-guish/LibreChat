/**
 * PostgreSQL record sizes (`~/ports/storeDocuments`; docs/postgres-port/PHASE4.md §4). Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * The limit stays MongoDB's 16 MiB, so the conversation import and the checkpoint size guard
 * refuse the same records on both backends (PostgreSQL itself would store far larger rows). A
 * record is measured as the UTF-8 bytes of its canonical JSON: the tagged encoding of `json`
 * columns (`values.ts`) of the record with the fields the store adds to a new one, a generated
 * `_id` (24 hex characters, whatever the record carried) and `__v: 0`. U+0000 are measured as the
 * U+FFFD they are stored as, without counting them as replaced (D8). Throws a `StoreQueryError`
 * when the record cannot be encoded (a key starting with `$`, a non-finite number, ...).
 */
import type { StoreDocuments } from '~/ports/storeDocuments';
import { generatePostgresStoreId } from './storeIds';
import { encodeJsonColumn } from './values';

/** The largest record a write accepts: MongoDB's document limit, kept for parity. */
export const POSTGRES_MAX_DOCUMENT_BYTES: number = 16 * 1024 * 1024;

/** PostgreSQL record sizes: 16 MiB, measured as the UTF-8 bytes of the canonical JSON. */
export const postgresStoreDocuments: StoreDocuments = {
  maxDocumentBytes: POSTGRES_MAX_DOCUMENT_BYTES,
  measureDocument: (record) =>
    Buffer.byteLength(
      encodeJsonColumn({ ...record, _id: generatePostgresStoreId(), __v: 0 }, { countNul: false }),
      'utf8',
    ),
};

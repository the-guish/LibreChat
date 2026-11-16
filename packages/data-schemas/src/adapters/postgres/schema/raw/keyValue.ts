/**
 * `key_value_entries`: the PostgreSQL key-value store (docs/postgres-port/PHASE4.md §4), which
 * replaces the Keyv collections and their GridFS buckets: one row per store and key, the value
 * as text, or as bytes for a store with `largeValues` (TOAST instead of GridFS), and its expiry.
 * Declared for the PostgreSQL mapping only, keyed by `(store, key)` rather than `_id`, without
 * `_nulls`/`_extra`; the TTL index on `expires_at` feeds the sweeper (I4).
 */
import { Schema } from 'mongoose';

/** One key-value entry. */
export const keyValueEntrySchema: Schema = new Schema(
  {
    store: String,
    key: String,
    value: String,
    value_bytes: Buffer,
    expires_at: Date,
  },
  { _id: false, versionKey: false },
);
keyValueEntrySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

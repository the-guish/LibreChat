/**
 * `librechatCredentialMetadata` (`adapters/mongo/credentialMarker.ts`), declared for the
 * PostgreSQL mapping only (docs/postgres-port/PHASE4.md §1.4, §1.6): never registered as a model.
 * It holds one document, `_id: 'primary'` (`CredentialMarker`).
 */
import { Schema } from 'mongoose';

/** The credential marker: a fingerprint per credential name, and when it was recorded. */
export const credentialMarkerSchema: Schema = new Schema(
  {
    _id: { type: String },
    fingerprints: { type: Map, of: String },
    createdAt: Date,
  },
  { versionKey: false },
);

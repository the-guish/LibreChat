/**
 * The PostgreSQL credential marker (`~/ports/credentialMarker`; docs/postgres-port/PHASE4.md §8
 * I1): the `primary` row of the raw table `librechatCredentialMetadata` (`0001_initial`:
 * `fingerprints` a `json` column in the tagged encoding, `createdAt` a `timestamptz`, plus
 * `_nulls`/`_extra`), and the `users` table for whether users exist. Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * The table and the id are the MongoDB collection's and document's
 * (`CREDENTIAL_MARKER_COLLECTION`, `CREDENTIAL_MARKER_ID` in `adapters/mongo/credentialMarker.ts`,
 * which this adapter may not import; a spec checks they are equal), so the copy tool (X1) moves
 * the marker by name. `readMarker` returns the row as MongoDB returns the document: `_id`, the
 * stated fields, then any legacy field kept in `_extra` (D7).
 */
import { sql } from 'kysely';
import type { CredentialMarker, CredentialMarkerStore } from '~/ports/credentialMarker';
import type { PostgresKysely } from './types';
import { decodeJsonColumn, encodeJsonColumn, fromTimestampColumn } from './values';
import { decodeExtraColumn, mergeExtra } from './records/extra';

/** The table holding the credential marker (the MongoDB collection's name). */
export const POSTGRES_CREDENTIAL_MARKER_TABLE = 'librechatCredentialMetadata';
/** The marker row's `_id`. */
export const POSTGRES_CREDENTIAL_MARKER_ID = 'primary';

interface MarkerRow {
  _id: string;
  fingerprints: unknown;
  createdAt: Date | null;
  _extra: unknown;
}

/** The credential marker on the PostgreSQL database `db` queries. */
export function createPostgresCredentialMarkerStore(db: PostgresKysely): CredentialMarkerStore {
  const table = sql.table(POSTGRES_CREDENTIAL_MARKER_TABLE);
  return {
    async hasUsers() {
      const { rows } = await sql<{ found: boolean }>`
        SELECT EXISTS (SELECT 1 FROM ${sql.table('users')}) AS found
      `.execute(db);
      return rows[0].found === true;
    },

    async readMarker() {
      const { rows } = await sql<MarkerRow>`
        SELECT "_id", "fingerprints", "createdAt", "_extra" FROM ${table}
        WHERE "_id" = ${POSTGRES_CREDENTIAL_MARKER_ID}
      `.execute(db);
      const row = rows[0];
      if (!row) {
        return null;
      }
      const marker: Record<string, unknown> = { _id: row._id };
      const fingerprints = decodeJsonColumn(row.fingerprints);
      if (fingerprints !== null) {
        marker.fingerprints = fingerprints;
      }
      const createdAt = fromTimestampColumn(row.createdAt);
      if (createdAt !== null) {
        marker.createdAt = createdAt;
      }
      return mergeExtra(marker, decodeExtraColumn(row._extra)) as unknown as CredentialMarker;
    },

    async recordMarkerIfAbsent(marker) {
      const { rows } = await sql<{ _id: string }>`
        INSERT INTO ${table} ("_id", "fingerprints", "createdAt")
        VALUES (
          ${POSTGRES_CREDENTIAL_MARKER_ID},
          ${encodeJsonColumn(marker.fingerprints)}::json,
          ${marker.createdAt}
        )
        ON CONFLICT ("_id") DO NOTHING
        RETURNING "_id"
      `.execute(db);
      return rows.length === 1;
    },
  };
}

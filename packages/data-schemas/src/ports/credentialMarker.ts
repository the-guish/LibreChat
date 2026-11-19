/**
 * Credential marker port: the one record in the database that holds fingerprints (hashes, never
 * the values) of the credentials the deployment was first started with, so each startup can
 * warn when the active credentials drift from the ones existing encrypted records and JWTs
 * need. Nothing here may import `mongoose` or the MongoDB driver, at runtime or as a type.
 *
 * The startup check (`checkCredentialDatabase` in `@librechat/api`) keeps the decisions (when
 * to record the marker, how to compare, what to log); the backend only reads and records it,
 * and says whether the deployment already has users. Where the marker lives is the backend's
 * own business (with MongoDB: the `primary` document of the `librechatCredentialMetadata`
 * collection).
 *
 * Not a member of `DataStore`: it is deployment-wide boot maintenance, reached through the
 * backend (`DataStoreBackend.getCredentialMarkerStore`).
 */
import { listPortMethods } from './common';

/** The credential marker: a fingerprint per credential name, and when it was recorded. */
export interface CredentialMarker {
  fingerprints: Partial<Record<string, string>>;
  createdAt: Date;
}

/** Reads and records the {@link CredentialMarker}; every operation may reject. */
export interface CredentialMarkerStore {
  /** Whether at least one user exists. */
  hasUsers(): Promise<boolean>;
  /** The recorded marker (possibly with backend fields besides the stated ones), or `null`. */
  readMarker(): Promise<CredentialMarker | null>;
  /**
   * Records `marker` unless a marker already exists, which is never overwritten; resolves
   * whether this call recorded it.
   */
  recordMarkerIfAbsent(marker: CredentialMarker): Promise<boolean>;
}

/** Every method of {@link CredentialMarkerStore}, for adapters and conformance checks. */
export const CREDENTIAL_MARKER_STORE_METHODS: ReadonlyArray<keyof CredentialMarkerStore> =
  listPortMethods<CredentialMarkerStore>({
    hasUsers: true,
    readMarker: true,
    recordMarkerIfAbsent: true,
  });

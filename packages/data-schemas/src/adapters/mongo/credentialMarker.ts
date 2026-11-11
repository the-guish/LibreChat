/**
 * The MongoDB credential marker (`~/ports/credentialMarker`), moved from
 * `checkCredentialDatabase` in `@librechat/api`: the `primary` document of the raw
 * `librechatCredentialMetadata` collection on the default connection, and the `User` model for
 * whether users exist.
 *
 * `@librechat/api` still exports the same collection name and id (`credentialMetadataCollection`,
 * `credentialMetadataId` from its `credentials` entry, which loads before the data layer and so
 * cannot import them); they must stay equal to {@link CREDENTIAL_MARKER_COLLECTION} and
 * {@link CREDENTIAL_MARKER_ID}.
 */
import type { Mongoose } from 'mongoose';
import type { CredentialMarker, CredentialMarkerStore } from '~/ports/credentialMarker';

/** The collection that holds the credential marker. */
export const CREDENTIAL_MARKER_COLLECTION = 'librechatCredentialMetadata';
/** The credential marker's `_id`. */
export const CREDENTIAL_MARKER_ID = 'primary';

interface CredentialMarkerDocument extends CredentialMarker {
  _id: string;
}

/**
 * The credential marker on `mongoose`'s default connection, or `null` while that connection is
 * not open or has no database, or no `User` model is registered on `mongoose`.
 */
export function createMongoCredentialMarkerStore(mongoose: Mongoose): CredentialMarkerStore | null {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) {
    return null;
  }

  const User = mongoose.models.User;
  if (!User) {
    return null;
  }

  const collection = () => db.collection<CredentialMarkerDocument>(CREDENTIAL_MARKER_COLLECTION);

  return {
    async hasUsers() {
      const existingUser = await User.exists({}).exec();
      return existingUser !== null;
    },
    readMarker: () => collection().findOne({ _id: CREDENTIAL_MARKER_ID }),
    async recordMarkerIfAbsent(marker) {
      const result = await collection().updateOne(
        { _id: CREDENTIAL_MARKER_ID },
        {
          $setOnInsert: {
            _id: CREDENTIAL_MARKER_ID,
            fingerprints: marker.fingerprints,
            createdAt: marker.createdAt,
          },
        },
        { upsert: true },
      );
      return result.upsertedCount === 1;
    },
  };
}

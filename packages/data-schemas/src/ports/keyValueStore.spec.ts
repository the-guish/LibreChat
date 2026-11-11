import type { createMongoCredentialMarkerStore } from '~/adapters/mongo/credentialMarker';
import type { MongoKeyValueStoreOptions } from '~/adapters/mongo/keyValueStore';
import type { KeyValueStore, KeyValueStoreOptions } from './keyValueStore';
import type { Assert, SameSignatures, Satisfies } from './conformance';
import type { MongoDataStoreBackend } from '~/adapters/mongo/backend';
import type { CredentialMarkerStore } from './credentialMarker';
import { CREDENTIAL_MARKER_STORE_METHODS } from './credentialMarker';
import { KEY_VALUE_STORE_METHODS } from './keyValueStore';

/**
 * The MongoDB key-value store is typed as the port itself (`SameSignatures`); its options take
 * the port's plus the GridFS read preference (`Satisfies`). The MongoDB credential marker is
 * the port, or `null` (no connection or no `User` model).
 */
type Checks = [
  Assert<SameSignatures<KeyValueStore, ReturnType<MongoDataStoreBackend['createKeyValueStore']>>>,
  Assert<Satisfies<KeyValueStoreOptions, MongoKeyValueStoreOptions>>,
  Assert<
    SameSignatures<
      CredentialMarkerStore,
      NonNullable<ReturnType<typeof createMongoCredentialMarkerStore>>
    >
  >,
];

describe('KeyValueStore / CredentialMarkerStore ports', () => {
  it('match the MongoDB adapters at the type level', () => {
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('list each method once', () => {
    expect(new Set(KEY_VALUE_STORE_METHODS).size).toBe(KEY_VALUE_STORE_METHODS.length);
    expect(new Set(CREDENTIAL_MARKER_STORE_METHODS).size).toBe(
      CREDENTIAL_MARKER_STORE_METHODS.length,
    );
  });
});

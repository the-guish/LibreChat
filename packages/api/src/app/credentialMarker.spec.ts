import { CREDENTIAL_MARKER_COLLECTION, CREDENTIAL_MARKER_ID } from '@librechat/data-schemas';
import { credentialMetadataCollection, credentialMetadataId } from '~/credentials';

/**
 * The `credentials` entry cannot import the data layer, so it repeats where the MongoDB backend
 * keeps the credential marker; the two must stay equal.
 */
describe('credential marker location', () => {
  it('names the collection and id the MongoDB backend uses', () => {
    expect(credentialMetadataCollection).toBe(CREDENTIAL_MARKER_COLLECTION);
    expect(credentialMetadataId).toBe(CREDENTIAL_MARKER_ID);
  });
});

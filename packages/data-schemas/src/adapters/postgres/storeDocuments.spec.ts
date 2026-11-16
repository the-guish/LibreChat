import { postgresStoreDocuments, POSTGRES_MAX_DOCUMENT_BYTES } from './storeDocuments';
import { getNulReplacementCount, resetNulReplacementCount } from './values';
import { mongoStoreDocuments } from '~/adapters/mongo/storeDocuments';
import { STORE_DOCUMENTS_MEMBERS } from '~/ports/storeDocuments';
import { StoreQueryError } from '~/ports/query';

/** `{"_id":"<24 hex>","__v":0}` around the record's own fields. */
const ID_AND_VERSION_BYTES = '"_id":"000000000000000000000000",'.length + '"__v":0'.length;

describe('postgresStoreDocuments', () => {
  it('has every StoreDocuments member', () => {
    for (const member of STORE_DOCUMENTS_MEMBERS) {
      expect(postgresStoreDocuments[member]).toBeDefined();
    }
  });

  it("keeps MongoDB's 16 MiB limit (parity)", () => {
    expect(POSTGRES_MAX_DOCUMENT_BYTES).toBe(16 * 1024 * 1024);
    expect(postgresStoreDocuments.maxDocumentBytes).toBe(mongoStoreDocuments.maxDocumentBytes);
  });

  it('measures the UTF-8 bytes of the canonical JSON with _id and __v', () => {
    expect(postgresStoreDocuments.measureDocument({})).toBe('{}'.length + ID_AND_VERSION_BYTES);
    const record = { title: 'héllo', n: 1 };
    expect(postgresStoreDocuments.measureDocument(record)).toBe(
      Buffer.byteLength(`{"title":"héllo","n":1,`, 'utf8') + ID_AND_VERSION_BYTES + 1,
    );
  });

  it('counts the _id and __v the store gives, whatever the record carried', () => {
    expect(postgresStoreDocuments.measureDocument({ _id: 'x', __v: 12345 })).toBe(
      postgresStoreDocuments.measureDocument({}),
    );
  });

  it('measures dates and binary data in their tagged form', () => {
    const at = new Date(0);
    expect(postgresStoreDocuments.measureDocument({ at })).toBe(
      postgresStoreDocuments.measureDocument({}) +
        `"at":{"$date":"1970-01-01T00:00:00.000Z"},`.length,
    );
    const bytes = Buffer.alloc(3);
    expect(postgresStoreDocuments.measureDocument({ b: bytes })).toBe(
      postgresStoreDocuments.measureDocument({}) + `"b":{"$binary":"AAAA"},`.length,
    );
  });

  it('measures U+0000 as the U+FFFD stored, without counting a replacement', () => {
    resetNulReplacementCount();
    expect(postgresStoreDocuments.measureDocument({ s: '\u0000' })).toBe(
      postgresStoreDocuments.measureDocument({ s: '\uFFFD' }),
    );
    expect(getNulReplacementCount()).toBe(0);
  });

  it('grows with the record, so an oversized record is over the limit', () => {
    const big = { text: 'x'.repeat(POSTGRES_MAX_DOCUMENT_BYTES) };
    expect(postgresStoreDocuments.measureDocument(big)).toBeGreaterThan(
      postgresStoreDocuments.maxDocumentBytes,
    );
  });

  it('throws when the record cannot be encoded', () => {
    expect(() => postgresStoreDocuments.measureDocument({ $bad: 1 })).toThrow(StoreQueryError);
  });
});

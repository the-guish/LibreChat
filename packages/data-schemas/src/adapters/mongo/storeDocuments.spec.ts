import { mongo } from 'mongoose';
import type { StoreDocuments } from '~/ports/storeDocuments';
import { MONGO_MAX_DOCUMENT_BYTES, mongoStoreDocuments } from './storeDocuments';
import { STORE_DOCUMENTS_MEMBERS } from '~/ports/storeDocuments';
import { getDataStoreBackend } from '~/adapters/backend';

/** What callers measured before the port: the record as a new mongoose document. */
const asNewDocument = (record: Record<string, unknown>): number =>
  mongo.BSON.calculateObjectSize({ ...record, _id: new mongo.ObjectId(), __v: 0 });

const RECORDS: Array<Record<string, unknown>> = [
  {},
  { conversationId: 'c1', title: 'Imported', user: 'u1', tenantId: 'tenant-a' },
  { text: 'é'.repeat(1000), createdAt: new Date(0), tags: ['a', 'b'], nested: { n: 1.5 } },
  { _id: 'a string id the store replaces', __v: 7, title: 'x' },
  { _id: new mongo.ObjectId(), title: 'x'.repeat(1024) },
];

describe('mongoStoreDocuments', () => {
  it('lists each member once and implements them all', () => {
    const documents: StoreDocuments = mongoStoreDocuments;
    expect(new Set(STORE_DOCUMENTS_MEMBERS).size).toBe(STORE_DOCUMENTS_MEMBERS.length);
    expect(Object.keys(documents).sort()).toEqual([...STORE_DOCUMENTS_MEMBERS].sort());
  });

  it('is the backend’s record size', () => {
    expect(getDataStoreBackend().documents).toBe(mongoStoreDocuments);
  });

  it('states MongoDB’s 16 MiB document limit', () => {
    expect(MONGO_MAX_DOCUMENT_BYTES).toBe(16 * 1024 * 1024);
    expect(mongoStoreDocuments.maxDocumentBytes).toBe(MONGO_MAX_DOCUMENT_BYTES);
  });

  it.each(RECORDS.map((record) => [record]))(
    'measures %p as the BSON size of a new mongoose document',
    (record) => {
      expect(mongoStoreDocuments.measureDocument(record)).toBe(asNewDocument(record));
    },
  );

  it('counts the _id and __v the store adds', () => {
    const empty = mongoStoreDocuments.measureDocument({});
    /** Length and terminator (5), `_id` ObjectId (1 + 4 + 12), `__v` int32 (1 + 4 + 4). */
    expect(empty).toBe(5 + 17 + 9);
  });

  it('does not change the record it measures', () => {
    const record = { title: 'kept' };
    mongoStoreDocuments.measureDocument(record);
    expect(record).toEqual({ title: 'kept' });
  });

  it('throws when it cannot encode a record', () => {
    const circular: Record<string, unknown> = { title: 'loop' };
    circular.self = circular;
    expect(() => mongoStoreDocuments.measureDocument(circular)).toThrow();
  });
});

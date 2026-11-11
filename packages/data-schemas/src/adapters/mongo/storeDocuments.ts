import { mongo } from 'mongoose';
import type { StoreDocuments } from '~/ports/storeDocuments';

/** MongoDB's limit on the BSON size of one document. */
export const MONGO_MAX_DOCUMENT_BYTES: number = 16 * 1024 * 1024;

/**
 * MongoDB record sizes (`~/ports/storeDocuments`): the server's document limit, and the BSON
 * size of a record stored as a new document of a mongoose model, with the `_id` the driver
 * generates and the `__v` version key mongoose adds (an ObjectId is always 12 bytes, so the
 * value does not change the size).
 */
export const mongoStoreDocuments: StoreDocuments = {
  maxDocumentBytes: MONGO_MAX_DOCUMENT_BYTES,
  measureDocument: (record) =>
    mongo.BSON.calculateObjectSize({ ...record, _id: new mongo.ObjectId(), __v: 0 }),
};

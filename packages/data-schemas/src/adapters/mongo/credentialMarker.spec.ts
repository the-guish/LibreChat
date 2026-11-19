import mongoose, { Mongoose } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  CREDENTIAL_MARKER_ID,
  CREDENTIAL_MARKER_COLLECTION,
  createMongoCredentialMarkerStore,
} from './credentialMarker';
import { CREDENTIAL_MARKER_STORE_METHODS } from '~/ports/credentialMarker';
import { createMongoDataStoreBackend } from './backend';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  mongoose.model('User', new mongoose.Schema({}, { collection: 'users', strict: false }));
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.models.User.deleteMany({});
  await mongoose.connection.db!.collection(CREDENTIAL_MARKER_COLLECTION).deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('MongoDB credential marker', () => {
  it('has every port method, each listed once, and is served by the backend', () => {
    const markers = createMongoDataStoreBackend(mongoose).getCredentialMarkerStore();
    expect(markers).not.toBeNull();
    expect(Object.keys(markers!).sort()).toEqual([...CREDENTIAL_MARKER_STORE_METHODS].sort());
    expect(new Set(CREDENTIAL_MARKER_STORE_METHODS).size).toBe(
      CREDENTIAL_MARKER_STORE_METHODS.length,
    );
  });

  it('is null before the connection is open or without a User model', async () => {
    const other = new Mongoose();
    expect(createMongoCredentialMarkerStore(other)).toBeNull();
    other.model('User', new other.Schema({}));
    expect(createMongoCredentialMarkerStore(other)).toBeNull();

    const withoutUsers = new Mongoose();
    await withoutUsers.connect(mongo.getUri());
    try {
      expect(createMongoCredentialMarkerStore(withoutUsers)).toBeNull();
    } finally {
      await withoutUsers.disconnect();
    }
  });

  it('says whether users exist', async () => {
    const markers = createMongoCredentialMarkerStore(mongoose)!;
    expect(await markers.hasUsers()).toBe(false);
    await mongoose.models.User.collection.insertOne({ email: 'a@example.com' });
    expect(await markers.hasUsers()).toBe(true);
  });

  it('records the marker once and never overwrites it', async () => {
    const markers = createMongoCredentialMarkerStore(mongoose)!;
    expect(await markers.readMarker()).toBeNull();

    const createdAt = new Date('2026-01-01T00:00:00Z');
    expect(await markers.recordMarkerIfAbsent({ fingerprints: { A: 'one' }, createdAt })).toBe(
      true,
    );
    expect(
      await markers.recordMarkerIfAbsent({ fingerprints: { A: 'two' }, createdAt: new Date() }),
    ).toBe(false);

    expect(await markers.readMarker()).toEqual({
      _id: CREDENTIAL_MARKER_ID,
      fingerprints: { A: 'one' },
      createdAt,
    });
  });
});

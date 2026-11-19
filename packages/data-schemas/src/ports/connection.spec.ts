import mongoose from 'mongoose';
import type { Mongoose } from 'mongoose';
import type { MongoDataStoreConnection } from '~/adapters/mongo/connection';
import type { DataStoreBackend, DataStoreConnection } from './connection';
import type { MongoDataStoreBackend } from '~/adapters/mongo/backend';
import type { AllMethods, CreateMethodsDeps } from '~/methods';
import type { Assert, Satisfies } from './conformance';
import { DATA_STORE_BACKEND_MEMBERS, DATA_STORE_CONNECTION_METHODS } from './connection';
import { createMongoDataStoreBackend } from '~/adapters/mongo/backend';

/**
 * The MongoDB backend and its connection satisfy the lifecycle port. They return more than the
 * port states (`registerModels` returns the models, `createConnection` takes an optional
 * connection cache), hence `Satisfies`.
 */
type Checks = [
  Assert<Satisfies<DataStoreConnection<Mongoose>, MongoDataStoreConnection>>,
  Assert<
    Satisfies<DataStoreBackend<AllMethods, CreateMethodsDeps, Mongoose>, MongoDataStoreBackend>
  >,
];

describe('DataStoreConnection / DataStoreBackend port', () => {
  it('matches the MongoDB backend at the type level', () => {
    const typeChecks: Checks = [true, true];
    expect(typeChecks).toEqual([true, true]);
  });

  it('lists each member once', () => {
    expect(new Set(DATA_STORE_CONNECTION_METHODS).size).toBe(DATA_STORE_CONNECTION_METHODS.length);
    expect(new Set(DATA_STORE_BACKEND_MEMBERS).size).toBe(DATA_STORE_BACKEND_MEMBERS.length);
  });

  it('is satisfied by the MongoDB backend and its connection', () => {
    const mongoBackend = createMongoDataStoreBackend(mongoose);
    const backend: DataStoreBackend<AllMethods, CreateMethodsDeps, Mongoose> = mongoBackend;
    expect(Object.keys(backend).sort()).toEqual([...DATA_STORE_BACKEND_MEMBERS].sort());
    expect(backend.name).toBe('mongo');

    const connection: DataStoreConnection<Mongoose> = mongoBackend.createConnection({
      env: { MONGO_URI: 'mongodb://127.0.0.1:1/port-spec' },
      cache: { conn: null, promise: null },
    });
    expect(Object.keys(connection).sort()).toEqual([...DATA_STORE_CONNECTION_METHODS].sort());
  });
});

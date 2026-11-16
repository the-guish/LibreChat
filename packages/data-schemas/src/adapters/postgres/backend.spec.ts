import { sql } from 'kysely';
import mongoose from 'mongoose';
import type { DataMethods, DataMethodsBackend } from '~/compose/types';
import type { PostgresDataStoreBackend } from './backend';
import type { Assert } from '~/ports/conformance';
import type { DataStore } from '~/ports';
import {
  POSTGRES_UNIMPLEMENTED_MEMBERS,
  IncompletePostgresBackendError,
  createPostgresDataStoreBackend,
} from './backend';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { DATA_STORE_BACKEND_MEMBERS } from '~/ports/connection';
import { resolvePostgresExecutor } from './storeTransactions';
import { StoreNotImplementedError } from './notImplemented';
import { POSTGRES_UNIMPLEMENTED_STORES } from './factories';
import { postgresStoreDocuments } from './storeDocuments';
import { postgresStoreIds } from './storeIds';
import { DATA_STORE_METHODS } from '~/ports';
import { createMethods } from '~/methods';

type Assignable<From, To> = [From] extends [To] ? true : false;
type _Checks = [Assert<Assignable<PostgresDataStoreBackend, DataMethodsBackend>>];

/** What `getDataStoreBackend` returns, chosen anew with `DATABASE_BACKEND` set to `value`. */
function selectBackend(value: string | undefined): {
  name: string;
  again: string;
  generatedId: string;
} {
  const previous = process.env.DATABASE_BACKEND;
  let selected: ReturnType<typeof selectBackend> | undefined;
  try {
    if (value === undefined) {
      delete process.env.DATABASE_BACKEND;
    } else {
      process.env.DATABASE_BACKEND = value;
    }
    jest.isolateModules(() => {
      const { getDataStoreBackend } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry
        require('~/adapters/backend') as typeof import('~/adapters/backend');
      const backend = getDataStoreBackend();
      /** Read once: changing the variable afterwards changes nothing. */
      process.env.DATABASE_BACKEND = backend.name === 'mongo' ? 'postgres' : 'mongo';
      selected = {
        name: backend.name,
        again: getDataStoreBackend().name,
        generatedId: backend.ids.generate(),
      };
    });
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_BACKEND;
    } else {
      process.env.DATABASE_BACKEND = previous;
    }
  }
  return selected!;
}

describe('DATABASE_BACKEND switch (getDataStoreBackend)', () => {
  it('selects MongoDB by default, and reads the variable once', () => {
    expect(selectBackend(undefined)).toMatchObject({ name: 'mongo', again: 'mongo' });
    expect(selectBackend('')).toMatchObject({ name: 'mongo', again: 'mongo' });
    expect(selectBackend(' Mongo ')).toMatchObject({ name: 'mongo', again: 'mongo' });
  });

  it('selects PostgreSQL with DATABASE_BACKEND=postgres', () => {
    const selected = selectBackend('postgres');
    expect(selected).toMatchObject({ name: 'postgres', again: 'postgres' });
    expect(selected.generatedId).toMatch(/^[0-9a-f]{24}$/);
    expect(selectBackend('POSTGRES').name).toBe('postgres');
  });

  it('refuses any other value rather than falling back to MongoDB', () => {
    expect(() => selectBackend('postgresql')).toThrow(
      'DATABASE_BACKEND must be "mongo" or "postgres", got "postgresql"',
    );
    expect(() => selectBackend('mysql')).toThrow('DATABASE_BACKEND');
  });
});

describe('PostgreSQL backend', () => {
  const backend = createPostgresDataStoreBackend();

  it('has every DataStoreBackend member', () => {
    expect(backend.name).toBe('postgres');
    for (const member of DATA_STORE_BACKEND_MEMBERS) {
      expect(backend[member]).toBeDefined();
    }
  });

  it('serves the PostgreSQL ids, documents and errors', () => {
    expect(backend.ids).toBe(postgresStoreIds);
    expect(backend.documents).toBe(postgresStoreDocuments);
    expect(backend.errors.isDuplicateKey({ code: '23505' })).toBe(true);
    expect(backend.errors.isDuplicateKey({ code: 11000 })).toBe(false);
  });

  it('registers nothing (the tables come from the migrations)', () => {
    expect(() => backend.registerModels()).not.toThrow();
  });

  describe('createMethods', () => {
    const methods: DataMethods = backend.createMethods();

    it('builds every store through the composition root', () => {
      expect(Object.keys(methods.stores).sort()).toEqual(Object.keys(DATA_STORE_METHODS).sort());
      expect(methods.conversations).toBe(methods.stores.conversations);
      for (const store of Object.keys(DATA_STORE_METHODS) as Array<keyof DataStore>) {
        expect(Object.keys(methods.stores[store]).sort()).toEqual(
          [...(DATA_STORE_METHODS[store] as string[])].sort(),
        );
      }
    });

    it('has the flat methods MongoDB has, except its three MongoDB-only reads', () => {
      const mongoKeys = new Set(Object.keys(createMethods(mongoose)));
      const postgresKeys = Object.keys(methods);
      expect(postgresKeys.filter((key) => !mongoKeys.has(key))).toEqual([]);
      expect([...mongoKeys].filter((key) => !postgresKeys.includes(key)).sort()).toEqual([
        'aggregateAclEntries',
        'getMessagesByCursor',
        'searchMessages',
      ]);
    });

    it('makes every method of a store not implemented yet throw StoreNotImplementedError', () => {
      expect(POSTGRES_UNIMPLEMENTED_STORES).toHaveLength(
        Object.keys(DATA_STORE_METHODS).length - 1,
      );
      expect(POSTGRES_UNIMPLEMENTED_STORES).not.toContain('transactions');
      for (const store of POSTGRES_UNIMPLEMENTED_STORES) {
        for (const method of DATA_STORE_METHODS[store] as string[]) {
          const fn = (methods.stores[store] as unknown as Record<string, () => unknown>)[method];
          let thrown: unknown;
          try {
            fn();
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(StoreNotImplementedError);
          expect(thrown).toMatchObject({ store, method });
        }
      }
      expect(() => methods.findUser({})).toThrow(
        'The PostgreSQL backend does not implement users.findUser yet',
      );
    });

    it('stands in for the domain functions and the pure helpers still inside MongoDB modules', () => {
      expect(() => methods.saveConvo({} as never, {} as never)).toThrow(StoreNotImplementedError);
      expect(() => methods.deleteConvos('u', {})).toThrow(StoreNotImplementedError);
      expect(() => methods.generateActionMetadataHash([], [])).toThrow(StoreNotImplementedError);
      expect(() => methods.sortPrincipalsByRelevance([])).toThrow(StoreNotImplementedError);
    });

    it('shares the pure helpers it can: token pricing and SessionError', () => {
      expect(Object.keys(methods.tokenValues).length).toBeGreaterThan(0);
      expect(typeof methods.getMultiplier({ model: 'gpt-4o', tokenType: 'prompt' })).toBe('number');
      const error = new methods.SessionError('x', 'CODE');
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('CODE');
    });

    it('needs a connection for transactions', async () => {
      await expect(methods.stores.transactions.transaction(async () => 1)).rejects.toThrow(
        'PostgreSQL is not connected',
      );
    });
  });

  it('throws StoreNotImplementedError from the members other than stores', async () => {
    expect(() => backend.getSearchIndexSync()).toThrow(StoreNotImplementedError);
    expect(() => backend.getCredentialMarkerStore()).toThrow(StoreNotImplementedError);
    expect(() => backend.getCheckpointStore()).toThrow(StoreNotImplementedError);
    const keyValueStore = backend.createKeyValueStore({ name: 'cache' });
    expect(() => keyValueStore.get('k')).toThrow(StoreNotImplementedError);
    const checks = backend.createStartupChecks({ findRoleByIdentifier: async () => null });
    expect(() => checks.probeSearchTokens()).toThrow(StoreNotImplementedError);
  });

  it('lists what is missing', () => {
    expect(backend.unimplemented).toEqual([
      ...POSTGRES_UNIMPLEMENTED_STORES,
      ...POSTGRES_UNIMPLEMENTED_MEMBERS,
    ]);
    expect(backend.unimplemented).toContain('users');
    expect(backend.unimplemented).toContain('keyValueStore');
  });

  it('refuses to connect while incomplete, before opening anything', async () => {
    const connection = backend.createConnection({
      env: { POSTGRES_URI: 'postgresql://postgres@127.0.0.1:1/nowhere' },
    });
    const refusal = await connection.connect().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(IncompletePostgresBackendError);
    expect((refusal as Error).message).toContain('POSTGRES_ALLOW_INCOMPLETE_STORES=true');
    expect((refusal as Error).message).toContain('users');
    expect(connection.getState()).toBe('disconnected');
  });
});

describePostgres('PostgreSQL backend with POSTGRES_ALLOW_INCOMPLETE_STORES=true', () => {
  const database = usePostgresTestDatabase();

  it('connects, and the transactions store runs on that connection', async () => {
    const backend = createPostgresDataStoreBackend();
    const connection = backend.createConnection({
      env: database.env({ POSTGRES_ALLOW_INCOMPLETE_STORES: 'true' }),
      cache: { handle: null, promise: null },
    });
    const methods = backend.createMethods();
    const handle = await connection.connect();
    try {
      expect(connection.isConnected()).toBe(true);
      await sql`CREATE TABLE backend_items (id integer PRIMARY KEY)`.execute(handle.db);
      await methods.stores.transactions.transaction(async (tx) => {
        await sql`INSERT INTO backend_items (id) VALUES (1)`.execute(
          resolvePostgresExecutor(handle.db, tx),
        );
      });
      const { rows } = await sql`SELECT id FROM backend_items`.execute(handle.db);
      expect(rows).toEqual([{ id: 1 }]);
      expect(() => methods.stores.users.findUser({})).toThrow(StoreNotImplementedError);
    } finally {
      await connection.close();
    }
  });

  it('still refuses without the variable', async () => {
    const backend = createPostgresDataStoreBackend();
    const connection = backend.createConnection({
      env: database.env({ POSTGRES_ALLOW_INCOMPLETE_STORES: 'false' }),
      cache: { handle: null, promise: null },
    });
    await expect(connection.connect()).rejects.toBeInstanceOf(IncompletePostgresBackendError);
  });
});

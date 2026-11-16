import { sql } from 'kysely';
import type { PostgresKysely } from './types';
import {
  isUniqueViolation,
  postgresStoreErrors,
  createPostgresStoreErrors,
  toStoreDuplicateKeyError,
} from './storeErrors';
import { describePostgres, usePostgresTestDatabase } from '~/test/postgres';
import { mongoStoreErrors } from '~/adapters/mongo/storeErrors';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { STORE_ERRORS_METHODS } from '~/ports/storeErrors';

interface PublicErrors {
  isDuplicateKeyError: (error: unknown) => boolean;
  duplicateKeyFields: (error: unknown) => string[] | undefined;
  backend: string;
}

/**
 * The public functions of `@librechat/data-schemas` (`~/adapters`), loaded in a fresh module
 * registry with `DATABASE_BACKEND` set to `backendName` (so the backend is chosen anew). Its
 * classes are that registry's own: a `StoreDuplicateKeyError` made here is not one of them.
 */
function loadPublicErrors(backendName: string | undefined): PublicErrors {
  const previous = process.env.DATABASE_BACKEND;
  let loaded: PublicErrors | undefined;
  try {
    if (backendName === undefined) {
      delete process.env.DATABASE_BACKEND;
    } else {
      process.env.DATABASE_BACKEND = backendName;
    }
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module registry
      const adapters = require('~/adapters') as typeof import('~/adapters');
      loaded = {
        isDuplicateKeyError: adapters.isDuplicateKeyError,
        duplicateKeyFields: adapters.duplicateKeyFields,
        backend: adapters.getDataStoreBackend().name,
      };
    });
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_BACKEND;
    } else {
      process.env.DATABASE_BACKEND = previous;
    }
  }
  return loaded!;
}

describe('PostgreSQL store errors without a database', () => {
  it('implements every StoreErrors method', () => {
    for (const method of STORE_ERRORS_METHODS) {
      expect(typeof postgresStoreErrors[method]).toBe('function');
    }
  });

  it('recognizes SQLSTATE 23505 and StoreDuplicateKeyError, nothing else', () => {
    expect(postgresStoreErrors.isDuplicateKey({ code: '23505' })).toBe(true);
    expect(postgresStoreErrors.isDuplicateKey(new StoreDuplicateKeyError())).toBe(true);
    for (const other of [{ code: '23502' }, { code: 11000 }, new Error('x'), null, '23505']) {
      expect(postgresStoreErrors.isDuplicateKey(other)).toBe(false);
    }
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it("names a StoreDuplicateKeyError's fields from its keyValue", () => {
    const error = new StoreDuplicateKeyError('dup', { keyValue: { email: 'a', tenantId: 't' } });
    expect(postgresStoreErrors.duplicateKeyFields(error)).toEqual(['email', 'tenantId']);
    expect(postgresStoreErrors.duplicateKeyFields(new StoreDuplicateKeyError())).toBeUndefined();
    expect(postgresStoreErrors.duplicateKeyFields(new Error('x'))).toBeUndefined();
  });
});

describePostgres('PostgreSQL store errors on a real unique violation', () => {
  const database = usePostgresTestDatabase();
  let db: PostgresKysely;

  /** The `pg` error of inserting a duplicate into `people`. */
  async function duplicateError(): Promise<unknown> {
    await sql`INSERT INTO people (email, "tenantId") VALUES ('a@example.com', 't1')`.execute(db);
    try {
      await sql`INSERT INTO people (email, "tenantId") VALUES ('a@example.com', 't1')`.execute(db);
    } catch (error) {
      return error;
    }
    throw new Error('expected a unique violation');
  }

  beforeAll(async () => {
    db = database.kysely();
    await sql`CREATE TABLE people (id serial PRIMARY KEY, email text NOT NULL, "tenantId" text)`.execute(
      db,
    );
    await sql`CREATE UNIQUE INDEX people__email_tenant ON people (email, "tenantId") NULLS NOT DISTINCT`.execute(
      db,
    );
  });

  beforeEach(() => sql`TRUNCATE people`.execute(db));

  const constraints = new Map([['people__email_tenant', ['email', 'tenantId']]]);

  it('is SQLSTATE 23505 naming the violated index', async () => {
    const error = (await duplicateError()) as { code?: string; constraint?: string };
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('people__email_tenant');
  });

  it('is recognized by the public isDuplicateKeyError when the backend is postgres', async () => {
    const error = await duplicateError();
    const errors = loadPublicErrors('postgres');
    const mongoDefault = loadPublicErrors(undefined);
    expect(mongoDefault.backend).toBe('mongo');
    /** The MongoDB backend (the default) does not take it for a duplicate key. */
    expect(mongoDefault.isDuplicateKeyError(error)).toBe(false);
    expect(errors.backend).toBe('postgres');
    expect(errors.isDuplicateKeyError(error)).toBe(true);
    /** The descriptor's index map does not exist yet (F3), so the fields are not known. */
    expect(errors.duplicateKeyFields(error)).toBeUndefined();
    expect(errors.isDuplicateKeyError(new Error('other'))).toBe(false);
  });

  it("names the key's fields from the constraint map", async () => {
    const error = await duplicateError();
    const errors = createPostgresStoreErrors(constraints);
    expect(errors.isDuplicateKey(error)).toBe(true);
    expect(errors.duplicateKeyFields(error)).toEqual(['email', 'tenantId']);
    expect(createPostgresStoreErrors(new Map()).duplicateKeyFields(error)).toBeUndefined();
  });

  it('converts to a StoreDuplicateKeyError carrying the written values', async () => {
    const error = await duplicateError();
    const converted = toStoreDuplicateKeyError(error, constraints, {
      email: 'a@example.com',
      tenantId: 't1',
      other: 1,
    });
    expect(converted).toBeInstanceOf(StoreDuplicateKeyError);
    expect(converted.keyValue).toEqual({ email: 'a@example.com', tenantId: 't1' });
    expect(converted.cause).toBe(error);
    expect(converted.message).toContain('people__email_tenant');
    expect(postgresStoreErrors.isDuplicateKey(converted)).toBe(true);
    expect(postgresStoreErrors.duplicateKeyFields(converted)).toEqual(['email', 'tenantId']);
    /** The MongoDB backend recognizes the neutral error too. */
    expect(mongoStoreErrors.isDuplicateKey(converted)).toBe(true);
  });

  it('reads nested paths of the record, and leaves keyValue out for an unknown index', async () => {
    const error = await duplicateError();
    const nested = toStoreDuplicateKeyError(
      error,
      new Map([['people__email_tenant', ['profile.email', 'tenantId']]]),
      { profile: { email: 'a@example.com' }, tenantId: null },
    );
    expect(nested.keyValue).toEqual({ 'profile.email': 'a@example.com', tenantId: null });
    const unknown = toStoreDuplicateKeyError(error, new Map());
    expect(unknown.keyValue).toBeUndefined();
    expect(postgresStoreErrors.isDuplicateKey(unknown)).toBe(true);
  });

  it('does not take other constraint violations for duplicate keys', async () => {
    let error: unknown;
    try {
      await sql`INSERT INTO people (email) VALUES (NULL)`.execute(db);
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string }).code).toBe('23502');
    expect(postgresStoreErrors.isDuplicateKey(error)).toBe(false);
  });
});

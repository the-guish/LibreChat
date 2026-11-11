import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { StoreErrors } from '~/ports/storeErrors';
import { STORE_ERRORS_METHODS, StoreDuplicateKeyError } from '~/ports/storeErrors';
import { isDuplicateKeyError, duplicateKeyFields } from '~/adapters/storeErrors';
import { getDataStoreBackend } from '~/adapters/backend';
import { mongoStoreErrors } from './storeErrors';

/** The checks callers outside the data layer made before the port, one per kind of check. */
const FORMER_CHECKS: Record<string, (error: unknown) => boolean> = {
  /** skills/handlers, skills/import, auth/email, code/http, middleware/error */
  objectWithNumericCode: (error) =>
    error != null && typeof error === 'object' && (error as { code?: unknown }).code === 11000,
  /** prompts/store, agents/handlers, agents/triggers/bindings (non-nullish) */
  anyValueWithNumericCode: (error) => (error as { code?: unknown } | undefined)?.code === 11000,
  /** auth/passkey/handlers */
  numericOrStringCode: (error) => {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return code === 11000 || code === 'E11000';
  },
};

/** What a caller may catch, besides real driver errors. */
const INPUTS: unknown[] = [
  undefined,
  null,
  0,
  11000,
  'E11000',
  '',
  true,
  {},
  [],
  new Error('plain'),
  { code: 11000 },
  { code: 11000, keyValue: { email: 'a@b.c' } },
  { code: 'E11000' },
  { code: '11000' },
  { code: 11001 },
  { code: 11100 },
  { code: 'SKILL_VALIDATION_FAILED' },
  { code: '23505' },
  { codeName: 'DuplicateKey' },
  Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
  Object.assign(new Error('not a duplicate'), { code: 121 }),
  new StoreDuplicateKeyError(),
];

let mongo: MongoMemoryServer;
interface ThingRecord {
  name: string;
  tenantId?: string;
  n?: number;
}

let Thing: mongoose.Model<ThingRecord>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  const schema = new mongoose.Schema<ThingRecord>({ name: String, tenantId: String, n: Number });
  schema.index({ name: 1, tenantId: 1 }, { unique: true });
  Thing = mongoose.model('StoreErrorsSpecThing', schema);
  await Thing.init();
});

beforeEach(async () => {
  await Thing.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

/** The error `write` rejects with. */
async function rejection(write: () => Promise<unknown>): Promise<unknown> {
  try {
    await write();
  } catch (error) {
    return error;
  }
  throw new Error('expected the write to reject');
}

describe('mongoStoreErrors', () => {
  it('lists each method once, implements them all and is the backend’s', () => {
    const errors: StoreErrors = mongoStoreErrors;
    expect(new Set(STORE_ERRORS_METHODS).size).toBe(STORE_ERRORS_METHODS.length);
    expect(Object.keys(errors).sort()).toEqual([...STORE_ERRORS_METHODS].sort());
    expect(getDataStoreBackend().errors).toBe(mongoStoreErrors);
  });

  it('recognizes a real unique index violation from create, with its fields', async () => {
    await Thing.create({ name: 'a', tenantId: 't' });
    const error = await rejection(() => Thing.create({ name: 'a', tenantId: 't' }));
    expect((error as { code?: unknown }).code).toBe(11000);
    expect(isDuplicateKeyError(error)).toBe(true);
    expect(duplicateKeyFields(error)).toEqual(['name', 'tenantId']);
    expect(Object.values(FORMER_CHECKS).every((check) => check(error))).toBe(true);
  });

  it('recognizes a violation from an update and from an upsert', async () => {
    await Thing.create([{ name: 'a' }, { name: 'b' }]);
    const update = await rejection(() =>
      Thing.updateOne({ name: 'b' }, { $set: { name: 'a' } }).exec(),
    );
    expect(isDuplicateKeyError(update)).toBe(true);
    expect(duplicateKeyFields(update)).toEqual(['name', 'tenantId']);

    await Thing.create({ name: 'c', tenantId: 't', n: 1 });
    const upsert = await rejection(() =>
      Thing.findOneAndUpdate(
        { name: 'c', tenantId: 't', n: 2 },
        { $set: { n: 2 } },
        { upsert: true },
      ).exec(),
    );
    expect(isDuplicateKeyError(upsert)).toBe(true);
  });

  it('recognizes a bulk write violation', async () => {
    const error = await rejection(() => Thing.insertMany([{ name: 'x' }, { name: 'x' }]));
    expect((error as { code?: unknown }).code).toBe(11000);
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it('does not take other driver errors for duplicates', async () => {
    await Thing.create({ name: 'a' });
    const error = await rejection(() =>
      Thing.collection.updateOne({ name: 'a' }, { $inc: { name: 1 } }),
    );
    expect(typeof (error as { code?: unknown }).code).toBe('number');
    expect(isDuplicateKeyError(error)).toBe(false);
    expect(duplicateKeyFields(error)).toBeUndefined();
  });

  it('recognizes the neutral error, with or without its key', () => {
    const withKey = new StoreDuplicateKeyError('taken', {
      keyValue: { email: 'a@b.c', tenantId: 't' },
      cause: { code: '23505' },
    });
    expect(withKey).toBeInstanceOf(Error);
    expect(withKey.name).toBe('StoreDuplicateKeyError');
    expect(withKey.message).toBe('taken');
    expect(withKey.cause).toEqual({ code: '23505' });
    expect(isDuplicateKeyError(withKey)).toBe(true);
    expect(duplicateKeyFields(withKey)).toEqual(['email', 'tenantId']);

    const bare = new StoreDuplicateKeyError();
    expect(bare.message).toBe('Duplicate key');
    expect(isDuplicateKeyError(bare)).toBe(true);
    expect(duplicateKeyFields(bare)).toBeUndefined();
  });

  it('recognizes exactly what the former checks did, and the neutral error', () => {
    for (const input of INPUTS) {
      const former =
        FORMER_CHECKS.objectWithNumericCode(input) || FORMER_CHECKS.numericOrStringCode(input);
      expect([input, isDuplicateKeyError(input)]).toEqual([
        input,
        former || input instanceof StoreDuplicateKeyError,
      ]);
      expect(isDuplicateKeyError(input)).toBe(mongoStoreErrors.isDuplicateKey(input));
    }
  });

  it('differs from a numeric-code check only on codes no MongoDB error carries', () => {
    const widened = INPUTS.filter(
      (input) => isDuplicateKeyError(input) !== FORMER_CHECKS.anyValueWithNumericCode(input),
    );
    expect(widened).toEqual([{ code: 'E11000' }, expect.any(StoreDuplicateKeyError)]);
  });

  it('names the fields only of a duplicate, as the error middleware did', () => {
    expect(duplicateKeyFields({ code: 11000 })).toBeUndefined();
    expect(duplicateKeyFields({ code: 11000, keyValue: { a: 1, b: 2 } })).toEqual(['a', 'b']);
    expect(duplicateKeyFields({ code: 11000, keyValue: {} })).toEqual([]);
    expect(duplicateKeyFields({ code: 121, keyValue: { a: 1 } })).toBeUndefined();
    expect(duplicateKeyFields(null)).toBeUndefined();
  });
});

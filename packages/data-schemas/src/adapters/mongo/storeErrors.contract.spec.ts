import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { isDuplicateKeyError, duplicateKeyFields } from '~/adapters/storeErrors';
import { createMethods } from '~/methods';
import { createModels } from '~/models';
import logger from '~/config/winston';

/**
 * The store methods whose ports promise a duplicate-key error (`~/ports/storeErrors`) that
 * callers outside the data layer turn into an outcome: on MongoDB, each rejects with an error
 * `isDuplicateKeyError` recognizes.
 */
let mongo: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  logger.silent = true;
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await Promise.all(
    ['Skill', 'Passkey', 'User'].map((name) => mongoose.models[name].syncIndexes()),
  );
  methods = createMethods(mongoose);
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

const skillInput = (author: mongoose.Types.ObjectId, name: string) => ({
  name,
  description: 'A skill used to check duplicate names.',
  body: '# Skill\n\nBody',
  frontmatter: { name, description: 'A skill used to check duplicate names.' },
  author,
  authorName: 'Author',
});

describe('duplicate-key errors of the MongoDB store methods', () => {
  it('createSkill: a name the author already uses', async () => {
    const author = new mongoose.Types.ObjectId();
    await methods.createSkill(skillInput(author, 'taken-name'));
    const error = await rejection(() => methods.createSkill(skillInput(author, 'taken-name')));
    expect(isDuplicateKeyError(error)).toBe(true);
    expect((error as Error).message).toMatch(/skill with name .* already exists/i);
  });

  it('updateSkill: a rename to a name the author already uses', async () => {
    const author = new mongoose.Types.ObjectId();
    await methods.createSkill(skillInput(author, 'first-name'));
    const { skill } = await methods.createSkill(skillInput(author, 'second-name'));
    const error = await rejection(() =>
      methods.updateSkill({
        id: skill._id.toString(),
        expectedVersion: 1,
        update: { name: 'first-name' },
      }),
    );
    expect(isDuplicateKeyError(error)).toBe(true);
    expect(duplicateKeyFields(error)).toEqual(['name', 'author', 'tenantId']);
  });

  it('createPasskey: a credential id registered again', async () => {
    const data = {
      user: new mongoose.Types.ObjectId().toString(),
      credentialId: 'credential-taken',
      publicKey: Buffer.from([1, 2, 3]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'multiDevice' as const,
      backedUp: true,
      name: 'This device',
    };
    await methods.createPasskey(data);
    const error = await rejection(() => methods.createPasskey(data));
    expect(isDuplicateKeyError(error)).toBe(true);
    expect(duplicateKeyFields(error)).toEqual(['credentialId']);
  });

  it('updateUser: an email another user holds', async () => {
    await mongoose.models.User.create({ email: 'held@example.com', provider: 'local' });
    const user = await mongoose.models.User.create({
      email: 'other@example.com',
      provider: 'local',
    });
    const error = await rejection(() =>
      methods.updateUser(user._id.toString(), { email: 'held@example.com' }),
    );
    expect(isDuplicateKeyError(error)).toBe(true);
    expect(duplicateKeyFields(error)).toEqual(['email', 'tenantId']);
  });
});

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createSkillMethods } from './skill';
import { createModels } from '~/models';

/**
 * `findExistingSkillIds`, the existence check the skill-states controller ran on the `Skill`
 * model through `filterExistingSkillIds` (skipped when the model is not registered).
 */

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createSkillMethods>;

const deps = {
  removeAllPermissions: async () => undefined,
  getSoleOwnedResourceIds: async () => [],
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createSkillMethods(mongoose, deps);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Skill.collection.deleteMany({});
});

describe('findExistingSkillIds', () => {
  it('keeps stored, undeleted and external ids, canonical, each once, in order', async () => {
    const stored = new mongoose.Types.ObjectId();
    const deleting = new mongoose.Types.ObjectId();
    const external = new mongoose.Types.ObjectId().toString();
    const missing = new mongoose.Types.ObjectId().toString();
    await mongoose.models.Skill.collection.insertMany([
      { _id: stored, name: 'stored' },
      { _id: deleting, name: 'deleting', deletingAt: new Date() },
    ]);

    await expect(
      methods.findExistingSkillIds(
        [
          external,
          'not-an-id',
          stored.toString().toUpperCase(),
          missing,
          deleting.toString(),
          stored.toString(),
        ],
        (id) => id === external,
      ),
    ).resolves.toEqual([external, stored.toString()]);
    await expect(methods.findExistingSkillIds([external])).resolves.toEqual([]);
    await expect(methods.findExistingSkillIds([])).resolves.toEqual([]);
  });

  it('returns the candidates unchanged without the skill model', async () => {
    const unregistered = new mongoose.Mongoose();
    const candidates = ['not-an-id', new mongoose.Types.ObjectId().toString()];
    await expect(
      createSkillMethods(unregistered, deps).findExistingSkillIds(candidates),
    ).resolves.toBe(candidates);
  });
});

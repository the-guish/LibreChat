import mongoose, { Schema, Types } from 'mongoose';
import { createSchemaEngine, ENGINE_PLUGIN_DEFAULTS, getSchemaEngine } from './engine';
import { generateSchemaDescriptor } from './generate';
import mongoMeili from '~/models/plugins/mongoMeili';
import { SCHEMA_OVERRIDES } from './overrides';
import convoSchema from '~/schema/convo';
import { RAW_COLLECTIONS } from './raw';

jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn().mockImplementation(() => ({
    index: () => ({ getRawInfo: () => Promise.resolve({}) }),
    createIndex: jest.fn(),
    waitForTask: jest.fn(),
  })),
  MeiliSearchTimeOutError: class MeiliSearchTimeOutError extends Error {},
}));

const engine = createSchemaEngine();

describe('PostgreSQL schema engine (D2)', () => {
  it('has a model for every table of the descriptor, on an instance that never connects', () => {
    const roots = generateSchemaDescriptor()
      .tables.filter((table) => table.kind === 'collection' || table.kind === 'raw')
      .map((table) => table.collection);
    expect([...engine.collections].sort()).toEqual([...roots].sort());
    expect(engine.collections).toHaveLength(53 + RAW_COLLECTIONS.length);
    for (const collection of engine.collections) {
      expect(engine.model(collection).db.readyState).toBe(0);
    }
    expect(getSchemaEngine()).toBe(getSchemaEngine());
  });

  it('builds documents with casting, defaults, setters and subdocument _ids, without timestamps or __v', async () => {
    const document = await engine.buildDocument('users', {
      email: 'Someone@Example.COM',
      emailVerified: 'true',
      twoFactorEnabled: 0,
    });
    expect(document._id).toBeInstanceOf(Types.ObjectId);
    expect(document).toMatchObject({
      email: 'someone@example.com',
      emailVerified: true,
      twoFactorEnabled: false,
      provider: 'local',
      role: 'USER',
      backupCodes: [],
    });
    expect((document.personalization as { _id: unknown })._id).toBeInstanceOf(Types.ObjectId);
    expect(document).not.toHaveProperty('createdAt');
    expect(document).not.toHaveProperty('__v');
  });

  it('flattens Maps to plain objects, as MongoDB stores them', async () => {
    const document = await engine.buildDocument(
      'users',
      { skillStates: new Map([['b', 'yes']]) },
      { validate: false },
    );
    expect(document.skillStates).toEqual({ b: true });
    expect(document.skillStates).not.toBeInstanceOf(Map);
  });

  it('validates (enums, required, pre-validate hooks) unless told not to', async () => {
    await expect(engine.buildDocument('users', { email: 'a@b.c', role: {} })).rejects.toThrow();
    await expect(engine.buildDocument('messages', { messageId: 'm' })).rejects.toMatchObject({
      name: 'ValidationError',
    });
    await expect(
      engine.buildDocument('messages', { messageId: 'm' }, { validate: false }),
    ).resolves.toMatchObject({ messageId: 'm' });
    await expect(
      engine.validatePaths('messages', { messageId: 'm' }, ['conversationId']),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(
      engine.validatePaths('messages', { conversationId: 'c' }, ['conversationId']),
    ).resolves.toBeUndefined();
  });

  it('applies the mongoMeili plugin paths with the plugin defaults to conversations and messages only', async () => {
    for (const collection of ['conversations', 'messages']) {
      const document = await engine.buildDocument(collection, {}, { validate: false });
      expect(document).toMatchObject(ENGINE_PLUGIN_DEFAULTS);
    }
    const user = await engine.buildDocument('users', {}, { validate: false });
    expect(user).not.toHaveProperty('_meiliIndex');
    /** The module-level schema the MongoDB models share is left as it is. */
    expect(convoSchema.path('_meiliIndex')).toBeUndefined();
  });

  it('declares the defaults the mongoMeili plugin gives its paths', () => {
    const schema = new Schema({ conversationId: String, subagentThread: String });
    schema.plugin(mongoMeili, {
      mongoose,
      host: 'http://meili.invalid',
      apiKey: 'key',
      indexName: 'conversations',
      primaryKey: 'conversationId',
      excludeFromIndexPath: 'subagentThread',
    });
    const pluginDefaults: Record<string, unknown> = {};
    for (const path of Object.keys(SCHEMA_OVERRIDES.pluginPaths[0].paths)) {
      const value = (schema.path(path) as unknown as { defaultValue?: unknown }).defaultValue;
      if (value !== undefined) pluginDefaults[path] = value;
    }
    expect(pluginDefaults).toEqual(ENGINE_PLUGIN_DEFAULTS);
  });

  it('builds subdocuments of updates and names immutable paths', () => {
    const element = engine.castUpdateValue('balances', '$push', 'reservations', { amount: '5' });
    expect(element).toBeDefined();
    expect(engine.isImmutable('users', 'createdAt')).toBe(true);
    expect(engine.isImmutable('users', 'updatedAt')).toBe(false);
    expect(engine.isImmutable('auditlogs', 'actor.name')).toBe(true);
    expect(engine.isImmutable('files', 'metadata.runFile')).toBe(true);
    expect(engine.isImmutable('files', 'notDeclared')).toBe(false);
    expect(() => engine.castUpdateValue('users', '$set', 'personalization', 'x')).toThrow();
  });
});

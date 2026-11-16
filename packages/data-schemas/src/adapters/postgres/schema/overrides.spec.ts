import mongoose, { Schema } from 'mongoose';
import mongoMeili from '~/models/plugins/mongoMeili';
import { SCHEMA_OVERRIDES } from './overrides';

jest.mock('meilisearch', () => ({
  MeiliSearch: jest.fn().mockImplementation(() => ({
    index: () => ({ getRawInfo: () => Promise.resolve({}) }),
    createIndex: jest.fn(),
    waitForTask: jest.fn(),
  })),
  MeiliSearchTimeOutError: class MeiliSearchTimeOutError extends Error {},
}));

/** The options models/convo.ts and models/message.ts give the plugin. */
const PLUGIN_OPTIONS: Record<string, { primaryKey: string; excludeFromIndexPath: string }> = {
  conversations: { primaryKey: 'conversationId', excludeFromIndexPath: 'subagentThread' },
  messages: { primaryKey: 'messageId', excludeFromIndexPath: 'subagentTask' },
};

describe('PostgreSQL schema overrides', () => {
  it.each(SCHEMA_OVERRIDES.pluginPaths.map((entry) => [entry.collection, entry] as const))(
    'declares the paths and indexes the mongoMeili plugin adds to %s',
    (collection, override) => {
      const options = PLUGIN_OPTIONS[collection];
      const schema = new Schema({
        [options.primaryKey]: String,
        [options.excludeFromIndexPath]: String,
      });
      const before = new Set(Object.keys(schema.paths));
      schema.plugin(mongoMeili, {
        mongoose,
        host: 'http://meili.invalid',
        apiKey: 'key',
        indexName: collection,
        ...options,
      });
      const added = Object.keys(schema.paths).filter((path) => !before.has(path));
      expect(added).toEqual(Object.keys(override.paths));
      for (const path of added) {
        const type = schema.path(path) as unknown as {
          instance: string;
          options: { select?: boolean };
        };
        const declared = override.paths[path] as { type: () => unknown; select?: boolean };
        expect({ path, instance: type.instance, select: type.options.select }).toEqual({
          path,
          instance: declared.type.name,
          select: declared.select,
        });
      }
      expect(JSON.parse(JSON.stringify(schema.indexes()))).toEqual(
        JSON.parse(
          JSON.stringify(
            override.indexes.map(([fields, indexOptions]) => [
              fields,
              { background: true, ...indexOptions },
            ]),
          ),
        ),
      );
    },
  );

  it('states a reason for every override', () => {
    const entries = [
      ...SCHEMA_OVERRIDES.columnTypes,
      ...SCHEMA_OVERRIDES.jsonHints,
      ...SCHEMA_OVERRIDES.elementTables,
      ...SCHEMA_OVERRIDES.pluginPaths,
      SCHEMA_OVERRIDES.largeTables,
    ];
    for (const entry of entries) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

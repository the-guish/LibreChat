import fs from 'node:fs';
import path from 'node:path';
import { Mongoose } from 'mongoose';
import { MCP_SERVER_HOOKS, DEFAULT_COLLECTION_HOOKS, AUDIT_LOG_APPEND_ONLY_MESSAGE } from './hooks';
import { USER_SEARCH_TOKEN_FIELDS, GROUP_SEARCH_TOKEN_FIELDS } from '~/utils/search';
import { hasTenantIsolation } from '~/models/plugins/tenantIsolation';
import { SCHEMA_DESCRIPTOR } from '../schema/descriptor.generated';
import { POSTGRES_UNIQUE_CONSTRAINTS } from '../storeErrors';
import { descriptorUniqueConstraints } from './constraints';
import { getSchemaEngine } from '../schema/engine';
import { createModels } from '~/models';

/**
 * The collection primitive's bindings checked against the mongoose schemas they re-express
 * (docs/postgres-port/PHASE4.md §1.8, §1.9, §3.6): which collections bind the tenant policy, which
 * carry collection hooks, and the duplicate-key map of the descriptor.
 */

const models = Object.values(createModels(new Mongoose())) as unknown as Array<{
  schema: Parameters<typeof hasTenantIsolation>[0];
  collection: { collectionName: string };
}>;
const collectionOf = (model: (typeof models)[number]) => model.collection.collectionName;

describe('collection primitive bindings', () => {
  it('binds the tenant policy to exactly the collections whose schema has the plugin', () => {
    const engine = getSchemaEngine();
    const expected = models.filter((model) => hasTenantIsolation(model.schema)).map(collectionOf);
    expect(expected.length).toBeGreaterThan(40);
    const actual = engine.collections.filter((collection) => engine.isTenantScoped(collection));
    expect(actual.sort()).toEqual([...expected].sort());
    expect(engine.isTenantScoped('browser_setup_sessions')).toBe(false);
  });

  it('keeps search tokens for exactly the schemas that derive them', () => {
    const tokenFields = new Map([
      ['users', USER_SEARCH_TOKEN_FIELDS],
      ['groups', GROUP_SEARCH_TOKEN_FIELDS],
    ]);
    for (const model of models) {
      const collection = collectionOf(model);
      const derives = (model.schema as unknown as { path(p: string): unknown }).path('nameTokens');
      expect([collection, Boolean(derives)]).toEqual([collection, tokenFields.has(collection)]);
      if (tokenFields.has(collection)) {
        expect(DEFAULT_COLLECTION_HOOKS[collection]?.beforeInsert).toBeDefined();
        expect(DEFAULT_COLLECTION_HOOKS[collection]?.beforeUpdate).toBeDefined();
      }
    }
  });

  it('refuses audit log mutations with the schema message', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../schema/auditLog.ts'), 'utf8');
    expect(source).toContain(`'${AUDIT_LOG_APPEND_ONLY_MESSAGE}'`);
    const hooks = DEFAULT_COLLECTION_HOOKS.auditlogs;
    for (const refuse of [
      hooks.beforeUpdate,
      hooks.beforeDelete,
      hooks.beforeInsertMany,
      hooks.beforeBulk,
    ]) {
      expect(() => (refuse as (...args: unknown[]) => unknown)({}, {})).toThrow(
        AUDIT_LOG_APPEND_ONLY_MESSAGE,
      );
    }
    expect(hooks.beforeInsert).toBeUndefined();
  });

  it('normalizes MCP server names as the schema pre-validate hook does', async () => {
    for (const serverName of ['My Server', 'a.b/c', 'ünï cödé', 'plain']) {
      const built = await getSchemaEngine().buildDocument(
        'mcpservers',
        { serverName, config: {}, author: '65000000000000000000000a' },
        { validate: true },
      );
      expect(MCP_SERVER_HOOKS.beforeBuild!({ serverName }).normalizedServerName).toBe(
        built.normalizedServerName,
      );
    }
  });

  it('maps every unique index and primary key of the descriptor to its fields', () => {
    const map = descriptorUniqueConstraints(SCHEMA_DESCRIPTOR);
    expect(POSTGRES_UNIQUE_CONSTRAINTS).toBe(map);
    for (const table of SCHEMA_DESCRIPTOR.tables) {
      if (table.kind !== 'collection' && table.kind !== 'raw') continue;
      expect(map.get(`${table.name}__pkey`)).toEqual(table.primaryKey);
      for (const index of table.indexes.filter((entry) => entry.unique)) {
        expect(map.get(index.name)).toEqual(index.sources[0].fields.map(([field]) => field));
      }
    }
    const users = SCHEMA_DESCRIPTOR.tables.find((table) => table.name === 'users')!;
    const email = users.indexes.find(
      (index) =>
        index.unique && index.sources[0].fields.map(([f]) => f).join() === 'email,tenantId',
    )!;
    expect(map.get(email.name)).toEqual(['email', 'tenantId']);
  });
});

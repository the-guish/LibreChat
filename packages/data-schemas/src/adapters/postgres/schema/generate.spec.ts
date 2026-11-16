import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import type { Schema } from 'mongoose';
import type {
  FieldDescriptor,
  TableDescriptor,
  SchemaDescriptor,
  IndexSourceDescriptor,
} from './descriptor';
import { parentKeyName, primaryKeyName, defaultMongoIndexName } from './descriptor';
import { CHECKPOINT_DELETION_COLLECTION } from '~/adapters/mongo/checkpointStore';
import { CHECKPOINT_STORAGE_COLLECTION } from '~/adapters/mongo/checkpointSaver';
import { CREDENTIAL_MARKER_COLLECTION } from '~/adapters/mongo/credentialMarker';
import { generateSchemaDescriptor, collectModelSources } from './generate';
import { IDENTIFIER_MAX_BYTES, identifierBytes } from './naming';
import { SCHEMA_OVERRIDES } from './overrides';
import { RAW_COLLECTIONS } from './raw';
import { createModels } from '~/models';

/** What one schema type maps to, read with mongoose's public schema API. */
type ExpectedKind = FieldDescriptor['kind'];

interface IntrospectedType {
  instance: string;
  schema?: Schema;
  $isSingleNested?: boolean;
  $isMongooseDocumentArray?: boolean;
  $embeddedSchemaType?: { instance: string };
  options: Record<string, unknown>;
}

/** Every declared path of `schema` (prefixed), with the node kind §1.2 gives it. */
function mongoosePaths(schema: Schema, prefix = '', out = new Map<string, ExpectedKind>()) {
  schema.eachPath((relative, schemaType) => {
    if (relative.includes('$*')) return;
    const segments = relative.split('.');
    for (let i = 1; i < segments.length; i++) {
      const nested = segments.slice(0, i).join('.');
      if (schema.pathType(nested) === 'nested') out.set(prefix + nested, 'object');
    }
    const type = schemaType as unknown as IntrospectedType;
    const full = prefix + relative;
    if (type.$isSingleNested && type.schema) {
      out.set(full, 'object');
      mongoosePaths(type.schema, `${full}.`, out);
    } else if (type.$isMongooseDocumentArray && type.schema) {
      out.set(full, 'children');
      mongoosePaths(type.schema, `${full}.`, out);
    } else if (type.instance === 'Array') {
      out.set(full, type.$embeddedSchemaType?.instance === 'Mixed' ? 'json' : 'array');
    } else if (type.instance === 'Mixed' || type.instance === 'Map') {
      out.set(full, 'json');
    } else {
      out.set(full, 'scalar');
    }
  });
  return out;
}

/** Every node of the descriptor's tables of `collection`, by document path. */
function descriptorPaths(descriptor: SchemaDescriptor, collection: string) {
  const out = new Map<string, ExpectedKind>();
  const walk = (fields: FieldDescriptor[], prefix: string) => {
    for (const field of fields) {
      out.set(prefix + field.path, field.kind);
      if (field.kind === 'object') walk(field.fields, prefix);
    }
  };
  for (const table of descriptor.tables.filter((entry) => entry.collection === collection)) {
    walk(table.fields, table.kind === 'child' ? `${table.path}.` : '');
  }
  return out;
}

function sourceKey(fields: Array<[string, unknown]>, options: Record<string, unknown>): string {
  return JSON.stringify({
    fields,
    name: typeof options.name === 'string' ? options.name : defaultMongoIndexName(fields),
    unique: options.unique === true,
    sparse: options.sparse === true,
    partial: options.partialFilterExpression ?? null,
    ttl: options.expireAfterSeconds ?? null,
  });
}

function descriptorSourceKeys(descriptor: SchemaDescriptor, collection: string): string[] {
  const sources = new Set<IndexSourceDescriptor>();
  for (const table of descriptor.tables.filter((entry) => entry.collection === collection)) {
    for (const index of table.indexes) index.sources.forEach((source) => sources.add(source));
  }
  return [...sources]
    .map((source) =>
      JSON.stringify({
        fields: source.fields,
        name: source.mongoName,
        unique: source.unique,
        sparse: source.sparse,
        partial: source.partialFilterExpression ?? null,
        ttl: source.expireAfterSeconds ?? null,
      }),
    )
    .sort();
}

const pluginPathsOf = (collection: string): string[] =>
  SCHEMA_OVERRIDES.pluginPaths
    .filter((entry) => entry.collection === collection)
    .flatMap((entry) => Object.keys(entry.paths));

describe('PostgreSQL schema generator on the production schemas', () => {
  const models = Object.values(createModels(new mongoose.Mongoose()));
  const descriptor = generateSchemaDescriptor();
  const collections = models.map((model) => model.collection.collectionName);

  it('reads every model the MongoDB backend registers (53) and every raw collection', () => {
    expect(models).toHaveLength(53);
    expect(collectModelSources().map((source) => source.collection)).toEqual(collections);
    const roots = descriptor.tables.filter((table) => !table.parent);
    expect(roots.map((table) => table.collection)).toEqual([
      ...collections,
      ...RAW_COLLECTIONS.map((raw) => raw.collection),
    ]);
    expect(roots.filter((table) => table.kind === 'collection')).toHaveLength(53);
  });

  it.each(models.map((model) => [model.collection.collectionName, model] as const))(
    'maps every path of %s as mongoose declares it',
    (collection, model) => {
      const expected = mongoosePaths(model.schema);
      for (const plugin of pluginPathsOf(collection)) expected.set(plugin, 'scalar');
      for (const entry of SCHEMA_OVERRIDES.elementTables.filter(
        (e) => e.collection === collection,
      )) {
        expect(expected.get(entry.path)).toBe('array');
        expected.set(entry.path, 'elements');
      }
      for (const entry of SCHEMA_OVERRIDES.columnTypes.filter((e) => e.collection === collection)) {
        expect(expected.get(entry.path)).toBe('json');
        expected.set(entry.path, 'scalar');
      }
      expect(Object.fromEntries(descriptorPaths(descriptor, collection))).toEqual(
        Object.fromEntries(expected),
      );
    },
  );

  it.each(models.map((model) => [model.collection.collectionName, model] as const))(
    'maps every index of %s',
    (collection, model) => {
      const expected = model.schema
        .indexes()
        .map(([fields, options]) =>
          sourceKey(Object.entries(fields), options as Record<string, unknown>),
        );
      for (const plugin of SCHEMA_OVERRIDES.pluginPaths.filter(
        (e) => e.collection === collection,
      )) {
        for (const [fields, options] of plugin.indexes) {
          expected.push(sourceKey(Object.entries(fields), options));
        }
      }
      expect(descriptorSourceKeys(descriptor, collection)).toEqual(expected.sort());
    },
  );

  it('maps every index of the raw collections', () => {
    for (const raw of RAW_COLLECTIONS) {
      const expected = raw.schema
        .indexes()
        .map(([fields, options]) =>
          sourceKey(Object.entries(fields), options as Record<string, unknown>),
        );
      expect(descriptorSourceKeys(descriptor, raw.collection)).toEqual(expected.sort());
    }
  });

  it('types every scalar column as its mongoose instance', () => {
    const expectedSql: Record<string, string> = {
      String: 'text COLLATE "C"',
      Number: 'double precision',
      Boolean: 'boolean',
      Date: 'timestamptz',
      ObjectId: 'lc_object_id',
      Buffer: 'bytea',
    };
    for (const model of models) {
      const root = descriptor.tables.find(
        (table) => table.name === model.collection.collectionName,
      )!;
      model.schema.eachPath((pathName, schemaType) => {
        const type = schemaType as unknown as IntrospectedType;
        const sql = expectedSql[type.instance];
        if (!sql || pathName === '__v' || pathName === '_id' || pathName.includes('$*')) return;
        const column = root.columns.find((entry) => entry.path === pathName);
        expect({
          path: `${model.collection.collectionName}.${pathName}`,
          sql: column?.sqlType,
        }).toEqual({
          path: `${model.collection.collectionName}.${pathName}`,
          sql,
        });
      });
    }
  });

  it('keeps every identifier within 63 bytes', () => {
    const identifiers = descriptor.tables.flatMap((table: TableDescriptor) => [
      table.name,
      primaryKeyName(table),
      ...(table.parent ? [parentKeyName(table)] : []),
      ...table.columns.map((column) => column.name),
      ...table.indexes.map((index) => index.name),
      ...table.checks.map((check) => check.name),
    ]);
    const tooLong = identifiers.filter((name) => identifierBytes(name) > IDENTIFIER_MAX_BYTES);
    expect(tooLong).toEqual([]);
    const shortened = descriptor.tables.find((table) =>
      table.name.startsWith('conversations__agentEventActor__compactionSemanticInde_'),
    );
    expect(shortened).toMatchObject({
      path: 'agentEventActor.compactionSemanticIndex.entries',
    });
    expect(identifierBytes(shortened!.name)).toBe(63);
  });

  it('applies the overrides of §1.6', () => {
    const tableOf = (name: string) => descriptor.tables.find((table) => table.name === name)!;
    for (const collection of ['aclentries', 'systemgrants']) {
      expect(tableOf(collection).columns.find((c) => c.name === 'principalId')).toMatchObject({
        sqlType: 'text COLLATE "C"',
        type: 'objectIdOrString',
      });
    }
    expect(tableOf('agenttriggerdeliveries').checks).toHaveLength(8);
    expect(tableOf('assistants').checks.map((check) => check.path)).toEqual(['filepath']);
    expect(tableOf('skills').checks.map((check) => check.path)).toEqual(['upstreamId', 'sourceId']);
    expect(
      descriptor.tables.filter((table) => table.kind === 'element').map((table) => table.name),
    ).toEqual([
      'users__nameTokens',
      'users__emailTokens',
      'users__usernameTokens',
      'groups__nameTokens',
      'groups__emailTokens',
    ]);
    for (const collection of ['conversations', 'messages']) {
      const names = tableOf(collection).columns.map((column) => column.name);
      expect(names).toEqual(expect.arrayContaining(pluginPathsOf(collection)));
      expect(tableOf(collection).hiddenPaths).toEqual(
        expect.arrayContaining(pluginPathsOf(collection)),
      );
    }
    expect(
      descriptor.tables.filter((table) => table.large).map((table) => table.collection),
    ).toEqual(expect.arrayContaining([...SCHEMA_OVERRIDES.largeTables.collections]));
  });

  it('names the raw collections as the MongoDB modules do', () => {
    const names = RAW_COLLECTIONS.map((raw) => raw.collection);
    expect(names).toEqual(
      expect.arrayContaining([
        CHECKPOINT_DELETION_COLLECTION,
        CHECKPOINT_STORAGE_COLLECTION,
        CREDENTIAL_MARKER_COLLECTION,
      ]),
    );
    const source = (file: string) =>
      fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
    for (const name of [
      'browser_setup_sessions',
      'browser_setup_budget',
      'browser_setup_requests',
    ]) {
      expect(source('methods/browserSetup.ts')).toContain(`'${name}'`);
    }
    for (const name of ['code_environment_tombstones', 'code_environment_reconciliation']) {
      expect(source('methods/codeEnvironment.ts')).toContain(`'${name}'`);
    }
    expect(source('methods/mcpAuthorizationFenceRetry.ts')).toContain(
      "'mcp_authorization_fence_retries'",
    );
  });

  it('is deterministic and serializable (the snapshot is plain JSON)', () => {
    const again = generateSchemaDescriptor();
    expect(again).toEqual(descriptor);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  });

  it('counts what the design measured', () => {
    const count = (kind: TableDescriptor['kind']) =>
      descriptor.tables.filter((table) => table.kind === kind).length;
    const modelTables = descriptor.tables.filter(
      (table) => !RAW_COLLECTIONS.some((raw) => raw.collection === table.collection),
    );
    expect({
      collections: count('collection'),
      raw: count('raw'),
      modelChildTables: modelTables.filter((table) => table.kind === 'child').length,
      elementTables: count('element'),
      modelJsonColumns: modelTables.flatMap((t) => t.columns).filter((c) => c.type === 'json')
        .length,
    }).toEqual({
      collections: 53,
      raw: 10,
      modelChildTables: 25,
      elementTables: 5,
      modelJsonColumns: 38,
    });
  });
});

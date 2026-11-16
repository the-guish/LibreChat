/**
 * The PostgreSQL schema generator (docs/postgres-port/PHASE4.md §5): reads the collection schemas
 * offline and builds the {@link SchemaDescriptor}, from
 *
 * - `createModels(new Mongoose())`: every model the MongoDB backend registers, with the plugin
 *   paths of the overrides applied to a copy of its schema;
 * - `schema/raw`: the raw collections;
 * - `overrides.ts`.
 *
 * Mongoose is used here without a connection, for schema introspection only (D2); this module
 * and `raw/` are the only files of `adapters/postgres` allowed to load it (eslint.config.mjs),
 * and neither the generated descriptor nor the adapter's runtime depends on them.
 */
import { Mongoose } from 'mongoose';
import type { Schema } from 'mongoose';
import type {
  SourceField,
  SourceIndex,
  TimestampNames,
  StringTransform,
  CollectionSource,
  SchemaDescriptor,
} from './descriptor';
import type { SchemaOverrides } from './overrides';
import { buildSchemaDescriptor } from './descriptor';
import { SchemaGenerationError } from './naming';
import { SCHEMA_OVERRIDES } from './overrides';
import { RAW_COLLECTIONS } from './raw';
import { createModels } from '~/models';

/** The parts of mongoose's `SchemaType` the introspection reads. */
interface IntrospectedType {
  instance: string;
  options?: Record<string, unknown>;
  schema?: Schema;
  $isSingleNested?: boolean;
  $isMongooseDocumentArray?: boolean;
  $embeddedSchemaType?: IntrospectedType;
  caster?: IntrospectedType;
  $__schemaType?: IntrospectedType;
}

const TRANSFORMS: readonly StringTransform[] = ['lowercase', 'uppercase', 'trim'];

function transformsOf(...options: Array<Record<string, unknown> | undefined>): StringTransform[] {
  return TRANSFORMS.filter((transform) => options.some((option) => option?.[transform] === true));
}

/** One schema type as a {@link SourceField} named `name`. */
function introspectType(type: IntrospectedType, name: string, where: string): SourceField {
  const options = type.options ?? {};
  const hidden = options.select === false;
  if (type.$isSingleNested && type.schema) {
    return {
      kind: 'object',
      name,
      subdocument: true,
      fields: introspectFields(type.schema, `${where}.${name}`),
      hidden,
    };
  }
  if (type.$isMongooseDocumentArray && type.schema) {
    return {
      kind: 'documentArray',
      name,
      fields: introspectFields(type.schema, `${where}.${name}`),
      hidden,
    };
  }
  if (type.instance === 'Array') {
    const element = type.$embeddedSchemaType ?? type.caster;
    if (!element) {
      throw new SchemaGenerationError(`${where}.${name}: array without an element type`);
    }
    const field = introspectType(element, name, where);
    if (field.kind === 'leaf') {
      field.transforms = transformsOf(element.options, options);
    }
    return { kind: 'array', name, element: field, hidden };
  }
  if (type.instance === 'Map') {
    const of = type.$__schemaType;
    return {
      kind: 'map',
      name,
      of: of
        ? introspectType(of, name, where)
        : { kind: 'leaf', name, instance: 'Mixed', hidden: false, transforms: [] },
      hidden,
    };
  }
  return { kind: 'leaf', name, instance: type.instance, hidden, transforms: transformsOf(options) };
}

/**
 * The fields of `schema` in `schema.paths` order; a nested plain object is placed at its first
 * path and holds its own paths.
 */
export function introspectFields(schema: Schema, where = 'schema'): SourceField[] {
  const root: SourceField[] = [];
  const nested = new Map<string, SourceField[]>();
  const nestedPaths = (schema as unknown as { nested: Record<string, unknown> }).nested ?? {};
  const containerOf = (path: string): SourceField[] => {
    const dot = path.lastIndexOf('.');
    if (dot < 0) {
      return root;
    }
    const parent = path.slice(0, dot);
    const existing = nested.get(parent);
    if (existing) {
      return existing;
    }
    if (!nestedPaths[parent]) {
      throw new SchemaGenerationError(`${where}: "${path}" has no nested parent "${parent}"`);
    }
    const fields: SourceField[] = [];
    nested.set(parent, fields);
    containerOf(parent).push({
      kind: 'object',
      name: parent.slice(parent.lastIndexOf('.') + 1),
      subdocument: false,
      fields,
      hidden: false,
    });
    return fields;
  };
  for (const [path, type] of Object.entries(schema.paths)) {
    if (path.includes('.$*')) {
      continue;
    }
    const name = path.slice(path.lastIndexOf('.') + 1);
    containerOf(path).push(introspectType(type as unknown as IntrospectedType, name, where));
  }
  return root;
}

function timestampNames(schema: Schema): TimestampNames | null {
  const timestamps = schema.get('timestamps') as unknown;
  if (!timestamps) {
    return null;
  }
  if (timestamps === true) {
    return { createdAt: 'createdAt', updatedAt: 'updatedAt' };
  }
  const options = timestamps as { createdAt?: unknown; updatedAt?: unknown };
  const name = (value: unknown, fallback: string): string | null => {
    if (value === false) return null;
    return typeof value === 'string' ? value : fallback;
  };
  return {
    createdAt: name(options.createdAt, 'createdAt'),
    updatedAt: name(options.updatedAt, 'updatedAt'),
  };
}

/** A collection schema as a {@link CollectionSource}. */
export function introspectSchema(
  schema: Schema,
  options: {
    collection: string;
    kind?: 'collection' | 'raw';
    modelName?: string;
    primaryKey?: string[];
    pluginIndexes?: SourceIndex[];
  },
): CollectionSource {
  const versionKey = schema.get('versionKey') as unknown;
  const indexes: SourceIndex[] = schema.indexes().map(([fields, indexOptions]) => ({
    fields: Object.entries(fields as Record<string, unknown>),
    options: { ...(indexOptions as Record<string, unknown>) },
  }));
  const fields = introspectFields(schema, options.collection);
  if (typeof versionKey === 'string' && !fields.some((field) => field.name === versionKey)) {
    /** Mongoose adds the version key path when it compiles a model; a bare schema lacks it. */
    fields.push({
      kind: 'leaf',
      name: versionKey,
      instance: 'Number',
      hidden: false,
      transforms: [],
    });
  }
  return {
    collection: options.collection,
    kind: options.kind ?? 'collection',
    ...(options.modelName ? { modelName: options.modelName } : {}),
    fields,
    indexes: [...indexes, ...(options.pluginIndexes ?? [])],
    timestamps: timestampNames(schema),
    versionKey: typeof versionKey === 'string' ? versionKey : null,
    strict: schema.get('strict') !== false,
    ...(options.primaryKey ? { primaryKey: [...options.primaryKey] } : {}),
  };
}

/**
 * The models the MongoDB backend registers (`createModels`), built on a private mongoose instance
 * without a connection. The `mongoMeili` plugin is kept off (it would contact MeiliSearch): its
 * paths and indexes come from the overrides, on every environment.
 */
export function collectModelSources(
  overrides: SchemaOverrides = SCHEMA_OVERRIDES,
): CollectionSource[] {
  const meiliHost = process.env.MEILI_HOST;
  const meiliKey = process.env.MEILI_MASTER_KEY;
  delete process.env.MEILI_HOST;
  delete process.env.MEILI_MASTER_KEY;
  let models: ReturnType<typeof createModels>;
  try {
    models = createModels(new Mongoose());
  } finally {
    if (meiliHost !== undefined) process.env.MEILI_HOST = meiliHost;
    if (meiliKey !== undefined) process.env.MEILI_MASTER_KEY = meiliKey;
  }
  const registered = Object.values(models) as unknown as Array<{
    modelName: string;
    schema: Schema;
    collection: { collectionName: string };
  }>;
  return registered.map((model) => {
    // eslint-disable-next-line no-restricted-syntax -- Collection name metadata only, no raw driver operations.
    const collection = model.collection.collectionName;
    const plugins = overrides.pluginPaths.filter((entry) => entry.collection === collection);
    let schema = model.schema;
    const pluginIndexes: SourceIndex[] = [];
    if (plugins.length > 0) {
      /** A copy: the module-level schema the MongoDB models share is left as it is. */
      schema = schema.clone();
      for (const plugin of plugins) {
        schema.add({ ...plugin.paths });
        for (const [fields, options] of plugin.indexes) {
          pluginIndexes.push({
            fields: Object.entries(fields),
            options: { ...options },
            plugin: true,
          });
        }
      }
    }
    return introspectSchema(schema, {
      collection,
      modelName: model.modelName,
      pluginIndexes,
    });
  });
}

/** The raw collections (`schema/raw`). */
export function collectRawSources(): CollectionSource[] {
  return RAW_COLLECTIONS.map((raw) =>
    introspectSchema(raw.schema, {
      collection: raw.collection,
      kind: 'raw',
      ...(raw.primaryKey ? { primaryKey: raw.primaryKey } : {}),
    }),
  );
}

/** Every collection schema the PostgreSQL schema maps: the models, then the raw collections. */
export function collectSchemaSources(
  overrides: SchemaOverrides = SCHEMA_OVERRIDES,
): CollectionSource[] {
  return [...collectModelSources(overrides), ...collectRawSources()];
}

/** The descriptor of the whole PostgreSQL schema, as the generator builds it today. */
export function generateSchemaDescriptor(
  overrides: SchemaOverrides = SCHEMA_OVERRIDES,
): SchemaDescriptor {
  return buildSchemaDescriptor(collectSchemaSources(overrides), overrides);
}

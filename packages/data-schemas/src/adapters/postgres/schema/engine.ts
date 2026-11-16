/**
 * The schema engine of the PostgreSQL backend (docs/postgres-port/PHASE4.md §1.9, D2): mongoose
 * without a connection builds the documents the backend inserts and replaces, so casting,
 * defaults (289 declarations, 13 functions), setters, enums, `required`, the custom validators,
 * `minimize` and subdocument `_id`s are exactly today's. The record codec (`records/`) then
 * decomposes the result into rows.
 *
 * - The models are the generator's (`createOfflineModels` in `generate.ts`): `createModels` on a
 *   private `new Mongoose()` that is never connected, with the `mongoMeili` plugin's paths applied
 *   to `conversations` and `messages` whatever the environment, carrying the plugin's defaults
 *   (`_meiliIndex: false`, `_meiliCleanupVersion`), as MongoDB documents get them when MeiliSearch
 *   is configured. The raw collections (`schema/raw`) get models too (never registered anywhere
 *   else), for documents of their schemas.
 * - {@link SchemaEngine.buildDocument}: `new Model(doc)`, `validate()`, then `toObject()` with the
 *   options mongoose uses when it saves (no getters, virtuals or transforms; `minimize` per
 *   schema; `Map`s flattened to plain objects, as MongoDB stores them). Timestamps and `__v` are
 *   not set here: the collection primitive sets them on insert (§1.2 "System fields"), as
 *   mongoose does on save.
 * - {@link SchemaEngine.castUpdateValue}: the subdocuments an update writes (`$set` of a single
 *   subdocument, child array elements of `$set`/`$push`/`$addToSet`), cast by mongoose's own
 *   update casting (defaults and `_id`s included); the descriptor caster (`records/cast.ts`) calls
 *   it for those values and casts everything else itself.
 * - {@link SchemaEngine.isImmutable}: whether a path is declared `immutable`, which update casting
 *   strips outside `$setOnInsert`, as mongoose does.
 * - {@link SchemaEngine.validatePaths}: `Model.validate(record, paths, context)` for
 *   `runValidators` updates, on the computed post-image.
 *
 * Hooks are not run here (`pre('save')` hooks such as tenant stamping, search tokens and the audit
 * log chain are re-expressed in the collection primitive, §1.9); `pre('validate')` hooks run as
 * part of `validate()`, as on MongoDB.
 *
 * Like `generate.ts` and `raw/`, this module may load `mongoose` (eslint.config.mjs, the schema
 * engine block); the MongoDB driver stays banned, and nothing here ever connects.
 */
import { Mongoose } from 'mongoose';
import type { Schema } from 'mongoose';
import type { UpdateCastEngine, SubdocumentOperator } from '../records/cast';
import type { SchemaOverrides } from './overrides';
import type { OfflineModel } from './generate';
import { hasTenantIsolation } from '~/models/plugins/tenantIsolation';
import { MEILI_CLEANUP_VERSION } from '~/models/plugins/mongoMeili';
import { createOfflineModels } from './generate';
import { StoreQueryError } from '~/ports/query';
import { SCHEMA_OVERRIDES } from './overrides';
import { RAW_COLLECTIONS } from './raw';

/** A model of the engine (untyped: every schema). */
export type EngineModel = OfflineModel['model'];

/** Options of {@link SchemaEngine.buildDocument}. */
export interface BuildDocumentOptions {
  /** Run the validators (default true); a failure rejects with mongoose's `ValidationError`. */
  validate?: boolean;
}

/** The schema engine: documents built and validated by mongoose, offline. */
export interface SchemaEngine extends UpdateCastEngine {
  /** The collections it builds documents for (the models, then the raw collections). */
  readonly collections: readonly string[];
  hasCollection(collection: string): boolean;
  /**
   * The document mongoose would insert for `input` in `collection`: cast, defaults, setters,
   * validators, subdocument `_id`s. Values keep mongoose's types (ObjectIds, BSON binaries,
   * dates); the record codec converts them.
   */
  buildDocument(
    collection: string,
    input: Readonly<Record<string, unknown>>,
    options?: BuildDocumentOptions,
  ): Promise<Record<string, unknown>>;
  /**
   * Validates the paths `paths` of `record` (a computed post-image), as `runValidators` does;
   * rejects with mongoose's `ValidationError`.
   */
  validatePaths(
    collection: string,
    record: Readonly<Record<string, unknown>>,
    paths: readonly string[],
    context?: unknown,
  ): Promise<void>;
  /** The mongoose model of `collection` (specs compare with its casting and `toObject()`). */
  model(collection: string): EngineModel;
  /**
   * Whether the collection's schema carries the tenant-isolation plugin
   * (`applyTenantIsolation`), so the collection primitive binds the tenant policy to it.
   */
  isTenantScoped(collection: string): boolean;
}

/**
 * The defaults the `mongoMeili` plugin declares on its paths, which the overrides (plain data,
 * shared with the descriptor) do not carry. A spec checks them against the plugin.
 */
export const ENGINE_PLUGIN_DEFAULTS: Readonly<Record<string, unknown>> = {
  _meiliIndex: false,
  _meiliCleanupVersion: MEILI_CLEANUP_VERSION,
};

/** The options mongoose's `save` serializes a document with (`internalToObjectOptions`). */
const SAVE_TO_OBJECT = {
  transform: false,
  virtuals: false,
  getters: false,
  depopulate: true,
  flattenDecimals: false,
  useProjection: false,
  versionKey: true,
  flattenObjectIds: false,
  flattenMaps: true,
} as const;

/** A mongoose `CastError` as a `StoreQueryError` (the store's error for uncastable values). */
function toStoreError(error: unknown): unknown {
  if (error instanceof Error && error.name === 'CastError') {
    return new StoreQueryError(error.message);
  }
  return error;
}

/** The raw collections' model names on the private instance. */
function rawModelName(collection: string): string {
  return `PostgresRaw:${collection}`;
}

/**
 * Creates a schema engine on a private mongoose instance that is never connected. The models are
 * compiled once, here.
 */
export function createSchemaEngine(overrides: SchemaOverrides = SCHEMA_OVERRIDES): SchemaEngine {
  const mongoose = new Mongoose();
  mongoose.set('strictQuery', true);
  const models = new Map<string, EngineModel>();
  const tenantScoped = new Set<string>();

  for (const entry of createOfflineModels(mongoose, overrides)) {
    /** Read on the model's own schema: a plugin-path copy does not carry the plugin's marker. */
    if (hasTenantIsolation(entry.model.schema)) {
      tenantScoped.add(entry.collection);
    }
    if (entry.schema === entry.model.schema) {
      models.set(entry.collection, entry.model);
      continue;
    }
    /** Plugin paths: compile the copy, with the plugin's defaults, in place of the model. */
    const schema: Schema = entry.schema;
    for (const [path, value] of Object.entries(ENGINE_PLUGIN_DEFAULTS)) {
      const type = schema.path(path);
      if (type) {
        type.default(value);
      }
    }
    mongoose.deleteModel(entry.modelName);
    models.set(entry.collection, mongoose.model(entry.modelName, schema, entry.collection));
  }
  for (const raw of RAW_COLLECTIONS) {
    models.set(
      raw.collection,
      mongoose.model(rawModelName(raw.collection), raw.schema.clone(), raw.collection),
    );
  }
  return engineOverModels(models, tenantScoped);
}

/** A schema of {@link createSchemaEngineForSchemas}: a collection and its mongoose schema. */
export interface EngineSchemaSource {
  collection: string;
  schema: Schema;
}

/**
 * A schema engine over the given schemas (specs: hand-made tables such as the query corpora's),
 * compiled on a private mongoose instance that is never connected. A schema carrying the
 * tenant-isolation plugin is tenant-scoped, as in {@link createSchemaEngine}.
 */
export function createSchemaEngineForSchemas(sources: readonly EngineSchemaSource[]): SchemaEngine {
  const mongoose = new Mongoose();
  mongoose.set('strictQuery', true);
  const models = new Map<string, EngineModel>();
  const tenantScoped = new Set<string>();
  for (const { collection, schema } of sources) {
    if (hasTenantIsolation(schema)) {
      tenantScoped.add(collection);
    }
    models.set(
      collection,
      mongoose.model(`PostgresEngine:${collection}`, schema, collection) as unknown as EngineModel,
    );
  }
  return engineOverModels(models, tenantScoped);
}

/** The engine's operations over compiled models. */
function engineOverModels(
  models: ReadonlyMap<string, EngineModel>,
  tenantScoped: ReadonlySet<string>,
): SchemaEngine {
  const modelOf = (collection: string): EngineModel => {
    const model = models.get(collection);
    if (!model) {
      throw new StoreQueryError(`No schema for the collection "${collection}"`);
    }
    return model;
  };

  return {
    collections: [...models.keys()],
    hasCollection: (collection) => models.has(collection),
    isTenantScoped: (collection) => tenantScoped.has(collection),
    model: modelOf,
    buildDocument: async (collection, input, options = {}) => {
      const Constructor = modelOf(collection);
      const document = new Constructor(input);
      if (options.validate !== false) {
        await document.validate();
      }
      return document.toObject(SAVE_TO_OBJECT) as Record<string, unknown>;
    },
    validatePaths: async (collection, record, paths, context) => {
      try {
        const validate = modelOf(collection).validate as unknown as (
          obj: unknown,
          paths: string[],
          context?: unknown,
        ) => Promise<void>;
        await validate.call(modelOf(collection), { ...record }, [...paths], context);
      } catch (error) {
        throw toStoreError(error);
      }
    },
    castUpdateValue: (collection: string, operator: SubdocumentOperator, path: string, value) => {
      const query = modelOf(collection).updateOne(
        {},
        { [operator]: { [path]: value } },
      ) as unknown as {
        getUpdate(): Record<string, Record<string, unknown>>;
        _castUpdate(update: unknown): Record<string, Record<string, unknown>> | false | undefined;
      };
      let cast: Record<string, Record<string, unknown>> | false | undefined;
      try {
        cast = query._castUpdate(query.getUpdate());
      } catch (error) {
        throw toStoreError(error);
      }
      return cast ? cast[operator]?.[path] : undefined;
    },
    isImmutable: (collection, path) => {
      const schema = modelOf(collection).schema as unknown as {
        _getSchema(path: string): { options?: { immutable?: unknown } } | undefined;
      };
      return schema._getSchema(path)?.options?.immutable === true;
    },
  };
}

let defaultEngine: SchemaEngine | undefined;

/** The process's schema engine over the production schemas (built on first use). */
export function getSchemaEngine(): SchemaEngine {
  defaultEngine ??= createSchemaEngine();
  return defaultEngine;
}

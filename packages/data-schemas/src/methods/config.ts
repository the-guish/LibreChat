import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import type { PrincipalModel, TCustomConfig } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  ConfigDraft,
  ConfigStore,
  ConfigRecord,
  ConfigRevision,
  ConfigPrincipal,
  ConfigListFilter,
} from '~/app/store';
import type { TenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import type { StoredKeyForm } from './encoding';
import type { IConfig } from '~/types';
import {
  toConfigRecord,
  CONFIG_STORE_ORDER,
  configVersionFilter,
  configIdentityFilter,
  configPrincipalFilter,
  createConfigOverrideMethods,
} from './configOverrideMethods';
import {
  ABSENT_CONFIG_REVISION,
  ConfigRevisionConflictError,
  getConfigRevision,
  parseConfigRevision,
  isConfigRevisionConflict,
} from '~/app/store';
import { toStoredKeys, getStoredKeyForms, CONFIG_KEY_ENCODING_VERSION } from './encoding';
import { tenantPartitionFilter } from '~/models/plugins/tenantIsolation';
import { isFieldNameRejection } from '~/utils/fields';
import logger from '~/config/winston';

/** A config document as MongoDB returns it, before the binding decodes it. */
interface StoredConfig {
  _id: Types.ObjectId | string;
  principalType: PrincipalType;
  principalId: Types.ObjectId | string;
  principalModel: PrincipalModel;
  priority: number;
  overrides?: Partial<TCustomConfig>;
  tombstones?: string[];
  isActive?: boolean;
  configVersion?: number | null;
  keyEncoding?: number;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Engine order for {@link ConfigStore.list}: ascending priority, then identity. */
const STORE_ORDER = CONFIG_STORE_ORDER;

function toRecord(document: StoredConfig): ConfigRecord {
  return toConfigRecord(document);
}

/** A principal's document in one tenant partition, as role documents are addressed. */
type PrincipalFilter = ConfigPrincipal | (ConfigPrincipal & TenantPartitionFilter);

const identityFilter = configIdentityFilter;

/** The filter that addresses one principal's document (`configPrincipalFilter`). */
function principalFilter(principal: ConfigPrincipal, operation: string): PrincipalFilter {
  return configPrincipalFilter(principal, operation, tenantPartitionFilter);
}

const versionFilter = configVersionFilter;

function toObjectId(id: unknown): unknown {
  if (id instanceof Types.ObjectId) {
    return id;
  }
  return typeof id === 'string' && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** The filter that pins a document revision, or `null` when the revision can never match. */
function revisionFilter(
  principal: ConfigPrincipal,
  revision: ConfigRevision,
  operation: string,
): Record<string, unknown> | null {
  const parsed = parseConfigRevision(revision);
  if (!parsed || !Types.ObjectId.isValid(parsed.id)) {
    return null;
  }
  return {
    ...principalFilter(principal, operation),
    _id: new Types.ObjectId(parsed.id),
    configVersion: versionFilter(parsed.configVersion),
  };
}

/** Override keys in the form one write stores them, and whether that form carries the marker. */
interface StoredKeys {
  overrides: Partial<TCustomConfig>;
  encoded: boolean;
}

/**
 * The Mongoose engine for the portable config store. Override keys are stored raw where the
 * engine accepts them and encoded where it refuses them (see `./encoding`), and every read
 * decodes them. Queries run through the `Config` model, so the tenant-isolation plugin scopes
 * every read and write; role documents are also kept to one tenant partition (`principalFilter`),
 * and `listActive`, which a merge reads, draws every document from one partition.
 */
export function createConfigStore(mongoose: typeof import('mongoose')): ConfigStore {
  const model = () => mongoose.models.Config as Model<IConfig>;
  /** Set once the engine refuses a raw key name, so later writes encode without asking again. */
  let refusesRawKeys = false;

  /**
   * Runs `write` with the overrides raw, or encoded when a raw read could not return them
   * unchanged. When the engine refuses a raw key name, the refused write changed nothing, so it
   * runs once more encoded, under the same precondition.
   */
  async function storeKeys<T>(
    overrides: Partial<TCustomConfig>,
    write: (keys: StoredKeys) => Promise<T>,
  ): Promise<T> {
    const [form, fallback] = getStoredKeyForms(overrides, refusesRawKeys);
    const run = (next: StoredKeyForm) =>
      write({ overrides: toStoredKeys(overrides, next), encoded: next === 'encoded' });
    try {
      return await run(form);
    } catch (error) {
      if (!fallback || !isFieldNameRejection(error)) {
        throw error;
      }
      refusesRawKeys = true;
      logger.warn(
        '[configStore] The database refused a raw key name in config overrides; storing override keys encoded from now on',
      );
      return run(fallback);
    }
  }

  async function read(principal: ConfigPrincipal): Promise<ConfigRecord | null> {
    const document = await model()
      .findOne(principalFilter(principal, 'configStore.read'))
      .lean<StoredConfig>();
    return document ? toRecord(document) : null;
  }

  /**
   * Every document the caller can address by principal: the role documents of the active tenant
   * partition, and the group and user documents the tenant plugin lets it see. `acrossTenants`
   * drops the partition, so role documents of every tenant the plugin lets it see are listed too.
   */
  async function list(filter?: ConfigListFilter): Promise<ConfigRecord[]> {
    const where = {
      ...(filter?.acrossTenants
        ? {}
        : {
            $or: [
              { principalType: { $ne: PrincipalType.ROLE } },
              { principalType: PrincipalType.ROLE, ...tenantPartitionFilter('configStore.list') },
            ],
          }),
      ...(filter?.isActive !== undefined ? { isActive: filter.isActive } : {}),
    };
    const documents = await model().find(where).sort(STORE_ORDER).lean<StoredConfig[]>();
    return documents.map(toRecord);
  }

  /**
   * The active documents of `principals`, all from one tenant partition: the active tenant's, or
   * the tenantless ones outside a tenant. Role ids are names shared across tenants, so an
   * unpartitioned read would merge every tenant's `__base__` and same-named role documents into
   * one config.
   */
  async function listActive(principals: readonly ConfigPrincipal[]): Promise<ConfigRecord[]> {
    if (principals.length === 0) {
      return [];
    }
    const documents = await model()
      .find({
        $and: [
          { $or: principals.map(identityFilter) },
          tenantPartitionFilter('configStore.listActive'),
        ],
        isActive: true,
      })
      .sort(STORE_ORDER)
      .lean<StoredConfig[]>();
    return documents.map(toRecord);
  }

  /**
   * Inserts the principal's document only when it has none. An existing document matches the
   * principal filter, `$setOnInsert` leaves it untouched, and the `_id` it returns is not the one
   * offered, so the conflict is seen without relying on the unique principal index (which some
   * engines, such as DocumentDB elastic clusters, do not enforce); the index still turns two
   * racing inserts into a duplicate-key conflict. Timestamps are set here because Mongoose would
   * otherwise `$set` `updatedAt` on the document it found.
   *
   * The `_id` is chosen here, so an insert whose acknowledgement is lost (the connection drops
   * after the server applied it, where the driver cannot retry the write) is settled by looking
   * that `_id` up: found at version 1, the insert committed and its document is returned, as
   * the contract requires. Otherwise, or when the lookup fails too, the write's own error is
   * rethrown.
   */
  async function create(
    principal: ConfigPrincipal,
    fields: Record<string, unknown>,
  ): Promise<ConfigRecord> {
    const _id = new Types.ObjectId();
    const now = new Date();
    try {
      const document = await model()
        .findOneAndUpdate(
          principalFilter(principal, 'configStore.write'),
          {
            $setOnInsert: { ...fields, _id, configVersion: 1, createdAt: now, updatedAt: now },
          },
          { upsert: true, new: true, timestamps: false, setDefaultsOnInsert: true },
        )
        .lean<StoredConfig>();
      if (!document) {
        throw new ConfigRevisionConflictError();
      }
      const record = toRecord(document);
      if (record._id !== _id.toString()) {
        throw new ConfigRevisionConflictError(getConfigRevision(record));
      }
      return record;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConfigRevisionConflictError();
      }
      if (isConfigRevisionConflict(error) || isFieldNameRejection(error)) {
        throw error;
      }
      const created = await model()
        .findOne({ ...principalFilter(principal, 'configStore.write'), _id, configVersion: 1 })
        .lean<StoredConfig>()
        .catch(() => null);
      if (created) {
        return toRecord(created);
      }
      throw error;
    }
  }

  async function write(
    principal: ConfigPrincipal,
    draft: ConfigDraft,
    expected: ConfigRevision,
  ): Promise<ConfigRecord> {
    const fields = (keys: StoredKeys): Record<string, unknown> => ({
      principalModel: draft.principalModel,
      priority: draft.priority,
      overrides: keys.overrides,
      tombstones: [...draft.tombstones],
      isActive: draft.isActive,
      ...(keys.encoded ? { keyEncoding: CONFIG_KEY_ENCODING_VERSION } : {}),
    });
    if (expected === ABSENT_CONFIG_REVISION) {
      return storeKeys(draft.overrides ?? {}, (keys) => create(principal, fields(keys)));
    }
    const filter = revisionFilter(principal, expected, 'configStore.write');
    if (!filter) {
      throw new ConfigRevisionConflictError();
    }
    const configVersion = (parseConfigRevision(expected)?.configVersion ?? 0) + 1;
    const updated = await storeKeys(draft.overrides ?? {}, (keys) =>
      model()
        .findOneAndUpdate(
          filter,
          {
            $set: { ...fields(keys), configVersion },
            /** A raw write clears a marker an earlier encoded write left. */
            ...(keys.encoded ? {} : { $unset: { keyEncoding: '' } }),
          },
          { new: true },
        )
        .lean<StoredConfig>(),
    );
    if (!updated) {
      throw new ConfigRevisionConflictError();
    }
    return toRecord(updated);
  }

  async function remove(
    principal: ConfigPrincipal,
    expected?: ConfigRevision,
  ): Promise<ConfigRecord | null> {
    if (expected === undefined) {
      const deleted = await model()
        .findOneAndDelete(principalFilter(principal, 'configStore.remove'))
        .lean<StoredConfig>();
      return deleted ? toRecord(deleted) : null;
    }
    if (expected === ABSENT_CONFIG_REVISION) {
      const current = await read(principal);
      if (current) {
        throw new ConfigRevisionConflictError(getConfigRevision(current));
      }
      return null;
    }
    const filter = revisionFilter(principal, expected, 'configStore.remove');
    const deleted = filter ? await model().findOneAndDelete(filter).lean<StoredConfig>() : null;
    if (!deleted) {
      throw new ConfigRevisionConflictError();
    }
    return toRecord(deleted);
  }

  /** `snapshot` is a decoded record, as `read` and `remove` return it; it is stored like a write. */
  async function restore(snapshot: ConfigRecord): Promise<boolean> {
    const { _id, overrides, ...rest } = snapshot;
    const principalId = snapshot.principalId.toString();
    const result = await storeKeys(overrides ?? {}, (keys) =>
      model().updateOne(
        principalFilter(
          { principalType: snapshot.principalType, principalId },
          'configStore.restore',
        ),
        {
          $setOnInsert: {
            ...rest,
            principalId,
            _id: toObjectId(_id),
            overrides: keys.overrides,
            ...(keys.encoded ? { keyEncoding: CONFIG_KEY_ENCODING_VERSION } : {}),
          },
        },
        { upsert: true, timestamps: false },
      ),
    );
    return result.upsertedCount > 0;
  }

  return { read, list, listActive, write, remove, restore };
}

type ConfigPrincipalId = string | Types.ObjectId;

/**
 * Config methods for callers, backed by the Mongoose store (`createConfigOverrideMethods`, shared
 * with every backend). Every write reads the document, applies a pure transform and stores it
 * with one compare-and-swap; a concurrent write is re-read and re-applied, and
 * `expectedRevision` turns any mismatch into a `ConfigRevisionConflictError`.
 */
export function createConfigMethods(
  mongoose: typeof import('mongoose'),
): ReturnType<typeof createConfigOverrideMethods<ConfigPrincipalId>> {
  return createConfigOverrideMethods<ConfigPrincipalId>(createConfigStore(mongoose));
}

export type ConfigMethods = ReturnType<typeof createConfigMethods>;

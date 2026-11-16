/**
 * The PostgreSQL `ConfigOverrideStore` (`~/ports/config`): the database-neutral config override
 * methods (`~/methods/configOverrideMethods`) on a PostgreSQL `ConfigStore` engine over the
 * `configs` table, through the collection primitive. Must not import `mongoose`, `mongodb` or
 * `bson`.
 *
 * The engine (`createPostgresConfigStore`) mirrors MongoDB's (`methods/config.ts`):
 * - role documents (`__base__` included) are addressed in the caller's tenant partition
 *   (`tenantPartitionFilter`), group and user documents by id alone; `listActive` (a merged read)
 *   draws every document from one partition; every query also goes through the tenant policy;
 * - every write is one compare-and-set on `_id` and `configVersion` (a legacy document without a
 *   version matches version 0); a create is an insert-only upsert whose `_id` is chosen first,
 *   so a lost acknowledgement is settled by looking that `_id` up, and a duplicate key on the
 *   unique principal index is a revision conflict;
 * - override keys go through `~/methods/encoding`: stored raw, or encoded with the
 *   `keyEncoding` marker when a raw read could not return them unchanged. The `json` column
 *   stores dotted keys as they are, but refuses keys starting with `$` and cannot hold U+0000
 *   (D8), so overrides holding either are stored encoded from the start; reads decode them.
 */
import { PrincipalType } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { ConfigPrincipal, ConfigRecord, ConfigStore } from '~/app/store';
import type { StoredConfigDocument } from '~/methods/configOverrideMethods';
import type { ConfigOverrideStore } from '~/ports/config';
import type { PostgresStoreContext } from './context';
import type { IdLike } from '~/ports/common';
import {
  toConfigRecord,
  CONFIG_STORE_ORDER,
  configVersionFilter,
  configIdentityFilter,
  configPrincipalFilter,
  createConfigOverrideMethods,
} from '~/methods/configOverrideMethods';
import {
  ABSENT_CONFIG_REVISION,
  ConfigRevisionConflictError,
  getConfigRevision,
  parseConfigRevision,
  isConfigRevisionConflict,
} from '~/app/store';
import { toStoredKeys, getStoredKeyForms, CONFIG_KEY_ENCODING_VERSION } from '~/methods/encoding';
import { generatePostgresStoreId, postgresStoreIds } from '../storeIds';
import { tenantPartitionFilter } from '../collection/tenant';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';

type ConfigDocument = StoredConfigDocument & Record<string, unknown>;

/** Override keys in the form one write stores them, and whether that form carries the marker. */
interface StoredKeys {
  overrides: Partial<TCustomConfig>;
  encoded: boolean;
}

/** Whether a key below `value` cannot be stored raw in a `json` column (`$…`, U+0000). */
function holdsUnstorableKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(holdsUnstorableKey);
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => key.startsWith('$') || key.includes('\u0000') || holdsUnstorableKey(child),
  );
}

/** The overrides in the form a write stores them (see the module comment). */
function storedKeys(overrides: Partial<TCustomConfig>): StoredKeys {
  const [form] = getStoredKeyForms(overrides, holdsUnstorableKey(overrides));
  return { overrides: toStoredKeys(overrides, form), encoded: form === 'encoded' };
}

/** The principal's document in one tenant partition, as role documents are addressed. */
function principalFilter(principal: ConfigPrincipal, operation: string): Record<string, unknown> {
  return { ...configPrincipalFilter(principal, operation, tenantPartitionFilter) };
}

/** The filter that pins a document revision, or `null` when the revision can never match. */
function revisionFilter(
  principal: ConfigPrincipal,
  revision: string,
  operation: string,
): Record<string, unknown> | null {
  const parsed = parseConfigRevision(revision);
  if (!parsed || !postgresStoreIds.isValid(parsed.id)) {
    return null;
  }
  return {
    ...principalFilter(principal, operation),
    _id: postgresStoreIds.toCanonicalString(parsed.id),
    configVersion: configVersionFilter(parsed.configVersion),
  };
}

/** The `ConfigStore` engine over the `configs` table. */
export function createPostgresConfigStore(context: PostgresStoreContext): ConfigStore {
  const configs = () => context.collections().collection<ConfigDocument>('configs');
  const toRecord = (document: ConfigDocument): ConfigRecord => toConfigRecord(document);

  async function read(principal: ConfigPrincipal): Promise<ConfigRecord | null> {
    const document = await configs().findOne(principalFilter(principal, 'configStore.read'));
    return document ? toRecord(document) : null;
  }

  async function create(
    principal: ConfigPrincipal,
    fields: Record<string, unknown>,
  ): Promise<ConfigRecord> {
    const _id = generatePostgresStoreId();
    const now = new Date();
    try {
      const document = await configs().findOneAndUpdate(
        principalFilter(principal, 'configStore.write'),
        { $setOnInsert: { ...fields, _id, configVersion: 1, createdAt: now, updatedAt: now } },
        { upsert: true, returnDocument: 'after', timestamps: false },
      );
      if (!document) {
        throw new ConfigRevisionConflictError();
      }
      const record = toRecord(document);
      if (record._id !== _id) {
        throw new ConfigRevisionConflictError(getConfigRevision(record));
      }
      return record;
    } catch (error) {
      if (error instanceof StoreDuplicateKeyError) {
        throw new ConfigRevisionConflictError();
      }
      if (isConfigRevisionConflict(error)) {
        throw error;
      }
      const created = await configs()
        .findOne({ ...principalFilter(principal, 'configStore.write'), _id, configVersion: 1 })
        .catch(() => null);
      if (created) {
        return toRecord(created);
      }
      throw error;
    }
  }

  const engine: ConfigStore = {
    read,

    async list(filter) {
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
      return (await configs().find(where, { sort: CONFIG_STORE_ORDER })).map(toRecord);
    },

    async listActive(principals) {
      if (principals.length === 0) {
        return [];
      }
      const documents = await configs().find(
        {
          $and: [
            { $or: principals.map(configIdentityFilter) },
            tenantPartitionFilter('configStore.listActive'),
          ],
          isActive: true,
        },
        { sort: CONFIG_STORE_ORDER },
      );
      return documents.map(toRecord);
    },

    async write(principal, draft, expected) {
      const keys = storedKeys(draft.overrides ?? {});
      const fields: Record<string, unknown> = {
        principalModel: draft.principalModel,
        priority: draft.priority,
        overrides: keys.overrides,
        tombstones: [...draft.tombstones],
        isActive: draft.isActive,
        ...(keys.encoded ? { keyEncoding: CONFIG_KEY_ENCODING_VERSION } : {}),
      };
      if (expected === ABSENT_CONFIG_REVISION) {
        return create(principal, fields);
      }
      const filter = revisionFilter(principal, expected, 'configStore.write');
      if (!filter) {
        throw new ConfigRevisionConflictError();
      }
      const configVersion = (parseConfigRevision(expected)?.configVersion ?? 0) + 1;
      const updated = await configs().findOneAndUpdate(
        filter,
        {
          $set: { ...fields, configVersion },
          /** A raw write clears a marker an earlier encoded write left. */
          ...(keys.encoded ? {} : { $unset: { keyEncoding: '' } }),
        },
        { returnDocument: 'after' },
      );
      if (!updated) {
        throw new ConfigRevisionConflictError();
      }
      return toRecord(updated);
    },

    async remove(principal, expected) {
      if (expected === undefined) {
        const deleted = await configs().findOneAndDelete(
          principalFilter(principal, 'configStore.remove'),
        );
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
      const deleted = filter ? await configs().findOneAndDelete(filter) : null;
      if (!deleted) {
        throw new ConfigRevisionConflictError();
      }
      return toRecord(deleted);
    },

    /** `snapshot` is a decoded record, as `read` and `remove` return it; stored like a write. */
    async restore(snapshot) {
      const { _id, overrides, ...rest } = snapshot;
      const principalId = snapshot.principalId.toString();
      const keys = storedKeys(overrides ?? {});
      const result = await configs().updateOne(
        principalFilter(
          { principalType: snapshot.principalType, principalId },
          'configStore.restore',
        ),
        {
          $setOnInsert: {
            ...rest,
            principalId,
            _id: postgresStoreIds.isValid(_id) ? postgresStoreIds.toCanonicalString(_id) : _id,
            overrides: keys.overrides,
            ...(keys.encoded ? { keyEncoding: CONFIG_KEY_ENCODING_VERSION } : {}),
          },
        },
        { upsert: true, timestamps: false },
      );
      return result.upsertedCount > 0;
    },
  };
  return engine;
}

export function createPostgresConfigOverrideStore(
  context: PostgresStoreContext,
): ConfigOverrideStore {
  const store: ConfigOverrideStore = createConfigOverrideMethods<IdLike>(
    createPostgresConfigStore(context),
  );
  return store;
}

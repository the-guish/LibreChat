/**
 * The config override methods (`ConfigOverrideStore`, `~/ports/config`) on any engine's
 * `ConfigStore` (`~/app/store`), shared by every backend: the MongoDB methods
 * (`./config`, on `createConfigStore`) and the PostgreSQL store
 * (`adapters/postgres/stores/configOverride.ts`). Every method but `restoreConfig` and
 * `writeConfigDocument` applies the database-neutral rules of `createConfigOperations`. Also the
 * decoding of a stored document into a `ConfigRecord`, which every engine storing the override
 * keys with `./encoding` shares. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { PrincipalType } from 'librechat-data-provider';
import type { PrincipalModel, TCustomConfig } from 'librechat-data-provider';
import type {
  ConfigDraft,
  ConfigStore,
  ConfigRecord,
  ConfigRevision,
  ConfigPrincipal,
  ConfigTombstones,
  ConfigPathInputs,
  ConfigMoveOptions,
  ConfigWriteOutcome,
  ConfigWriteOptions,
  ConfigLifecycleOptions,
} from '~/app/store';
import type { IdLike } from '~/ports/common';
import { CONFIG_KEY_ENCODING_VERSION, readStoredKeys } from './encoding';
import { createConfigOperations } from '~/app/store';

/** A principal id the methods accept: a string, or an id whose `toString()` is its string. */
export type ConfigPrincipalIdLike = string | { toString(): string };

/** A config document as an engine returns it, before it is decoded. */
export interface StoredConfigDocument {
  _id: { toString(): string } | string;
  principalType: PrincipalType;
  principalId: { toString(): string } | string;
  principalModel: PrincipalModel;
  priority: number;
  overrides?: Partial<TCustomConfig>;
  tombstones?: string[];
  isActive?: boolean;
  configVersion?: number | null;
  keyEncoding?: number | null;
  tenantId?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

/** Engine order for `ConfigStore.list`: ascending priority, then identity. */
export const CONFIG_STORE_ORDER = { priority: 1, _id: 1 } as const;

/** The principal's identity alone: its type and id. */
export function configIdentityFilter(principal: ConfigPrincipal): ConfigPrincipal {
  return { principalType: principal.principalType, principalId: principal.principalId };
}

/**
 * The filter that addresses one principal's document. A role's document, `__base__` included,
 * is addressed in the active tenant partition (`partition`, the engine's binding of
 * `tenantPartition`): role ids are names every tenant reuses and a document's identity includes
 * its tenant (the unique index is principal plus `tenantId`), so without a tenant in context an
 * unpartitioned filter would match whichever tenant's document comes first, and an unscoped admin
 * write could land in a tenant's profile that the deployment's own resolution never reads. Group
 * and user ids are unique across tenants, so their documents are addressed by id alone, like the
 * groups and users themselves: inside a tenant the tenant policy still scopes them, and outside
 * one a group's or user's cleanup reaches its document whichever tenant holds it.
 */
export function configPrincipalFilter<P extends object>(
  principal: ConfigPrincipal,
  operation: string,
  partition: (operation: string) => P,
): ConfigPrincipal | (ConfigPrincipal & P) {
  const filter = configIdentityFilter(principal);
  if (principal.principalType !== PrincipalType.ROLE) {
    return filter;
  }
  return { ...filter, ...partition(operation) };
}

/** A legacy document may predate `configVersion`; version 0 matches it too. */
export function configVersionFilter(configVersion: number): number | { $in: Array<number | null> } {
  return configVersion === 0 ? { $in: [0, null] } : configVersion;
}

/**
 * The record a stored document reads as: ids as strings, override keys decoded (`./encoding`),
 * a missing version as `0`, and `tenantId` and the timestamps only when stored.
 */
export function toConfigRecord(document: StoredConfigDocument): ConfigRecord {
  const overrides = document.overrides ?? {};
  const record: ConfigRecord = {
    _id: document._id.toString(),
    principalType: document.principalType,
    principalId: document.principalId.toString(),
    principalModel: document.principalModel,
    priority: document.priority,
    overrides: readStoredKeys(overrides, document.keyEncoding === CONFIG_KEY_ENCODING_VERSION),
    tombstones: Array.isArray(document.tombstones) ? document.tombstones : [],
    isActive: document.isActive === true,
    configVersion: document.configVersion ?? 0,
  };
  if (document.tenantId != null) {
    record.tenantId = document.tenantId;
  }
  if (document.createdAt != null) {
    record.createdAt = document.createdAt;
  }
  if (document.updatedAt != null) {
    record.updatedAt = document.updatedAt;
  }
  return record;
}

/**
 * Positional slot where these methods once took a Mongoose `ClientSession`. The portable store
 * does not join transactions, so only `undefined` is accepted; the slot stays so existing call
 * sites keep their argument positions.
 */
type NoSession = undefined;

function toPrincipal(
  principalType: PrincipalType,
  principalId: ConfigPrincipalIdLike,
): ConfigPrincipal {
  return { principalType, principalId: principalId.toString() };
}

/**
 * Config methods for callers, backed by any engine's `ConfigStore`. Every write reads the
 * document, applies a pure transform and stores it with one compare-and-swap; a concurrent write
 * is re-read and re-applied, and `expectedRevision` turns any mismatch into a
 * `ConfigRevisionConflictError`. `Id` is the principal id type the methods accept (each backend
 * states its own; ids are stored as their strings).
 */
export function createConfigOverrideMethods<Id extends ConfigPrincipalIdLike = IdLike>(
  store: ConfigStore,
) {
  const operations = createConfigOperations(store);

  return {
    /** The documents the store lists, in merge precedence order (`compareConfigPrecedence`). */
    listAllConfigs: (
      filter?: { isActive?: boolean },
      _session?: NoSession,
    ): Promise<ConfigRecord[]> => operations.listConfigs(filter),

    findConfigByPrincipal: (
      principalType: PrincipalType,
      principalId: Id,
      options?: { includeInactive?: boolean },
      _session?: NoSession,
    ): Promise<ConfigRecord | null> =>
      operations.findConfig(toPrincipal(principalType, principalId), options),

    /** Base and the principals' active documents, in merge precedence order. */
    getApplicableConfigs: (
      principals?: Array<{ principalType: string; principalId?: Id }>,
      _session?: NoSession,
    ): Promise<ConfigRecord[]> => operations.getApplicableConfigs(principals),

    /**
     * Active documents with a tombstone at `fieldPath` or below it, across every tenant the
     * caller's scope can read, in store order and without their overrides.
     */
    listConfigTombstones: (fieldPath: string, _session?: NoSession): Promise<ConfigTombstones[]> =>
      operations.listTombstones(fieldPath),

    /**
     * Replaces the overrides whole and activates the document; tombstones stay. An omitted
     * `priority` keeps the stored one, or gives a new document its principal type's default.
     */
    upsertConfig: (
      principalType: PrincipalType,
      principalId: Id,
      principalModel: PrincipalModel,
      overrides: Partial<TCustomConfig>,
      priority?: number,
      _session?: NoSession,
      options?: ConfigLifecycleOptions & { preservePriority?: boolean },
    ): Promise<ConfigRecord | null> =>
      operations.replaceOverrides(
        toPrincipal(principalType, principalId),
        principalModel,
        overrides,
        priority,
        options,
      ),

    /** Sets dotted field paths; an omitted `priority` keeps the stored one. */
    patchConfigFields: (
      principalType: PrincipalType,
      principalId: Id,
      principalModel: PrincipalModel,
      fields: Record<string, unknown>,
      priority?: number,
      _session?: NoSession,
      options?: ConfigWriteOptions,
    ): Promise<ConfigRecord> =>
      operations.setFields(
        toPrincipal(principalType, principalId),
        principalModel,
        fields,
        priority,
        options,
      ),

    /** Tombstones one path, or several in one write; an omitted `priority` keeps the stored one. */
    tombstoneConfigField: (
      principalType: PrincipalType,
      principalId: Id,
      principalModel: PrincipalModel,
      fieldPaths: ConfigPathInputs,
      priority?: number,
      _session?: NoSession,
      options?: ConfigWriteOptions,
    ): Promise<ConfigRecord> =>
      operations.tombstoneFields(
        toPrincipal(principalType, principalId),
        principalModel,
        fieldPaths,
        priority,
        options,
      ),

    /**
     * Removes one path, or several in one write, pruning the parents left empty. A path is a
     * dotted field path or `{ segments }`, which can name a key that contains a dot.
     */
    unsetConfigField: (
      principalType: PrincipalType,
      principalId: Id,
      fieldPaths: ConfigPathInputs,
      _session?: NoSession,
      options?: ConfigWriteOptions,
    ): Promise<ConfigRecord | null> =>
      operations.unsetFields(toPrincipal(principalType, principalId), fieldPaths, options),

    deleteConfig: (
      principalType: PrincipalType,
      principalId: Id,
      _session?: NoSession,
      options?: ConfigLifecycleOptions,
    ): Promise<ConfigRecord | null> =>
      operations.deleteConfig(toPrincipal(principalType, principalId), options),

    /**
     * Re-creates a deleted config document exactly as it was (tombstones, active flag,
     * version), only when no document exists for the principal. Returns whether it
     * inserted, so a document written after the snapshot is never overwritten.
     */
    restoreConfig: (snapshot: ConfigRecord): Promise<boolean> => store.restore(snapshot),

    toggleConfigActive: async (
      principalType: PrincipalType,
      principalId: Id,
      isActive: boolean,
      _session?: NoSession,
      options?: ConfigLifecycleOptions,
    ): Promise<ConfigRecord | null> => {
      const toggled = await operations.setActive(
        toPrincipal(principalType, principalId),
        isActive,
        options,
      );
      return toggled?.config ?? null;
    },

    /** Like `toggleConfigActive`, but also reports whether this write changed `isActive`. */
    toggleConfigActiveTracked: (
      principalType: PrincipalType,
      principalId: Id,
      isActive: boolean,
      options?: ConfigLifecycleOptions,
    ): Promise<{ config: ConfigRecord; changed: boolean } | null> =>
      operations.setActive(toPrincipal(principalType, principalId), isActive, options),

    /**
     * Sets only the priority; overrides, tombstones and `isActive` stay. Resolves to the
     * document and whether this write changed it, or `null` when the principal has none.
     * A role's document is the one in the caller's tenant partition, as for every write.
     */
    setConfigPriority: (
      principalType: PrincipalType,
      principalId: Id,
      priority: number,
      options?: ConfigWriteOptions,
    ): Promise<ConfigWriteOutcome | null> =>
      operations.setPriority(toPrincipal(principalType, principalId), priority, options),

    /**
     * Moves a principal's document to another id of the same type (a role rename) and
     * returns it as moved, or `null` when there is none to move. Throws a
     * `ConfigMoveRefusedError`, changing nothing, when the target already has one
     * (`CONFIG_PRINCIPAL_EXISTS`) or either side is Base (`CONFIG_PRINCIPAL_RESERVED`).
     *
     * A role's documents on both sides are the ones in the caller's tenant partition: outside a
     * tenant only a platform-level document moves, and only a platform-level one at the target
     * refuses the move, so a tenant's role of the same name keeps its profile. With `identity`
     * (how a rename undoes its move), only that document moves, and `null` means the source
     * holds another or none.
     */
    renameConfigPrincipal: (
      principalType: PrincipalType,
      fromPrincipalId: Id,
      toPrincipalId: Id,
      options?: ConfigMoveOptions,
    ): Promise<ConfigRecord | null> =>
      operations.movePrincipal(
        toPrincipal(principalType, fromPrincipalId),
        toPrincipal(principalType, toPrincipalId),
        options,
      ),

    /**
     * Writes a principal's whole document when it is still at `expected` (`absent`: only when
     * none exists). The admin API plans the next document from the one it read, so validation
     * and secret preservation see exactly what the write replaces.
     */
    writeConfigDocument: (
      principalType: PrincipalType,
      principalId: Id,
      draft: ConfigDraft,
      expected: ConfigRevision,
    ): Promise<ConfigRecord> =>
      store.write(toPrincipal(principalType, principalId), draft, expected),
  };
}

export type ConfigOverrideMethods = ReturnType<typeof createConfigOverrideMethods>;

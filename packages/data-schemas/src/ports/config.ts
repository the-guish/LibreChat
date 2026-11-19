/**
 * Config override store port: the per-principal documents that override the YAML config (the
 * `__base__` role's for the whole deployment, then roles, groups and users, merged by priority).
 * Nothing here may import `mongoose`. Signatures are those of `ConfigMethods` (`~/methods/config`)
 * with principal ids stated as `IdLike`; `config.spec.ts` fails the typecheck if the MongoDB
 * methods stop satisfying them.
 *
 * Named apart from `ConfigStore` (`~/app/store`), the engine-level port these methods are built
 * on: every method here but `restoreConfig` and `writeConfigDocument` applies the
 * database-neutral rules of `createConfigOperations` to that engine, which both MongoDB and an
 * in-memory engine already implement.
 *
 * A role's document is the one in the caller's tenant partition; group and user documents are
 * addressed by id alone. Every write is one compare-and-swap: a concurrent write is re-read and
 * re-applied, and `expectedRevision` turns any mismatch into a `ConfigRevisionConflictError`.
 *
 * Known leak kept for now so callers stay unchanged: the `_session` slots where these methods
 * once took a MongoDB `ClientSession` accept only `undefined`; they are kept so call sites keep
 * their argument positions.
 */
import type { PrincipalModel, PrincipalType, TCustomConfig } from 'librechat-data-provider';
import type {
  ConfigDraft,
  ConfigRecord,
  ConfigRevision,
  ConfigPathInputs,
  ConfigTombstones,
  ConfigMoveOptions,
  ConfigWriteOutcome,
  ConfigWriteOptions,
  ConfigLifecycleOptions,
} from '~/app/store';
import type { IdLike } from './common';
import { listPortMethods } from './common';

export interface ConfigOverrideStore {
  /** The documents, all or only active or inactive ones, in merge precedence order. */
  listAllConfigs(filter?: { isActive?: boolean }, _session?: undefined): Promise<ConfigRecord[]>;
  /** The principal's document; an inactive one only with `includeInactive`. */
  findConfigByPrincipal(
    principalType: PrincipalType,
    principalId: IdLike,
    options?: { includeInactive?: boolean },
    _session?: undefined,
  ): Promise<ConfigRecord | null>;
  /** Base and the principals' active documents, in merge precedence order. */
  getApplicableConfigs(
    principals?: Array<{ principalType: string; principalId?: IdLike }>,
    _session?: undefined,
  ): Promise<ConfigRecord[]>;
  /**
   * The active documents with a tombstone at `fieldPath` or below it, across every tenant the
   * caller's scope can read, without their overrides.
   */
  listConfigTombstones(fieldPath: string, _session?: undefined): Promise<ConfigTombstones[]>;
  /**
   * Replaces the principal's overrides whole and activates the document; tombstones stay. An
   * omitted `priority` keeps the stored one, or gives a new document its type's default.
   */
  upsertConfig(
    principalType: PrincipalType,
    principalId: IdLike,
    principalModel: PrincipalModel,
    overrides: Partial<TCustomConfig>,
    priority?: number,
    _session?: undefined,
    options?: ConfigLifecycleOptions & { preservePriority?: boolean },
  ): Promise<ConfigRecord | null>;
  /** Sets dotted field paths; an omitted `priority` keeps the stored one. */
  patchConfigFields(
    principalType: PrincipalType,
    principalId: IdLike,
    principalModel: PrincipalModel,
    fields: Record<string, unknown>,
    priority?: number,
    _session?: undefined,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord>;
  /** Tombstones one path or several in one write; an omitted `priority` keeps the stored one. */
  tombstoneConfigField(
    principalType: PrincipalType,
    principalId: IdLike,
    principalModel: PrincipalModel,
    fieldPaths: ConfigPathInputs,
    priority?: number,
    _session?: undefined,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord>;
  /** Removes one path or several in one write, pruning the parents left empty. */
  unsetConfigField(
    principalType: PrincipalType,
    principalId: IdLike,
    fieldPaths: ConfigPathInputs,
    _session?: undefined,
    options?: ConfigWriteOptions,
  ): Promise<ConfigRecord | null>;
  /** Deletes the principal's document and resolves to it, or `null`. */
  deleteConfig(
    principalType: PrincipalType,
    principalId: IdLike,
    _session?: undefined,
    options?: ConfigLifecycleOptions,
  ): Promise<ConfigRecord | null>;
  /**
   * Re-creates a deleted document exactly as it was, only when the principal has none; resolves
   * whether it did.
   */
  restoreConfig(snapshot: ConfigRecord): Promise<boolean>;
  /** Activates or deactivates the principal's document; `null` when it has none. */
  toggleConfigActive(
    principalType: PrincipalType,
    principalId: IdLike,
    isActive: boolean,
    _session?: undefined,
    options?: ConfigLifecycleOptions,
  ): Promise<ConfigRecord | null>;
  /** Like `toggleConfigActive`, also resolving whether this write changed `isActive`. */
  toggleConfigActiveTracked(
    principalType: PrincipalType,
    principalId: IdLike,
    isActive: boolean,
    options?: ConfigLifecycleOptions,
  ): Promise<{ config: ConfigRecord; changed: boolean } | null>;
  /**
   * Sets only the priority; resolves to the document and whether this write changed it, or
   * `null` when the principal has none.
   */
  setConfigPriority(
    principalType: PrincipalType,
    principalId: IdLike,
    priority: number,
    options?: ConfigWriteOptions,
  ): Promise<ConfigWriteOutcome | null>;
  /**
   * Moves the principal's document to another id of the same type (a role rename) and resolves
   * to it moved, or `null` when there is none (with `identity`, when the source holds another).
   * Throws a `ConfigMoveRefusedError`, changing nothing, when the target already has one or
   * either side is Base.
   */
  renameConfigPrincipal(
    principalType: PrincipalType,
    fromPrincipalId: IdLike,
    toPrincipalId: IdLike,
    options?: ConfigMoveOptions,
  ): Promise<ConfigRecord | null>;
  /**
   * Writes the principal's whole document while it is still at `expected` (`absent`: only while
   * none exists).
   */
  writeConfigDocument(
    principalType: PrincipalType,
    principalId: IdLike,
    draft: ConfigDraft,
    expected: ConfigRevision,
  ): Promise<ConfigRecord>;
}

/** Every method of {@link ConfigOverrideStore}, for adapters and conformance checks. */
export const CONFIG_OVERRIDE_STORE_METHODS: ReadonlyArray<keyof ConfigOverrideStore> =
  listPortMethods<ConfigOverrideStore>({
    listAllConfigs: true,
    findConfigByPrincipal: true,
    getApplicableConfigs: true,
    listConfigTombstones: true,
    upsertConfig: true,
    patchConfigFields: true,
    tombstoneConfigField: true,
    unsetConfigField: true,
    deleteConfig: true,
    restoreConfig: true,
    toggleConfigActive: true,
    toggleConfigActiveTracked: true,
    setConfigPriority: true,
    renameConfigPrincipal: true,
    writeConfigDocument: true,
  });

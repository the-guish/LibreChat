/**
 * Preset store port: the conversation presets users save. Nothing here may import `mongoose`.
 * Signatures are those of `PresetMethods` (`~/methods/preset`), copied verbatim but for
 * `getPresets` and `deletePresets`, whose criteria the port states in the store query language
 * (`./query`), whose records it states as `PresetRecord` and whose delete result it states as a
 * `DeleteCount`; `preset.spec.ts` fails the typecheck if the MongoDB methods stop satisfying
 * them.
 *
 * Every read and delete is scoped to one user: the criteria a caller adds are combined with the
 * user's, and cannot widen them (a `user` condition among them is replaced by the user's).
 */
import type { PresetRecord } from '~/types';
import type { DeleteCount } from './common';
import type { StoreFilter } from './query';
import { listPortMethods } from './common';

export interface PresetStore {
  /**
   * The user's presets matching `filter` (every one without it), ordered by `order` (presets
   * without one last), then most recently updated first. Resolves `{ message }` instead of
   * throwing when the read fails.
   */
  getPresets(user: string, filter?: StoreFilter): Promise<PresetRecord[] | { message: string }>;
  /**
   * Creates or replaces the user's preset `presetId` (renamed to `newPresetId` when given), with
   * tools stored by plugin key. `defaultPreset: true` makes it the user's only default, first in
   * order; `defaultPreset: false` clears that. Resolves `{ message }` instead of throwing when
   * the write fails.
   */
  savePreset(
    user: string,
    preset: {
      presetId?: string;
      newPresetId?: string;
      defaultPreset?: boolean;
      [key: string]: unknown;
    },
  ): Promise<PresetRecord | { message: string }>;
  /**
   * Deletes the user's presets matching `filter` (every one without it; callers pass
   * `{ presetId }` to delete one). The preset route sends the result to the client as is, which
   * reads it as `{ acknowledged, deletedCount }`.
   */
  deletePresets(user: string, filter?: StoreFilter): Promise<DeleteCount>;
}

/** Every method of {@link PresetStore}, for adapters and conformance checks. */
export const PRESET_STORE_METHODS: ReadonlyArray<keyof PresetStore> = listPortMethods<PresetStore>({
  getPresets: true,
  savePreset: true,
  deletePresets: true,
});

/**
 * Preset store port: the conversation presets users save. Nothing here may import `mongoose`.
 * Signatures are copied verbatim from `PresetMethods` (`~/methods/preset`); `preset.spec.ts`
 * fails the typecheck if the two drift.
 *
 * `getPresets` and `deletePresets` are not in this port: each takes a raw MongoDB filter that is
 * merged into the user's query (callers pass none, or `{ presetId }` to delete one preset).
 */
import type { PresetRecord } from '~/types';
import { listPortMethods } from './common';

export interface PresetStore {
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
}

/** Every method of {@link PresetStore}, for adapters and conformance checks. */
export const PRESET_STORE_METHODS: ReadonlyArray<keyof PresetStore> = listPortMethods<PresetStore>({
  savePreset: true,
});

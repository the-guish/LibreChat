/**
 * The preset store's database-neutral rules (`PresetStore`, `~/ports/preset`), shared by every
 * backend: the MongoDB methods (`./preset`) and the PostgreSQL store
 * (`adapters/postgres/stores/preset.ts`). Nothing here may import `mongoose` or the MongoDB
 * driver.
 */

/** The position of a preset without an `order`. */
const DEFAULT_PRESET_ORDER = 10000;

/** Sorts presets in place by `order` (none: last), then most recently updated first. */
export function sortPresets<T extends { order?: number; updatedAt?: Date | string | number }>(
  presets: T[],
): T[] {
  const defaultValue = DEFAULT_PRESET_ORDER;

  presets.sort((a, b) => {
    const orderA = a.order !== undefined ? a.order : defaultValue;
    const orderB = b.order !== undefined ? b.order : defaultValue;

    if (orderA !== orderB) {
      return orderA - orderB;
    }

    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  });

  return presets;
}

/** The writes of one `savePreset`, in the store query language. */
export interface PresetSavePlan {
  /** When set, first `updateMany(demoteFilter, demoteUpdate)`: the other defaults lose theirs. */
  demoteFilter?: Record<string, unknown>;
  demoteUpdate: { $unset: { defaultPreset: ''; order: '' } };
  /** Then the upsert of the preset itself: `findOneAndUpdate(filter, update)`, returning it. */
  filter: { presetId: string | undefined; user: string };
  /**
   * `$set` of the preset's fields (a `false` default sets `defaultPreset` and `order` to
   * `undefined`, which the write drops, and also `$unset`s them).
   */
  update: Record<string, unknown>;
}

/**
 * Plans a preset save: tools normalized to their plugin keys, `newPresetId` renaming the preset,
 * a default preset at order 0 demoting every other default of the user, and `defaultPreset:
 * false` removing the default flag and order.
 */
export function planPresetSave(
  user: string,
  {
    presetId,
    newPresetId,
    defaultPreset,
    ...preset
  }: {
    presetId?: string;
    newPresetId?: string;
    defaultPreset?: boolean;
    [key: string]: unknown;
  },
): PresetSavePlan {
  const setter: Record<string, unknown> = { $set: {} };
  const { user: _unusedUser, ...cleanPreset } = preset;
  const update: Record<string, unknown> = { presetId, ...cleanPreset };
  if (preset.tools && Array.isArray(preset.tools)) {
    update.tools =
      (preset.tools as Array<string | { pluginKey?: string }>)
        .map((tool) => (typeof tool === 'object' && tool?.pluginKey ? tool.pluginKey : tool))
        .filter((toolName) => typeof toolName === 'string') ?? [];
  }
  if (newPresetId) {
    update.presetId = newPresetId;
  }

  let demoteFilter: Record<string, unknown> | undefined;
  if (defaultPreset) {
    update.defaultPreset = defaultPreset;
    update.order = 0;
    demoteFilter = {
      user,
      defaultPreset: true,
      ...(presetId != null && { presetId: { $ne: presetId } }),
    };
  } else if (defaultPreset === false) {
    update.defaultPreset = undefined;
    update.order = undefined;
    setter['$unset'] = { defaultPreset: '', order: '' };
  }

  setter.$set = update;
  return {
    demoteFilter,
    demoteUpdate: { $unset: { defaultPreset: '', order: '' } },
    filter: { presetId, user },
    update: setter,
  };
}

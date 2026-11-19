import type { Model } from 'mongoose';
import type { PresetRecord as IPreset } from '~/types/preset';
import { planPresetSave, sortPresets } from './presetRules';
import logger from '~/config/winston';

export type { PresetRecord as IPreset } from '~/types/preset';

export function createPresetMethods(mongoose: typeof import('mongoose')): {
  getPresets: (
    user: string,
    filter?: Record<string, unknown>,
  ) => Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user?: string | undefined;
        presetId?: string | undefined;
        order?: number | undefined;
        defaultPreset?: boolean | undefined;
        tools?:
          | (
              | string
              | {
                  pluginKey?: string | undefined;
                }
            )[]
          | undefined;
        updatedAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })[]
    | {
        message: string;
      }
  >;
  savePreset: (
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
  ) => Promise<
    | IPreset
    | {
        message: string;
      }
  >;
  deletePresets: (
    user: string,
    filter?: Record<string, unknown>,
  ) => Promise<import('mongodb').DeleteResult>;
} {
  /**
   * Retrieves all presets for a user, sorted by order then updatedAt.
   */
  async function getPresets(
    user: string,
    filter: Record<string, unknown> = {},
  ): Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user?: string | undefined;
        presetId?: string | undefined;
        order?: number | undefined;
        defaultPreset?: boolean | undefined;
        tools?:
          | (
              | string
              | {
                  pluginKey?: string | undefined;
                }
            )[]
          | undefined;
        updatedAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })[]
    | {
        message: string;
      }
  > {
    try {
      const Preset = mongoose.models.Preset as Model<IPreset>;
      const presets = await Preset.find({ ...filter, user }).lean();
      return sortPresets(presets);
    } catch (error) {
      logger.error('[getPresets] Error getting presets', error);
      return { message: 'Error retrieving presets' };
    }
  }

  /**
   * Saves a preset. Handles default preset logic and tool normalization.
   */
  async function savePreset(
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
  ): Promise<
    | IPreset
    | {
        message: string;
      }
  > {
    try {
      const Preset = mongoose.models.Preset as Model<IPreset>;
      const plan = planPresetSave(user, { presetId, newPresetId, defaultPreset, ...preset });
      if (plan.demoteFilter) {
        /** One write demotes every other default, instead of a read then a by-id update. */
        await Preset.updateMany(plan.demoteFilter, plan.demoteUpdate);
      }
      return await Preset.findOneAndUpdate(plan.filter, plan.update, {
        new: true,
        upsert: true,
      });
    } catch (error) {
      logger.error('[savePreset] Error saving preset', error);
      return { message: 'Error saving preset' };
    }
  }

  /**
   * Deletes presets matching the given filter for a user.
   */
  async function deletePresets(
    user: string,
    filter: Record<string, unknown> = {},
  ): Promise<import('mongodb').DeleteResult> {
    const Preset = mongoose.models.Preset as Model<IPreset>;
    const deleteCount = await Preset.deleteMany({ ...filter, user });
    return deleteCount;
  }

  return {
    getPresets,
    savePreset,
    deletePresets,
  };
}

export type PresetMethods = ReturnType<typeof createPresetMethods>;

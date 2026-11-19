/**
 * The PostgreSQL `PresetStore` (`~/ports/preset`) on the `presets` table, through the collection
 * primitive, with the ordering and save plan of `~/methods/presetRules`. Must not import
 * `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB, reads and saves resolve `{ message }` instead of throwing; `undefined` values in
 * the save's `$set` are dropped, as mongoose drops them (the plan `$unset`s those paths).
 */
import type { PostgresStoreContext } from './context';
import type { PresetStore } from '~/ports/preset';
import type { PresetRecord } from '~/types';
import { planPresetSave, sortPresets } from '~/methods/presetRules';
import logger from '~/config/winston';

/** `update` with the `undefined` values of its `$set` dropped. */
function withoutUndefined(update: Record<string, unknown>): Record<string, unknown> {
  const set = update.$set as Record<string, unknown> | undefined;
  if (!set) {
    return update;
  }
  return {
    ...update,
    $set: Object.fromEntries(Object.entries(set).filter(([, value]) => value !== undefined)),
  };
}

export function createPostgresPresetStore(context: PostgresStoreContext): PresetStore {
  const presets = () =>
    context.collections().collection<PresetRecord & Record<string, unknown>>('presets');
  const store: PresetStore = {
    async getPresets(user, filter = {}) {
      try {
        return sortPresets(await presets().find({ ...filter, user }));
      } catch (error) {
        logger.error('[getPresets] Error getting presets', error);
        return { message: 'Error retrieving presets' };
      }
    },

    async savePreset(user, preset) {
      try {
        const plan = planPresetSave(user, preset);
        if (plan.demoteFilter) {
          /** One write demotes every other default, instead of a read then a by-id update. */
          await presets().updateMany(plan.demoteFilter, plan.demoteUpdate);
        }
        const saved = await presets().findOneAndUpdate(plan.filter, withoutUndefined(plan.update), {
          upsert: true,
          returnDocument: 'after',
        });
        return saved as PresetRecord;
      } catch (error) {
        logger.error('[savePreset] Error saving preset', error);
        return { message: 'Error saving preset' };
      }
    },

    async deletePresets(user, filter = {}) {
      return presets().deleteMany({ ...filter, user });
    },
  };
  return store;
}

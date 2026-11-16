/**
 * The PostgreSQL `BannerStore` (`~/ports/banner`) on the `banners` table, through the collection
 * primitive only. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB: a read without a sort takes the first record (by `_id` here, which is MongoDB's
 * natural order for generated ids), `saveBanner` replaces the first record found or creates one,
 * and `getBanner` hides a record that is not public when no `user` is given.
 */
import type { PostgresStoreContext } from './context';
import type { BannerFields, IBanner } from '~/types';
import type { BannerStore } from '~/ports/banner';
import logger from '~/config/winston';
import { asRecord } from './context';

/** The display window holds now: started, and not ended (a `null` or missing end never ends). */
const currentWindow = (now: Date) => ({
  displayFrom: { $lte: now },
  $or: [{ displayTo: { $gte: now } }, { displayTo: null }],
});

export function createPostgresBannerStore(context: PostgresStoreContext): BannerStore {
  const banners = () => context.collections().collection('banners');
  const asBanner = (record: unknown) => record as IBanner | null;

  const store: BannerStore = {
    async getBanner(user) {
      try {
        const banner = asBanner(
          await banners().findOne({ ...currentWindow(new Date()), type: 'banner' }),
        );
        if (!banner || banner.isPublic || user != null) {
          return banner;
        }
        return null;
      } catch (error) {
        logger.error('[getBanners] Error getting banners', error);
        throw new Error('Error getting banners');
      }
    },

    async getCurrentBannerRecord() {
      return asBanner(await banners().findOne(currentWindow(new Date())));
    },

    async deleteBannerRecord(id) {
      await banners().deleteOne({ _id: id });
    },

    async saveBanner(fields: BannerFields) {
      const existing = await banners().findOne({}, { projection: { _id: 1 } });
      if (existing) {
        return asBanner(
          await banners().findOneAndUpdate({ _id: existing._id }, asRecord(fields), {
            returnDocument: 'after',
          }),
        );
      }
      return asBanner(await banners().insertOne(asRecord(fields)));
    },
  };
  return store;
}

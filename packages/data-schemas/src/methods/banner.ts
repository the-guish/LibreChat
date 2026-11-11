import type { Model } from 'mongoose';
import type { BannerFields, IBanner, IUser } from '~/types';
import logger from '~/config/winston';

export function createBannerMethods(mongoose: typeof import('mongoose')): {
  getBanner: (user?: IUser | null) => Promise<IBanner | null>;
  getCurrentBannerRecord: () => Promise<IBanner | null>;
  deleteBannerRecord: (id: string) => Promise<void>;
  saveBanner: (fields: BannerFields) => Promise<IBanner | null>;
} {
  /**
   * Retrieves the current active banner.
   */
  async function getBanner(user?: IUser | null): Promise<IBanner | null> {
    try {
      const Banner = mongoose.models.Banner as Model<IBanner>;
      const now = new Date();
      const banner = (await Banner.findOne({
        displayFrom: { $lte: now },
        $or: [{ displayTo: { $gte: now } }, { displayTo: null }],
        type: 'banner',
      }).lean()) as IBanner | null;

      if (!banner || banner.isPublic || user != null) {
        return banner;
      }

      return null;
    } catch (error) {
      logger.error('[getBanners] Error getting banners', error);
      throw new Error('Error getting banners');
    }
  }

  /**
   * The banner record whose display window holds now (an open end never closes), whatever its
   * type and visibility, or `null`: the record the `delete-banner` script offers to delete.
   */
  async function getCurrentBannerRecord(): Promise<IBanner | null> {
    const Banner = mongoose.models.Banner as Model<IBanner>;
    const now = new Date();
    return (await Banner.findOne({
      displayFrom: { $lte: now },
      $or: [{ displayTo: { $gte: now } }, { displayTo: null }],
    }).lean()) as IBanner | null;
  }

  /** Deletes the banner record with this id; deleting one that is gone is a no-op. */
  async function deleteBannerRecord(id: string): Promise<void> {
    const Banner = mongoose.models.Banner as Model<IBanner>;
    await Banner.findByIdAndDelete(id);
  }

  /**
   * Writes the banner: there is one banner record, so the first record found is replaced with
   * `fields`, or one is created when there is none. Resolves to the record written, or `null`
   * when the record found was deleted before the write.
   */
  async function saveBanner(fields: BannerFields): Promise<IBanner | null> {
    const Banner = mongoose.models.Banner as Model<IBanner>;
    const existingBanner = await Banner.findOne();
    if (existingBanner) {
      return (await Banner.findByIdAndUpdate(existingBanner._id, fields, {
        new: true,
      }).lean()) as IBanner | null;
    }
    return (await Banner.create(fields)).toObject() as IBanner;
  }

  return { getBanner, getCurrentBannerRecord, deleteBannerRecord, saveBanner };
}

export type BannerMethods = ReturnType<typeof createBannerMethods>;

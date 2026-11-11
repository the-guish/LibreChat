/**
 * Banner store port: reading the banner shown to users, and the banner record the banner
 * command line scripts manage, independent of the database behind it. Nothing here may import
 * `mongoose`. Signatures are copied verbatim from `BannerMethods` (`~/methods/banner`);
 * `banner.spec.ts` fails the typecheck if the two drift.
 */
import type { BannerFields, IBanner, IUser } from '~/types';
import { listPortMethods } from './common';

export interface BannerStore {
  /**
   * The banner whose display window holds now (an open end never closes), or `null`. A banner
   * that is not public reads as `null` without a `user`. Throws when the read fails.
   */
  getBanner(user?: IUser | null): Promise<IBanner | null>;
  /**
   * The banner record whose display window holds now (an open end never closes), whatever its
   * type and visibility, or `null`.
   */
  getCurrentBannerRecord(): Promise<IBanner | null>;
  /** Deletes the banner record with this id; deleting one that is gone is a no-op. */
  deleteBannerRecord(id: string): Promise<void>;
  /**
   * Writes the banner: there is one banner record, so the first record found is replaced with
   * `fields`, or one is created when there is none. Resolves to the record written, or `null`
   * when the record found was deleted before the write.
   */
  saveBanner(fields: BannerFields): Promise<IBanner | null>;
}

/** Every method of {@link BannerStore}, for adapters and conformance checks. */
export const BANNER_STORE_METHODS: ReadonlyArray<keyof BannerStore> = listPortMethods<BannerStore>({
  getBanner: true,
  getCurrentBannerRecord: true,
  deleteBannerRecord: true,
  saveBanner: true,
});

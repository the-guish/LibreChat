/**
 * Banner store port: reading the banner shown to users, independent of the database behind it.
 * Nothing here may import `mongoose`. Signatures are copied verbatim from `BannerMethods`
 * (`~/methods/banner`); `banner.spec.ts` fails the typecheck if the two drift.
 */
import type { IBanner, IUser } from '~/types';
import { listPortMethods } from './common';

export interface BannerStore {
  /**
   * The banner whose display window holds now (an open end never closes), or `null`. A banner
   * that is not public reads as `null` without a `user`. Throws when the read fails.
   */
  getBanner(user?: IUser | null): Promise<IBanner | null>;
}

/** Every method of {@link BannerStore}, for adapters and conformance checks. */
export const BANNER_STORE_METHODS: ReadonlyArray<keyof BannerStore> = listPortMethods<BannerStore>({
  getBanner: true,
});

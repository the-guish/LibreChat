import type { Document } from 'mongoose';

export interface IBanner extends Document {
  bannerId: string;
  message: string;
  displayFrom: Date;
  displayTo?: Date;
  type: 'banner' | 'popup';
  isPublic: boolean;
  persistable: boolean;
  tenantId?: string;
}

/** The fields the banner command line writes on the banner record (`saveBanner`). */
export interface BannerFields {
  displayFrom: Date;
  /** `null` for a banner shown until it is replaced. */
  displayTo: Date | null;
  message: string;
  bannerId: string;
  isPublic: boolean;
  persistable: boolean;
}

import { Types } from 'mongoose';
import type { StoreIds } from '~/ports/storeIds';

type ObjectIdInput = Parameters<typeof Types.ObjectId.isValid>[0];

/**
 * MongoDB store ids (`~/ports/storeIds`): ObjectIds, validated, cast and created exactly as
 * `Types.ObjectId` does (`isValid`, `new Types.ObjectId(value)`, `new Types.ObjectId()`).
 */
export const mongoStoreIds: StoreIds = {
  isValid: (value) => Types.ObjectId.isValid(value as ObjectIdInput),
  toCanonicalString: (value) => {
    if (!Types.ObjectId.isValid(value as ObjectIdInput)) {
      throw new TypeError(`Not a valid store id: ${String(value)}`);
    }
    return new Types.ObjectId(value as ObjectIdInput).toString();
  },
  toStoreId: (value) => {
    if (!Types.ObjectId.isValid(value as ObjectIdInput)) {
      throw new TypeError(`Not a valid store id: ${String(value)}`);
    }
    return new Types.ObjectId(value as ObjectIdInput);
  },
  generate: () => new Types.ObjectId().toString(),
};

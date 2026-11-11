import type { StoreErrors } from '~/ports/storeErrors';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';

/**
 * Whether `error` carries MongoDB's duplicate-key code: the number 11000 the server reports (on a
 * `MongoServerError`, or a `MongoBulkWriteError` for a bulk write), or the `E11000` its message
 * starts with, which the passkey registration also accepted as a code. The driver and mongoose
 * only ever report the number; these are exactly the values callers tested before the port.
 */
function hasMongoDuplicateKeyCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code } = error as { code?: unknown };
  return code === 11000 || code === 'E11000';
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof StoreDuplicateKeyError || hasMongoDuplicateKeyCode(error);
}

/**
 * MongoDB store errors (`~/ports/storeErrors`): a duplicate key is the driver's error with code
 * 11000 (or `E11000`) or a `StoreDuplicateKeyError`; its fields are the keys of the error's
 * `keyValue`, which the server reports for a unique index violation.
 */
export const mongoStoreErrors: StoreErrors = {
  isDuplicateKey,
  duplicateKeyFields: (error) => {
    if (!isDuplicateKey(error)) {
      return undefined;
    }
    const { keyValue } = error as { keyValue?: unknown };
    return keyValue ? Object.keys(keyValue as object) : undefined;
  },
};

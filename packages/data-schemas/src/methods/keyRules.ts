/**
 * The user key store's database-neutral rules (`UserKeyStore`, `~/ports/key`), shared by every
 * backend: the MongoDB methods (`./key`) and the PostgreSQL store
 * (`adapters/postgres/stores/userKey.ts`). The encryption formats, the errors a missing or
 * malformed key throws, the write of a key and its expiry. Nothing here may import `mongoose` or
 * the MongoDB driver.
 */
import { ErrorTypes } from 'librechat-data-provider';
import type { TCredentialsConfig } from 'librechat-data-provider';
import { encrypt, decrypt, encryptV3, decryptV3 } from '~/crypto';
import logger from '~/config/winston';

const V3_PREFIX = 'v3:';

/** Values written by earlier releases are bare hex (fixed IV); `v3:` values carry a random IV. */
export function decryptStoredKey(value: string): Promise<string> | string {
  return value.startsWith(V3_PREFIX) ? decryptV3(value) : decrypt(value);
}

/**
 * `value` encrypted for storage: `v3` (default) writes a random IV per value; `legacy` writes
 * the fixed-IV format that releases predating `v3` can read (rolling upgrades).
 */
export async function encryptUserKeyValue(
  value: string,
  writeFormat: TCredentialsConfig['writeFormat'] = 'v3',
): Promise<string> {
  return writeFormat === 'legacy' ? await encrypt(value) : encryptV3(value);
}

/** The error `getUserKey` throws when the user has no such key. */
export function noUserKeyError(): Error {
  return new Error(
    JSON.stringify({
      type: ErrorTypes.NO_USER_KEY,
    }),
  );
}

/**
 * The decrypted key value parsed as a JSON object; throws an error whose message is the JSON of
 * `{ type: ErrorTypes.INVALID_USER_KEY }` when it is not JSON.
 */
export function parseUserKeyValues(userValues: string): Record<string, string> {
  try {
    return JSON.parse(userValues) as Record<string, string>;
  } catch (e) {
    logger.error('[getUserKeyValues]', e);
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.INVALID_USER_KEY,
      }),
    );
  }
}

/** The fields `updateUserKey` sets. */
export interface UserKeyFields {
  userId: string;
  name: string;
  value: string;
  expiresAt?: Date;
}

/**
 * The upsert of `updateUserKey` for the encrypted value: the key's fields, and its expiry set
 * (or unset for no expiry).
 */
export function userKeyUpdate(params: {
  userId: string;
  name: string;
  encryptedValue: string;
  expiresAt?: Date | null;
}): { $set: UserKeyFields; $unset?: { expiresAt: string } } {
  const { userId, name, encryptedValue, expiresAt } = params;
  const updateObject: UserKeyFields = {
    userId,
    name,
    value: encryptedValue,
  };
  const updateQuery: { $set: UserKeyFields; $unset?: { expiresAt: string } } = {
    $set: updateObject,
  };
  if (expiresAt) {
    updateObject.expiresAt = new Date(expiresAt);
  } else {
    updateQuery.$unset = { expiresAt: '' };
  }
  return updateQuery;
}

/** What `getUserKeyExpiry` reports for the stored key (`null`: no such key). */
export function userKeyExpiry(keyValue: { expiresAt?: Date } | null): {
  expiresAt: Date | 'never' | null;
} {
  if (!keyValue) {
    return { expiresAt: null };
  }
  return { expiresAt: keyValue.expiresAt || 'never' };
}

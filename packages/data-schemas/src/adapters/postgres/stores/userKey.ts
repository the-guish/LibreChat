/**
 * The PostgreSQL `UserKeyStore` (`~/ports/key`) on the `keys` table, through the collection
 * primitive, with the encryption formats, errors and writes of `~/methods/keyRules`. Must not
 * import `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB: values are encrypted before they are stored (`v3` by default) and decrypted
 * when read, legacy fixed-IV values included; `updateUserKey` is one upsert that sets or unsets
 * the expiry; `deleteUserKey` without `all` deletes the named key and resolves it.
 */
import type { PostgresStoreContext } from './context';
import type { UserKeyStore } from '~/ports/key';
import {
  userKeyUpdate,
  userKeyExpiry,
  noUserKeyError,
  decryptStoredKey,
  parseUserKeyValues,
  encryptUserKeyValue,
} from '~/methods/keyRules';

interface KeyRecord extends Record<string, unknown> {
  userId: string;
  name: string;
  value: string;
  expiresAt?: Date;
}

export function createPostgresUserKeyStore(context: PostgresStoreContext): UserKeyStore {
  const keys = () => context.collections().collection<KeyRecord>('keys');

  async function getUserKey({ userId, name }: { userId: string; name: string }): Promise<string> {
    const keyValue = await keys().findOne({ userId, name });
    if (!keyValue) {
      throw noUserKeyError();
    }
    return await decryptStoredKey(keyValue.value);
  }

  const store: UserKeyStore = {
    getUserKey,

    async getUserKeyValues({ userId, name }) {
      return parseUserKeyValues(await getUserKey({ userId, name }));
    },

    async getUserKeyExpiry({ userId, name }) {
      return userKeyExpiry(await keys().findOne({ userId, name }));
    },

    async updateUserKey({ userId, name, value, expiresAt = null, writeFormat = 'v3' }) {
      const encryptedValue = await encryptUserKeyValue(value, writeFormat);
      return await keys().findOneAndUpdate(
        { userId, name },
        userKeyUpdate({ userId, name, encryptedValue, expiresAt }),
        { upsert: true, returnDocument: 'after' },
      );
    },

    async deleteUserKey({ userId, name, all = false }) {
      if (all) {
        return await keys().deleteMany({ userId });
      }
      return await keys().findOneAndDelete({ userId, name });
    },
  };
  return store;
}

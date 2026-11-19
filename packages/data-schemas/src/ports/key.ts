/**
 * User key store port: the encrypted credentials users supply for providers. Nothing here may
 * import `mongoose`. Signatures are copied verbatim from `KeyMethods` (`~/methods/key`);
 * `key.spec.ts` fails the typecheck if the two drift. Values are encrypted before they are stored
 * and decrypted when read; any store keeps that.
 *
 * Known leak kept for now so callers stay unchanged: `updateUserKey` and `deleteUserKey` resolve
 * to whatever the store reports (`unknown`); no caller reads it.
 */
import type { TCredentialsConfig } from 'librechat-data-provider';
import { listPortMethods } from './common';

export interface UserKeyStore {
  /**
   * The decrypted value of the user's key `name`. Throws an error whose message is the JSON of
   * `{ type: ErrorTypes.NO_USER_KEY }` when there is none.
   */
  getUserKey(params: { userId: string; name: string }): Promise<string>;
  /**
   * Creates or replaces the user's key `name` with `value`, encrypted in `writeFormat` (`v3` by
   * default). Without `expiresAt` the key never expires.
   */
  updateUserKey(params: {
    userId: string;
    name: string;
    value: string;
    expiresAt?: Date | null;
    writeFormat?: TCredentialsConfig['writeFormat'];
  }): Promise<unknown>;
  /** Deletes the user's key `name`, or every key of the user with `all`. */
  deleteUserKey(params: { userId: string; name?: string; all?: boolean }): Promise<unknown>;
  /**
   * The user's key `name`, decrypted and parsed as a JSON object. Throws like `getUserKey`, or an
   * error whose message is the JSON of `{ type: ErrorTypes.INVALID_USER_KEY }` when it is not JSON.
   */
  getUserKeyValues(params: { userId: string; name: string }): Promise<Record<string, string>>;
  /** When the user's key `name` expires: `'never'`, or `null` when there is no such key. */
  getUserKeyExpiry(params: {
    userId: string;
    name: string;
  }): Promise<{ expiresAt: Date | 'never' | null }>;
}

/** Every method of {@link UserKeyStore}, for adapters and conformance checks. */
export const USER_KEY_STORE_METHODS: ReadonlyArray<keyof UserKeyStore> =
  listPortMethods<UserKeyStore>({
    getUserKey: true,
    updateUserKey: true,
    deleteUserKey: true,
    getUserKeyValues: true,
    getUserKeyExpiry: true,
  });

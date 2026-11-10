/**
 * Passkey store port: the WebAuthn credentials users register to sign in. Nothing here may
 * import `mongoose`. Signatures are those of `PasskeyMethods` (`~/methods/passkey`) with delete
 * results stated as `DeleteCount`; `passkey.spec.ts` fails the typecheck if the MongoDB methods
 * stop satisfying them. Records are plain (`PasskeyRecord`: string ids, a real `Buffer` key).
 */
import type { PasskeyCreateData, PasskeyRecord } from '~/types';
import type { DeleteCount } from './common';
import { listPortMethods } from './common';

export interface PasskeyStore {
  /** Registers a verified credential; a credential id is unique across the deployment. */
  createPasskey(data: PasskeyCreateData): Promise<PasskeyRecord>;
  /** The user's credentials, newest first. */
  findPasskeysByUser(userId: string): Promise<PasskeyRecord[]>;
  /** The credential with this authenticator-supplied id, whoever owns it, or `null`. */
  findPasskeyByCredentialId(credentialId: string): Promise<PasskeyRecord | null>;
  countPasskeysByUser(userId: string): Promise<number>;
  /**
   * Records a successful assertion. For a counter-capable credential (`counter > 0`) the write is
   * a compare-and-swap that only succeeds while the stored counter is below `counter`; resolves
   * whether this assertion won it, and `false` when the write fails. A counterless credential
   * (`counter` 0) only restamps its last use and resolves `true` even when the write fails.
   */
  recordPasskeyUse(credentialId: string, counter: number, backedUp?: boolean): Promise<boolean>;
  /** Renames the user's credential; `null` when the user has no such credential. */
  renamePasskey(passkeyId: string, userId: string, name: string): Promise<PasskeyRecord | null>;
  /** Deletes the user's credential; `deletedCount` is 0 when there was none. */
  deletePasskey(passkeyId: string, userId: string): Promise<DeleteCount>;
  /** Deletes every credential of the user. */
  deletePasskeysByUser(userId: string): Promise<DeleteCount>;
}

/** Every method of {@link PasskeyStore}, for adapters and conformance checks. */
export const PASSKEY_STORE_METHODS: ReadonlyArray<keyof PasskeyStore> =
  listPortMethods<PasskeyStore>({
    createPasskey: true,
    findPasskeysByUser: true,
    findPasskeyByCredentialId: true,
    countPasskeysByUser: true,
    recordPasskeyUse: true,
    renamePasskey: true,
    deletePasskey: true,
    deletePasskeysByUser: true,
  });

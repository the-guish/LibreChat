/**
 * The passkey store's database-neutral rules (`PasskeyStore`, `~/ports/passkey`), shared by every
 * backend: the MongoDB methods (`./passkey`) and the PostgreSQL store
 * (`adapters/postgres/stores/passkey.ts`). The plain record a stored credential is handed out as
 * (its public key a `Buffer` whatever the driver returns) and the counter compare-and-swap.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { IPasskey, PasskeyRecord } from '~/types';

/** The shapes a `Buffer` schema field can come back as, depending on `lean()`. */
export type StoredBinary = Buffer | Uint8Array | { buffer: Buffer };

/** What the driver hands back for a stored passkey: `lean()` rows or saved documents. */
export type StoredPasskey = Pick<
  IPasskey,
  | 'credentialId'
  | 'publicKey'
  | 'counter'
  | 'transports'
  | 'deviceType'
  | 'backedUp'
  | 'name'
  | 'lastUsedAt'
  | 'tenantId'
  | 'createdAt'
> & {
  _id: { toString(): string };
  user: { toString(): string };
};

/**
 * `lean()` skips Mongoose casting, so a `Buffer` field arrives as the driver's
 * BSON `Binary`. `new Uint8Array(binary)` silently yields zero bytes, which
 * would make every signature check fail. Normalize at the data-layer boundary
 * so callers can trust the declared `Buffer` type.
 */
export function toBuffer(value: StoredBinary): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if ('buffer' in value && Buffer.isBuffer(value.buffer)) {
    return value.buffer;
  }
  return Buffer.from(value as Uint8Array);
}

/** Maps a stored row to the plain record the methods expose. */
export function toPasskeyRecord(passkey: StoredPasskey): PasskeyRecord {
  return {
    id: passkey._id.toString(),
    userId: passkey.user.toString(),
    credentialId: passkey.credentialId,
    publicKey: toBuffer(passkey.publicKey as StoredBinary),
    counter: passkey.counter,
    transports: passkey.transports ?? [],
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
    name: passkey.name,
    lastUsedAt: passkey.lastUsedAt ?? null,
    tenantId: passkey.tenantId,
    createdAt: passkey.createdAt,
  };
}

/**
 * The guarded write of `recordPasskeyUse`. For counter-capable authenticators this is the
 * compare-and-swap that makes clone detection meaningful: the update only matches while the
 * stored counter is still strictly below the asserted one, so of two assertions that verified
 * concurrently against the same stored value exactly one can commit. Authenticators that do not
 * implement a counter report 0 forever and carry no clone signal, so they only restamp
 * `lastUsedAt`.
 */
export function passkeyUseWrite(
  credentialId: string,
  counter: number,
  backedUp?: boolean,
): { filter: Record<string, unknown>; update: Record<string, unknown> } {
  const filter =
    counter > 0
      ? { credentialId, counter: { $lt: counter } }
      : { credentialId, counter: { $lte: 0 } };
  return {
    filter,
    update: {
      $set: {
        counter,
        lastUsedAt: new Date(),
        ...(backedUp === undefined ? {} : { backedUp }),
      },
    },
  };
}

/**
 * What `recordPasskeyUse` resolves when its write fails: it fails closed for counter-capable
 * credentials, and a counterless credential has no clone signal to forfeit.
 */
export function passkeyUseOnFailure(counter: number): boolean {
  return counter === 0;
}

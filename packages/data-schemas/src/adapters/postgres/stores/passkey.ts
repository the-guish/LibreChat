/**
 * The PostgreSQL `PasskeyStore` (`~/ports/passkey`) on the `passkeys` table, through the collection
 * primitive, with the record mapping and the counter compare-and-swap of
 * `~/methods/passkeyRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The public key is a `bytea` column, read back as a `Buffer`. The unique `credentialId` index
 * comes with the migrations, so registering a credential twice rejects with a duplicate-key
 * error from the first write. As on MongoDB, `recordPasskeyUse` fails closed for counter-capable
 * credentials when its write fails.
 */
import type { StoredPasskey } from '~/methods/passkeyRules';
import type { PostgresStoreContext } from './context';
import type { PasskeyStore } from '~/ports/passkey';
import type { PasskeyRecord } from '~/types';
import { passkeyUseWrite, toPasskeyRecord, passkeyUseOnFailure } from '~/methods/passkeyRules';
import logger from '~/config/winston';
import { asRecord } from './context';

type PasskeyRow = StoredPasskey & Record<string, unknown>;

export function createPostgresPasskeyStore(context: PostgresStoreContext): PasskeyStore {
  const passkeys = () => context.collections().collection<PasskeyRow>('passkeys');
  const toRecord = (passkey: PasskeyRow): PasskeyRecord => toPasskeyRecord(passkey);

  const store: PasskeyStore = {
    async createPasskey(data) {
      return toRecord(await passkeys().insertOne(asRecord(data)));
    },

    async findPasskeysByUser(userId) {
      return (await passkeys().find({ user: userId }, { sort: { createdAt: -1 } })).map(toRecord);
    },

    async findPasskeyByCredentialId(credentialId) {
      const passkey = await passkeys().findOne({ credentialId });
      return passkey ? toRecord(passkey) : null;
    },

    async countPasskeysByUser(userId) {
      return await passkeys().count({ user: userId });
    },

    async recordPasskeyUse(credentialId, counter, backedUp) {
      try {
        const { filter, update } = passkeyUseWrite(credentialId, counter, backedUp);
        const result = await passkeys().updateOne(filter, update);
        return result.matchedCount > 0;
      } catch (error) {
        logger.error('[recordPasskeyUse] Failed to persist passkey counter', error);
        return passkeyUseOnFailure(counter);
      }
    },

    async renamePasskey(passkeyId, userId, name) {
      const renamed = await passkeys().findOneAndUpdate(
        { _id: passkeyId, user: userId },
        { name },
        { returnDocument: 'after' },
      );
      return renamed ? toRecord(renamed) : null;
    },

    async deletePasskey(passkeyId, userId) {
      return await passkeys().deleteOne({ _id: passkeyId, user: userId });
    },

    async deletePasskeysByUser(userId) {
      return await passkeys().deleteMany({ user: userId });
    },
  };
  return store;
}

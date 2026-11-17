/**
 * The PostgreSQL `ResourceLockStore` (`~/ports/resourceLock`): expiring leases on the
 * `resourcelocks` table, through the collection primitive. Must not import `mongoose`, `mongodb`
 * or `bson`.
 *
 * The unique `key` index decides who creates a lease; a takeover and a renewal are guarded
 * single-record updates (§3.5), so of several racing takeovers exactly one matches. The indexes
 * come with the migrations, so the acquisition never waits for an index build (`readyWaitMs` is a
 * MongoDB concern).
 */
import type { ResourceLockStore } from '~/ports/resourceLock';
import type { PostgresStoreContext } from './context';
import type { IResourceLock } from '~/types';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { asRecord } from './context';

export function createPostgresResourceLockStore(context: PostgresStoreContext): ResourceLockStore {
  const locks = () =>
    context.collections().collection<IResourceLock & Record<string, unknown>>('resourcelocks');

  const store: ResourceLockStore = {
    async acquireResourceLock({ key, ownerId, ttlMs }) {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs);
      try {
        await locks().insertOne(asRecord({ key, ownerId, expiresAt }));
        return true;
      } catch (error) {
        if (!(error instanceof StoreDuplicateKeyError)) {
          throw error;
        }
      }
      const taken = await locks().findOneAndUpdate(
        { key, expiresAt: { $lte: now } },
        { $set: { ownerId, expiresAt } },
        { returnDocument: 'after' },
      );
      return taken != null;
    },

    async renewResourceLock({ key, ownerId, ttlMs }) {
      const now = new Date();
      const renewed = await locks().findOneAndUpdate(
        { key, ownerId, expiresAt: { $gt: now } },
        /** $max keeps overlapping renewals from moving the expiry backwards. */
        { $max: { expiresAt: new Date(now.getTime() + ttlMs) } },
        { returnDocument: 'after' },
      );
      return renewed != null;
    },

    async releaseResourceLock({ key, ownerId }) {
      const result = await locks().deleteOne({ key, ownerId });
      return result.deletedCount > 0;
    },
  };
  return store;
}

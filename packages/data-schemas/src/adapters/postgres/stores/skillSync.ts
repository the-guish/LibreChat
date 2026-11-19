/**
 * The PostgreSQL `SkillSyncStore` (`~/ports/skillSync`): the provider credentials
 * (`skillsynccredentials`), the per-source run statuses and the provider lock
 * (`skillsyncstatuses`), through the collection primitive, with the writes of
 * `~/methods/skillSyncRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * As on MongoDB: tokens are stored encrypted with their hash (the hash and the ciphertext are
 * hidden paths, selected by the reads that need them); a status is kept per provider, source and
 * tenant bucket, which the unique index makes `NULLS NOT DISTINCT`, so the bucket without a
 * tenant holds one row; the skip lists are child tables, replaced whole by each run. Neither
 * collection is tenant-scoped: the bucket is the explicit `tenantId`.
 *
 * - **Lock**: the lock row shares the status table under a reserved source id. A claim reads the
 *   row; a live lease refuses it; a missing row is inserted, and the unique index lets exactly
 *   one of racing inserts win (the others resolve `false`); an expired or released lease is taken
 *   over with a guarded upsert (the primitive's compare-and-set, §3.5), which a concurrent winner
 *   turns into a miss or a duplicate key, both `false`. Renewals and releases are guarded updates
 *   on the owner and the lease.
 */
import type {
  ISkillSyncStatus,
  ISkillSyncCredential,
  SkillSyncCredentialSummary,
} from '~/types/skillSync';
import type { SkillSyncStore } from '~/ports/skillSync';
import type { PostgresStoreContext } from './context';
import {
  SKILL_SYNC_LOCK_SOURCE_ID,
  hashSkillSyncToken,
  skillSyncLockFilter,
  skillSyncStatusWrite,
  skillSyncLockIdentity,
  skillSyncCredentialUpdate,
  summarizeSkillSyncCredential,
} from '~/methods/skillSyncRules';
import { StoreDuplicateKeyError } from '~/ports/storeErrors';
import { encryptV2, decryptV2 } from '~/crypto';

type CredentialRecord = ISkillSyncCredential & Record<string, unknown>;
type StatusRecord = ISkillSyncStatus & Record<string, unknown>;

export function createPostgresSkillSyncStore(context: PostgresStoreContext): SkillSyncStore {
  const credentials = () =>
    context.collections().collection<CredentialRecord>('skillsynccredentials');
  const statuses = () => context.collections().collection<StatusRecord>('skillsyncstatuses');
  const summarize = (credential: CredentialRecord): SkillSyncCredentialSummary =>
    summarizeSkillSyncCredential(credential);

  const store: SkillSyncStore = {
    async upsertSkillSyncCredential(input) {
      const encryptedToken = await encryptV2(input.token);
      const tokenHash = hashSkillSyncToken(input.token);
      const credential = await credentials().findOneAndUpdate(
        { provider: input.provider, credentialKey: input.credentialKey },
        skillSyncCredentialUpdate(input, encryptedToken, tokenHash),
        { upsert: true, returnDocument: 'after', projection: '+tokenHash' },
      );
      return summarize(credential as CredentialRecord);
    },

    async deleteSkillSyncCredential(provider, credentialKey) {
      const result = await credentials().deleteOne({ provider, credentialKey });
      return { deleted: result.deletedCount > 0 };
    },

    async listSkillSyncCredentials(provider) {
      const rows = await credentials().find(
        { provider },
        { projection: '+tokenHash', sort: { credentialKey: 1 } },
      );
      return rows.map(summarize);
    },

    async getSkillSyncCredentialToken(provider, credentialKey) {
      const credential = await credentials().findOne(
        { provider, credentialKey },
        { projection: '+encryptedToken' },
      );
      if (!credential) {
        return null;
      }
      return decryptV2(credential.encryptedToken);
    },

    async getSkillSyncCredentialSummary(provider, credentialKey) {
      const credential = await credentials().findOne(
        { provider, credentialKey },
        { projection: '+tokenHash' },
      );
      return credential ? summarize(credential) : null;
    },

    async listSkillSyncStatuses(provider) {
      return statuses().find(
        { provider, sourceId: { $ne: SKILL_SYNC_LOCK_SOURCE_ID } },
        { sort: { sourceId: 1 } },
      );
    },

    async upsertSkillSyncStatus(input) {
      const { filter, update } = skillSyncStatusWrite(input, new Date());
      const row = await statuses().findOneAndUpdate(filter, update, {
        upsert: true,
        returnDocument: 'after',
      });
      return row as StatusRecord;
    },

    async tryAcquireSkillSyncLock(params) {
      const now = new Date();
      const lockExpiresAt = new Date(now.getTime() + params.leaseMs);
      const existing = await statuses().findOne(skillSyncLockFilter(params));
      if (existing?.lockOwner && existing.lockExpiresAt && existing.lockExpiresAt > now) {
        return false;
      }
      try {
        if (!existing) {
          await statuses().insertOne({
            ...skillSyncLockIdentity(params),
            status: 'running',
            lockOwner: params.lockOwner,
            lockExpiresAt,
            startedAt: now,
          });
          return true;
        }
        const row = await statuses().findOneAndUpdate(
          {
            ...skillSyncLockFilter(params),
            $or: [{ lockExpiresAt: { $exists: false } }, { lockExpiresAt: { $lte: now } }],
          },
          {
            $set: { status: 'running', lockOwner: params.lockOwner, lockExpiresAt, startedAt: now },
            $setOnInsert: skillSyncLockIdentity(params),
          },
          { upsert: true, returnDocument: 'after' },
        );
        return row?.lockOwner === params.lockOwner;
      } catch (error) {
        if (error instanceof StoreDuplicateKeyError) {
          return false;
        }
        throw error;
      }
    },

    async refreshSkillSyncLock(params) {
      const now = new Date();
      const row = await statuses().findOneAndUpdate(
        {
          ...skillSyncLockFilter(params),
          lockOwner: params.lockOwner,
          lockExpiresAt: { $gt: now },
        },
        { $set: { status: 'running', lockExpiresAt: new Date(now.getTime() + params.leaseMs) } },
        { returnDocument: 'after' },
      );
      return Boolean(row);
    },

    async releaseSkillSyncLock(params) {
      await statuses().updateOne(
        { ...skillSyncLockFilter(params), lockOwner: params.lockOwner },
        {
          $set: { status: 'idle', finishedAt: new Date() },
          $unset: { lockOwner: '', lockExpiresAt: '' },
        },
      );
    },
  };
  return store;
}

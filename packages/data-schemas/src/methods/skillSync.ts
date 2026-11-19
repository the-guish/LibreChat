import type { Model } from 'mongoose';
import type {
  ISkillSyncStatus,
  SkillSyncProvider,
  SkillSyncLockInput,
  SkillSyncStatusInput,
  ISkillSyncCredential,
  ISkillSyncStatusDocument,
  SkillSyncReleaseLockInput,
  SkillSyncCredentialSummary,
  ISkillSyncCredentialDocument,
  UpsertSkillSyncCredentialInput,
} from '~/types/skillSync';
import {
  skillSyncLockFilter,
  skillSyncStatusWrite,
  skillSyncLockIdentity,
  hashSkillSyncToken,
  SKILL_SYNC_LOCK_SOURCE_ID,
  skillSyncCredentialUpdate,
  summarizeSkillSyncCredential,
} from './skillSyncRules';
import { encryptV2, decryptV2 } from '~/crypto';

export type {
  SkillSyncLockInput,
  SkillSyncStatusInput,
  SkillSyncReleaseLockInput,
  SkillSyncCredentialSummary,
  UpsertSkillSyncCredentialInput,
} from '~/types/skillSync';

export type SkillSyncMethods = {
  upsertSkillSyncCredential: (
    input: UpsertSkillSyncCredentialInput,
  ) => Promise<SkillSyncCredentialSummary>;
  deleteSkillSyncCredential: (
    provider: SkillSyncProvider,
    credentialKey: string,
  ) => Promise<{ deleted: boolean }>;
  listSkillSyncCredentials: (provider: SkillSyncProvider) => Promise<SkillSyncCredentialSummary[]>;
  getSkillSyncCredentialToken: (
    provider: SkillSyncProvider,
    credentialKey: string,
  ) => Promise<string | null>;
  getSkillSyncCredentialSummary: (
    provider: SkillSyncProvider,
    credentialKey: string,
  ) => Promise<SkillSyncCredentialSummary | null>;
  listSkillSyncStatuses: (provider: SkillSyncProvider) => Promise<ISkillSyncStatus[]>;
  upsertSkillSyncStatus: (input: SkillSyncStatusInput) => Promise<ISkillSyncStatus>;
  tryAcquireSkillSyncLock: (params: SkillSyncLockInput) => Promise<boolean>;
  refreshSkillSyncLock: (params: SkillSyncLockInput) => Promise<boolean>;
  releaseSkillSyncLock: (params: SkillSyncReleaseLockInput) => Promise<void>;
};

export function createSkillSyncMethods(mongoose: typeof import('mongoose')): SkillSyncMethods {
  async function upsertSkillSyncCredential(
    input: UpsertSkillSyncCredentialInput,
  ): Promise<SkillSyncCredentialSummary> {
    const Credential = mongoose.models.SkillSyncCredential as Model<ISkillSyncCredentialDocument>;
    const encryptedToken = await encryptV2(input.token);
    const tokenHash = hashSkillSyncToken(input.token);
    const update = skillSyncCredentialUpdate(input, encryptedToken, tokenHash);
    const credential = await Credential.findOneAndUpdate(
      { provider: input.provider, credentialKey: input.credentialKey },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
      .select('+tokenHash')
      .lean();
    return summarizeSkillSyncCredential(credential as ISkillSyncCredential);
  }

  async function deleteSkillSyncCredential(
    provider: SkillSyncProvider,
    credentialKey: string,
  ): Promise<{ deleted: boolean }> {
    const Credential = mongoose.models.SkillSyncCredential as Model<ISkillSyncCredentialDocument>;
    const result = await Credential.deleteOne({ provider, credentialKey });
    return { deleted: (result.deletedCount ?? 0) > 0 };
  }

  async function listSkillSyncCredentials(
    provider: SkillSyncProvider,
  ): Promise<SkillSyncCredentialSummary[]> {
    const Credential = mongoose.models.SkillSyncCredential as Model<ISkillSyncCredentialDocument>;
    const rows = await Credential.find({ provider })
      .select('+tokenHash')
      .sort({ credentialKey: 1 })
      .lean();
    return rows.map((row) => summarizeSkillSyncCredential(row as ISkillSyncCredential));
  }

  async function getSkillSyncCredentialToken(
    provider: SkillSyncProvider,
    credentialKey: string,
  ): Promise<string | null> {
    const Credential = mongoose.models.SkillSyncCredential as Model<ISkillSyncCredentialDocument>;
    const credential = await Credential.findOne({ provider, credentialKey })
      .select('+encryptedToken')
      .lean();
    if (!credential) {
      return null;
    }
    return decryptV2((credential as ISkillSyncCredential).encryptedToken);
  }

  async function getSkillSyncCredentialSummary(
    provider: SkillSyncProvider,
    credentialKey: string,
  ): Promise<SkillSyncCredentialSummary | null> {
    const Credential = mongoose.models.SkillSyncCredential as Model<ISkillSyncCredentialDocument>;
    const credential = await Credential.findOne({ provider, credentialKey })
      .select('+tokenHash')
      .lean();
    if (!credential) {
      return null;
    }
    return summarizeSkillSyncCredential(credential as ISkillSyncCredential);
  }

  async function listSkillSyncStatuses(provider: SkillSyncProvider): Promise<ISkillSyncStatus[]> {
    const Status = mongoose.models.SkillSyncStatus as Model<ISkillSyncStatusDocument>;
    const rows = await Status.find({ provider, sourceId: { $ne: SKILL_SYNC_LOCK_SOURCE_ID } })
      .sort({ sourceId: 1 })
      .lean<ISkillSyncStatus[]>();
    return rows;
  }

  async function upsertSkillSyncStatus(input: SkillSyncStatusInput): Promise<ISkillSyncStatus> {
    const Status = mongoose.models.SkillSyncStatus as Model<ISkillSyncStatusDocument>;
    const now = new Date();
    const { filter, update } = skillSyncStatusWrite(input, now);
    const row = await Status.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }).lean<ISkillSyncStatus>();
    return row;
  }

  async function tryAcquireSkillSyncLock(params: SkillSyncLockInput): Promise<boolean> {
    const Status = mongoose.models.SkillSyncStatus as Model<ISkillSyncStatusDocument>;
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + params.leaseMs);
    const existing = await Status.findOne(
      skillSyncLockFilter(params),
    ).lean<ISkillSyncStatus | null>();
    if (existing?.lockOwner && existing.lockExpiresAt && existing.lockExpiresAt > now) {
      return false;
    }
    if (!existing) {
      try {
        await Status.create({
          ...skillSyncLockIdentity(params),
          status: 'running',
          lockOwner: params.lockOwner,
          lockExpiresAt,
          startedAt: now,
        });
        return true;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) {
          return false;
        }
        throw error;
      }
    }
    try {
      const row = await Status.findOneAndUpdate(
        {
          ...skillSyncLockFilter(params),
          $or: [{ lockExpiresAt: { $exists: false } }, { lockExpiresAt: { $lte: now } }],
        },
        {
          $set: {
            status: 'running',
            lockOwner: params.lockOwner,
            lockExpiresAt,
            startedAt: now,
          },
          $setOnInsert: skillSyncLockIdentity(params),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      return (row as ISkillSyncStatus | null)?.lockOwner === params.lockOwner;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return false;
      }
      throw error;
    }
  }

  async function refreshSkillSyncLock(params: SkillSyncLockInput): Promise<boolean> {
    const Status = mongoose.models.SkillSyncStatus as Model<ISkillSyncStatusDocument>;
    const now = new Date();
    const row = await Status.findOneAndUpdate(
      {
        ...skillSyncLockFilter(params),
        lockOwner: params.lockOwner,
        lockExpiresAt: { $gt: now },
      },
      {
        $set: {
          status: 'running',
          lockExpiresAt: new Date(now.getTime() + params.leaseMs),
        },
      },
      { new: true },
    ).lean<ISkillSyncStatus | null>();
    return Boolean(row);
  }

  async function releaseSkillSyncLock(params: SkillSyncReleaseLockInput): Promise<void> {
    const Status = mongoose.models.SkillSyncStatus as Model<ISkillSyncStatusDocument>;
    await Status.updateOne(
      {
        ...skillSyncLockFilter(params),
        lockOwner: params.lockOwner,
      },
      {
        $set: {
          status: 'idle',
          finishedAt: new Date(),
        },
        $unset: {
          lockOwner: '',
          lockExpiresAt: '',
        },
      },
    );
  }

  return {
    upsertSkillSyncCredential,
    deleteSkillSyncCredential,
    listSkillSyncCredentials,
    getSkillSyncCredentialToken,
    getSkillSyncCredentialSummary,
    listSkillSyncStatuses,
    upsertSkillSyncStatus,
    tryAcquireSkillSyncLock,
    refreshSkillSyncLock,
    releaseSkillSyncLock,
  };
}

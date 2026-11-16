import type { FilterQuery, Model } from 'mongoose';
import type {
  FileStorageClaim,
  FileStorageDeleteClaim,
  FileProvisionCommit,
  IMongoFile,
} from '~/types/file';

import {
  fileStorageClaimFilter,
  fileProvisionCommitFilter,
  fileProvisionCommitUpdate,
} from './fileStorageRules';

function claimFilter(data: FileStorageClaim): FilterQuery<IMongoFile> {
  return fileStorageClaimFilter(data) as FilterQuery<IMongoFile>;
}

/** Claims never expire: elapsed time cannot fence an external storage operation. */
export function createFileStorageMethods(mongoose: typeof import('mongoose')): {
  acquireFileProvision: (data: FileStorageClaim) => Promise<boolean>;
  releaseFileProvision: (data: FileStorageClaim) => Promise<boolean>;
  commitFileProvision: (data: FileProvisionCommit) => Promise<boolean>;
  acquireFileDeletion: (data: FileStorageDeleteClaim) => Promise<{ resumed: boolean } | null>;
  releaseFileDeletion: (data: FileStorageClaim & { retainDeletion: boolean }) => Promise<boolean>;
} {
  async function acquireFileProvision(data: FileStorageClaim): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      {
        ...claimFilter(data),
        'storageOperations.deletionPending': { $ne: true },
        'storageOperations.deleting': { $exists: false },
      },
      { $addToSet: { 'storageOperations.provisioning': data.token }, $unset: { expiresAt: '' } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  /** An already-applied release is successful; only the supplied token is removed. */
  async function releaseFileProvision(data: FileStorageClaim): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      claimFilter(data),
      { $pull: { 'storageOperations.provisioning': data.token } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  async function commitFileProvision(data: FileProvisionCommit): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    if (data.releaseOnly) {
      return (
        (await File.exists({
          ...claimFilter(data.claim),
          'storageOperations.provisioning': data.claim.token,
          'storageOperations.deletionPending': { $ne: true },
          'storageOperations.deleting': { $exists: false },
        })) != null
      );
    }
    const content = fileProvisionCommitUpdate(data);
    const result = await File.updateOne(
      fileProvisionCommitFilter(data) as FilterQuery<IMongoFile>,
      {
        ...content,
        $unset: { expiresAt: '' },
      },
    );
    return result.matchedCount === 1;
  }

  async function acquireFileDeletion(
    data: FileStorageDeleteClaim,
  ): Promise<{ resumed: boolean } | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const previous = await File.findOneAndUpdate(
      {
        ...claimFilter(data),
        updatedAt: data.updatedAt ?? { $exists: false },
        'storageOperations.deleting': { $exists: false },
        'storageOperations.provisioning.0': { $exists: false },
      },
      {
        $set: {
          'storageOperations.deleting': data.token,
          'storageOperations.deletionPending': true,
        },
        $unset: { expiresAt: '' },
      },
      { new: false, timestamps: false },
    )
      .select({ 'storageOperations.deletionPending': 1 })
      .lean();
    return previous == null
      ? null
      : { resumed: previous.storageOperations?.deletionPending === true };
  }

  async function releaseFileDeletion(
    data: FileStorageClaim & { retainDeletion: boolean },
  ): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      { ...claimFilter(data), 'storageOperations.deleting': data.token },
      {
        $unset: {
          'storageOperations.deleting': '',
          ...(!data.retainDeletion ? { 'storageOperations.deletionPending': '' } : {}),
        },
      },
      { timestamps: false },
    );
    if (result.matchedCount === 1) return true;
    // A lost release acknowledgement must not clear pending intent or a newer token.
    return (
      (await File.exists({
        ...claimFilter(data),
        'storageOperations.deleting': { $exists: false },
      })) != null
    );
  }

  return {
    acquireFileProvision,
    releaseFileProvision,
    commitFileProvision,
    acquireFileDeletion,
    releaseFileDeletion,
  };
}

export type FileStorageMethods = ReturnType<typeof createFileStorageMethods>;

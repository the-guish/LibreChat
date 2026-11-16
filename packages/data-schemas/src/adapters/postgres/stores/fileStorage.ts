/**
 * The PostgreSQL `FileStorageStore` (`~/ports/fileStorage`) on the `files` table, through the
 * collection primitive, with the claim filter and provisioning commit of
 * `~/methods/fileStorageRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Every claim write is one guarded single-record update (§3.5: it never lands on a record that no
 * longer matches); claims never expire. `storageOperations.provisioning` is a `text[]` column
 * (`$addToSet`/`$pull` in tier 1); the provisioning commit's `metadata` subpaths are tier 2.
 */
import type { FileStorageStore } from '~/ports/fileStorage';
import type { PostgresStoreContext } from './context';
import {
  fileStorageClaimFilter,
  fileProvisionCommitFilter,
  fileProvisionCommitUpdate,
} from '~/methods/fileStorageRules';

const claimFilter = fileStorageClaimFilter;

export function createPostgresFileStorageStore(context: PostgresStoreContext): FileStorageStore {
  const files = () => context.collections().collection('files');
  const store: FileStorageStore = {
    async acquireFileProvision(data) {
      const result = await files().updateOne(
        {
          ...claimFilter(data),
          'storageOperations.deletionPending': { $ne: true },
          'storageOperations.deleting': { $exists: false },
        },
        { $addToSet: { 'storageOperations.provisioning': data.token }, $unset: { expiresAt: '' } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },

    /** An already-applied release is successful; only the supplied token is removed. */
    async releaseFileProvision(data) {
      const result = await files().updateOne(
        claimFilter(data),
        { $pull: { 'storageOperations.provisioning': data.token } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },

    async commitFileProvision(data) {
      if (data.releaseOnly) {
        return (
          (await files().exists({
            ...claimFilter(data.claim),
            'storageOperations.provisioning': data.claim.token,
            'storageOperations.deletionPending': { $ne: true },
            'storageOperations.deleting': { $exists: false },
          })) != null
        );
      }
      const content = fileProvisionCommitUpdate(data);
      const result = await files().updateOne(fileProvisionCommitFilter(data), {
        ...content,
        $unset: { expiresAt: '' },
      });
      return result.matchedCount === 1;
    },

    async acquireFileDeletion(data) {
      const previous = await files().findOneAndUpdate(
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
        {
          returnDocument: 'before',
          timestamps: false,
          projection: { 'storageOperations.deletionPending': 1 },
        },
      );
      if (previous == null) {
        return null;
      }
      const operations = previous.storageOperations as { deletionPending?: boolean } | undefined;
      return { resumed: operations?.deletionPending === true };
    },

    async releaseFileDeletion(data) {
      const result = await files().updateOne(
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
      /** A lost release acknowledgement must not clear pending intent or a newer token. */
      return (
        (await files().exists({
          ...claimFilter(data),
          'storageOperations.deleting': { $exists: false },
        })) != null
      );
    },
  };
  return store;
}

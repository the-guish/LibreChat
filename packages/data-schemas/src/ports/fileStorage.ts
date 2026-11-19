/**
 * File storage store port: the claims that fence external storage work on a file record. A
 * provisioning claim holds a file while its bytes are written elsewhere; a deletion claim holds
 * it while they are removed; the two exclude each other. Claims never expire, since elapsed time
 * cannot fence an external operation. Nothing here may import `mongoose`. Signatures are copied
 * verbatim from `FileStorageMethods` (`~/methods/fileStorage`); `fileStorage.spec.ts` fails the
 * typecheck if the two drift.
 *
 * Every claim names the file, its owner and tenant, and a caller-chosen token; a malformed claim
 * throws. Writes leave the file's `updatedAt` as it was, except a committed provisioning result.
 */
import type { FileStorageClaim, FileProvisionCommit, FileStorageDeleteClaim } from '~/types/file';
import { listPortMethods } from './common';

export interface FileStorageStore {
  /**
   * Adds the token to the file's provisioning claims and clears its expiry, unless a deletion is
   * pending or running; resolves whether it did.
   */
  acquireFileProvision(data: FileStorageClaim): Promise<boolean>;
  /** Removes the token from the file's provisioning claims; resolves whether the file matched. */
  releaseFileProvision(data: FileStorageClaim): Promise<boolean>;
  /**
   * Stores the provisioning result (generated output, a code environment reference, embedding)
   * while the claim is still held and no deletion is pending, and clears the file's expiry; with
   * `releaseOnly`, only checks that the claim is still held. Resolves whether it did. Throws when
   * the output does not belong to the claim or there is nothing to store.
   */
  commitFileProvision(data: FileProvisionCommit): Promise<boolean>;
  /**
   * Takes the file's deletion claim and marks the deletion pending, while the file is unchanged
   * since `updatedAt` and no other claim is held. `null` when it could not; `resumed` when a
   * deletion was already pending.
   */
  acquireFileDeletion(data: FileStorageDeleteClaim): Promise<{ resumed: boolean } | null>;
  /**
   * Releases the token's deletion claim, keeping the deletion pending with `retainDeletion`.
   * Resolves `true` also when the claim was already released.
   */
  releaseFileDeletion(data: FileStorageClaim & { retainDeletion: boolean }): Promise<boolean>;
}

/** Every method of {@link FileStorageStore}, for adapters and conformance checks. */
export const FILE_STORAGE_STORE_METHODS: ReadonlyArray<keyof FileStorageStore> =
  listPortMethods<FileStorageStore>({
    acquireFileProvision: true,
    releaseFileProvision: true,
    commitFileProvision: true,
    acquireFileDeletion: true,
    releaseFileDeletion: true,
  });

/**
 * The file storage claims' database-neutral rules (`FileStorageStore`, `~/ports/fileStorage`),
 * shared by every backend: the MongoDB methods (`./fileStorage`) and the PostgreSQL store
 * (`adapters/postgres/stores/fileStorage.ts`). Filters and updates are in the store query
 * language. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type { FileStorageClaim, FileProvisionCommit } from '~/types/file';
import { fileContentUpdate } from './fileContent';

/**
 * The owner scope of a claim: the file, its user and its tenant (none: `null`). Throws unless the
 * claim names a file, a 24-hex user, a token and, when given, a nonempty tenant.
 */
export function fileStorageClaimFilter(data: FileStorageClaim): Record<string, unknown> {
  if (
    typeof data.file_id !== 'string' ||
    data.file_id.trim().length === 0 ||
    typeof data.userId !== 'string' ||
    !/^[a-f\d]{24}$/i.test(data.userId) ||
    typeof data.token !== 'string' ||
    data.token.trim().length === 0 ||
    (data.tenantId != null &&
      (typeof data.tenantId !== 'string' || data.tenantId.trim().length === 0))
  ) {
    throw new Error('A valid file storage owner scope and claim token are required');
  }
  return {
    file_id: data.file_id,
    user: data.userId,
    $and: [{ tenantId: data.tenantId ?? null }],
  };
}

/** The filter of a provisioning commit: the claim held, no deletion, and no newer source. */
export function fileProvisionCommitFilter(data: FileProvisionCommit): Record<string, unknown> {
  return {
    ...fileStorageClaimFilter(data.claim),
    'storageOperations.provisioning': data.claim.token,
    'storageOperations.deletionPending': { $ne: true },
    'storageOperations.deleting': { $exists: false },
    ...(data.output?.sourceDispatchedAt != null
      ? {
          $or: [
            { 'metadata.sourceDispatchedAt': { $exists: false } },
            { 'metadata.sourceDispatchedAt': { $lte: data.output.sourceDispatchedAt } },
          ],
        }
      : {}),
  };
}

/**
 * The content update of a provisioning commit (without the `expiresAt` unset): the generated
 * output's fields, the code environment reference, the embedded flag and the embedding owner.
 * Throws when the output does not match its claim, the route key is not one, or nothing is set.
 */
export function fileProvisionCommitUpdate(
  data: FileProvisionCommit,
): ReturnType<typeof fileContentUpdate> {
  const update: Record<string, unknown> = {};
  if (data.output) {
    const { file } = data.output;
    if (
      file.file_id !== data.claim.file_id ||
      file.user !== data.claim.userId ||
      (file.tenantId ?? null) !== (data.claim.tenantId ?? null)
    ) {
      throw new Error('Generated output does not match its storage claim');
    }
    Object.assign(update, file);
    delete update.file_id;
  }
  if (data.code) {
    const { routeKey, ref, legacyRef } = data.code;
    if (!routeKey || routeKey.includes('.') || routeKey.startsWith('$')) {
      throw new Error('Invalid code environment route key');
    }
    update[`metadata.codeEnvRefs.${routeKey}`] = ref;
    if (legacyRef) update['metadata.codeEnvRef'] = legacyRef;
  }
  if (data.embedded === true) update.embedded = true;
  if (Object.keys(update).length === 0) throw new Error('Missing provisioning result');
  const content = fileContentUpdate(update);
  if (data.entityId) {
    const owners = content.$addToSet?.['metadata.embeddedEntities']?.$each ?? [];
    content.$addToSet = { 'metadata.embeddedEntities': { $each: [...owners, data.entityId] } };
  }
  return content;
}

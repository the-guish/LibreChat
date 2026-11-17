/**
 * The skill sync store's domain rules, shared by the MongoDB methods (`./skillSync`) and the
 * PostgreSQL store (`adapters/postgres/stores/skillSync.ts`; docs/postgres-port/PHASE4.md §8,
 * S8): the credential's token hash and summary, the status write of a run (its counts, skip
 * lists, times and error), the tenant bucket of a status (an explicit tenant id, or none), and
 * the lock row, which shares the status collection under a reserved source id. Nothing here may
 * import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'crypto';
import type {
  ISkillSyncStatus,
  SkillSyncStatusInput,
  ISkillSyncCredential,
  SkillSyncCredentialSummary,
} from '~/types/skillSync';

/** The source id of the lock row: never a source, never listed among the statuses. */
export const SKILL_SYNC_LOCK_SOURCE_ID = '__global_lock__';

/** The SHA-256 hex of a credential's token (its fingerprint is the first 12 characters). */
export function hashSkillSyncToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The tenant bucket of a status: the tenant's, or the one without a tenant. */
export function skillSyncTenantCondition(tenantId?: string): Record<string, unknown> {
  return tenantId ? { tenantId } : { tenantId: { $exists: false } };
}

/** A credential as every read but the token read sees it: no token material. */
export function summarizeSkillSyncCredential(
  credential: Pick<
    ISkillSyncCredential,
    'provider' | 'credentialKey' | 'tokenHash' | 'createdAt' | 'updatedAt'
  >,
): SkillSyncCredentialSummary {
  return {
    provider: credential.provider,
    credentialKey: credential.credentialKey,
    credentialPresent: true,
    tokenFingerprint: credential.tokenHash.slice(0, 12),
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

/** The upsert that creates or replaces a credential, keeping who created it. */
export function skillSyncCredentialUpdate(
  input: { provider: string; credentialKey: string; userId?: unknown },
  encryptedToken: string,
  tokenHash: string,
): Record<string, unknown> {
  return {
    $set: {
      encryptedToken,
      tokenHash,
      updatedBy: input.userId,
    },
    $setOnInsert: {
      provider: input.provider,
      credentialKey: input.credentialKey,
      createdBy: input.userId,
    },
  };
}

/**
 * The upsert that records a run's outcome on its source's status: a `succeeded` or `partial`
 * run sets `lastSuccessAt` (a partial run published skills; the dropped ones are in its skip
 * lists), a `failed` one `lastFailureAt` and the error, any other run clears the error; counts
 * and skip lists left out are recorded as zero and empty.
 */
export function skillSyncStatusWrite(
  input: SkillSyncStatusInput,
  now: Date,
): { filter: Record<string, unknown>; update: Record<string, unknown> } {
  const success = input.status === 'succeeded' || input.status === 'partial';
  const failure = input.status === 'failed';
  const setPayload: Partial<ISkillSyncStatus> = {
    status: input.status,
    credentialKey: input.credentialKey,
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    paths: input.paths,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    syncedSkillCount: input.syncedSkillCount ?? 0,
    syncedFileCount: input.syncedFileCount ?? 0,
    deletedSkillCount: input.deletedSkillCount ?? 0,
    deletedFileCount: input.deletedFileCount ?? 0,
    skippedSkillCount: input.skippedSkillCount ?? 0,
    skippedSkills: input.skippedSkills ?? [],
    skippedFileCount: input.skippedFileCount ?? 0,
    skippedFiles: input.skippedFiles ?? [],
    ...(success ? { lastSuccessAt: input.finishedAt ?? now } : {}),
    ...(failure ? { lastFailureAt: input.finishedAt ?? now } : {}),
  };
  if (failure) {
    setPayload.errorCode = input.errorCode;
    setPayload.errorMessage = input.errorMessage;
  }
  const unsetPayload = failure ? {} : { errorCode: '', errorMessage: '' };
  return {
    filter: {
      provider: input.provider,
      sourceId: input.sourceId,
      ...skillSyncTenantCondition(input.tenantId),
    },
    update: {
      $set: setPayload,
      ...(failure ? {} : { $unset: unsetPayload }),
      $setOnInsert: {
        provider: input.provider,
        sourceId: input.sourceId,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      },
    },
  };
}

/** The lock row of the provider and tenant (or no tenant). */
export function skillSyncLockFilter(params: {
  provider: string;
  tenantId?: string;
}): Record<string, unknown> {
  return {
    provider: params.provider,
    sourceId: SKILL_SYNC_LOCK_SOURCE_ID,
    ...skillSyncTenantCondition(params.tenantId),
  };
}

/** The fields that identify a lock row, for the insert or upsert that creates it. */
export function skillSyncLockIdentity(params: {
  provider: string;
  tenantId?: string;
}): Record<string, unknown> {
  return {
    provider: params.provider,
    sourceId: SKILL_SYNC_LOCK_SOURCE_ID,
    ...(params.tenantId ? { tenantId: params.tenantId } : {}),
  };
}

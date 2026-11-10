/**
 * Skill sync store port: what mirroring skills from an external provider (GitHub) keeps
 * between runs — the provider credentials admins register, the status of each synced source, and
 * the lease-based lock that lets one worker per provider and tenant run a sync at a time. Nothing
 * here may import `mongoose`. Signatures are those of `SkillSyncMethods` (`~/methods/skillSync`)
 * with the writing admin's user id stated as `IdLike`; `skillSync.spec.ts` fails the typecheck
 * if the MongoDB methods stop satisfying them.
 *
 * A credential is unique per provider by its key. Its token is stored encrypted and only
 * `getSkillSyncCredentialToken` hands it back, decrypted; every other read sees a
 * {@link SkillSyncCredentialSummary} with a fingerprint of the token. A source's status is
 * unique per provider, source id and tenant (or no tenant). The lock is not a source: it never
 * appears among the statuses.
 */
import type {
  ISkillSyncStatus,
  SkillSyncProvider,
  SkillSyncLockInput,
  SkillSyncStatusInput,
  SkillSyncReleaseLockInput,
  SkillSyncCredentialSummary,
  UpsertSkillSyncCredentialInput,
} from '~/types';
import type { WithIdLike } from './common';
import { listPortMethods } from './common';

export interface SkillSyncStore {
  /** Creates or replaces the provider's credential `credentialKey` with the token. */
  upsertSkillSyncCredential(
    input: WithIdLike<UpsertSkillSyncCredentialInput, 'userId'>,
  ): Promise<SkillSyncCredentialSummary>;
  /** Deletes the provider's credential; `deleted` is whether there was one. */
  deleteSkillSyncCredential(
    provider: SkillSyncProvider,
    credentialKey: string,
  ): Promise<{ deleted: boolean }>;
  /** The provider's credentials, by credential key. */
  listSkillSyncCredentials(provider: SkillSyncProvider): Promise<SkillSyncCredentialSummary[]>;
  /** The decrypted token of the provider's credential, or `null` when there is none. */
  getSkillSyncCredentialToken(
    provider: SkillSyncProvider,
    credentialKey: string,
  ): Promise<string | null>;
  /** The provider's credential `credentialKey`, or `null` when there is none. */
  getSkillSyncCredentialSummary(
    provider: SkillSyncProvider,
    credentialKey: string,
  ): Promise<SkillSyncCredentialSummary | null>;
  /** The status of each of the provider's sources, by source id. */
  listSkillSyncStatuses(provider: SkillSyncProvider): Promise<ISkillSyncStatus[]>;
  /**
   * Records a run's outcome on the source's status, creating it, and resolves to the status. A
   * `succeeded` or `partial` run sets `lastSuccessAt`, a `failed` one `lastFailureAt` and the
   * error; any other run clears the error. Counts left out are recorded as zero.
   */
  upsertSkillSyncStatus(input: SkillSyncStatusInput): Promise<ISkillSyncStatus>;
  /**
   * Claims the provider's sync lock for the tenant for `leaseMs`; `false` when another owner
   * holds a live lease (or wins a concurrent claim).
   */
  tryAcquireSkillSyncLock(params: SkillSyncLockInput): Promise<boolean>;
  /** Renews the live lease `lockOwner` holds to end `leaseMs` from now; `false` when it lost it. */
  refreshSkillSyncLock(params: SkillSyncLockInput): Promise<boolean>;
  /** Gives up the lock if `lockOwner` holds it. */
  releaseSkillSyncLock(params: SkillSyncReleaseLockInput): Promise<void>;
}

/** Every method of {@link SkillSyncStore}, for adapters and conformance checks. */
export const SKILL_SYNC_STORE_METHODS: ReadonlyArray<keyof SkillSyncStore> =
  listPortMethods<SkillSyncStore>({
    upsertSkillSyncCredential: true,
    deleteSkillSyncCredential: true,
    listSkillSyncCredentials: true,
    getSkillSyncCredentialToken: true,
    getSkillSyncCredentialSummary: true,
    listSkillSyncStatuses: true,
    upsertSkillSyncStatus: true,
    tryAcquireSkillSyncLock: true,
    refreshSkillSyncLock: true,
    releaseSkillSyncLock: true,
  });

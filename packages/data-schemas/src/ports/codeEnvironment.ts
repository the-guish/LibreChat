/**
 * Code environment store port: the registry of the code execution environments (managed or
 * attached workers behind a code bridge) users register and select for their agents, with the
 * leases that fence their registration and removal. Nothing here may import `mongoose`.
 * Signatures are those of `CodeEnvironmentMethods` (`~/methods/codeEnvironment`) with record
 * ids stated as `IdLike`; `codeEnvironment.spec.ts` fails the typecheck if the MongoDB methods
 * stop satisfying them.
 *
 * Lifecycle: an environment is created pending registration, and only a completed
 * registration makes it live. Removal is two-phase: `beginCodeEnvironmentRemoval` claims a
 * lease (refused while an agent write holds a live reference to the environment), then the
 * lease is either cancelled or committed. A deleted environment id is retired for good: it can
 * never be registered again in its tenant.
 *
 * Browser setup: a setup binding (the attempt id, request hash, owner and the environment's
 * fields) reserves an environment idempotently. Replaying the same binding resolves the same
 * reservation; a binding that collides with another environment or a retired one throws.
 *
 * Reconciliation: the lifecycle reconciler (in `@librechat/api`) runs on the steps in the last
 * section: the sweep of expired agent reference reservations (its progress is the store's),
 * interrupted removals, stale registrations, committed removals, environments whose creator is
 * gone, and the leased, retried worker revocations. An account deletion marks, commits and
 * records its user's worker revocations through the last three methods.
 *
 * Known leaks kept for now so callers stay unchanged: `CodeEnvironmentDocument` extends
 * mongoose's `Document` (its `_id` and `createdBy` are ObjectIds), and the create input's
 * `createdBy` is an ObjectId (the MongoDB adapter derives an owner slot's id from it).
 */
import type { CodeEnvironmentUserSettings } from 'librechat-data-provider';
import type {
  CodeEnvironmentSetupRecord,
  CodeEnvironmentSetupBinding,
} from '~/types/codeEnvironmentSetup';
import type {
  CodeEnvironmentDocument,
  CreateCodeEnvironmentInput,
  OrphanedCodeEnvironment,
} from '~/types';
import type { IdLike } from './common';
import { listPortMethods } from './common';

export interface CodeEnvironmentStore {
  /** Makes sure the setup indexes exist; a failed build is retried on the next call. */
  ensureSetupEnvironmentIndexes(): Promise<void>;
  /**
   * Reserves the environment the setup binding describes, pending registration, or resolves the
   * reservation an earlier call with the same binding made. With `maxOwned`, `null` when the
   * owner already has that many environments.
   */
  reserveSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
    maxOwned?: number,
  ): Promise<CodeEnvironmentSetupRecord | null>;
  /** The live reservation of the setup binding, or `null` when it has none. */
  findSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
  ): Promise<CodeEnvironmentSetupRecord | null>;
  /** Completes the registration of the binding's reservation `resourceId`. */
  completeSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
    resourceId: string,
  ): Promise<CodeEnvironmentSetupRecord>;
  /**
   * Marks the binding's reservation discarded and retires its ids, so no later replay can
   * reserve it; resolves to the reservation, or `null` when none was made.
   */
  beginDiscardSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
  ): Promise<CodeEnvironmentSetupRecord | null>;
  /** Deletes the discarded reservation `resourceId` of the binding. */
  finishDiscardSetupEnvironment(
    binding: CodeEnvironmentSetupBinding,
    resourceId: string,
  ): Promise<void>;
  /** Creates the environment pending registration; throws for a retired environment id. */
  createCodeEnvironment(input: CreateCodeEnvironmentInput): Promise<CodeEnvironmentDocument>;
  /**
   * As {@link createCodeEnvironment}, in one of the creator's `maxOwned` owner slots; `null`
   * when every slot is taken.
   */
  createCodeEnvironmentWithinOwnerLimit(
    input: CreateCodeEnvironmentInput,
    maxOwned: number,
  ): Promise<CodeEnvironmentDocument | null>;
  /** The environments with the ids, oldest first. */
  findCodeEnvironmentsByIds(ids: IdLike[]): Promise<CodeEnvironmentDocument[]>;
  /** The environment with the environment id, or `null`. */
  findCodeEnvironmentByEnvironmentId(
    environmentId: string,
  ): Promise<CodeEnvironmentDocument | null>;
  /**
   * Sets the given permission settings on the live environment and resolves to it, or `null`
   * when it is pending registration, being removed or absent.
   */
  updateCodeEnvironmentSettings(
    environmentId: string,
    settings: CodeEnvironmentUserSettings,
  ): Promise<CodeEnvironmentDocument | null>;
  /** The environment id of every stored environment, each once. */
  listCodeEnvironmentIds(): Promise<string[]>;
  /** The environments the user created, oldest first. */
  findCodeEnvironmentsByCreator(userId: IdLike): Promise<CodeEnvironmentDocument[]>;
  /** Retires the environment's ids and deletes it; resolves to it, or `null` when absent. */
  deleteCodeEnvironmentById(id: IdLike): Promise<CodeEnvironmentDocument | null>;
  /** Deletes an environment whose registration failed (never a setup reservation). */
  discardCodeEnvironmentById(id: IdLike): Promise<void>;
  /**
   * Makes the pending environment live; throws when it is not pending registration or is a
   * setup reservation.
   */
  completeCodeEnvironmentRegistration(id: IdLike): Promise<void>;
  /**
   * Claims the removal lease of the environment (its `deletionLeaseId`), or `null` when it is
   * committed for removal, leased by another removal, or referenced by an in-flight agent write.
   */
  beginCodeEnvironmentRemoval(id: IdLike): Promise<CodeEnvironmentDocument | null>;
  /** Gives up the removal lease; the environment stays live. */
  cancelCodeEnvironmentRemoval(id: IdLike, leaseId: string): Promise<void>;
  /** Commits the removal under the lease; throws when the lease was lost. */
  commitCodeEnvironmentRemoval(id: IdLike, leaseId: string): Promise<void>;
  /**
   * Deletes the environments the user created (and every permission on them) that no agent
   * selects and whose worker needs no revocation retry; resolves how many it deleted.
   */
  deleteUserCodeEnvironments(userId: IdLike): Promise<number>;
  /** Whether an agent in the tenant (none: outside every tenant) selects the environment. */
  isCodeEnvironmentReferencedByAgent(environmentId: string, tenantId?: string): Promise<boolean>;
  /**
   * Marks the environment's worker for revocation (counting the attempt, clearing the last error
   * and retry time); `false` when no environment with the id is left to remove.
   */
  requestCodeEnvironmentRevocation(environmentId: string): Promise<boolean>;

  /* --------------------------------------------------------- reconciliation */

  /**
   * One step of the sweep of expired agent reference reservations: the next `limit`
   * environments, up to the bound captured when the sweep began, lose the reservations that
   * expired by `now`. The progress is durable and never rewound by a competing sweep. `false`
   * when the reconciliation must stop here: the store holds no code environments or permissions,
   * or a competing sweep captured the bound first.
   */
  sweepExpiredCodeEnvironmentReferences(now: Date, limit: number): Promise<boolean>;
  /** Up to `limit` environments, by id, whose uncommitted removal lease expired by `now`. */
  findExpiredCodeEnvironmentRemovals(
    now: Date,
    limit: number,
  ): Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>>;
  /**
   * Up to `limit` environments (never setup reservations) pending registration since
   * `staleBefore`, due at `now` and not leased, the earliest due first.
   */
  findStaleCodeEnvironmentRegistrations(
    staleBefore: Date,
    now: Date,
    limit: number,
  ): Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>>;
  /**
   * Leases the stale registration for `leaseMs` under `leaseId` while it is still stale, due and
   * unleased; resolves to it, or `null`.
   */
  claimStaleCodeEnvironmentRegistration(
    id: IdLike,
    staleBefore: Date,
    leaseId: string,
    leaseMs: number,
  ): Promise<CodeEnvironmentDocument | null>;
  /** Releases the registration lease `leaseId` and retries the registration after `reconcileAfter`. */
  deferCodeEnvironmentRegistration(
    id: IdLike,
    leaseId: string,
    reconcileAfter: Date,
  ): Promise<void>;
  /** Deletes the stale registration while it is still leased under `leaseId`. */
  deleteStaleCodeEnvironmentRegistration(id: IdLike, leaseId: string): Promise<void>;
  /** Up to `limit` environments whose removal was committed. */
  findCommittedCodeEnvironmentDeletions(limit: number): Promise<CodeEnvironmentDocument[]>;
  /**
   * Up to `limit` environments, by id, whose creator no longer exists, neither marked for
   * revocation nor committed for removal.
   */
  findOrphanedCodeEnvironments(limit: number): Promise<OrphanedCodeEnvironment[]>;
  /**
   * Marks the environments' workers for revocation at `now` (counting the attempt, clearing the
   * last error and retry time).
   */
  requestOrphanedCodeEnvironmentRevocations(ids: IdLike[], now: Date): Promise<void>;
  /**
   * Up to `limit` environments whose worker revocation is due at `now` and not leased, the
   * earliest due first.
   */
  findCodeEnvironmentRevocationCandidates(
    now: Date,
    limit: number,
  ): Promise<Array<Pick<CodeEnvironmentDocument, '_id'>>>;
  /**
   * Leases the due revocation for `leaseMs` under `leaseId`, counting the attempt; resolves to
   * the environment, or `null` when it is no longer due or is leased.
   */
  claimCodeEnvironmentRevocation(
    id: IdLike,
    leaseId: string,
    leaseMs: number,
  ): Promise<CodeEnvironmentDocument | null>;
  /**
   * Records the failed revocation's `error`, releases the lease `leaseId` and retries it after
   * `reconcileAfter`.
   */
  deferCodeEnvironmentRevocation(
    id: IdLike,
    leaseId: string,
    error: string,
    reconcileAfter: Date,
  ): Promise<void>;
  /**
   * Marks the environments' workers for revocation now, at an account deletion (counting the
   * attempt, clearing the last error).
   */
  beginCodeEnvironmentWorkerRevocations(ids: IdLike[]): Promise<void>;
  /** Commits the removal of the environment whose worker was revoked, clearing its revocation. */
  commitCodeEnvironmentWorkerRevocation(id: IdLike): Promise<void>;
  /** Records why the environment's worker revocation failed. */
  recordCodeEnvironmentWorkerRevocationError(id: IdLike, error: string): Promise<void>;
}

/** Every method of {@link CodeEnvironmentStore}, for adapters and conformance checks. */
export const CODE_ENVIRONMENT_STORE_METHODS: ReadonlyArray<keyof CodeEnvironmentStore> =
  listPortMethods<CodeEnvironmentStore>({
    ensureSetupEnvironmentIndexes: true,
    reserveSetupEnvironment: true,
    findSetupEnvironment: true,
    completeSetupEnvironment: true,
    beginDiscardSetupEnvironment: true,
    finishDiscardSetupEnvironment: true,
    createCodeEnvironment: true,
    createCodeEnvironmentWithinOwnerLimit: true,
    findCodeEnvironmentsByIds: true,
    findCodeEnvironmentByEnvironmentId: true,
    updateCodeEnvironmentSettings: true,
    listCodeEnvironmentIds: true,
    findCodeEnvironmentsByCreator: true,
    deleteCodeEnvironmentById: true,
    discardCodeEnvironmentById: true,
    completeCodeEnvironmentRegistration: true,
    beginCodeEnvironmentRemoval: true,
    cancelCodeEnvironmentRemoval: true,
    commitCodeEnvironmentRemoval: true,
    deleteUserCodeEnvironments: true,
    isCodeEnvironmentReferencedByAgent: true,
    requestCodeEnvironmentRevocation: true,
    sweepExpiredCodeEnvironmentReferences: true,
    findExpiredCodeEnvironmentRemovals: true,
    findStaleCodeEnvironmentRegistrations: true,
    claimStaleCodeEnvironmentRegistration: true,
    deferCodeEnvironmentRegistration: true,
    deleteStaleCodeEnvironmentRegistration: true,
    findCommittedCodeEnvironmentDeletions: true,
    findOrphanedCodeEnvironments: true,
    requestOrphanedCodeEnvironmentRevocations: true,
    findCodeEnvironmentRevocationCandidates: true,
    claimCodeEnvironmentRevocation: true,
    deferCodeEnvironmentRevocation: true,
    beginCodeEnvironmentWorkerRevocations: true,
    commitCodeEnvironmentWorkerRevocation: true,
    recordCodeEnvironmentWorkerRevocationError: true,
  });

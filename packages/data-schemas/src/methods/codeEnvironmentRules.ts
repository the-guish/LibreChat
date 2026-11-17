/**
 * The code environment store's database-neutral rules (`CodeEnvironmentStore`,
 * `~/ports/codeEnvironment`), shared by every backend: the MongoDB methods (`./codeEnvironment`)
 * and the PostgreSQL store (`adapters/postgres/stores/codeEnvironment.ts`). They are the retired
 * ids (`code_environment_tombstones`: their record ids and the writes that retire an environment
 * or fence a setup binding), the owner slots, the setup binding's identity, filters and record,
 * the lifecycle filters and updates of the removal, registration and revocation leases, the
 * sweep's durable progress record, and the agent reference reservations an agent write holds
 * (`withCodeEnvironmentReferences`, written once on the steps of
 * {@link CodeEnvironmentReferenceSteps}). Filters and updates are in the store query language.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'crypto';
import { MAX_AGENT_CODE_ENVIRONMENT_CHOICES } from 'librechat-data-provider';
import type { CodeEnvironmentUserSettings } from 'librechat-data-provider';
import type {
  CodeEnvironmentSetupBinding,
  CodeEnvironmentSetupRecord,
} from '~/types/codeEnvironmentSetup';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import logger from '~/config/winston';

/** A filter or update in the store query language. */
export type CodeEnvironmentQuery = Record<string, unknown>;

export const CODE_ENVIRONMENT_TOMBSTONES = 'code_environment_tombstones';
export const CODE_ENVIRONMENT_RECONCILIATION = 'code_environment_reconciliation';
export const AGENT_REFERENCE_CLEANUP_CHECKPOINT = 'agent-reference-cleanup';
export const REFERENCE_LEASE_MS: number = 2 * 60_000;
export const REFERENCE_RENEW_INTERVAL_MS: number = REFERENCE_LEASE_MS / 3;
export const REMOVAL_LEASE_MS: number = 2 * 60_000;

/** The progress of the agent reference sweep, kept across leader changes. */
export type CodeEnvironmentReconciliationCheckpoint<Id> = {
  _id: string;
  lastId: Id | null;
  upperId?: Id | null;
};

/** A retired environment id or setup attempt (`code_environment_tombstones`). */
export type CodeEnvironmentTombstone = {
  _id: string;
  tenantId: string;
  environmentId: string;
  deletedAt: Date;
  setupBinding?: string;
  setupResourceId?: string;
};

/** The fields of a stored environment the rules read (ids in the backend's form). */
export interface CodeEnvironmentRow {
  _id: { toString(): string };
  environmentId: string;
  name: string;
  type: CodeEnvironmentSetupBinding['type'];
  baseURL: string;
  controlPlaneId: string;
  createdBy: { toString(): string };
  tenantId?: string;
  setupAttemptId?: string;
  setupRequestHash?: string;
  workerId?: string;
  revocationTokenEnv?: string;
  workerPrincipal?: CodeEnvironmentSetupBinding['workerPrincipal'];
  registrationPendingAt?: Date;
}

/** The tenant a retirement is recorded in: the given or active one, `''` outside every tenant. */
export function codeEnvironmentTenantScope(tenantId?: string): string {
  const resolved = tenantId ?? getTenantId();
  return resolved == null || resolved === SYSTEM_TENANT_ID ? '' : resolved;
}

/** The tenant condition of a tenant-scoped lookup: the active tenant, or none. */
export function codeEnvironmentTenantFilter(): CodeEnvironmentQuery['tenantId'] {
  return codeEnvironmentTenantScope() === '' ? { $exists: false } : codeEnvironmentTenantScope();
}

/** The tombstone id retiring `environmentId` in the tenant. */
export function codeEnvironmentTombstoneId(environmentId: string, tenantId?: string): string {
  return createHash('sha256')
    .update(
      `librechat-code-environment-tombstone\0${codeEnvironmentTenantScope(tenantId)}\0${environmentId}`,
    )
    .digest('hex');
}

/** The tombstone id retiring the setup attempt in the tenant. */
export function codeEnvironmentSetupTombstoneId(attemptId: string, tenantId?: string): string {
  return createHash('sha256')
    .update(
      `librechat-code-environment-setup-tombstone\0${codeEnvironmentTenantScope(tenantId)}\0${attemptId}`,
    )
    .digest('hex');
}

/** The 24-hex id of the owner's slot `slot` (the owner's id given as its hex string). */
export function codeEnvironmentOwnerSlotHex(ownerHex: string, slot: number): string {
  return createHash('sha256')
    .update(`librechat-code-environment-slot\0${ownerHex}\0${slot}`)
    .digest('hex')
    .slice(0, 24);
}

/** The slots the owner's environments hold: their valid slots, legacy ones taking the lowest. */
export function reservedCodeEnvironmentOwnerSlots(
  existing: ReadonlyArray<{ ownerSlot?: unknown }>,
  maxOwned: number,
): Set<number> {
  const reserved = new Set(
    existing
      .map(({ ownerSlot }) => ownerSlot)
      .filter(
        (slot): slot is number =>
          typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 && slot < maxOwned,
      ),
  );
  for (let ownerSlot = 0; reserved.size < existing.length && ownerSlot < maxOwned; ownerSlot++) {
    reserved.add(ownerSlot);
  }
  return reserved;
}

/** The agents selecting the environment, in the tenant (none: outside every tenant). */
export function agentCodeEnvironmentReferenceFilter(
  environmentId: string,
  tenantId?: string,
): CodeEnvironmentQuery {
  return {
    $or: [{ code_environment_id: environmentId }, { code_environment_ids: environmentId }],
    ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
  };
}

/* ------------------------------------------------------------------ setup bindings */

/** The setup binding's identity, as a tombstone records it. */
export function codeEnvironmentSetupIdentity(
  binding: CodeEnvironmentSetupBinding,
  tenantId: string = codeEnvironmentTenantScope(),
): string {
  return JSON.stringify([
    tenantId,
    binding.setupAttemptId,
    binding.requestHash,
    binding.ownerId,
    binding.environmentId,
    binding.name,
    binding.type,
    binding.baseURL,
    binding.controlPlaneId,
    binding.workerId ?? null,
    binding.revocationTokenEnv ?? null,
    binding.workerPrincipal?.type ?? null,
    binding.workerPrincipal?.id ?? null,
  ]);
}

/** The identity of the binding a stored setup reservation was made for, if it is one. */
export function codeEnvironmentRowSetupBinding(
  environment: CodeEnvironmentRow,
): string | undefined {
  if (environment.setupAttemptId == null || environment.setupRequestHash == null) return undefined;
  return codeEnvironmentSetupIdentity(
    {
      setupAttemptId: environment.setupAttemptId,
      requestHash: environment.setupRequestHash,
      ownerId: environment.createdBy.toString(),
      environmentId: environment.environmentId,
      name: environment.name,
      type: environment.type,
      baseURL: environment.baseURL,
      controlPlaneId: environment.controlPlaneId,
      workerId: environment.workerId,
      revocationTokenEnv: environment.revocationTokenEnv,
      workerPrincipal: environment.workerPrincipal,
    },
    codeEnvironmentTenantScope(environment.tenantId),
  );
}

/** The environment as a setup record. */
export function codeEnvironmentSetupRecord(
  environment: CodeEnvironmentRow,
): CodeEnvironmentSetupRecord {
  return {
    resourceId: environment._id.toString(),
    id: environment.environmentId,
    name: environment.name,
    type: environment.type,
    pending: environment.registrationPendingAt != null,
  };
}

/** The environments the binding describes, in the active tenant (`ownerId` cast by the caller). */
export function codeEnvironmentSetupFilter(
  binding: CodeEnvironmentSetupBinding,
  ownerId: unknown,
): CodeEnvironmentQuery {
  return {
    environmentId: binding.environmentId,
    tenantId: codeEnvironmentTenantFilter(),
    setupAttemptId: binding.setupAttemptId,
    setupRequestHash: binding.requestHash,
    createdBy: ownerId,
    name: binding.name,
    type: binding.type,
    baseURL: binding.baseURL,
    controlPlaneId: binding.controlPlaneId,
    workerId: binding.workerId ?? { $exists: false },
    revocationTokenEnv: binding.revocationTokenEnv ?? { $exists: false },
    ...(binding.workerPrincipal == null
      ? { workerPrincipal: { $exists: false } }
      : {
          'workerPrincipal.type': binding.workerPrincipal.type,
          'workerPrincipal.id': binding.workerPrincipal.id,
        }),
  };
}

/** {@link codeEnvironmentSetupFilter} narrowed to a live (neither discarded nor removed) one. */
export function codeEnvironmentSetupLiveFilter(
  binding: CodeEnvironmentSetupBinding,
  ownerId: unknown,
): CodeEnvironmentQuery {
  return {
    ...codeEnvironmentSetupFilter(binding, ownerId),
    setupDiscardedAt: { $exists: false },
    deletionStartedAt: { $exists: false },
    deletionCommittedAt: { $exists: false },
    revocationPendingAt: { $exists: false },
  };
}

/** The ids of the tombstones that retire the binding (its environment id and attempt). */
export function codeEnvironmentRetiredSetupIds(binding: CodeEnvironmentSetupBinding): string[] {
  return [
    codeEnvironmentTombstoneId(binding.environmentId),
    codeEnvironmentSetupTombstoneId(binding.setupAttemptId),
  ];
}

/** The environments that collide with the binding in the active tenant (by id or attempt). */
export function codeEnvironmentSetupCollisionFilter(
  binding: CodeEnvironmentSetupBinding,
): CodeEnvironmentQuery {
  return {
    tenantId: codeEnvironmentTenantFilter(),
    $or: [{ environmentId: binding.environmentId }, { setupAttemptId: binding.setupAttemptId }],
  };
}

/** A tombstone upsert: its filter and update. */
export interface CodeEnvironmentTombstoneWrite {
  filter: CodeEnvironmentQuery & { _id: string };
  update: CodeEnvironmentQuery;
}

/**
 * The tombstone upserts retiring a stored environment: its environment id and, for a setup
 * reservation, its attempt (with the binding and resource id, where no other binding holds it).
 */
export function codeEnvironmentRetirementWrites(
  environment: CodeEnvironmentRow,
): CodeEnvironmentTombstoneWrite[] {
  const setupBinding = codeEnvironmentRowSetupBinding(environment);
  const metadata =
    setupBinding == null ? {} : { setupBinding, setupResourceId: environment._id.toString() };
  const ids = [codeEnvironmentTombstoneId(environment.environmentId, environment.tenantId)];
  if (setupBinding != null)
    ids.push(codeEnvironmentSetupTombstoneId(environment.setupAttemptId!, environment.tenantId));
  return ids.map((_id) => ({
    filter: {
      _id,
      ...(setupBinding == null
        ? {}
        : { $or: [{ setupBinding: { $exists: false } }, { setupBinding }] }),
    },
    update: {
      $setOnInsert: {
        tenantId: codeEnvironmentTenantScope(environment.tenantId),
        environmentId: environment.environmentId,
        deletedAt: new Date(),
      },
      ...(setupBinding == null ? {} : { $set: metadata }),
    },
  }));
}

/** The tombstone upserts fencing a binding that was never reserved. */
export function codeEnvironmentSetupFenceWrites(
  binding: CodeEnvironmentSetupBinding,
): CodeEnvironmentTombstoneWrite[] {
  return codeEnvironmentRetiredSetupIds(binding).map((_id) => ({
    filter: { _id },
    update: {
      $setOnInsert: {
        tenantId: codeEnvironmentTenantScope(),
        environmentId: binding.environmentId,
        deletedAt: new Date(),
        setupBinding: codeEnvironmentSetupIdentity(binding),
      },
    },
  }));
}

/** The discarded reservation a replayed discard resolves, from the binding's tombstone. */
export function codeEnvironmentDiscardedSetupRecord(
  binding: CodeEnvironmentSetupBinding,
  retired: Pick<CodeEnvironmentTombstone, 'setupResourceId'> | null,
): CodeEnvironmentSetupRecord | null {
  return retired?.setupResourceId == null
    ? null
    : {
        resourceId: retired.setupResourceId,
        id: binding.environmentId,
        name: binding.name,
        type: binding.type,
        pending: true,
      };
}

/* ------------------------------------------------------------------ lifecycle */

/** The settings paths a settings write sets (none for empty settings). */
export function codeEnvironmentSettingsUpdates(
  settings: CodeEnvironmentUserSettings,
): Record<string, string> {
  const updates: Record<string, string> = {};
  if (settings.permissions?.fileWrite != null) {
    updates['settings.permissions.fileWrite'] = settings.permissions.fileWrite;
  }
  if (settings.permissions?.commandExecution != null) {
    updates['settings.permissions.commandExecution'] = settings.permissions.commandExecution;
  }
  return updates;
}

/** A live environment (registered, not being removed) with the environment id. */
export function liveCodeEnvironmentFilter(environmentId: string): CodeEnvironmentQuery {
  return {
    environmentId,
    registrationPendingAt: { $exists: false },
    deletionStartedAt: { $exists: false },
    deletionCommittedAt: { $exists: false },
  };
}

/**
 * The removal claim of `beginCodeEnvironmentRemoval` at `now` (`_id` added by the caller): an
 * uncommitted environment, unleased or with an expired lease, held by no live agent reference.
 */
export function codeEnvironmentRemovalClaimFilter(now: Date): CodeEnvironmentQuery {
  return {
    deletionCommittedAt: { $exists: false },
    $and: [
      {
        $or: [{ deletionStartedAt: { $exists: false } }, { deletionLeaseExpiresAt: { $lte: now } }],
      },
      {
        $or: [
          { pendingAgentReferences: { $exists: false } },
          { pendingAgentReferences: { $size: 0 } },
          {
            pendingAgentReferences: {
              $not: { $elemMatch: { expiresAt: { $gt: now } } },
            },
          },
        ],
      },
    ],
  };
}

/** The removal claim's update: the lease, and the expired agent references pulled. */
export function codeEnvironmentRemovalClaimUpdate(
  now: Date,
  leaseId: string,
): CodeEnvironmentQuery {
  return {
    $set: {
      deletionStartedAt: now,
      deletionLeaseId: leaseId,
      deletionLeaseExpiresAt: new Date(now.getTime() + REMOVAL_LEASE_MS),
    },
    $pull: { pendingAgentReferences: { expiresAt: { $lte: now } } },
  };
}

/** A registration (not a setup reservation's) left pending since `staleBefore`, due and unleased. */
export function staleCodeEnvironmentRegistrationFilter(
  staleBefore: Date,
  now: Date,
): CodeEnvironmentQuery {
  return {
    registrationPendingAt: { $lte: staleBefore },
    $and: [
      {
        $or: [
          { registrationReconcileAfter: { $exists: false } },
          { registrationReconcileAfter: { $lte: now } },
        ],
      },
      {
        $or: [
          { registrationLeaseExpiresAt: { $exists: false } },
          { registrationLeaseExpiresAt: { $lte: now } },
        ],
      },
    ],
  };
}

/** A worker revocation due at `now` and not leased. */
export function dueCodeEnvironmentRevocationFilter(now: Date): CodeEnvironmentQuery {
  return {
    revocationPendingAt: { $exists: true },
    $and: [
      {
        $or: [
          { revocationReconcileAfter: { $exists: false } },
          { revocationReconcileAfter: { $lte: now } },
        ],
      },
      {
        $or: [
          { revocationLeaseExpiresAt: { $exists: false } },
          { revocationLeaseExpiresAt: { $lte: now } },
        ],
      },
    ],
  };
}

/** The update marking a worker for revocation at `now` (a reconciler or registry request). */
export function codeEnvironmentRevocationRequest(now: Date): CodeEnvironmentQuery {
  return {
    $set: { revocationPendingAt: now },
    $inc: { revocationAttempts: 1 },
    $unset: { revocationLastError: 1, revocationReconcileAfter: 1 },
  };
}

/* ------------------------------------------------------------------ agent references */

/** A live reference an agent write holds on an environment (`pendingAgentReferences`). */
export type CodeEnvironmentReferenceReservation = {
  environmentId: string;
  reservationId: string;
};

export class CodeEnvironmentReferenceError extends Error {
  readonly statusCode = 409;
  constructor(environmentId: string) {
    super(`Code environment is being removed: ${environmentId}`);
    this.name = 'CodeEnvironmentReferenceError';
  }
}

/** The environment a reservation may be taken on: live and not being removed. */
export function codeEnvironmentReservableFilter(environmentId: string): CodeEnvironmentQuery {
  return {
    environmentId,
    registrationPendingAt: { $exists: false },
    deletionCommittedAt: { $exists: false },
    deletionStartedAt: { $exists: false },
  };
}

/** The storage steps of the reservations an agent write holds. */
export interface CodeEnvironmentReferenceSteps {
  /**
   * Reserves a reference on the environment, `undefined` when the registry does not hold it
   * (deployment-owned configuration); throws {@link CodeEnvironmentReferenceError} when it is
   * held but cannot be referenced (pending, being removed or retired).
   */
  reserve(
    environmentId: string | undefined,
  ): Promise<CodeEnvironmentReferenceReservation | undefined>;
  /** Extends the reservation's lease; throws {@link CodeEnvironmentReferenceError} once lost. */
  renew(reservation: CodeEnvironmentReferenceReservation): Promise<void>;
  /** Removes the reservation. */
  release(reservation: CodeEnvironmentReferenceReservation | undefined): Promise<void>;
}

/** Hold every machine reference until the write settles. Nesting the existing
 * guards renews already-acquired leases and releases them if a later acquisition fails. */
export async function withCodeEnvironmentReferencesOnSteps<T>(
  steps: CodeEnvironmentReferenceSteps,
  environmentIds: string[],
  operation: () => Promise<T>,
  onReferenceLoss?: (result: T, environmentId: string) => Promise<void>,
): Promise<T> {
  if (environmentIds.length > MAX_AGENT_CODE_ENVIRONMENT_CHOICES + 1) {
    throw new Error('Agent code environment references exceed the storage safety ceiling');
  }
  const ids = [...new Set(environmentIds.filter(Boolean))];
  const run = (index: number): Promise<T> =>
    index === ids.length
      ? operation()
      : withCodeEnvironmentReferenceOnSteps(
          steps,
          ids[index],
          () => run(index + 1),
          undefined,
          (result) => onReferenceLoss?.(result, ids[index]) ?? Promise.resolve(),
        );
  return await run(0);
}

/** Holds one environment reference while `operation` runs, renewing its lease on a timer. */
export async function withCodeEnvironmentReferenceOnSteps<T>(
  steps: CodeEnvironmentReferenceSteps,
  environmentId: string | undefined,
  operation: () => Promise<T>,
  renewIntervalMs: number = REFERENCE_RENEW_INTERVAL_MS,
  onReferenceLoss?: (result: T) => Promise<void>,
): Promise<T> {
  const reservation = await steps.reserve(environmentId);
  if (reservation == null) return await operation();

  let renewal = Promise.resolve();
  let renewalError: unknown;
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => steps.renew(reservation))
      .catch((error) => {
        renewalError ??= error;
        logger.error('[code-environments] agent reference lease renewal failed:', error);
      });
  }, renewIntervalMs);
  timer.unref();
  try {
    const result = await operation();
    /** Freeze the renewal chain before awaiting it. Otherwise the interval can
     * append one last renewal after this await has captured an earlier promise. */
    clearInterval(timer);
    await renewal;
    if (renewalError != null) {
      try {
        await steps.renew(reservation);
        renewalError = undefined;
      } catch (error) {
        await onReferenceLoss?.(result);
        throw error;
      }
    }
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
    await steps.release(reservation);
  }
}

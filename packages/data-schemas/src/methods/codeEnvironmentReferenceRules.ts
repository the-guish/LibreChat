/**
 * The code environment reference leases' database-neutral rules, shared by every backend: the
 * MongoDB code environment methods (`./codeEnvironment`) and the stores that write agents
 * (`./agent`, `adapters/postgres/stores/agent.ts`). An agent write that names a registered code
 * environment first reserves a reference on it (a `pendingAgentReferences` entry with a lease),
 * which a removal in progress refuses and a removal waits for; the lease is renewed while the
 * write runs and released when it settles. The tombstone ids of retired environments, the
 * reservation's filters and updates (in the store query language) and the lease protocol on
 * three storage steps live here. Nothing here may import `mongoose` or the MongoDB driver.
 */
import { createHash } from 'crypto';
import { MAX_AGENT_CODE_ENVIRONMENT_CHOICES } from 'librechat-data-provider';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import logger from '~/config/winston';

/** How long a reference reservation lasts unless renewed. */
export const REFERENCE_LEASE_MS: number = 2 * 60_000;
/** How often a held reservation is renewed. */
export const REFERENCE_RENEW_INTERVAL_MS: number = REFERENCE_LEASE_MS / 3;

/** The tenant scope of a code environment's tombstone (`''`: none, or the system tenant). */
export function codeEnvironmentTenantScope(tenantId?: string): string {
  const resolved = tenantId ?? getTenantId();
  return resolved == null || resolved === SYSTEM_TENANT_ID ? '' : resolved;
}

/** The `_id` of the tombstone of a retired environment id in a tenant (the ambient one by default). */
export function codeEnvironmentTombstoneId(environmentId: string, tenantId?: string): string {
  return createHash('sha256')
    .update(
      `librechat-code-environment-tombstone\0${codeEnvironmentTenantScope(tenantId)}\0${environmentId}`,
    )
    .digest('hex');
}

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

/** The environments a reference may be reserved on: registered, and not being removed. */
export function referenceReservationFilter(environmentId: string): Record<string, unknown> {
  return {
    environmentId,
    registrationPendingAt: { $exists: false },
    deletionCommittedAt: { $exists: false },
    deletionStartedAt: { $exists: false },
  };
}

/** The `$push` of a new reservation leased from `now`. */
export function referenceReservationUpdate(
  reservationId: string,
  now: Date,
): Record<string, unknown> {
  const expiresAt = new Date(now.getTime() + REFERENCE_LEASE_MS);
  return { $push: { pendingAgentReferences: { reservationId, expiresAt } } };
}

/** The filter and update of a reservation's release. */
export function referenceReleaseWrite(reservation: CodeEnvironmentReferenceReservation): {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
} {
  return {
    filter: { environmentId: reservation.environmentId },
    update: {
      $pull: { pendingAgentReferences: { reservationId: reservation.reservationId } },
    },
  };
}

/** The filter and update of a reservation's renewal, while no removal has started. */
export function referenceRenewalWrite(reservation: CodeEnvironmentReferenceReservation): {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
} {
  return {
    filter: {
      environmentId: reservation.environmentId,
      deletionStartedAt: { $exists: false },
      'pendingAgentReferences.reservationId': reservation.reservationId,
    },
    update: {
      $set: {
        'pendingAgentReferences.$.expiresAt': new Date(Date.now() + REFERENCE_LEASE_MS),
      },
    },
  };
}

/** What the lease protocol reads and writes, per backend. */
export interface CodeEnvironmentReferenceSteps {
  /**
   * Reserves a reference on the environment: the reservation, `undefined` for an id the registry
   * does not hold (deployment-owned configuration), or a `CodeEnvironmentReferenceError` for an
   * environment being registered, removed or retired.
   */
  reserve(
    environmentId: string | undefined,
  ): Promise<CodeEnvironmentReferenceReservation | undefined>;
  /** Extends the lease; throws `CodeEnvironmentReferenceError` once a removal took it. */
  renew(reservation: CodeEnvironmentReferenceReservation): Promise<void>;
  /** Releases the reservation (idempotent). */
  release(reservation: CodeEnvironmentReferenceReservation | undefined): Promise<void>;
}

/**
 * Runs `operation` while holding a reference reservation on `environmentId`, renewed every
 * `renewIntervalMs`. A renewal that failed during the operation is retried once at the end; if
 * that fails too, `onReferenceLoss` runs on the result and the error is thrown. The reservation
 * is always released.
 */
export async function withCodeEnvironmentReferenceSteps<T>(
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

/** Hold every machine reference until the write settles. Nesting the existing
 * guards renews already-acquired leases and releases them if a later acquisition fails. */
export async function withCodeEnvironmentReferencesSteps<T>(
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
      : withCodeEnvironmentReferenceSteps(
          steps,
          ids[index],
          () => run(index + 1),
          undefined,
          (result) => onReferenceLoss?.(result, ids[index]) ?? Promise.resolve(),
        );
  return await run(0);
}

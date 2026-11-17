/**
 * The schedule consent store's domain rules, shared by the MongoDB storage
 * (`./scheduleConsent`) and the PostgreSQL store (`adapters/postgres/stores/scheduleConsent.ts`;
 * docs/postgres-port/PHASE4.md §8, S10a): the schedule a consent identity addresses, the
 * revision and config fences, the snapshot a read hands out, the enrollment binding check, the
 * revoked enrollment, and the admission's filter. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
import { randomUUID } from 'node:crypto';
import { scheduledMCPEnrollmentSchema } from 'librechat-data-provider';
import type { ScheduledMCPIdentity, ScheduledMCPEnrollment } from 'librechat-data-provider';
import type { ISchedule, ScheduleConsentSnapshot } from '~/types/schedule';

/** A filter, as both backends' query languages spell it. */
export type ScheduleConsentFilter = Record<string, unknown>;

/** The schedule fields a consent read selects. */
export const CONSENT_READ_PROJECTION: string = 'agent_id enabled configRevision mcpConsent';

/**
 * The schedule an identity addresses (schedule, owner, tenant); one being deleted, erased or
 * suspended for deletion reads as absent.
 */
export function consentScope(identity: ScheduledMCPIdentity): ScheduleConsentFilter {
  return {
    id: identity.scheduleId,
    user: identity.ownerId,
    tenantId: identity.tenantId,
    deleting: { $ne: true },
    erased: { $ne: true },
    deletionSuspension: { $exists: false },
  };
}

/** The stored consent at `revision` (`null`: no consent stored). */
export function consentRevisionFilter(revision: string | null): ScheduleConsentFilter {
  return revision == null
    ? { mcpConsent: { $exists: false } }
    : { 'mcpConsent.version': 1, 'mcpConsent.revision': revision };
}

/** The schedule at config revision `revision` (a missing legacy revision reads as 0). */
export function consentConfigFilter(revision: number): ScheduleConsentFilter {
  return revision === 0
    ? { $or: [{ configRevision: 0 }, { configRevision: { $exists: false } }] }
    : { configRevision: revision };
}

/** The consent state a read hands out, from the selected schedule fields. */
export function consentSnapshotOf(
  row: Pick<ISchedule, 'agent_id' | 'enabled' | 'configRevision' | 'mcpConsent'>,
): ScheduleConsentSnapshot {
  const parsed = scheduledMCPEnrollmentSchema.safeParse(row.mcpConsent);
  return {
    agentId: row.agent_id,
    enabled: row.enabled,
    configRevision: row.configRevision ?? 0,
    enrollment: parsed.success ? parsed.data : null,
    compatible: row.mcpConsent === undefined || parsed.success,
  };
}

/**
 * The enrollment a confirmation stores, parsed (key order as the parse writes it); throws on one
 * bound to another schedule, revision, owner, tenant or agent, or already revoked.
 */
export function parseConfirmedEnrollment(input: {
  identity: ScheduledMCPIdentity;
  expectedConfigRevision: number;
  enrollment: ScheduledMCPEnrollment;
}): ScheduledMCPEnrollment {
  const enrollment = scheduledMCPEnrollmentSchema.parse(input.enrollment);
  if (
    enrollment.scheduleRevision !== input.expectedConfigRevision ||
    enrollment.consents.some(
      (consent) =>
        consent.identity.scheduleId !== input.identity.scheduleId ||
        consent.identity.ownerId !== input.identity.ownerId ||
        consent.identity.tenantId !== input.identity.tenantId ||
        consent.identity.agentId !== input.identity.agentId ||
        consent.identity.invocationMode !== 'delegated' ||
        consent.revision !== enrollment.revision ||
        consent.revokedAtMs != null,
    )
  )
    throw new Error('Invalid scheduled MCP enrollment binding');
  return enrollment;
}

/** Whether a consent of the enrollment has already expired at `nowMs`. */
export function hasExpiredConsent(enrollment: ScheduledMCPEnrollment, nowMs: number): boolean {
  return enrollment.consents.some((consent) => consent.absoluteExpiresAtMs <= nowMs);
}

/** The filter of a confirmation's compare-and-set. */
export function confirmationFilter(input: {
  identity: ScheduledMCPIdentity;
  expectedConfigRevision: number;
  expectedRevision: string | null;
}): ScheduleConsentFilter {
  return {
    ...consentScope(input.identity),
    ...consentConfigFilter(input.expectedConfigRevision),
    ...consentRevisionFilter(input.expectedRevision),
    agent_id: input.identity.agentId,
  };
}

/** Every consent of the stored enrollment marked revoked (at `nowMs`) under a new revision. */
export function revokedEnrollment(
  stored: ScheduledMCPEnrollment,
  nowMs: number,
): ScheduledMCPEnrollment {
  const revokedRevision = randomUUID();
  return {
    ...stored,
    revision: revokedRevision,
    consents: stored.consents.map((consent) => ({
      ...consent,
      revision: revokedRevision,
      revokedAtMs: consent.revokedAtMs ?? nowMs,
    })),
  };
}

/**
 * The filter of an admission: the consent `consentId` at `revision`, while no consent is revoked
 * or expired at `nowMs` and, unless `requireEnabled` is `false`, the schedule is enabled.
 */
export function admissionFilter(
  input: {
    identity: ScheduledMCPIdentity;
    expectedConfigRevision: number;
    revision: string;
    consentId: string;
    requireEnabled?: boolean;
  },
  nowMs: number,
): ScheduleConsentFilter {
  return {
    ...consentScope(input.identity),
    ...consentConfigFilter(input.expectedConfigRevision),
    ...consentRevisionFilter(input.revision),
    agent_id: input.identity.agentId,
    ...(input.requireEnabled !== false && { enabled: true }),
    'mcpConsent.consents': {
      $elemMatch: { id: input.consentId, revision: input.revision, revokedAtMs: null },
    },
    'mcpConsent.consents.0': { $exists: true },
    $nor: [
      {
        'mcpConsent.consents': {
          $elemMatch: {
            $or: [{ revokedAtMs: { $ne: null } }, { absoluteExpiresAtMs: { $lte: nowMs } }],
          },
        },
      },
    ],
  };
}

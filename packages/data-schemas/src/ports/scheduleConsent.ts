/**
 * Schedule consent store port: the delegated MCP consent stored on a schedule. Nothing here may
 * import `mongoose`. Signatures are copied verbatim from `ScheduleMCPConsentStorage`
 * (`~/methods/scheduleConsent`); `scheduleConsent.spec.ts` fails the typecheck if the two drift.
 *
 * Contract common to every method: a schedule is addressed by its identity (schedule, owner,
 * tenant); one being deleted, erased or suspended for deletion reads as absent. Writes are
 * compare-and-set and resolve `false` when the expected state no longer holds.
 */
import type { ScheduledMCPEnrollment, ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleConsentSnapshot } from '~/types';
import { listPortMethods } from './common';

export interface ScheduleConsentStore {
  /** The schedule's consent state, read from the primary; `null` when there is no such schedule. */
  readScheduleMCPConsent(identity: ScheduledMCPIdentity): Promise<ScheduleConsentSnapshot | null>;
  /**
   * Stores `enrollment` while the schedule is still at `expectedConfigRevision` and its consent at
   * `expectedRevision` (`null`: none). Throws on an enrollment bound to another schedule; `false`
   * when a consent in it has already expired.
   */
  confirmScheduleMCPConsent(input: {
    identity: ScheduledMCPIdentity;
    expectedConfigRevision: number;
    expectedRevision: string | null;
    enrollment: ScheduledMCPEnrollment;
  }): Promise<boolean>;
  /** Marks every consent at `revision` revoked, under a new revision. */
  revokeScheduleMCPConsent(identity: ScheduledMCPIdentity, revision: string): Promise<boolean>;
  /**
   * Admits a run under consent `consentId` at `revision`: only while no consent is revoked or
   * expired and, unless `requireEnabled` is `false`, the schedule is enabled.
   */
  admitScheduleMCPConsent(input: {
    identity: ScheduledMCPIdentity;
    expectedConfigRevision: number;
    revision: string;
    consentId: string;
    requireEnabled?: boolean;
  }): Promise<boolean>;
}

/** Every method of {@link ScheduleConsentStore}, for adapters and conformance checks. */
export const SCHEDULE_CONSENT_STORE_METHODS: ReadonlyArray<keyof ScheduleConsentStore> =
  listPortMethods<ScheduleConsentStore>({
    readScheduleMCPConsent: true,
    confirmScheduleMCPConsent: true,
    revokeScheduleMCPConsent: true,
    admitScheduleMCPConsent: true,
  });

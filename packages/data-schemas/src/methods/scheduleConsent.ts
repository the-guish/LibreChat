import { scheduledMCPEnrollmentSchema } from 'librechat-data-provider';
import type { ScheduledMCPIdentity, ScheduledMCPEnrollment } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { IScheduleDocument, ScheduleConsentSnapshot } from '~/types/schedule';
import {
  admissionFilter,
  consentScope,
  revokedEnrollment,
  consentSnapshotOf,
  hasExpiredConsent,
  confirmationFilter,
  consentRevisionFilter,
  CONSENT_READ_PROJECTION,
  parseConfirmedEnrollment,
} from './scheduleConsentRules';

export type { ScheduleConsentSnapshot } from '~/types/schedule';

export interface ScheduleMCPConsentStorage {
  readScheduleMCPConsent: (
    identity: ScheduledMCPIdentity,
  ) => Promise<ScheduleConsentSnapshot | null>;
  confirmScheduleMCPConsent: (input: {
    identity: ScheduledMCPIdentity;
    expectedConfigRevision: number;
    expectedRevision: string | null;
    enrollment: ScheduledMCPEnrollment;
  }) => Promise<boolean>;
  revokeScheduleMCPConsent: (identity: ScheduledMCPIdentity, revision: string) => Promise<boolean>;
  admitScheduleMCPConsent: (input: {
    identity: ScheduledMCPIdentity;
    expectedConfigRevision: number;
    revision: string;
    consentId: string;
    requireEnabled?: boolean;
  }) => Promise<boolean>;
}

export function createScheduleMCPConsentStorage(
  mongoose: typeof import('mongoose'),
  options: { now?: () => number } = {},
): ScheduleMCPConsentStorage {
  const now = options.now ?? Date.now;
  const model = (): Model<IScheduleDocument> =>
    mongoose.models.Schedule as Model<IScheduleDocument>;
  return {
    async readScheduleMCPConsent(identity) {
      const row = await model()
        .findOne(consentScope(identity))
        .select(CONSENT_READ_PROJECTION)
        .read('primary')
        .lean();
      if (!row) return null;
      return consentSnapshotOf(row);
    },
    async confirmScheduleMCPConsent(input) {
      const enrollment = parseConfirmedEnrollment(input);
      if (hasExpiredConsent(enrollment, now())) return false;
      const result = await model().updateOne(
        confirmationFilter(input),
        { $set: { mcpConsent: enrollment } },
        { runValidators: true },
      );
      return result.matchedCount === 1;
    },
    async revokeScheduleMCPConsent(identity, revision) {
      const snapshot = await model()
        .findOne({ ...consentScope(identity), ...consentRevisionFilter(revision) })
        .select('mcpConsent')
        .read('primary')
        .lean();
      const parsed = scheduledMCPEnrollmentSchema.safeParse(snapshot?.mcpConsent);
      if (!parsed.success) return false;
      const enrollment = revokedEnrollment(parsed.data, now());
      const result = await model().updateOne(
        { ...consentScope(identity), ...consentRevisionFilter(revision) },
        { $set: { mcpConsent: enrollment } },
        { runValidators: true },
      );
      return result.matchedCount === 1;
    },
    async admitScheduleMCPConsent(input) {
      const result = await model().updateOne(
        admissionFilter(input, now()),
        { $set: { 'mcpConsent.revision': input.revision } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
  };
}

/**
 * The PostgreSQL `ScheduleConsentStore` (`~/ports/scheduleConsent`): the delegated MCP consent
 * stored on a schedule (`schedules.mcpConsent`, a `json` column), through the collection
 * primitive, with the filters of `~/methods/scheduleConsentRules`. Must not import `mongoose`,
 * `mongodb` or `bson`.
 *
 * The consent paths are jsonpath on `mcpConsent::jsonb` (`mcpConsent.version`/`.revision`, the
 * admission's `$elemMatch` and `$nor` over `mcpConsent.consents`, `mcpConsent.consents.0`); a
 * missing legacy config revision reads as 0. A confirmation and a revocation write the whole
 * value with the schema's validators (read-modify-write under the row lock, so of concurrent
 * confirmations at one expected revision exactly one wins); `json` keeps the text as written, so
 * the stored consent keeps the key order the schema parse wrote. An admission writes
 * `mcpConsent.revision` (a subpath: read-modify-write under the row lock) without `updatedAt`.
 */
import { scheduledMCPEnrollmentSchema } from 'librechat-data-provider';
import type { ScheduleConsentStore } from '~/ports/scheduleConsent';
import type { PostgresStoreContext } from './context';
import type { ISchedule } from '~/types';
import {
  consentScope,
  admissionFilter,
  revokedEnrollment,
  consentSnapshotOf,
  hasExpiredConsent,
  confirmationFilter,
  consentRevisionFilter,
  CONSENT_READ_PROJECTION,
  parseConfirmedEnrollment,
} from '~/methods/scheduleConsentRules';

type ScheduleRow = ISchedule & Record<string, unknown>;

export function createPostgresScheduleConsentStore(
  context: PostgresStoreContext,
  options: { now?: () => number } = {},
): ScheduleConsentStore {
  const now = options.now ?? Date.now;
  const schedules = () => context.collections().collection<ScheduleRow>('schedules');

  const store: ScheduleConsentStore = {
    async readScheduleMCPConsent(identity) {
      const row = await schedules().findOne(consentScope(identity), {
        projection: CONSENT_READ_PROJECTION,
      });
      return row ? consentSnapshotOf(row) : null;
    },

    async confirmScheduleMCPConsent(input) {
      const enrollment = parseConfirmedEnrollment(input);
      if (hasExpiredConsent(enrollment, now())) return false;
      const result = await schedules().updateOne(
        confirmationFilter(input),
        { $set: { mcpConsent: enrollment } },
        { runValidators: true },
      );
      return result.matchedCount === 1;
    },

    async revokeScheduleMCPConsent(identity, revision) {
      const filter = { ...consentScope(identity), ...consentRevisionFilter(revision) };
      const snapshot = await schedules().findOne(filter, { projection: 'mcpConsent' });
      const parsed = scheduledMCPEnrollmentSchema.safeParse(snapshot?.mcpConsent);
      if (!parsed.success) return false;
      const enrollment = revokedEnrollment(parsed.data, now());
      const result = await schedules().updateOne(
        { ...consentScope(identity), ...consentRevisionFilter(revision) },
        { $set: { mcpConsent: enrollment } },
        { runValidators: true },
      );
      return result.matchedCount === 1;
    },

    async admitScheduleMCPConsent(input) {
      const result = await schedules().updateOne(
        admissionFilter(input, now()),
        { $set: { 'mcpConsent.revision': input.revision } },
        { timestamps: false },
      );
      return result.matchedCount === 1;
    },
  };
  return store;
}

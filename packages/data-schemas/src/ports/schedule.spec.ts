import mongoose from 'mongoose';
import type {
  Assert,
  EveryMethodPlaced,
  ExclusionsHold,
  SameSignatures,
  Satisfies,
} from './conformance';
import type { ScheduleMethods } from '~/methods/schedule';
import type { ScheduleStore } from './schedule';
import { createScheduleMethods } from '~/methods/schedule';
import { SCHEDULE_STORE_METHODS } from './schedule';

/**
 * Schedule methods left out of the port, each with the reason:
 * - `updateScheduleById`: its `unset` is a raw MongoDB `$unset` document (field name to `1`);
 *   the owner-edit handler passes `{ disabledReason: 1 }` and/or `{ chatProjectId: 1 }`.
 * - `disableSchedule`: its `counterGuard` is a raw MongoDB filter merged into the update's
 *   filter (only the methods' own auto-disable passes one, e.g. `{ failureCount: { $gte } }`).
 *
 * The other methods' signatures are copied verbatim, but for owner and record ids typed
 * `Types.ObjectId`, which the port states as `IdLike`.
 */
const EXCLUDED = ['updateScheduleById', 'disableSchedule'] as const;
type Excluded = (typeof EXCLUDED)[number];

/** The port methods whose ids the port states as `IdLike`. */
type IdLikeMethods =
  | 'createSchedule'
  | 'createScheduleWithSlot'
  | 'deleteUnarmedSchedule'
  | 'getScheduleById'
  | 'getSchedulesByUser'
  | 'countSchedulesByUser'
  | 'getScheduleByClientRequestId'
  | 'markScheduleDeleting'
  | 'acquireManualRunLease'
  | 'insertScheduleRun'
  | 'reserveStartedRun'
  | 'getActiveRunsForUser'
  | 'recordSkippedRun'
  | 'markRunsReconciled'
  | 'suspendUserSchedulesForDeletion'
  | 'restoreUserSchedulesFromDeletion'
  | 'getDeletingScheduleIds'
  | 'deleteSchedulesByUser';

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<ScheduleStore, ScheduleMethods>>,
  Assert<SameSignatures<Omit<ScheduleStore, IdLikeMethods>, ScheduleMethods>>,
  Assert<EveryMethodPlaced<ScheduleStore, ScheduleMethods, Excluded>>,
  Assert<ExclusionsHold<ScheduleStore, Excluded>>,
];

describe('ScheduleStore port', () => {
  const methods = createScheduleMethods(mongoose);

  it('matches the MongoDB schedule methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SCHEDULE_STORE_METHODS).size).toBe(SCHEDULE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...SCHEDULE_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB schedule methods', () => {
    const store: ScheduleStore = methods;
    for (const name of SCHEDULE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

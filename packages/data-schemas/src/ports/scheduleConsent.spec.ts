import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, SameSignatures } from './conformance';
import type { ScheduleMCPConsentStorage } from '~/methods/scheduleConsent';
import type { ScheduleConsentStore } from './scheduleConsent';
import { createScheduleMCPConsentStorage } from '~/methods/scheduleConsent';
import { SCHEDULE_CONSENT_STORE_METHODS } from './scheduleConsent';

/**
 * Schedule consent methods left out of the port, each with the reason: none. Every method's
 * signature is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<SameSignatures<ScheduleConsentStore, ScheduleMCPConsentStorage>>,
  Assert<EveryMethodPlaced<ScheduleConsentStore, ScheduleMCPConsentStorage, Excluded>>,
  Assert<ExclusionsHold<ScheduleConsentStore, Excluded>>,
];

describe('ScheduleConsentStore port', () => {
  const methods = createScheduleMCPConsentStorage(mongoose);

  it('matches the MongoDB schedule consent methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SCHEDULE_CONSENT_STORE_METHODS).size).toBe(
      SCHEDULE_CONSENT_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...SCHEDULE_CONSENT_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB schedule consent methods', () => {
    const store: ScheduleConsentStore = methods;
    for (const name of SCHEDULE_CONSENT_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

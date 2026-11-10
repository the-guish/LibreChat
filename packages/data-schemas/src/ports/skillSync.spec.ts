import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { SkillSyncMethods } from '~/methods/skillSync';
import type { SkillSyncStore } from './skillSync';
import { createSkillSyncMethods } from '~/methods/skillSync';
import { SKILL_SYNC_STORE_METHODS } from './skillSync';

/**
 * Skill sync methods left out of the port, each with the reason: none. Every method's signature
 * is database-neutral but for the writing admin's user id typed `Types.ObjectId`
 * (`upsertSkillSyncCredential`), which the port states as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<SkillSyncStore, SkillSyncMethods>>,
  Assert<EveryMethodPlaced<SkillSyncStore, SkillSyncMethods, Excluded>>,
  Assert<ExclusionsHold<SkillSyncStore, Excluded>>,
];

describe('SkillSyncStore port', () => {
  const methods = createSkillSyncMethods(mongoose);

  it('matches the MongoDB skill sync methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SKILL_SYNC_STORE_METHODS).size).toBe(SKILL_SYNC_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...SKILL_SYNC_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB skill sync methods', () => {
    const store: SkillSyncStore = methods;
    for (const name of SKILL_SYNC_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

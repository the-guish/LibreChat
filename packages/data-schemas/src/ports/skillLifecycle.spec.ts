import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { SkillLifecycleMethods } from '~/methods/skillLifecycle';
import type { SkillLifecycleStore } from './skillLifecycle';
import { createSkillLifecycleMethods } from '~/methods/skillLifecycle';
import { SKILL_LIFECYCLE_STORE_METHODS } from './skillLifecycle';

/**
 * Skill lifecycle methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for skill ids typed `string | Types.ObjectId`, which the port
 * states as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<SkillLifecycleStore, SkillLifecycleMethods>>,
  Assert<EveryMethodPlaced<SkillLifecycleStore, SkillLifecycleMethods, Excluded>>,
  Assert<ExclusionsHold<SkillLifecycleStore, Excluded>>,
];

describe('SkillLifecycleStore port', () => {
  const methods = createSkillLifecycleMethods(mongoose);

  it('matches the MongoDB skill lifecycle methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SKILL_LIFECYCLE_STORE_METHODS).size).toBe(SKILL_LIFECYCLE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...SKILL_LIFECYCLE_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB skill lifecycle methods', () => {
    const store: SkillLifecycleStore = methods;
    for (const name of SKILL_LIFECYCLE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

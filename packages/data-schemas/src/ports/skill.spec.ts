import mongoose from 'mongoose';
import type {
  Assert,
  EveryMethodPlaced,
  ExclusionsHold,
  SameSignatures,
  Satisfies,
} from './conformance';
import type { SkillMethods } from '~/methods/skill';
import type { SkillStore } from './skill';
import { createSkillMethods } from '~/methods/skill';
import { SKILL_STORE_METHODS } from './skill';

/**
 * Skill methods left out of the port: none. Their signatures are database-neutral but for ids
 * typed `Types.ObjectId`, which the port states as `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/** The port methods that state no id as `IdLike`, so the port copies them verbatim. */
type VerbatimMethods =
  | 'updateSkill'
  | 'deleteSkill'
  | 'finalizeSkillDeletion'
  | 'findSkillBySourceIdentity'
  | 'listSkillsBySource'
  | 'deleteSkillFileAfterBlob';

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<SkillStore, SkillMethods>>,
  Assert<SameSignatures<Pick<SkillStore, VerbatimMethods>, SkillMethods>>,
  Assert<EveryMethodPlaced<SkillStore, SkillMethods, Excluded>>,
  Assert<ExclusionsHold<SkillStore, Excluded>>,
];

describe('SkillStore port', () => {
  const methods = createSkillMethods(mongoose, {
    removeAllPermissions: async () => undefined,
    getSoleOwnedResourceIds: async () => [],
  });

  it('matches the MongoDB skill methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true, true];
    expect(typeChecks).toEqual([true, true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(SKILL_STORE_METHODS).size).toBe(SKILL_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...SKILL_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB skill methods', () => {
    const store: SkillStore = methods;
    for (const name of SKILL_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

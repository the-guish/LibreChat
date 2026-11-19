import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { PresetMethods } from '~/methods/preset';
import type { PresetStore } from './preset';
import { createPresetMethods } from '~/methods/preset';
import { PRESET_STORE_METHODS } from './preset';

/**
 * Preset methods left out of the port, each with the reason: none. `getPresets` and
 * `deletePresets` take criteria the port states in the store query language (and resolve
 * records and a delete result the port states in neutral types); every other method's signature
 * is already database-neutral, so the port copies them verbatim.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<PresetStore, PresetMethods>>,
  Assert<EveryMethodPlaced<PresetStore, PresetMethods, Excluded>>,
  Assert<ExclusionsHold<PresetStore, Excluded>>,
];

describe('PresetStore port', () => {
  const methods = createPresetMethods(mongoose);

  it('matches the MongoDB preset methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(PRESET_STORE_METHODS).size).toBe(PRESET_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...PRESET_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB preset methods', () => {
    const store: PresetStore = methods;
    for (const name of PRESET_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

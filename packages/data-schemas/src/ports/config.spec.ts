import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { ConfigMethods } from '~/methods/config';
import type { ConfigOverrideStore } from './config';
import { CONFIG_OVERRIDE_STORE_METHODS } from './config';
import { createConfigMethods } from '~/methods/config';

/**
 * Config methods left out of the port, each with the reason: none. Every method's signature is
 * database-neutral but for principal ids typed `Types.ObjectId`, which the port states as
 * `IdLike`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<ConfigOverrideStore, ConfigMethods>>,
  Assert<EveryMethodPlaced<ConfigOverrideStore, ConfigMethods, Excluded>>,
  Assert<ExclusionsHold<ConfigOverrideStore, Excluded>>,
];

describe('ConfigOverrideStore port', () => {
  const methods = createConfigMethods(mongoose);

  it('matches the MongoDB config methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(CONFIG_OVERRIDE_STORE_METHODS).size).toBe(CONFIG_OVERRIDE_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...CONFIG_OVERRIDE_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB config methods', () => {
    const store: ConfigOverrideStore = methods;
    for (const name of CONFIG_OVERRIDE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

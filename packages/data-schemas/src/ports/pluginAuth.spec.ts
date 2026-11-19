import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { PluginAuthMethods } from '~/methods/pluginAuth';
import type { PluginAuthStore } from './pluginAuth';
import { createPluginAuthMethods } from '~/methods/pluginAuth';
import { PLUGIN_AUTH_STORE_METHODS } from './pluginAuth';

/**
 * Plugin auth methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for the driver's `DeleteResult`, which the port states as
 * `DeleteCount`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<PluginAuthStore, PluginAuthMethods>>,
  Assert<EveryMethodPlaced<PluginAuthStore, PluginAuthMethods, Excluded>>,
  Assert<ExclusionsHold<PluginAuthStore, Excluded>>,
];

describe('PluginAuthStore port', () => {
  const methods = createPluginAuthMethods(mongoose);

  it('matches the MongoDB plugin auth methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(PLUGIN_AUTH_STORE_METHODS).size).toBe(PLUGIN_AUTH_STORE_METHODS.length);
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual([...PLUGIN_AUTH_STORE_METHODS, ...EXCLUDED].sort());
  });

  it('is satisfied by the MongoDB plugin auth methods', () => {
    const store: PluginAuthStore = methods;
    for (const name of PLUGIN_AUTH_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

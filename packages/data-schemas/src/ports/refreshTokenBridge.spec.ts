import mongoose from 'mongoose';
import type { Assert, EveryMethodPlaced, ExclusionsHold, Satisfies } from './conformance';
import type { RefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import type { RefreshTokenBridgeStore } from './refreshTokenBridge';
import { createRefreshTokenBridgeMethods } from '~/methods/refreshTokenBridge';
import { REFRESH_TOKEN_BRIDGE_STORE_METHODS } from './refreshTokenBridge';

/**
 * Refresh token bridge methods left out of the port, each with the reason: none. Every method's
 * signature is database-neutral but for the driver's `DeleteResult`, which the port states as
 * `DeleteCount`.
 */
const EXCLUDED = [] as const;
type Excluded = (typeof EXCLUDED)[number];

/* Type-level conformance (see `./conformance`): fails `npm run typecheck`, not Jest. */
type Checks = [
  Assert<Satisfies<RefreshTokenBridgeStore, RefreshTokenBridgeMethods>>,
  Assert<EveryMethodPlaced<RefreshTokenBridgeStore, RefreshTokenBridgeMethods, Excluded>>,
  Assert<ExclusionsHold<RefreshTokenBridgeStore, Excluded>>,
];

describe('RefreshTokenBridgeStore port', () => {
  const methods = createRefreshTokenBridgeMethods(mongoose);

  it('matches the MongoDB refresh token bridge methods at the type level', () => {
    // A wrong signature, an unplaced method or a broken exclusion fails to compile here.
    const typeChecks: Checks = [true, true, true];
    expect(typeChecks).toEqual([true, true, true]);
  });

  it('lists each method once', () => {
    expect(new Set(REFRESH_TOKEN_BRIDGE_STORE_METHODS).size).toBe(
      REFRESH_TOKEN_BRIDGE_STORE_METHODS.length,
    );
  });

  it('places every runtime method in the port or the exclusion list', () => {
    expect(Object.keys(methods).sort()).toEqual(
      [...REFRESH_TOKEN_BRIDGE_STORE_METHODS, ...EXCLUDED].sort(),
    );
  });

  it('is satisfied by the MongoDB refresh token bridge methods', () => {
    const store: RefreshTokenBridgeStore = methods;
    for (const name of REFRESH_TOKEN_BRIDGE_STORE_METHODS) {
      expect(typeof store[name]).toBe('function');
    }
  });
});

/**
 * Refresh token bridge store port: for a short while after an OpenID refresh token is rotated,
 * the bridge maps the old token (by hash) to the encrypted new one, so a request that still
 * carries the old token can continue. Nothing here may import `mongoose`. Signatures are those
 * of `RefreshTokenBridgeMethods` (`~/methods/refreshTokenBridge`) with the delete result stated
 * as `DeleteCount`; `refreshTokenBridge.spec.ts` fails the typecheck if the MongoDB methods stop
 * satisfying them.
 *
 * A bridge is addressed by the old token's hash, the user and the tenant; a bridge without a
 * tenant is matched only by a call without one. Bridges expire at `expiresAt` and an expired
 * bridge is never returned; any store keeps that.
 *
 * Known leak kept for now so callers stay unchanged: `IRefreshTokenBridge` extends mongoose's
 * `Document`.
 */
import type {
  IRefreshTokenBridge,
  RefreshTokenBridgeQuery,
  RefreshTokenBridgeCreateData,
  RefreshTokenBridgeDeleteData,
} from '~/types';
import type { DeleteCount } from './common';
import { listPortMethods } from './common';

export interface RefreshTokenBridgeStore {
  /**
   * Creates the bridge, or replaces the new token, version, expiry and issuer of the existing
   * one; resolves to the stored bridge.
   */
  upsertRefreshTokenBridge(
    bridgeData: RefreshTokenBridgeCreateData,
  ): Promise<IRefreshTokenBridge | null>;
  /** The unexpired bridge for the old token, or `null`. */
  findRefreshTokenBridge(query: RefreshTokenBridgeQuery): Promise<IRefreshTokenBridge | null>;
  /**
   * Deletes the user's bridges in the tenant, narrowed to the listed old token hashes and to a
   * version when given.
   */
  deleteRefreshTokenBridges(data: RefreshTokenBridgeDeleteData): Promise<DeleteCount>;
}

/** Every method of {@link RefreshTokenBridgeStore}, for adapters and conformance checks. */
export const REFRESH_TOKEN_BRIDGE_STORE_METHODS: ReadonlyArray<keyof RefreshTokenBridgeStore> =
  listPortMethods<RefreshTokenBridgeStore>({
    upsertRefreshTokenBridge: true,
    findRefreshTokenBridge: true,
    deleteRefreshTokenBridges: true,
  });

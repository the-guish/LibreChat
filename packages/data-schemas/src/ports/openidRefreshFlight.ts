/**
 * OpenID refresh flight store port: the single-flight record that lets one owner refresh an
 * OpenID session while concurrent requests wait for and share its result. Nothing here may import
 * `mongoose`. Signatures are copied verbatim from `OpenIDRefreshFlightMethods`
 * (`~/methods/openidRefreshFlight`); `openidRefreshFlight.spec.ts` fails the typecheck if the two
 * drift.
 *
 * Contract common to every method: a flight is addressed by `key`; transitions other than
 * revocation apply only to the owner named in the call and resolve to the updated flight, or
 * `null` when the flight is not in the state the transition starts from.
 *
 * Known leak kept for now so callers stay unchanged: `IOpenIDRefreshFlight` extends mongoose's
 * `Document`.
 */
import type {
  IOpenIDRefreshFlight,
  OpenIDRefreshFlightAcquireResult,
  OpenIDRefreshFlightClaimDeliveryData,
  OpenIDRefreshFlightCompleteData,
  OpenIDRefreshFlightCreateData,
  OpenIDRefreshFlightFailData,
  OpenIDRefreshFlightQuery,
  OpenIDRefreshFlightReleaseDeliveryData,
  OpenIDRefreshFlightRenewData,
  OpenIDRefreshFlightRevokeData,
} from '~/types';
import { listPortMethods } from './common';

export interface OpenIDRefreshFlightStore {
  /**
   * Starts a pending flight for `key`, or takes over one that failed, expired or whose owner's
   * lock lapsed. Otherwise `acquired: false` with the live flight, if any.
   */
  acquireOpenIDRefreshFlight(
    data: OpenIDRefreshFlightCreateData,
  ): Promise<OpenIDRefreshFlightAcquireResult>;
  /** Pending to completed, storing the encrypted result. */
  completeOpenIDRefreshFlight(
    data: OpenIDRefreshFlightCompleteData,
  ): Promise<IOpenIDRefreshFlight | null>;
  /** Extends a pending flight's lock and expiry. */
  renewOpenIDRefreshFlight(
    data: OpenIDRefreshFlightRenewData,
  ): Promise<IOpenIDRefreshFlight | null>;
  /** Pending to failed, storing the error message. */
  failOpenIDRefreshFlight(data: OpenIDRefreshFlightFailData): Promise<IOpenIDRefreshFlight | null>;
  /**
   * Revokes the flight for `key` whoever owns it (logout), waiting while a live delivery holds it;
   * records a revoked flight when there is none.
   */
  revokeOpenIDRefreshFlight(
    data: OpenIDRefreshFlightRevokeData,
  ): Promise<IOpenIDRefreshFlight | null>;
  /**
   * Claims delivery of a completed flight that no live delivery holds and no revocation is
   * pending on; with `createdAt`, creates the completed record when it is absent.
   */
  claimOpenIDRefreshFlightDelivery(
    data: OpenIDRefreshFlightClaimDeliveryData,
  ): Promise<IOpenIDRefreshFlight | null>;
  /** Ends a delivery: applies a pending revocation, or frees the flight for the next delivery. */
  releaseOpenIDRefreshFlightDelivery(
    data: OpenIDRefreshFlightReleaseDeliveryData,
  ): Promise<IOpenIDRefreshFlight | null>;
  /** The unexpired flight for `key`, or `null`. */
  findOpenIDRefreshFlight(query: OpenIDRefreshFlightQuery): Promise<IOpenIDRefreshFlight | null>;
}

/** Every method of {@link OpenIDRefreshFlightStore}, for adapters and conformance checks. */
export const OPENID_REFRESH_FLIGHT_STORE_METHODS: ReadonlyArray<keyof OpenIDRefreshFlightStore> =
  listPortMethods<OpenIDRefreshFlightStore>({
    acquireOpenIDRefreshFlight: true,
    completeOpenIDRefreshFlight: true,
    renewOpenIDRefreshFlight: true,
    failOpenIDRefreshFlight: true,
    revokeOpenIDRefreshFlight: true,
    claimOpenIDRefreshFlightDelivery: true,
    releaseOpenIDRefreshFlightDelivery: true,
    findOpenIDRefreshFlight: true,
  });

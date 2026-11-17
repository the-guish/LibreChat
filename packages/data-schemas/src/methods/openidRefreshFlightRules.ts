/**
 * The OpenID refresh flight store's database-neutral rules (`OpenIDRefreshFlightStore`,
 * `~/ports/openidRefreshFlight`), shared by every backend: the MongoDB methods
 * (`./openidRefreshFlight`) and the PostgreSQL store
 * (`adapters/postgres/stores/openidRefreshFlight.ts`). The whole single-flight protocol (acquire,
 * join and reclaim; the owner-only renew, complete and fail; the delivery claim and release; the
 * logout revocation fence) is written once here on the storage steps of
 * {@link OpenIDRefreshFlightSteps}, its filters and updates stated in the store query language.
 * Nothing here may import `mongoose` or the MongoDB driver.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type {
  IOpenIDRefreshFlight,
  OpenIDRefreshFlightCreateData,
  OpenIDRefreshFlightCompleteData,
  OpenIDRefreshFlightRenewData,
  OpenIDRefreshFlightFailData,
  OpenIDRefreshFlightRevokeData,
  OpenIDRefreshFlightQuery,
  OpenIDRefreshFlightAcquireResult,
  OpenIDRefreshFlightClaimDeliveryData,
  OpenIDRefreshFlightReleaseDeliveryData,
} from '~/types';
import type { OpenIDRefreshFlightStore } from '~/ports/openidRefreshFlight';
import logger from '~/config/winston';

const DELIVERY_RELEASE_POLL_MS = 100;

/** A filter or update in the store query language. */
export type FlightQuery = Record<string, unknown>;

/** The storage steps the protocol runs on, each one atomic on its own. */
export interface OpenIDRefreshFlightSteps {
  /** Makes sure the unique `key` index (and the TTL index) exist before a create relies on it. */
  awaitIndexes(): Promise<void>;
  /** Inserts the flight; rejects with a duplicate-key error when one exists for its key. */
  create(record: FlightQuery): Promise<IOpenIDRefreshFlight>;
  /** Updates the first flight matching `filter`, resolving it updated (or upserted), or `null`. */
  findOneAndUpdate(
    filter: FlightQuery,
    update: FlightQuery,
    options?: { upsert?: boolean },
  ): Promise<IOpenIDRefreshFlight | null>;
  /** The flight matching `filter`, read from the primary, or `null`. */
  findOne(filter: FlightQuery): Promise<IOpenIDRefreshFlight | null>;
  /** Deletes the flight matching `filter`, resolving it, or `null`. */
  findOneAndDelete(filter: FlightQuery): Promise<IOpenIDRefreshFlight | null>;
  /** Whether `error` is the backend's duplicate-key error. */
  isDuplicateKey(error: unknown): boolean;
}

/** The revoked state a logout fences a flight with. */
function revokedSet(extra: FlightQuery = {}): FlightQuery {
  return {
    ownerId: 'revoked',
    status: 'revoked',
    errorMessage: 'OpenID refresh was revoked by logout',
    ...extra,
    updatedAt: new Date(),
  };
}

/** The delivery fields every state change but a plain release clears. */
const deliveryUnset = (): FlightQuery => ({
  deliveryId: '',
  deliveryExpiresAt: '',
  revocationRequestedAt: '',
});

/** No live delivery holds the flight. */
const noLiveDelivery = (): FlightQuery[] => [
  { deliveryId: { $exists: false } },
  { deliveryExpiresAt: { $exists: false } },
  { deliveryExpiresAt: { $lte: new Date() } },
];

/** The eight methods of the port on `steps`. */
export function createOpenIDRefreshFlightOnSteps(
  steps: OpenIDRefreshFlightSteps,
): OpenIDRefreshFlightStore {
  async function acquireOpenIDRefreshFlight(
    data: OpenIDRefreshFlightCreateData,
  ): Promise<OpenIDRefreshFlightAcquireResult> {
    const now = new Date();

    await steps.awaitIndexes();

    try {
      const flight = await steps.create({
        ...data,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      return { acquired: true, flight };
    } catch (error) {
      if (!steps.isDuplicateKey(error)) {
        logger.debug('[acquireOpenIDRefreshFlight] Error creating flight:', error);
        throw error;
      }
    }

    try {
      const reclaimed = await steps.findOneAndUpdate(
        {
          key: data.key,
          $or: [
            { status: 'failed' },
            { expiresAt: { $lte: now } },
            { status: 'pending', lockExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            ownerId: data.ownerId,
            status: 'pending',
            createdAt: now,
            lockExpiresAt: data.lockExpiresAt,
            expiresAt: data.expiresAt,
            updatedAt: now,
          },
          $unset: {
            encryptedResult: '',
            errorMessage: '',
            ...deliveryUnset(),
          },
        },
      );

      if (reclaimed) {
        return { acquired: true, flight: reclaimed };
      }

      const existing = await steps.findOne({
        key: data.key,
        expiresAt: { $gt: now },
      });

      return { acquired: false, flight: existing };
    } catch (error) {
      logger.debug('[acquireOpenIDRefreshFlight] Error acquiring flight:', error);
      throw error;
    }
  }

  async function completeOpenIDRefreshFlight(
    data: OpenIDRefreshFlightCompleteData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      return await steps.findOneAndUpdate(
        {
          key: data.key,
          ownerId: data.ownerId,
          status: 'pending',
        },
        {
          $set: {
            status: 'completed',
            encryptedResult: data.encryptedResult,
            expiresAt: data.expiresAt,
            updatedAt: new Date(),
          },
          $unset: {
            errorMessage: '',
            ...deliveryUnset(),
          },
        },
      );
    } catch (error) {
      logger.debug('[completeOpenIDRefreshFlight] Error completing flight:', error);
      throw error;
    }
  }

  async function renewOpenIDRefreshFlight(
    data: OpenIDRefreshFlightRenewData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      return await steps.findOneAndUpdate(
        {
          key: data.key,
          ownerId: data.ownerId,
          status: 'pending',
        },
        {
          $set: {
            lockExpiresAt: data.lockExpiresAt,
            expiresAt: data.expiresAt,
            updatedAt: new Date(),
          },
        },
      );
    } catch (error) {
      logger.debug('[renewOpenIDRefreshFlight] Error renewing flight:', error);
      throw error;
    }
  }

  async function failOpenIDRefreshFlight(
    data: OpenIDRefreshFlightFailData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      return await steps.findOneAndUpdate(
        {
          key: data.key,
          ownerId: data.ownerId,
          status: 'pending',
        },
        {
          $set: {
            status: 'failed',
            errorMessage: data.errorMessage,
            expiresAt: data.expiresAt,
            updatedAt: new Date(),
          },
          $unset: {
            encryptedResult: '',
            ...deliveryUnset(),
          },
        },
      );
    } catch (error) {
      logger.debug('[failOpenIDRefreshFlight] Error failing flight:', error);
      throw error;
    }
  }

  async function findOpenIDRefreshFlight(
    query: OpenIDRefreshFlightQuery,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      return await steps.findOne({
        key: query.key,
        expiresAt: { $gt: new Date() },
      });
    } catch (error) {
      logger.debug('[findOpenIDRefreshFlight] Error finding flight:', error);
      throw error;
    }
  }

  async function claimOpenIDRefreshFlightDelivery(
    data: OpenIDRefreshFlightClaimDeliveryData,
  ): Promise<IOpenIDRefreshFlight | null> {
    try {
      try {
        return await steps.findOneAndUpdate(
          {
            key: data.key,
            ownerId: data.ownerId,
            status: 'completed',
            revocationRequestedAt: { $exists: false },
            $or: noLiveDelivery(),
          },
          {
            $set: {
              deliveryId: data.deliveryId,
              deliveryExpiresAt: data.deliveryExpiresAt,
              updatedAt: new Date(),
            },
            $max: { expiresAt: data.deliveryExpiresAt },
            ...(data.createdAt
              ? {
                  $setOnInsert: {
                    createdAt: data.createdAt,
                    lockExpiresAt: data.deliveryExpiresAt,
                  },
                }
              : {}),
          },
          { upsert: Boolean(data.createdAt) },
        );
      } catch (error) {
        if (steps.isDuplicateKey(error)) return null;
        throw error;
      }
    } catch (error) {
      logger.debug('[claimOpenIDRefreshFlightDelivery] Error claiming delivery:', error);
      throw error;
    }
  }

  async function releaseOpenIDRefreshFlightDelivery(
    data: OpenIDRefreshFlightReleaseDeliveryData,
  ): Promise<IOpenIDRefreshFlight | null> {
    const delivery = {
      key: data.key,
      ownerId: data.ownerId,
      deliveryId: data.deliveryId,
      status: 'completed',
    } as const;
    const applyRevocation = () =>
      steps.findOneAndUpdate(
        { ...delivery, revocationRequestedAt: { $exists: true } },
        { $set: revokedSet(), $unset: deliveryUnset() },
      );
    try {
      const revoked = await applyRevocation();
      if (revoked) return revoked;

      const synthetic = await steps.findOneAndDelete({
        ...delivery,
        encryptedResult: { $exists: false },
        revocationRequestedAt: { $exists: false },
      });
      if (synthetic) return null;

      const completed = await steps.findOneAndUpdate(
        {
          ...delivery,
          encryptedResult: { $exists: true },
          revocationRequestedAt: { $exists: false },
        },
        {
          $set: { updatedAt: new Date() },
          $unset: { deliveryId: '', deliveryExpiresAt: '' },
        },
      );
      if (completed) return completed;

      return await applyRevocation();
    } catch (error) {
      logger.debug('[releaseOpenIDRefreshFlightDelivery] Error releasing delivery:', error);
      throw error;
    }
  }

  async function revokeOpenIDRefreshFlight(
    data: OpenIDRefreshFlightRevokeData,
  ): Promise<IOpenIDRefreshFlight | null> {
    const now = new Date();
    await steps.awaitIndexes();
    try {
      for (;;) {
        const revoked = await steps.findOneAndUpdate(
          {
            key: data.key,
            $or: noLiveDelivery(),
          },
          {
            $set: revokedSet({ lockExpiresAt: data.expiresAt, expiresAt: data.expiresAt }),
            $unset: deliveryUnset(),
          },
        );
        if (revoked) return revoked;

        const delivering = await steps.findOneAndUpdate(
          {
            key: data.key,
            status: 'completed',
            deliveryId: { $exists: true },
            deliveryExpiresAt: { $gt: new Date() },
          },
          {
            $set: {
              revocationRequestedAt: new Date(),
              expiresAt: data.expiresAt,
              updatedAt: new Date(),
            },
          },
        );
        if (delivering) {
          await delay(DELIVERY_RELEASE_POLL_MS);
          continue;
        }

        try {
          return await steps.create({
            key: data.key,
            ownerId: 'revoked',
            status: 'revoked',
            errorMessage: 'OpenID refresh was revoked by logout',
            lockExpiresAt: data.expiresAt,
            expiresAt: data.expiresAt,
            createdAt: now,
            updatedAt: now,
          });
        } catch (error) {
          if (!steps.isDuplicateKey(error)) throw error;
        }
      }
    } catch (error) {
      logger.debug('[revokeOpenIDRefreshFlight] Error revoking flight:', error);
      throw error;
    }
  }

  return {
    acquireOpenIDRefreshFlight,
    claimOpenIDRefreshFlightDelivery,
    renewOpenIDRefreshFlight,
    completeOpenIDRefreshFlight,
    failOpenIDRefreshFlight,
    revokeOpenIDRefreshFlight,
    releaseOpenIDRefreshFlightDelivery,
    findOpenIDRefreshFlight,
  };
}

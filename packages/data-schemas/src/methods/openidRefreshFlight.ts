import type { Model } from 'mongoose';
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
import { createOpenIDRefreshFlightOnSteps } from './openidRefreshFlightRules';
import { createIndexesWithRetry } from '~/utils/retry';

function hasErrorCode(error: unknown): error is { code: number } {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'number'
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 11000;
}

/** The OpenID refresh flight methods: the protocol of `./openidRefreshFlightRules` on the model. */
export function createOpenIDRefreshFlightMethods(mongoose: typeof import('mongoose')): {
  acquireOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightCreateData,
  ) => Promise<OpenIDRefreshFlightAcquireResult>;
  completeOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightCompleteData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  renewOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightRenewData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  failOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightFailData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  revokeOpenIDRefreshFlight: (
    data: OpenIDRefreshFlightRevokeData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  claimOpenIDRefreshFlightDelivery: (
    data: OpenIDRefreshFlightClaimDeliveryData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  releaseOpenIDRefreshFlightDelivery: (
    data: OpenIDRefreshFlightReleaseDeliveryData,
  ) => Promise<IOpenIDRefreshFlight | null>;
  findOpenIDRefreshFlight: (
    query: OpenIDRefreshFlightQuery,
  ) => Promise<IOpenIDRefreshFlight | null>;
} {
  let indexesPromise: Promise<void> | null = null;

  const getModel = () => mongoose.models.OpenIDRefreshFlight as Model<IOpenIDRefreshFlight>;

  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      indexesPromise = createIndexesWithRetry(getModel()).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  return createOpenIDRefreshFlightOnSteps({
    awaitIndexes: ensureIndexes,
    create: async (record) => (await getModel().create(record)) as IOpenIDRefreshFlight,
    findOneAndUpdate: (filter, update, options = {}) =>
      getModel()
        .findOneAndUpdate(filter, update, {
          new: true,
          ...(options.upsert ? { upsert: true } : {}),
        })
        .lean<IOpenIDRefreshFlight>(),
    findOne: (filter) => getModel().findOne(filter).read('primary').lean<IOpenIDRefreshFlight>(),
    findOneAndDelete: (filter) => getModel().findOneAndDelete(filter).lean<IOpenIDRefreshFlight>(),
    isDuplicateKey: isDuplicateKeyError,
  });
}

export type OpenIDRefreshFlightMethods = ReturnType<typeof createOpenIDRefreshFlightMethods>;

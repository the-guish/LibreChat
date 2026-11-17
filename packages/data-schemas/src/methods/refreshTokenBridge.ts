import type { DeleteResult, Model } from 'mongoose';
import type {
  IRefreshTokenBridge,
  RefreshTokenBridgeCreateData,
  RefreshTokenBridgeDeleteData,
  RefreshTokenBridgeQuery,
} from '~/types';
import {
  bridgeFilter,
  bridgeDeleteFilter,
  bridgeUpsertUpdate,
  unexpiredBridgeFilter,
} from './refreshTokenBridgeRules';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

export function createRefreshTokenBridgeMethods(mongoose: typeof import('mongoose')): {
  upsertRefreshTokenBridge: (
    bridgeData: RefreshTokenBridgeCreateData,
  ) => Promise<IRefreshTokenBridge | null>;
  findRefreshTokenBridge: (query: RefreshTokenBridgeQuery) => Promise<IRefreshTokenBridge | null>;
  deleteRefreshTokenBridges: (data: RefreshTokenBridgeDeleteData) => Promise<DeleteResult>;
} {
  let indexesPromise: Promise<void> | null = null;

  const getRefreshTokenBridgeModel = () =>
    mongoose.models.RefreshTokenBridge as Model<IRefreshTokenBridge>;

  /**
   * A bridge holds an encrypted refresh token, and the TTL index is the only thing that ever
   * deletes one. `MONGO_AUTO_INDEX=false` is a supported deployment setting, and under it Mongoose
   * builds neither that index nor the compound uniqueness the upsert relies on — so bridges would
   * accumulate for the life of the collection and concurrent writes could leave duplicates. The
   * indexes are therefore installed before the first write, and a failed build is retried on the
   * next attempt rather than cached.
   */
  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      indexesPromise = createIndexesWithRetry(getRefreshTokenBridgeModel()).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  async function upsertRefreshTokenBridge(
    bridgeData: RefreshTokenBridgeCreateData,
  ): Promise<IRefreshTokenBridge | null> {
    try {
      await ensureIndexes();
      const RefreshTokenBridge = getRefreshTokenBridgeModel();
      const filter = bridgeFilter(bridgeData);
      const update = bridgeUpsertUpdate(bridgeData);
      return await RefreshTokenBridge.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
      }).lean<IRefreshTokenBridge>();
    } catch (error) {
      logger.debug('[upsertRefreshTokenBridge] Error storing bridge:', error);
      throw error;
    }
  }

  async function findRefreshTokenBridge(
    query: RefreshTokenBridgeQuery,
  ): Promise<IRefreshTokenBridge | null> {
    try {
      const RefreshTokenBridge = getRefreshTokenBridgeModel();
      return await RefreshTokenBridge.findOne(
        unexpiredBridgeFilter(query),
      ).lean<IRefreshTokenBridge>();
    } catch (error) {
      logger.debug('[findRefreshTokenBridge] Error finding bridge:', error);
      throw error;
    }
  }

  async function deleteRefreshTokenBridges(
    data: RefreshTokenBridgeDeleteData,
  ): Promise<DeleteResult> {
    try {
      const RefreshTokenBridge = getRefreshTokenBridgeModel();
      return await RefreshTokenBridge.deleteMany(bridgeDeleteFilter(data));
    } catch (error) {
      logger.debug('[deleteRefreshTokenBridges] Error deleting bridges:', error);
      throw error;
    }
  }

  return {
    upsertRefreshTokenBridge,
    findRefreshTokenBridge,
    deleteRefreshTokenBridges,
  };
}

export type RefreshTokenBridgeMethods = ReturnType<typeof createRefreshTokenBridgeMethods>;

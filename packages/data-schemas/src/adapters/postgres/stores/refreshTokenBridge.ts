/**
 * The PostgreSQL `RefreshTokenBridgeStore` (`~/ports/refreshTokenBridge`) on the
 * `refreshtokenbridges` table, through the collection primitive, with the filters and upsert of
 * `~/methods/refreshTokenBridgeRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * The TTL and the compound uniqueness the upsert relies on come with the migrations (the TTL
 * sweeper removes expired bridges), so nothing is ensured before the first write.
 */
import type { RefreshTokenBridgeStore } from '~/ports/refreshTokenBridge';
import type { PostgresStoreContext } from './context';
import type { IRefreshTokenBridge } from '~/types';
import {
  bridgeFilter,
  bridgeDeleteFilter,
  bridgeUpsertUpdate,
  unexpiredBridgeFilter,
} from '~/methods/refreshTokenBridgeRules';
import logger from '~/config/winston';

type BridgeRecord = IRefreshTokenBridge & Record<string, unknown>;

export function createPostgresRefreshTokenBridgeStore(
  context: PostgresStoreContext,
): RefreshTokenBridgeStore {
  const bridges = () => context.collections().collection<BridgeRecord>('refreshtokenbridges');

  const store: RefreshTokenBridgeStore = {
    async upsertRefreshTokenBridge(bridgeData) {
      try {
        return await bridges().findOneAndUpdate(
          bridgeFilter(bridgeData),
          bridgeUpsertUpdate(bridgeData),
          { upsert: true, returnDocument: 'after' },
        );
      } catch (error) {
        logger.debug('[upsertRefreshTokenBridge] Error storing bridge:', error);
        throw error;
      }
    },

    async findRefreshTokenBridge(query) {
      try {
        return await bridges().findOne(unexpiredBridgeFilter(query));
      } catch (error) {
        logger.debug('[findRefreshTokenBridge] Error finding bridge:', error);
        throw error;
      }
    },

    async deleteRefreshTokenBridges(data) {
      try {
        return await bridges().deleteMany(bridgeDeleteFilter(data));
      } catch (error) {
        logger.debug('[deleteRefreshTokenBridges] Error deleting bridges:', error);
        throw error;
      }
    },
  };
  return store;
}

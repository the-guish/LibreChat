/**
 * The refresh token bridge store's database-neutral rules (`RefreshTokenBridgeStore`,
 * `~/ports/refreshTokenBridge`), shared by every backend: the MongoDB methods
 * (`./refreshTokenBridge`) and the PostgreSQL store
 * (`adapters/postgres/stores/refreshTokenBridge.ts`). The filters (a bridge without a tenant is
 * kept apart from tenant bridges) and the upsert, stated in the store query language. Nothing
 * here may import `mongoose` or the MongoDB driver.
 */
import type {
  RefreshTokenBridgeQuery,
  RefreshTokenBridgeCreateData,
  RefreshTokenBridgeDeleteData,
} from '~/types';

/** A filter or update in the store query language. */
export type RefreshTokenBridgeFilter = Record<string, unknown>;

/** The bridge of the old token, the user and the tenant (none: a tenantless bridge only). */
export function bridgeFilter({
  oldRefreshTokenHash,
  userId,
  tenantId,
}: RefreshTokenBridgeQuery): RefreshTokenBridgeFilter {
  return {
    oldRefreshTokenHash,
    userId,
    tenantId: tenantId ?? { $exists: false },
  };
}

/** {@link bridgeFilter}, unexpired. */
export function unexpiredBridgeFilter(query: RefreshTokenBridgeQuery): RefreshTokenBridgeFilter {
  return {
    ...bridgeFilter(query),
    expiresAt: { $gt: new Date() },
  };
}

/**
 * The upsert of `upsertRefreshTokenBridge`: the new token, version, expiry and issuer replaced
 * (the issuer unset when absent), the key fields and `createdAt` written on insert only.
 */
export function bridgeUpsertUpdate(
  bridgeData: RefreshTokenBridgeCreateData,
): RefreshTokenBridgeFilter {
  return {
    $set: {
      encryptedNewRefreshToken: bridgeData.encryptedNewRefreshToken,
      version: bridgeData.version,
      expiresAt: bridgeData.expiresAt,
      ...(bridgeData.openidIssuer != null && { openidIssuer: bridgeData.openidIssuer }),
    },
    $setOnInsert: {
      oldRefreshTokenHash: bridgeData.oldRefreshTokenHash,
      userId: bridgeData.userId,
      ...(bridgeData.tenantId != null && { tenantId: bridgeData.tenantId }),
      createdAt: new Date(),
    },
    ...(bridgeData.openidIssuer == null && { $unset: { openidIssuer: '' } }),
  };
}

/** The filter of `deleteRefreshTokenBridges`. */
export function bridgeDeleteFilter(data: RefreshTokenBridgeDeleteData): RefreshTokenBridgeFilter {
  return {
    ...(data.oldRefreshTokenHashes && {
      oldRefreshTokenHash: { $in: data.oldRefreshTokenHashes },
    }),
    ...(data.version && { version: data.version }),
    userId: data.userId,
    tenantId: data.tenantId ?? { $exists: false },
  };
}

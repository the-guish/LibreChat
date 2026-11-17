/**
 * The session store's database-neutral rules (`SessionStore`, `~/ports/session`), shared by every
 * backend: the MongoDB methods (`./session`) and the PostgreSQL store
 * (`adapters/postgres/stores/session.ts`). The coded error, the default expiry, the lookups and
 * deletes stated in the store query language (refresh tokens matched by their hash), and the
 * refresh token signing. Nothing here may import `mongoose` or the MongoDB driver.
 */
import type * as t from '~/types/session';
import { signPayload, hashToken } from '~/crypto';

export class SessionError extends Error {
  public code: string;

  constructor(message: string, code: string = 'SESSION_ERROR') {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

/** Default refresh token expiry: 7 days in milliseconds */
export const DEFAULT_REFRESH_TOKEN_EXPIRY: number = 1000 * 60 * 60 * 24 * 7;

/** Whether a string is an id of the backend's format (`StoreIds.isValid`). */
export type SessionIdCheck = (id: string) => boolean;

/** The filter of `findSession`: every given parameter, and an unexpired session. */
export async function sessionSearchQuery(
  params: t.SessionSearchParams,
  isValidId: SessionIdCheck,
): Promise<Record<string, unknown>> {
  const query: Record<string, unknown> = {};

  if (!params.refreshToken && !params.userId && !params.sessionId) {
    throw new SessionError('At least one search parameter is required', 'INVALID_SEARCH_PARAMS');
  }

  if (params.refreshToken) {
    const tokenHash = await hashToken(params.refreshToken);
    query.refreshTokenHash = tokenHash;
  }

  if (params.userId) {
    query.user = params.userId;
  }

  if (params.sessionId) {
    const sessionId =
      typeof params.sessionId === 'object' &&
      params.sessionId !== null &&
      'sessionId' in params.sessionId
        ? (params.sessionId as { sessionId: string }).sessionId
        : (params.sessionId as string);
    if (!isValidId(sessionId)) {
      throw new SessionError('Invalid session ID format', 'INVALID_SESSION_ID');
    }
    query._id = sessionId;
  }

  // Add expiration check to only return valid sessions
  query.expiration = { $gt: new Date() };
  return query;
}

/** The filter of `deleteSession`: by refresh token, by id, or both. */
export async function deleteSessionQuery(
  params: t.DeleteSessionParams,
): Promise<Record<string, unknown>> {
  if (!params.refreshToken && !params.sessionId) {
    throw new SessionError('Either refreshToken or sessionId is required', 'INVALID_DELETE_PARAMS');
  }

  const query: Record<string, unknown> = {};

  if (params.refreshToken) {
    query.refreshTokenHash = await hashToken(params.refreshToken);
  }

  if (params.sessionId) {
    query._id = params.sessionId;
  }
  return query;
}

/** The filter of `deleteAllUserSessions`, and the user id it names. */
export function allUserSessionsQuery(
  userId: string | { userId: string },
  options: t.DeleteAllSessionsOptions,
  isValidId: SessionIdCheck,
): { userIdString: string; query: Record<string, unknown> } {
  if (!userId) {
    throw new SessionError('User ID is required', 'INVALID_USER_ID');
  }

  const userIdString =
    typeof userId === 'object' && userId !== null ? userId.userId : (userId as string);

  if (!isValidId(userIdString)) {
    throw new SessionError('Invalid user ID format', 'INVALID_USER_ID_FORMAT');
  }

  const query: Record<string, unknown> = { user: userIdString };

  if (options.excludeCurrentSession && options.currentSessionId) {
    query._id = { $ne: options.currentSessionId };
  }
  return { userIdString, query };
}

/** The session fields `signSessionRefreshToken` reads and sets. */
export interface RefreshTokenSession {
  _id?: unknown;
  user?: unknown;
  expiration?: Date;
  refreshTokenHash?: string;
}

/**
 * Signs a new refresh token for `session` and stores its hash (and the default expiration when
 * it has none) on the session, which the caller then saves.
 */
export async function signSessionRefreshToken(session: RefreshTokenSession): Promise<string> {
  const expiresIn = session.expiration
    ? session.expiration.getTime()
    : Date.now() + DEFAULT_REFRESH_TOKEN_EXPIRY;

  if (!session.expiration) {
    session.expiration = new Date(expiresIn);
  }

  const refreshToken = await signPayload({
    payload: {
      id: session.user,
      sessionId: session._id,
      /** `iat` is whole seconds, too coarse to order this token against a password reset that
       * lands in the same second. `isTokenRetired` reads this claim to settle that exactly. */
      issuedAtMs: Date.now(),
    },
    secret: process.env.JWT_REFRESH_SECRET!,
    expirationTime: Math.floor((expiresIn - Date.now()) / 1000),
  });

  session.refreshTokenHash = await hashToken(refreshToken);
  return refreshToken;
}

/** The update of `upsertSession` for the token's hash. */
export function upsertSessionUpdate(
  userId: string,
  refreshTokenHash: string,
  options: t.UpsertSessionOptions,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    user: userId,
    refreshTokenHash,
    expiration: options.expiration,
  };
  if (options.tenantId) {
    update.tenantId = options.tenantId;
  }
  return update;
}

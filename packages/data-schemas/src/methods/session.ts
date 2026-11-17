import type * as t from '~/types/session';
import {
  SessionError,
  sessionSearchQuery,
  deleteSessionQuery,
  upsertSessionUpdate,
  allUserSessionsQuery,
  signSessionRefreshToken,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
} from './sessionRules';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';
import { hashToken } from '~/crypto';

export { SessionError, DEFAULT_REFRESH_TOKEN_EXPIRY } from './sessionRules';

// Factory function that takes mongoose instance and returns the methods
export function createSessionMethods(mongoose: typeof import('mongoose')): {
  findSession: (
    params: t.SessionSearchParams,
    options?: t.SessionQueryOptions,
  ) => Promise<t.ISession | null>;
  SessionError: typeof SessionError;
  deleteSession: (params: t.DeleteSessionParams) => Promise<{ deletedCount?: number }>;
  createSession: (userId: string, options?: t.CreateSessionOptions) => Promise<t.SessionResult>;
  upsertSession: (
    userId: string,
    refreshToken: string,
    options: t.UpsertSessionOptions,
  ) => Promise<t.ISession>;
  ensureSessionIndexes: () => Promise<void>;
  generateRefreshToken: (session: t.ISession) => Promise<string>;
  deleteAllUserSessions: (
    userId: string | { userId: string },
    options?: t.DeleteAllSessionsOptions,
  ) => Promise<{ deletedCount?: number }>;
} {
  let sessionIndexesPromise: Promise<void> | null = null;

  function ensureSessionIndexes(): Promise<void> {
    if (!sessionIndexesPromise) {
      sessionIndexesPromise = createIndexesWithRetry(mongoose.models.Session).catch((error) => {
        sessionIndexesPromise = null;
        throw error;
      });
    }
    return sessionIndexesPromise;
  }

  /**
   * Creates a new session for a user
   */
  async function createSession(
    userId: string,
    options: t.CreateSessionOptions = {},
  ): Promise<t.SessionResult> {
    if (!userId) {
      throw new SessionError('User ID is required', 'INVALID_USER_ID');
    }

    const expiresIn = options.expiresIn ?? DEFAULT_REFRESH_TOKEN_EXPIRY;

    try {
      await ensureSessionIndexes();
      const Session = mongoose.models.Session;
      const currentSession = new Session({
        user: userId,
        expiration: options.expiration || new Date(Date.now() + expiresIn),
      });
      const refreshToken = await generateRefreshToken(currentSession);

      return { session: currentSession, refreshToken };
    } catch (error) {
      logger.error('[createSession] Error creating session:', error);
      throw new SessionError('Failed to create session', 'CREATE_SESSION_FAILED');
    }
  }

  /** Stores an externally issued refresh token so logout and administrative revocation apply. */
  async function upsertSession(
    userId: string,
    refreshToken: string,
    options: t.UpsertSessionOptions,
  ): Promise<t.ISession> {
    if (!userId || !refreshToken || !options.expiration) {
      throw new SessionError('User, refresh token, and expiration are required', 'INVALID_SESSION');
    }

    try {
      await ensureSessionIndexes();
      const Session = mongoose.models.Session;
      const refreshTokenHash = await hashToken(refreshToken);
      const update = upsertSessionUpdate(userId, refreshTokenHash, options);
      const session = await Session.findOneAndUpdate(
        { user: userId, refreshTokenHash },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
      if (!session) {
        throw new SessionError('Stored session was not returned', 'SESSION_NOT_FOUND');
      }
      return session as t.ISession;
    } catch (error) {
      logger.error('[upsertSession] Error storing session:', error);
      throw new SessionError('Failed to store session', 'UPSERT_SESSION_FAILED');
    }
  }

  /**
   * Finds a session by various parameters
   */
  async function findSession(
    params: t.SessionSearchParams,
    options: t.SessionQueryOptions = { lean: true },
  ): Promise<t.ISession | null> {
    try {
      const Session = mongoose.models.Session;
      const query = await sessionSearchQuery(params, (id) => mongoose.Types.ObjectId.isValid(id));

      const sessionQuery = Session.findOne(query);

      if (options.lean) {
        return (await sessionQuery.lean()) as t.ISession | null;
      }

      return await sessionQuery.exec();
    } catch (error) {
      logger.error('[findSession] Error finding session:', error);
      throw new SessionError('Failed to find session', 'FIND_SESSION_FAILED');
    }
  }

  /**
   * Deletes a session by refresh token or session ID
   */
  async function deleteSession(params: t.DeleteSessionParams): Promise<{ deletedCount?: number }> {
    try {
      const Session = mongoose.models.Session;
      const query = await deleteSessionQuery(params);

      const result = await Session.deleteOne(query);

      if (result.deletedCount === 0) {
        logger.warn('[deleteSession] No session found to delete');
      }

      return result;
    } catch (error) {
      logger.error('[deleteSession] Error deleting session:', error);
      throw new SessionError('Failed to delete session', 'DELETE_SESSION_FAILED');
    }
  }

  /**
   * Deletes all sessions for a user
   */
  async function deleteAllUserSessions(
    userId: string | { userId: string },
    options: t.DeleteAllSessionsOptions = {},
  ): Promise<{ deletedCount?: number }> {
    try {
      const Session = mongoose.models.Session;
      const { userIdString, query } = allUserSessionsQuery(userId, options, (id) =>
        mongoose.Types.ObjectId.isValid(id),
      );

      const result = await Session.deleteMany(query);

      if (result.deletedCount && result.deletedCount > 0) {
        logger.debug(
          `[deleteAllUserSessions] Deleted ${result.deletedCount} sessions for user ${userIdString}.`,
        );
      }

      return result;
    } catch (error) {
      logger.error('[deleteAllUserSessions] Error deleting user sessions:', error);
      throw new SessionError('Failed to delete user sessions', 'DELETE_ALL_SESSIONS_FAILED');
    }
  }

  /**
   * Generates a refresh token for a session
   */
  async function generateRefreshToken(session: t.ISession): Promise<string> {
    if (!session || !session.user) {
      throw new SessionError('Invalid session object', 'INVALID_SESSION');
    }

    try {
      const refreshToken = await signSessionRefreshToken(session);
      await session.save();

      return refreshToken;
    } catch (error) {
      logger.error('[generateRefreshToken] Error generating refresh token:', error);
      throw new SessionError('Failed to generate refresh token', 'GENERATE_TOKEN_FAILED');
    }
  }

  return {
    findSession,
    SessionError,
    deleteSession,
    createSession,
    upsertSession,
    ensureSessionIndexes,
    generateRefreshToken,
    deleteAllUserSessions,
  };
}

export type SessionMethods = ReturnType<typeof createSessionMethods>;

/**
 * The PostgreSQL `SessionStore` (`~/ports/session`) on the `sessions` table, through the
 * collection primitive, with the filters, coded errors and refresh token signing of
 * `~/methods/sessionRules`. Must not import `mongoose`, `mongodb` or `bson`.
 *
 * Sessions are plain records here, whatever `findSession`'s `lean` option says (the port allows
 * it): `createSession` hands out a session that is not stored yet, as MongoDB hands out an
 * unsaved document, and `generateRefreshToken` stores the session it is given, inserting it the
 * first time (a session `createSession` handed out) and otherwise writing the new hash (and an
 * expiration it lacked) by id, failing when the session is gone, as `save()` does. Session ids
 * and user ids follow the PostgreSQL id rules (24 hex characters, R7). The indexes come with the
 * migrations, so `ensureSessionIndexes` resolves at once.
 */
import type { RefreshTokenSession } from '~/methods/sessionRules';
import type { PostgresStoreContext } from './context';
import type { SessionStore } from '~/ports/session';
import type { ISession } from '~/types';
import {
  SessionError,
  sessionSearchQuery,
  deleteSessionQuery,
  upsertSessionUpdate,
  allUserSessionsQuery,
  signSessionRefreshToken,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
} from '~/methods/sessionRules';
import { postgresStoreIds } from '../storeIds';
import logger from '~/config/winston';
import { hashToken } from '~/crypto';

type SessionRecord = RefreshTokenSession & Record<string, unknown>;

/** Sessions `createSession` handed out that no `generateRefreshToken` has stored yet. */
const unsavedSessions = new WeakSet<object>();

const isValidId = (id: string) => postgresStoreIds.isValid(id);

const asSession = (record: SessionRecord): ISession => record as unknown as ISession;

export function createPostgresSessionStore(context: PostgresStoreContext): SessionStore {
  const sessions = () => context.collections().collection<SessionRecord>('sessions');

  /** Stores `session` as `save()` does: an insert the first time, then the changed fields. */
  async function saveSession(session: SessionRecord): Promise<void> {
    if (unsavedSessions.has(session)) {
      const stored = await sessions().insertOne({
        _id: session._id,
        user: session.user,
        expiration: session.expiration,
        refreshTokenHash: session.refreshTokenHash,
      });
      unsavedSessions.delete(session);
      Object.assign(session, stored);
      return;
    }
    const result = await sessions().updateOne(
      { _id: session._id },
      { $set: { refreshTokenHash: session.refreshTokenHash, expiration: session.expiration } },
    );
    if (result.matchedCount === 0) {
      throw new Error(`No session found with id ${String(session._id)}`);
    }
  }

  async function generateRefreshToken(session: ISession): Promise<string> {
    if (!session || !session.user) {
      throw new SessionError('Invalid session object', 'INVALID_SESSION');
    }
    try {
      const record = session as unknown as SessionRecord;
      const refreshToken = await signSessionRefreshToken(record);
      await saveSession(record);
      return refreshToken;
    } catch (error) {
      logger.error('[generateRefreshToken] Error generating refresh token:', error);
      throw new SessionError('Failed to generate refresh token', 'GENERATE_TOKEN_FAILED');
    }
  }

  const store: SessionStore = {
    async createSession(userId, options = {}) {
      if (!userId) {
        throw new SessionError('User ID is required', 'INVALID_USER_ID');
      }
      const expiresIn = options.expiresIn ?? DEFAULT_REFRESH_TOKEN_EXPIRY;
      try {
        const currentSession: SessionRecord = {
          _id: postgresStoreIds.generate(),
          user: userId,
          expiration: options.expiration || new Date(Date.now() + expiresIn),
        };
        unsavedSessions.add(currentSession);
        const refreshToken = await generateRefreshToken(asSession(currentSession));
        return { session: asSession(currentSession), refreshToken };
      } catch (error) {
        logger.error('[createSession] Error creating session:', error);
        throw new SessionError('Failed to create session', 'CREATE_SESSION_FAILED');
      }
    },

    async upsertSession(userId, refreshToken, options) {
      if (!userId || !refreshToken || !options.expiration) {
        throw new SessionError(
          'User, refresh token, and expiration are required',
          'INVALID_SESSION',
        );
      }
      try {
        const refreshTokenHash = await hashToken(refreshToken);
        const session = await sessions().findOneAndUpdate(
          { user: userId, refreshTokenHash },
          { $set: upsertSessionUpdate(userId, refreshTokenHash, options) },
          { upsert: true, returnDocument: 'after' },
        );
        if (!session) {
          throw new SessionError('Stored session was not returned', 'SESSION_NOT_FOUND');
        }
        return asSession(session);
      } catch (error) {
        logger.error('[upsertSession] Error storing session:', error);
        throw new SessionError('Failed to store session', 'UPSERT_SESSION_FAILED');
      }
    },

    async findSession(params) {
      try {
        const session = await sessions().findOne(await sessionSearchQuery(params, isValidId));
        return session ? asSession(session) : null;
      } catch (error) {
        logger.error('[findSession] Error finding session:', error);
        throw new SessionError('Failed to find session', 'FIND_SESSION_FAILED');
      }
    },

    async deleteSession(params) {
      try {
        const result = await sessions().deleteOne(await deleteSessionQuery(params));
        if (result.deletedCount === 0) {
          logger.warn('[deleteSession] No session found to delete');
        }
        return result;
      } catch (error) {
        logger.error('[deleteSession] Error deleting session:', error);
        throw new SessionError('Failed to delete session', 'DELETE_SESSION_FAILED');
      }
    },

    async deleteAllUserSessions(userId, options = {}) {
      try {
        const { userIdString, query } = allUserSessionsQuery(userId, options, isValidId);
        const result = await sessions().deleteMany(query);
        if (result.deletedCount > 0) {
          logger.debug(
            `[deleteAllUserSessions] Deleted ${result.deletedCount} sessions for user ${userIdString}.`,
          );
        }
        return result;
      } catch (error) {
        logger.error('[deleteAllUserSessions] Error deleting user sessions:', error);
        throw new SessionError('Failed to delete user sessions', 'DELETE_ALL_SESSIONS_FAILED');
      }
    },

    async ensureSessionIndexes() {
      return undefined;
    },

    generateRefreshToken,
  };
  return store;
}
